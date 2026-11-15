// server.mjs — sample-d v4: 実 Issue（APS Issues API）+ 要素情報の自動付与 + キャッシュ方式の部分 3D 表示
// 起動: node server.mjs（.env に APS_CLIENT_ID / APS_CLIENT_SECRET、.token.json に 3-legged トークンが必要）
//
// キャッシュ設計（モデルバージョンがキー）:
//   L1: SVF リソースを cache/svf-v{version}/ に保存し、再ダウンロードを避ける
//   L2: 変換済み GLB を cache/glb/model-v{version}.glb に保存し、再変換を避ける
//   L3: ブラウザ側 Cache API（public/index.html が version 付きキーで保持し、再転送を避ける）
// モデルの tip バージョンが変わったら全層が自動で作り直される。起動時にバックグラウンドで事前生成（プリウォーム）する。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLTFWriter } from 'svf-utils';
import { NodeIO } from '@gltf-transform/core';
import { quantize } from '@gltf-transform/functions';
import { createFetchReader, getToken } from './lib/fetch-reader.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(root, 'public');
const cacheRoot = path.join(root, 'cache');
const env = {};
for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const model = JSON.parse(fs.readFileSync(path.join(root, 'data', 'model.json'), 'utf8'));
const propsIndex = JSON.parse(fs.readFileSync(path.join(root, 'data', 'props-index.json'), 'utf8'));
const ext2dbid = JSON.parse(fs.readFileSync(path.join(root, 'data', 'ext2dbid.json'), 'utf8'));
const bboxIndex = JSON.parse(fs.readFileSync(path.join(root, 'data', 'bbox-index.json'), 'utf8'));
const bboxDbIds = Object.keys(bboxIndex).map(Number);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png' };
const BASE = 'https://developer.api.autodesk.com';

// ---- 3-legged トークン（Issues API 用。refresh token を .token.json に保持し、ローテーションに追随する） ----
const TOKFILE = path.join(root, '.token.json');
let tok3 = JSON.parse(fs.readFileSync(TOKFILE, 'utf8'));
async function getToken3() {
  if (Date.now() - (tok3.obtained_at ?? 0) < 45 * 60000) return tok3.access_token;
  const r = await fetch(BASE + '/authentication/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(env.APS_CLIENT_ID + ':' + env.APS_CLIENT_SECRET).toString('base64') },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok3.refresh_token }),
  });
  if (!r.ok) throw new Error('3-legged refresh failed: ' + r.status);
  tok3 = { ...(await r.json()), obtained_at: Date.now() };
  fs.writeFileSync(TOKFILE, JSON.stringify(tok3, null, 1));
  return tok3.access_token;
}

