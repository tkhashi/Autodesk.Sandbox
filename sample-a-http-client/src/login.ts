import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { loadEnv, makePkce, authorizeUrl, exchangeCode } from "./aps.js";

// Starts a tiny local callback server, prints the authorize URL to open in a
// browser signed in to Autodesk, and stores the resulting token in .token.json.
const e = loadEnv();
const { verifier, challenge } = makePkce();
const state = randomBytes(8).toString("hex");
const cb = new URL(e.callbackUrl);
const port = Number(cb.port || 3000);

const server = createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (u.pathname !== cb.pathname) { res.writeHead(404).end(); return; }
  const code = u.searchParams.get("code");
  const gotState = u.searchParams.get("state");
  if (!code || gotState !== state) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf8" }).end("login failed: missing/mismatched code or state");
    console.error("login failed", u.searchParams.toString());
    server.close();
    return;
  }
  try {
    const tok = await exchangeCode(e, code, verifier);
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf8" }).end("Login OK. You can close this tab and return to the terminal.");
    console.log(`token stored (expires_in=${tok.expires_in}s). Now run: npm run site  /  npm run acc`);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf8" }).end("token exchange failed; see terminal");
    console.error(err);
  } finally {
    server.close();
  }
});

server.listen(port, () => {
  console.log("Open this URL in a browser signed in to Autodesk:\n");
  console.log(authorizeUrl(e, challenge, state));
  console.log(`\nWaiting for callback on ${e.callbackUrl} ...`);
});
