import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { loadEnv, makePkce, authorizeUrl, exchangeCode } from "./aps.js";

// Manual variant of login.ts for when the browser that approves consent is not
// on this machine: `start` prints an authorize URL and saves the PKCE verifier;
// after approving, the browser lands on the (unreachable) localhost callback —
// copy that full URL and pass it to `finish`, which exchanges the code.
const PKCE_FILE = new URL("../.pkce.json", import.meta.url);
const mode = process.argv[2];

if (mode === "start") {
  const e = loadEnv();
  const { verifier, challenge } = makePkce();
  const state = randomBytes(8).toString("hex");
  writeFileSync(PKCE_FILE, JSON.stringify({ verifier, state }));
  console.log(authorizeUrl(e, challenge, state));
} else if (mode === "finish") {
  const input = process.argv[3];
  if (!input) throw new Error("usage: login-manual finish <callback-url-or-code>");
  if (!existsSync(PKCE_FILE)) throw new Error("no .pkce.json — run start first");
  const { verifier, state } = JSON.parse(readFileSync(PKCE_FILE, "utf8"));
  let code = input;
  if (input.startsWith("http")) {
    const u = new URL(input);
    if (u.searchParams.get("state") !== state) throw new Error("state mismatch");
    code = u.searchParams.get("code") ?? "";
  }
  if (!code) throw new Error("no code found in input");
  const e = loadEnv();
  const tok = await exchangeCode(e, code, verifier);
  console.log(`token stored (expires_in=${tok.expires_in}s)`);
} else {
  throw new Error("usage: login-manual start|finish");
}
