import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// Minimal APS (Autodesk Platform Services) OAuth 2.0 Authorization Code + PKCE client.
// Forma Site Design HTTP APIs accept 3-legged tokens only, so every call in this
// sample goes through the user-consent flow implemented here.

const TOKEN_FILE = new URL("../.token.json", import.meta.url);

export interface Env {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  scopes: string;
}

export function loadEnv(): Env {
  const envPath = new URL("../.env", import.meta.url);
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) process.env[m[1]] = m[2];
    }
  }
  const e: Env = {
    clientId: process.env.APS_CLIENT_ID ?? "",
    clientSecret: process.env.APS_CLIENT_SECRET ?? "",
    callbackUrl: process.env.APS_CALLBACK_URL ?? "http://localhost:3000/callback",
    scopes: process.env.APS_SCOPES ?? "data:read data:write account:read",
  };
  if (!e.clientId || !e.clientSecret) {
    throw new Error("APS_CLIENT_ID / APS_CLIENT_SECRET are not set. Copy .env.example to .env and fill them from your APS app page.");
  }
  return e;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function makePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function authorizeUrl(e: Env, challenge: string, state: string): string {
  const u = new URL("https://developer.api.autodesk.com/authentication/v2/authorize");
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", e.clientId);
  u.searchParams.set("redirect_uri", e.callbackUrl);
  u.searchParams.set("scope", e.scopes);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);
  return u.toString();
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

export async function exchangeCode(e: Env, code: string, verifier: string): Promise<TokenResponse> {
  const basic = Buffer.from(`${e.clientId}:${e.clientSecret}`).toString("base64");
  const res = await fetch("https://developer.api.autodesk.com/authentication/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: e.callbackUrl,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  const tok = (await res.json()) as TokenResponse;
  writeFileSync(TOKEN_FILE, JSON.stringify({ ...tok, obtained_at: Date.now() }, null, 2));
  return tok;
}

export function loadToken(): string {
  if (!existsSync(TOKEN_FILE)) throw new Error("No token yet. Run `npm run login` first.");
  const t = JSON.parse(readFileSync(TOKEN_FILE, "utf8"));
  const ageSec = (Date.now() - t.obtained_at) / 1000;
  if (ageSec > t.expires_in - 60) throw new Error("Token expired. Run `npm run login` again.");
  return t.access_token as string;
}

/** fetch wrapper that prints status + a trimmed body, and returns parsed JSON. */
export async function apsFetch(token: string, url: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  console.log(`${init.method ?? "GET"} ${url} -> ${res.status}`);
  let json: unknown = undefined;
  try { json = JSON.parse(text); } catch { /* keep raw */ }
  if (!res.ok) {
    console.log("  error body:", text.slice(0, 800));
    throw new Error(`request failed: ${res.status}`);
  }
  return json;
}
