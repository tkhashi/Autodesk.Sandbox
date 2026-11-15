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
  const u = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9];
  for (const b of Object.values(m.bboxIndex)) for (let k = 0; k < 3; k++) { u[k] = Math.min(u[k], b[k]); u[k + 3] = Math.max(u[k + 3], b[k + 3]); }
  m.bounds = u;
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
const thumbCache = new Map();
const snapCache = new Map();
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
const MAX_CONTEXT = 131;
function distToBox(b, p) {
  const dx = Math.max(b[0] - p[0], 0, p[0] - b[3]);
  const dy = Math.max(b[1] - p[1], 0, p[1] - b[4]);
  const dz = Math.max(b[2] - p[2], 0, p[2] - b[5]);
  return Math.hypot(dx, dy, dz);
}
function enrich(issue) {
  const out = {
    id: issue.id, displayId: issue.displayId, title: issue.title, description: issue.description,
    status: issue.status, dueDate: issue.dueDate, assignedTo: issue.assignedTo, published: issue.published,
    createdAt: issue.createdAt, openedBy: issue.openedBy, openedAt: issue.openedAt, createdBy: issue.createdBy,
    snapshotUrn: issue.snapshotUrn ?? null, snapshotHasMarkups: issue.snapshotHasMarkups ?? false,
    permittedStatuses: issue.permittedStatuses ?? null, customAttributes: issue.customAttributes ?? [],
    attachmentCount: issue.attachmentCount ?? 0, commentCount: issue.commentCount ?? 0,
    pin: null, element: null, targetDbId: null, targetBbox: null,
    contextDbIds: null, modelKey: null, modelName: null,
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
  if (out.targetBbox) {
    // 先行表示サブセットと同じ選び方で、対象＋周辺（近い順に最大131要素）を Viewer の表示範囲にも使う
    const tb = out.targetBbox;
    const c = [(tb[0] + tb[3]) / 2, (tb[1] + tb[4]) / 2, (tb[2] + tb[5]) / 2];
    out.contextDbIds = Object.keys(m.bboxIndex).map(Number)
      .map(id => ({ id, d: id === dbId ? -1 : distToBox(m.bboxIndex[String(id)], c) }))
      .sort((a, b) => a.d - b.d).slice(0, MAX_CONTEXT).map(x => x.id);
  }
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
    if (url.pathname === '/api/footprints') {
      // 平面ロケーター用：全要素の平面フットプリント（SVF の x/y）と全体の外形
      const m = models.find(x => x.key === url.searchParams.get('key')) ?? models[0];
      const rects = [];
      let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
      for (const b of Object.values(m.bboxIndex)) {
        rects.push([+b[0].toFixed(1), +b[1].toFixed(1), +b[3].toFixed(1), +b[4].toFixed(1)]);
        minx = Math.min(minx, b[0]); miny = Math.min(miny, b[1]); maxx = Math.max(maxx, b[3]); maxy = Math.max(maxy, b[4]);
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ key: m.key, bounds: [minx, miny, maxx, maxy], rects }));
      return;
    }
    if (url.pathname === '/api/thumbnail') {
      // モデルのサムネイル（Model Derivative、2-legged）。メモリにキャッシュする
      const m = models.find(x => x.key === url.searchParams.get('model')) ?? models[0];
      if (!thumbCache.has(m.key)) {
        const t = (await getToken2()).access_token;
        const r = await fetch(`${BASE}/modelderivative/v2/designdata/${m.derivativeUrn}/thumbnail`, { headers: { Authorization: 'Bearer ' + t } });
        if (!r.ok) throw new Error('thumbnail failed: ' + r.status);
        thumbCache.set(m.key, Buffer.from(await r.arrayBuffer()));
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600' });
      res.end(thumbCache.get(m.key));
      return;
    }
    if (url.pathname === '/api/snapshot') {
      // Issue のスナップショット画像：snapshotUrn（OSS オブジェクト）→ 署名付き S3 URL 経由で取得（旧 OSS 直 GET は廃止済み）
      const urn = url.searchParams.get('urn') ?? '';
      const prefix = 'urn:adsk.objects:os.object:';
      if (!urn.startsWith(prefix)) { res.writeHead(404); res.end('no snapshot'); return; }
      if (!snapCache.has(urn)) {
        const rest = urn.slice(prefix.length);
        const slash = rest.indexOf('/');
        const bucket = rest.slice(0, slash), object = rest.slice(slash + 1);
        const t = await getToken3();
        const sr = await fetch(`${BASE}/oss/v2/buckets/${bucket}/objects/${encodeURIComponent(object)}/signeds3download`, { headers: { Authorization: 'Bearer ' + t } });
        if (!sr.ok) throw new Error('snapshot sign failed: ' + sr.status);
        const signed = (await sr.json()).url;
        const r = await fetch(signed);
        if (!r.ok) throw new Error('snapshot download failed: ' + r.status);
        const s3type = r.headers.get('content-type') ?? '';
        const type = s3type.startsWith('image/') ? s3type : (object.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg');
        snapCache.set(urn, { buf: Buffer.from(await r.arrayBuffer()), type });
      }
      const c = snapCache.get(urn);
      res.writeHead(200, { 'Content-Type': c.type, 'Cache-Control': 'max-age=3600' });
      res.end(c.buf);
      return;
    }
    if (url.pathname === '/api/issues/update' && req.method === 'POST') {
      // 実 Issue の編集（Issues API へ PATCH を中継する）
      const body = JSON.parse(await new Promise((resolve, reject) => {
        let d = ''; req.on('data', c => { d += c; }); req.on('end', () => resolve(d)); req.on('error', reject);
      }));
      const allow = ['title', 'description', 'status', 'dueDate'];
      const patch = {};
      for (const k of allow) if (body.patch && k in body.patch) patch[k] = body.patch[k];
      if (!body.id || !Object.keys(patch).length) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'id and patch required' })); return; }
      const t = await getToken3();
      const pid = models[0].projectId.replace(/^b\./, '');
      const r = await fetch(`${BASE}/construction/issues/v1/projects/${pid}/issues/${body.id}`, {
        method: 'PATCH', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      const j = await r.json().catch(() => null);
      res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(j ?? { error: 'empty response' }));
      return;
    }
    if (url.pathname === '/api/issues') {
      const issues = await fetchIssues();
      const vers = await Promise.all(models.map(getModelVersion));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        models: models.map((m, i) => ({ key: m.key, name: m.name, short: m.short, version: vers[i].versionNumber, urn: m.derivativeUrn, guid: m.viewableGuid, bounds: m.bounds })),
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
