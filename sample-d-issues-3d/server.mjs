// server.mjs — sample-d v6: 実 Issue（APS Issues API）+ 要素情報の自動付与 + ハイブリッド 3D 表示
// 起動: node server.mjs（.env に APS_CLIENT_ID / APS_CLIENT_SECRET、.token.json に 3-legged トークンが必要）
//
// 対象は2モデル（data/models.json）: DACHsampleproject.rvt（建築・132MB）と
// Snowdon Towers Sample Structural.rvt（構造・軽量）。Issue のピン先モデルに応じて付与と表示を切り替える。
// 3D 表示は2段構え: (1) 先行表示 = 起票対象＋周辺だけの軽量 GLB（Draco 圧縮、public/subsets/ に同梱）を
// three.js で即時表示、(2) 本表示 = APS Viewer（SVF 逐次配信）が読み込み完了後に使える。
// サーバーの役割はトークン配布と Issues API 連携のみ（変換・キャッシュは持たない）。
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
const models = JSON.parse(fs.readFileSync(path.join(root, 'data', 'models.json'), 'utf8'));
for (const m of models) {
  const dir = path.join(root, 'data', m.key);
  m.propsIndex = JSON.parse(fs.readFileSync(path.join(dir, 'props-index.json'), 'utf8'));
  m.ext2dbid = JSON.parse(fs.readFileSync(path.join(dir, 'ext2dbid.json'), 'utf8'));
  m.bboxIndex = JSON.parse(fs.readFileSync(path.join(dir, 'bbox-index.json'), 'utf8'));
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm' };
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

// ---- モデルの tip バージョン（表示用、モデルごと） ----
const versionCache = new Map();
async function getModelVersion(m) {
  const c = versionCache.get(m.key);
  if (c && Date.now() - c.at < 60000) return c.value;
  const token = (await getToken2()).access_token;
  const r = await fetch(`${BASE}/data/v1/projects/${m.projectId}/items/${encodeURIComponent(m.lineage)}/versions`, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error('versions fetch failed: ' + r.status);
  const j = await r.json();
  const tip = j.data?.[0];
  const value = { versionNumber: tip?.attributes?.versionNumber ?? 1, versionId: tip?.id ?? null };
  versionCache.set(m.key, { at: Date.now(), value });
  return value;
}

// ---- Issue の要素情報付与（ピン先モデルに応じて索引を切り替える） ----
function enrich(issue) {
  const out = {
    id: issue.id, displayId: issue.displayId, title: issue.title, description: issue.description,
    status: issue.status, dueDate: issue.dueDate, assignedTo: issue.assignedTo, published: issue.published,
    createdAt: issue.createdAt, pin: null, element: null, targetDbId: null, targetBbox: null,
    modelKey: null, modelName: null,
  };
  const ld = (issue.linkedDocuments ?? [])[0];
  if (!ld) return out;
  const d = ld.details ?? {};
  out.pin = { modelUrn: ld.urn, viewName: d.viewable?.name ?? null, objectId: d.objectId ?? null, externalId: d.externalId ?? null, position: d.position ?? null };
  const m = models.find(x => x.lineage === ld.urn);
  if (!m || !d.externalId) return out;
  out.modelKey = m.key;
  out.modelName = m.short;
  const dbId = m.ext2dbid[d.externalId];
  if (dbId === undefined) return out;
  out.targetDbId = dbId;
  out.element = m.propsIndex[d.externalId] ?? null;
  out.targetBbox = m.bboxIndex[String(dbId)] ?? null;
  return out;
}
async function fetchIssues() {
  const token = await getToken3();
  const pid = models[0].projectId.replace(/^b\./, '');
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
      const m = models.find(x => x.key === url.searchParams.get('key')) ?? models[0];
      const ver = await getModelVersion(m);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ key: m.key, name: m.name, short: m.short, lineage: m.lineage, version: ver.versionNumber, urn: m.derivativeUrn, guid: m.viewableGuid }));
      return;
    }
    if (url.pathname === '/api/issues') {
      const issues = await fetchIssues();
      const vers = await Promise.all(models.map(getModelVersion));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        models: models.map((m, i) => ({ key: m.key, name: m.name, short: m.short, version: vers[i].versionNumber, urn: m.derivativeUrn, guid: m.viewableGuid })),
        issues, fetchedAt: new Date().toISOString(),
      }));
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
server.listen(port, () => { console.log(`sample-d v6 server: http://localhost:${port}`); });
