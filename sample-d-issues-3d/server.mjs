// server.mjs — 静的配信 + /api/token（APS 2-legged） + /api/issues + /api/convert（都度変換）
// .env に APS_CLIENT_ID / APS_CLIENT_SECRET が必要（sample-a と同じもの）。
// /api/convert は「事前変換なし」の速度を測るため、キャッシュせず毎回フル変換する:
//   Autodesk から SVF をダウンロード → パース → 全要素を glTF 化 → GLB 化。
// 段階ごとの所要時間はレスポンスヘッダ（X-Read-Ms / X-Write-Ms / X-Pack-Ms）で返す。
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
const env = {};
for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const modelData = JSON.parse(fs.readFileSync(path.join(root, 'model-data.json'), 'utf8'));
const keepSet = new Set();
for (const iss of modelData.issues) {
  keepSet.add(iss.targetDbId);
  for (const c of iss.candidates) keepSet.add(c.dbId);
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png' };

// 変換はメモリを大きく使うため直列化する（同時実行はしない）
let convertChain = Promise.resolve();
function runConvert() {
  const job = async () => {
    const token = await getToken(env);
    let t = performance.now();
    const reader = await createFetchReader({ urn: modelData.model.urn, guid: modelData.model.guid, token });
    const scene = await reader.read();
    const readMs = performance.now() - t;
    t = performance.now();
    const writer = new GLTFWriter({ filter: (dbid) => keepSet.has(dbid), ignoreLineGeometry: true, ignorePointGeometry: true, maxBufferSize: 1 << 29, deduplicate: true });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'subset-'));
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
      const packMs = performance.now() - t;
      return { bytes, readMs, writeMs, packMs };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
  const result = convertChain.then(job, job);
  convertChain = result.catch(() => {});
  return result;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/token') {
    try {
      const r = await fetch('https://developer.api.autodesk.com/authentication/v2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(env.APS_CLIENT_ID + ':' + env.APS_CLIENT_SECRET).toString('base64') },
        body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'viewables:read data:read' }),
      });
      const j = await r.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: j.access_token, expires_in: j.expires_in }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }
  if (url.pathname === '/api/issues') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(modelData));
    return;
  }
  if (url.pathname === '/api/convert') {
    try {
      const { bytes, readMs, writeMs, packMs } = await runConvert();
      res.writeHead(200, {
        'Content-Type': 'model/gltf-binary',
        'X-Read-Ms': String(Math.round(readMs)),
        'X-Write-Ms': String(Math.round(writeMs)),
        'X-Pack-Ms': String(Math.round(packMs)),
      });
      res.end(bytes);
    } catch (e) {
      console.error('convert failed:', e);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String(e?.message ?? e) }));
    }
    return;
  }
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
  const file = path.join(pub, rel);
  if (!file.startsWith(pub) || !fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
const port = process.env.PORT ?? 3000;
server.listen(port, () => console.log(`sample-d server: http://localhost:${port}`));
