// server.mjs — sample-d-issues-3d 用の最小サーバー
// 役割: public/ の静的配信 + APS Viewer 用トークンの発行（GET /api/token）
// 認証情報は sample-a と同じ .env（APS_CLIENT_ID / APS_CLIENT_SECRET）をこのフォルダに置く。
// 依存パッケージなし（Node 標準機能のみ）。起動: node server.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(root, 'public');
const env = {};
try {
  for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
} catch { /* .env が無くても静的配信は動く（①Viewerだけトークン取得で失敗する） */ }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.svg': 'image/svg+xml' };

async function token(res) {
  const r = await fetch('https://developer.api.autodesk.com/authentication/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(env.APS_CLIENT_ID + ':' + env.APS_CLIENT_SECRET).toString('base64') },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'data:read' }),
  });
  const j = await r.json();
  res.writeHead(r.status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ access_token: j.access_token, expires_in: j.expires_in }));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/token') { try { await token(res); } catch (e) { res.writeHead(500); res.end('token error'); } return; }
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.join(pub, rel);
  if (!file.startsWith(pub) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`sample-d-issues-3d: http://localhost:${port}`));