// ---- モデルの tip バージョン（キャッシュキー） ----
let versionCache = { at: 0, value: null };
async function getModelVersion() {
  if (Date.now() - versionCache.at < 60000 && versionCache.value) return versionCache.value;
  const token = await getToken(env);
  const r = await fetch(`${BASE}/data/v1/projects/${model.projectId}/items/${encodeURIComponent(model.lineage)}/versions`, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error('versions fetch failed: ' + r.status);
  const j = await r.json();
  const tip = j.data?.[0];
  const value = { versionNumber: tip?.attributes?.versionNumber ?? 1, versionId: tip?.id ?? model.versionId };
  versionCache = { at: Date.now(), value };
  return value;
}

// ---- GLB 生成（L1 SVF キャッシュ + L2 GLB キャッシュ） ----
const glbState = { phase: 'idle', version: null, startedAt: null, timings: null, error: null };
let glbChain = Promise.resolve();
function glbPath(v) { return path.join(cacheRoot, 'glb', `model-v${v}.glb`); }
async function generateGlb(v) {
  const token = await getToken(env);
  let t = performance.now();
  const reader = await createFetchReader({ urn: model.derivativeUrn, guid: model.viewableGuid, token, cacheDir: path.join(cacheRoot, `svf-v${v}`) });
  const scene = await reader.read();
  const readMs = performance.now() - t;
  t = performance.now();
  const keep = new Set(bboxDbIds);
  const writer = new GLTFWriter({ filter: (dbid) => keep.has(dbid), ignoreLineGeometry: true, ignorePointGeometry: true, maxBufferSize: 1 << 29, deduplicate: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glb-'));
  try {
    await writer.write(scene, tmp);
    const writeMs = performance.now() - t;
    t = performance.now();
    const gltfPath = path.join(tmp, 'output.gltf');
    const gltf = JSON.parse(fs.readFileSync(gltfPath, 'utf8'));
    delete gltf.images; delete gltf.textures; delete gltf.samplers;
    for (const m of gltf.materials ?? []) {
      if (m.pbrMetallicRoughness) { delete m.pbrMetallicRoughness.baseColorTexture; delete m.pbrMetallicRoughness.metallicRoughnessTexture; }
      delete m.normalTexture; delete m.occlusionTexture; delete m.emissiveTexture;
    }
    fs.writeFileSync(gltfPath, JSON.stringify(gltf));
    const io = new NodeIO();
    const doc = await io.read(gltfPath);
    await doc.transform(quantize());
    const bytes = await io.writeBinary(doc);
    fs.mkdirSync(path.join(cacheRoot, 'glb'), { recursive: true });
    fs.writeFileSync(glbPath(v), bytes);
    return { bytes: bytes.length, readMs, writeMs, packMs: performance.now() - t };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
function ensureGlb(v) {
  if (fs.existsSync(glbPath(v))) { glbState.phase = 'ready'; glbState.version = v; return Promise.resolve(true); }
  if (glbState.phase === 'generating' && glbState.version === v) return glbChain;
  glbState.phase = 'generating'; glbState.version = v; glbState.startedAt = Date.now(); glbState.error = null;
  const job = generateGlb(v).then((timings) => { glbState.phase = 'ready'; glbState.timings = timings; console.log('GLB ready v' + v, timings); })
    .catch((e) => { glbState.phase = 'error'; glbState.error = String(e?.message ?? e); console.error('GLB generation failed:', e); });
  glbChain = job;
  return job;
}

// ---- Issue の要素情報付与 ----
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
    createdAt: issue.createdAt, pin: null, element: null, targetDbId: null, candidates: null,
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
  const tb = bboxIndex[String(dbId)];
  if (tb) {
    const center = [(tb[0] + tb[3]) / 2, (tb[1] + tb[4]) / 2, (tb[2] + tb[5]) / 2];
    out.candidates = bboxDbIds
      .map((id) => ({ dbId: id, dist: distToBox(bboxIndex[String(id)], center) }))
      .sort((a, b) => a.dist - b.dist)
      .map((c) => c.dbId);
  }
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
      const r = await fetch(BASE + '/authentication/v2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(env.APS_CLIENT_ID + ':' + env.APS_CLIENT_SECRET).toString('base64') },
        body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'viewables:read data:read' }),
      });
      const j = await r.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: j.access_token, expires_in: j.expires_in }));
      return;
    }
    if (url.pathname === '/api/issues') {
      const [issues, ver] = await Promise.all([fetchIssues(), getModelVersion()]);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ model: { name: model.itemName, lineage: model.lineage, version: ver.versionNumber, urn: model.derivativeUrn, guid: model.viewableGuid }, issues, fetchedAt: new Date().toISOString() }));
      return;
    }
    if (url.pathname === '/api/glb/status') {
      const ver = await getModelVersion();
      const ready = fs.existsSync(glbPath(ver.versionNumber));
      if (ready && glbState.version !== ver.versionNumber) { glbState.phase = 'ready'; glbState.version = ver.versionNumber; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        version: ver.versionNumber, phase: ready ? 'ready' : glbState.phase,
        glbBytes: ready ? fs.statSync(glbPath(ver.versionNumber)).size : null,
        startedAt: glbState.startedAt, timings: glbState.timings, error: glbState.error,
      }));
      return;
    }
    if (url.pathname === '/api/glb') {
      const ver = await getModelVersion();
      if (!fs.existsSync(glbPath(ver.versionNumber))) {
        ensureGlb(ver.versionNumber);
        res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'generating', version: ver.versionNumber }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'X-Model-Version': String(ver.versionNumber), 'Cache-Control': 'no-store' });
      fs.createReadStream(glbPath(ver.versionNumber)).pipe(res);
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
server.listen(port, async () => {
  console.log(`sample-d v4 server: http://localhost:${port}`);
  try {
    const ver = await getModelVersion();
    console.log('model version:', ver.versionNumber);
    ensureGlb(ver.versionNumber); // プリウォーム（バックグラウンド）
  } catch (e) { console.error('prewarm check failed:', e); }
});
