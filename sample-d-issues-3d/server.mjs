// server.mjs — sample-d v5: 実 Issue（APS Issues API）+ 要素情報の自動付与 + APS Viewer（SVF 逐次配信）
// 起動: node server.mjs（.env に APS_CLIENT_ID / APS_CLIENT_SECRET、.token.json に 3-legged トークンが必要）
//
// 3D 表示は APS Viewer に寄せた（v5）。モデルは Autodesk クラウドに置かれた SVF を Viewer が逐次配信で読み込む。
// サーバー側の変換・キャッシュは持たない。ここが担うのは (1) Viewer 用 2-legged トークンの配布、
// (2) Issues API からの実 Issue 取得と、ピン先要素の情報（要素名・階・通り芯・bbox）の自動付与だけ。
// GLB キャッシュ方式（v4）は Git 履歴を参照。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(root, 'public');
const env = {};
for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const model = JSON.parse(fs.readFileSync(path.join(root, 'data', 'model.json'), 'utf8'));
const propsIndex = JSON.parse(fs.readFileSync(path.join(root, 'data', 'props-index.json'), 'utf8'));
const ext2dbid = JSON.parse(fs.readFileSync(path.join(root, 'data', 'ext2dbid.json'), 'utf8'));
const bboxIndex = JSON.parse(fs.readFileSync(path.join(root, 'data', 'bbox-index.json'), 'utf8'));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const BASE = 'https://developer.api.autodesk.com';

function basicAuth() { return 'Basic ' + Buffer.from(env.APS_CLIENT_ID + ':' + env.APS_CLIENT_SECRET).toString('base64'); }

// ---- 2-legged トークン（Viewer 用） ----
async function getToken2() {
  const r = await fetch(BASE + '/authentication/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuth() },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'viewables:read data:read' }),
  });
  if (!r.ok) throw new Error('2-legged token failed: ' + r.status);
  return r.json();
}

// ---- 3-legged トークン（Issues API 用。refresh token を .token.json に保持し、ローテーションに追随する） ----
const TOKFILE = path.join(root, '.token.json');
let tok3 = JSON.parse(fs.readFileSync(TOKFILE, 'utf8'));
async function getToken3() {
  if (Date.now() - (tok3.obtained_at ?? 0) < 45 * 60000) return tok3.access_token;
  const r = await fetch(BASE + '/authentication/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuth() },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok3.refresh_token }),
  });
  if (!r.ok) throw new Error('3-legged refresh failed: ' + r.status);
  tok3 = { ...(await r.json()), obtained_at: Date.now() };
  fs.writeFileSync(TOKFILE, JSON.stringify(tok3, null, 1));
  return tok3.access_token;
}

// ---- モデルの tip バージョン（表示用） ----
let versionCache = { at: 0, value: null };
async function getModelVersion() {
  if (Date.now() - versionCache.at < 60000 && versionCache.value) return versionCache.value;
  const token = (await getToken2()).access_token;
  const r = await fetch(`${BASE}/data/v1/projects/${model.projectId}/items/${encodeURIComponent(model.lineage)}/versions`, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error('versions fetch failed: ' + r.status);
  const j = await r.json();
  const tip = j.data?.[0];
  const value = { versionNumber: tip?.attributes?.versionNumber ?? 1, versionId: tip?.id ?? model.versionId };
  versionCache = { at: Date.now(), value };
  return value;
}

// ---- Issue の要素情報付与 ----
function enrich(issue) {
  const out = {
    id: issue.id, displayId: issue.displayId, title: issue.title, description: issue.description,
    status: issue.status, dueDate: issue.dueDate, assignedTo: issue.assignedTo, published: issue.published,
    createdAt: issue.createdAt, pin: null, element: null, targetDbId: null, targetBbox: null,
  };
  const ld = (issue.linkedDocuments ?? [])[0];
  if (!ld) return out;
  const d = ld.details ?? {};
  out.pin = { modelUrn: ld.urn, viewName: d.viewable?.name ?? null, objectId: d.objectId ?? null, externalId: d.externalId ?? null, position: d.position ?? null };
  if (ld.urn !== model.lineage || !d.externalId) return out;
  const dbId = ext2dbid[d.externalId];
  if (dbId === undefined) return out;
  out.targetDbId = dbId;
  out.element = propsIndex[d.externalId] ?? null;
  out.targetBbox = bboxIndex[String(dbId)] ?? null;
  return out;
}
async function fetchIssues() {
  const token = await getToken3();
  const pid = model.projectId.replace(/^b\./, '');
  const r = await fetch(`${BASE}/construction/issues/v1/projects/${pid}/issues?limit=50`, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error('issues fetch failed: ' + r.status);
  const j = await r.json();
  return (j.results ?? []).filter((i) => !i.deleted).map(enrich);
}

// ---- HTTP サーバー ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/token') {
      const j = await getToken2();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: j.access_token, expires_in: j.expires_in }));
      return;
    }
    if (url.pathname === '/api/model') {
      const ver = await getModelVersion();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ name: model.itemName, lineage: model.lineage, version: ver.versionNumber, urn: model.derivativeUrn, guid: model.viewableGuid }));
      return;
    }
    if (url.pathname === '/api/issues') {
      const [issues, ver] = await Promise.all([fetchIssues(), getModelVersion()]);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ model: { name: model.itemName, lineage: model.lineage, version: ver.versionNumber, urn: model.derivativeUrn, guid: model.viewableGuid }, issues, fetchedAt: new Date().toISOString() }));
      return;
    }
  } catch (e) {
    console.error('api error:', e);
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: String(e?.message ?? e) }));
    return;
  }
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
  const file = path.join(pub, rel);
  if (!file.startsWith(pub) || !fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
const port = process.env.PORT ?? 3000;
server.listen(port, () => { console.log(`sample-d v5 server: http://localhost:${port}`); });
