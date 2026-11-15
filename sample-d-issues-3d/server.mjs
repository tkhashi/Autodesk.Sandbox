// server.mjs — sample-d: 実 Issue（APS Issues API）+ 要素情報の自動付与 + Forma 風 UI + APS Viewer 表示
// 起動: node server.mjs（.env に APS_CLIENT_ID / APS_CLIENT_SECRET、.token.json に 3-legged トークンが必要）
//
// 対象モデルは data/models.json の登録簿（5モデル）。要素情報の索引（プロパティ／externalId→dbId 対応）は
// 事前生成せず、起動後に Model Derivative API から非同期に構築する（cache/ に派生キャッシュを残し、
// モデルのバージョンが変わったら作り直す）。サーバーは索引の完成を待たずに即座に起動する。
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
const indexCacheDir = path.join(root, 'cache');
fs.mkdirSync(indexCacheDir, { recursive: true });
for (const m of models) {
  m.propsIndex = null; m.ext2dbid = null; m.indexStatus = 'idle'; m.indexError = null; m.indexVersionId = null;
  // 派生キャッシュ（前回 API から構築した索引）があれば即座に使う。無ければ起動後に非同期で構築する
  try {
    const c = JSON.parse(fs.readFileSync(path.join(indexCacheDir, 'index-' + m.key + '.json'), 'utf8'));
    if (c?.propsIndex && c?.ext2dbid) {
      m.propsIndex = c.propsIndex; m.ext2dbid = c.ext2dbid;
      m.indexVersionId = c.versionId ?? null; m.indexStatus = 'ready';
    }
  } catch (e) {}
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

// ---- 要素索引の動的構築（Model Derivative API から非同期に作る。事前の JSON 生成は不要） ----
let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch (e) {}
async function getPoll2(url, token, label) {
  const H = { Authorization: 'Bearer ' + token };
  for (let i = 0; i < 120; i++) {
    const r = await fetch(url, { headers: H });
    if (r.status === 200) return r.json();
    if (r.status !== 202) throw new Error(label + ' status ' + r.status);
    await new Promise(s => setTimeout(s, 3000));
  }
  throw new Error(label + ' timeout');
}
async function buildIndex(m) {
  if (m.indexStatus === 'building') return;
  m.indexStatus = 'building'; m.indexError = null;
  const t0 = Date.now();
  try {
    if (!DatabaseSync) throw new Error('node:sqlite が使えません（Node 22.5+ が必要です）');
    const token = (await getToken2()).access_token;
    const H = { Authorization: 'Bearer ' + token };
    // プロパティ一式 → externalId → プロパティ（平坦化）
    const props = await getPoll2(`${BASE}/modelderivative/v2/designdata/${m.derivativeUrn}/metadata/${m.viewableGuid}/properties?forceget=true`, token, 'properties');
    const propsIndex = {};
    for (const o of props.data?.collection ?? []) {
      if (!o.externalId) continue;
      const entry = { name: o.name, revitId: o.name?.match(/\[(\d+)\]\s*$/)?.[1] ?? null, objectid: o.objectid };
      for (const g of Object.values(o.properties ?? {})) for (const [k, v] of Object.entries(g)) {
        if (!k.startsWith('_') && entry[k] === undefined) entry[k] = v;
      }
      propsIndex[o.externalId] = entry;
    }
    // model.sdb（変換データ同梱のプロパティ DB）→ externalId → Viewer の dbId
    const sdbUrn = `urn:adsk.viewing:fs.file:${m.derivativeUrn}/output/Resource/model.sdb`;
    const sr = await fetch(`${BASE}/modelderivative/v2/designdata/${m.derivativeUrn}/manifest/${encodeURIComponent(sdbUrn)}`, { headers: H });
    if (!sr.ok) throw new Error('sdb status ' + sr.status);
    const sdbPath = path.join(indexCacheDir, 'tmp-' + m.key + '.sdb');
    fs.writeFileSync(sdbPath, Buffer.from(await sr.arrayBuffer()));
    const db = new DatabaseSync(sdbPath);
    const ext2dbid = {};
    for (const row of db.prepare('SELECT id, external_id FROM _objects_id').all()) ext2dbid[row.external_id] = row.id;
    db.close();
    fs.rmSync(sdbPath, { force: true });
    m.propsIndex = propsIndex; m.ext2dbid = ext2dbid; m.indexStatus = 'ready';
    const ver = await getModelVersion(m).catch(() => null);
    m.indexVersionId = ver?.versionId ?? null;
    fs.writeFileSync(path.join(indexCacheDir, 'index-' + m.key + '.json'), JSON.stringify({ versionId: m.indexVersionId, builtAt: new Date().toISOString(), propsIndex, ext2dbid }));
    console.log(`index built: ${m.key} (props ${Object.keys(propsIndex).length}, map ${Object.keys(ext2dbid).length}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    m.indexStatus = 'error'; m.indexError = String(e?.message ?? e);
    console.error('index build failed:', m.key, e);
  }
}
function initIndexes() {
  for (const m of models) {
    if (m.indexStatus === 'ready') {
      // キャッシュ使用中でも、モデルのバージョンが変わっていたら作り直す
      getModelVersion(m).then(ver => {
        if (ver?.versionId && m.indexVersionId && ver.versionId !== m.indexVersionId) buildIndex(m);
      }).catch(() => {});
    } else {
      buildIndex(m);
    }
  }
}
// ---- Issue タイプ（subtypeId → 親タイプ名／subtype名／コード）とプロジェクトメンバー（autodeskId → 名前） ----
let typesCache = null, usersCache = null;
async function getIssueTypes(token, pid) {
  if (typesCache) return typesCache;
  try {
    const r = await fetch(`${BASE}/construction/issues/v1/projects/${pid}/issue-types?include=subtypes`, { headers: { Authorization: 'Bearer ' + token } });
    const j = await r.json();
    const map = new Map();
    for (const t of j.results ?? []) for (const s of t.subtypes ?? []) {
      map.set(s.id, { typeTitle: t.title, subtypeTitle: s.title, code: s.code ?? null });
    }
    typesCache = map;
  } catch (e) { typesCache = new Map(); }
  return typesCache;
}
async function getProjectUsers(token, pidB) {
  if (usersCache) return usersCache;
  try {
    const r = await fetch(`${BASE}/construction/admin/v1/projects/${pidB}/users?limit=200`, { headers: { Authorization: 'Bearer ' + token } });
    const j = await r.json();
    const map = new Map();
    for (const u of j.results ?? []) if (u.autodeskId) map.set(u.autodeskId, u.name ?? null);
    usersCache = map;
  } catch (e) { usersCache = new Map(); }
  return usersCache;
}

function enrich(issue, types, users) {
  const st = issue.issueSubtypeId ? types?.get(issue.issueSubtypeId) ?? null : null;
  const out = {
    id: issue.id, displayId: issue.displayId, title: issue.title, description: issue.description,
    status: issue.status, dueDate: issue.dueDate, startDate: issue.startDate ?? null,
    assignedTo: issue.assignedTo, assignedToName: issue.assignedTo ? (users?.get(issue.assignedTo) ?? null) : null,
    watcherNames: (issue.watchers ?? []).map(w => users?.get(w) ?? w),
    published: issue.published,
    typeLabel: st ? `${st.typeTitle} > ${st.subtypeTitle}` : null,
    typeCode: st?.code ?? null,
    createdAt: issue.createdAt, openedBy: issue.openedBy, openedAt: issue.openedAt, createdBy: issue.createdBy,
    snapshotUrn: issue.snapshotUrn ?? null, snapshotHasMarkups: issue.snapshotHasMarkups ?? false,
    permittedStatuses: issue.permittedStatuses ?? null, customAttributes: issue.customAttributes ?? [],
    attachmentCount: issue.attachmentCount ?? 0, commentCount: issue.commentCount ?? 0,
    pin: null, element: null, targetDbId: null, targetBbox: null,
    contextDbIds: null, modelKey: null, modelName: null, modelFullName: null,
  };
  const ld = (issue.linkedDocuments ?? [])[0];
  if (!ld) return out;
  const d = ld.details ?? {};
  out.pin = { modelUrn: ld.urn, viewName: d.viewable?.name ?? null, objectId: d.objectId ?? null, externalId: d.externalId ?? null, position: d.position ?? null };
  const m = models.find(x => x.lineage === ld.urn);
  if (!m || !d.externalId) return out;
  out.modelKey = m.key;
  out.modelName = m.short;
  out.modelFullName = m.name;
  if (!m.ext2dbid || !m.propsIndex) return out; // 索引を構築中（または失敗）のモデルは、付与なしで返す
  const dbId = m.ext2dbid[d.externalId];
  if (dbId === undefined) return out;
  out.targetDbId = dbId;
  out.element = m.propsIndex[d.externalId] ?? null;
  return out;
}
async function fetchIssues() {
  const token = await getToken3();
  const pid = models[0].projectId.replace(/^b\./, '');
  const [r, types, users] = await Promise.all([
    fetch(`${BASE}/construction/issues/v1/projects/${pid}/issues?limit=50`, { headers: { Authorization: 'Bearer ' + token } }),
    getIssueTypes(token, pid),
    getProjectUsers(token, models[0].projectId),
  ]);
  if (!r.ok) throw new Error('issues fetch failed: ' + r.status);
  const j = await r.json();
  return (j.results ?? []).filter((i) => !i.deleted).map(i => enrich(i, types, users));
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
        models: models.map((m, i) => ({ key: m.key, name: m.name, short: m.short, version: vers[i].versionNumber, urn: m.derivativeUrn, guid: m.viewableGuid, indexStatus: m.indexStatus })),
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
initIndexes(); // 索引の非同期構築を開始（サーバーは待たずに起動する）
server.listen(port, () => { console.log(`sample-d server: http://localhost:${port}`); });
