// build-subsets.mjs — 先行表示用サブセット GLB の生成（モデルのバージョンが変わったら再実行）
// 各 Issue について「対象＋周辺（距離が近い順に最大131要素）」を切り出し、
// 対象／周辺の2マテリアルに結合して Draco 圧縮し、public/subsets/{issueId}.glb に置く。
// 必要物: ../.env と ../.token.json（Issues 取得に 3-legged、SVF 読込に 2-legged）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLTFWriter } from 'svf-utils';
import { NodeIO } from '@gltf-transform/core';
import { quantize, join, draco } from '@gltf-transform/functions';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import { createFetchReader, getToken, stats } from './fetch-reader.mjs';

const APP = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const env = Object.fromEntries(fs.readFileSync(path.join(APP, '.env'), 'utf8').split('\n').filter(l => l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const models = JSON.parse(fs.readFileSync(path.join(APP, 'data/models.json'), 'utf8'));
for (const m of models) {
  m.ext2dbid = JSON.parse(fs.readFileSync(path.join(APP, 'data', m.key, 'ext2dbid.json'), 'utf8'));
  m.bboxIndex = JSON.parse(fs.readFileSync(path.join(APP, 'data', m.key, 'bbox-index.json'), 'utf8'));
  m.categoryIndex = JSON.parse(fs.readFileSync(path.join(APP, 'data', m.key, 'category-index.json'), 'utf8'));
}
// 部材の種別（Revit カテゴリ）ごとの色分け。対象要素は常に橙。
const CATS = [
  [/Structural Columns/, 'columns', '構造柱', [0.18, 0.44, 0.82]],
  [/Structural Framing/, 'framing', '構造梁', [0.21, 0.63, 0.31]],
  [/Structural Foundations/, 'foundations', '基礎', [0.56, 0.27, 0.68]],
  [/Structural Rebar/, 'rebar', '鉄筋', [0.69, 0.19, 0.19]],
  [/Curtain Panels/, 'curtain-panels', 'カーテンパネル', [0.15, 0.65, 0.60]],
  [/Curtain Wall Mullions/, 'mullions', '方立', [0.00, 0.51, 0.56]],
  [/Walls/, 'walls', '壁', [0.91, 0.73, 0.24]],
  [/Floors/, 'floors', '床・スラブ', [0.39, 0.71, 0.96]],
  [/Roofs/, 'roofs', '屋根', [0.69, 0.48, 0.27]],
  [/Windows/, 'windows', '窓', [0.30, 0.82, 0.88]],
  [/Doors/, 'doors', '建具', [0.94, 0.33, 0.31]],
  [/Ceilings/, 'ceilings', '天井', [0.86, 0.91, 0.46]],
  [/Furniture/, 'furniture', '家具', [0.63, 0.53, 0.50]],
  [/Stairs/, 'stairs', '階段', [0.94, 0.38, 0.57]],
  [/Generic Models/, 'generic', '一般モデル', [0.73, 0.41, 0.78]],
];
function catOf(raw) {
  for (const [re, key, label, color] of CATS) if (re.test(raw ?? '')) return { key, label, color };
  return { key: 'other', label: 'その他', color: [0.66, 0.66, 0.66] };
}
const BASE = 'https://developer.api.autodesk.com';
const basic = 'Basic ' + Buffer.from(env.APS_CLIENT_ID + ':' + env.APS_CLIENT_SECRET).toString('base64');
// 3-legged（Issues 取得）
const TOKFILE = path.join(APP, '.token.json');
let tok3 = JSON.parse(fs.readFileSync(TOKFILE, 'utf8'));
if (Date.now() - (tok3.obtained_at ?? 0) > 45 * 60000) {
  const r = await fetch(BASE + '/authentication/v2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basic }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok3.refresh_token }) });
  tok3 = { ...(await r.json()), obtained_at: Date.now() };
  fs.writeFileSync(TOKFILE, JSON.stringify(tok3, null, 1));
}
const pid = models[0].projectId.replace(/^b\./, '');
const ij = await (await fetch(`${BASE}/construction/issues/v1/projects/${pid}/issues?limit=50`, { headers: { Authorization: 'Bearer ' + tok3.access_token } })).json();
const targets = [];
for (const issue of (ij.results ?? []).filter(i => !i.deleted)) {
  const ld = (issue.linkedDocuments ?? [])[0];
  const m = ld && models.find(x => x.lineage === ld.urn);
  const ext = ld?.details?.externalId;
  if (!m || !ext || m.ext2dbid[ext] === undefined) continue;
  targets.push({ issueId: issue.id, displayId: issue.displayId, model: m, targetDbId: m.ext2dbid[ext] });
}
console.log('subset targets:', targets.map(t => '#' + t.displayId + '(' + t.model.key + ')').join(' '));
const dracoEncoder = await draco3d.createEncoderModule({});
const token2 = await getToken(env);
const outDir = path.join(APP, 'public/subsets');
fs.mkdirSync(outDir, { recursive: true });
const index = {};
const MAX_CONTEXT = 131;
function distToBox(b, p) { const dx = Math.max(b[0] - p[0], 0, p[0] - b[3]); const dy = Math.max(b[1] - p[1], 0, p[1] - b[4]); const dz = Math.max(b[2] - p[2], 0, p[2] - b[5]); return Math.hypot(dx, dy, dz); }
for (const m of models) {
  const mine = targets.filter(t => t.model === m);
  if (!mine.length) continue;
  stats.bytes = 0; stats.files = 0;
  const t0 = performance.now();
  const reader = await createFetchReader({ urn: m.derivativeUrn, guid: m.viewableGuid, token: token2 });
  const scene = await reader.read();
  console.log(`${m.key}: SVF read ${((performance.now() - t0) / 1000).toFixed(1)}s, downloaded ${(stats.bytes / 1048576).toFixed(1)}MB / ${stats.files} files`);
  for (const t of mine) {
    const tb = m.bboxIndex[String(t.targetDbId)];
    const c = [(tb[0] + tb[3]) / 2, (tb[1] + tb[4]) / 2, (tb[2] + tb[5]) / 2];
    const ids = Object.keys(m.bboxIndex).map(Number)
      .map(id => ({ id, d: id === t.targetDbId ? -1 : distToBox(m.bboxIndex[String(id)], c) }))
      .sort((a, b) => a.d - b.d).slice(0, MAX_CONTEXT).map(x => x.id);
    const keep = new Set(ids);
    const writer = new GLTFWriter({ filter: (dbid) => keep.has(dbid), ignoreLineGeometry: true, ignorePointGeometry: true, maxBufferSize: 1 << 29, deduplicate: true });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'subset-'));
    try {
      await writer.write(scene, tmp);
      const gltfPath = path.join(tmp, 'output.gltf');
      const gltf = JSON.parse(fs.readFileSync(gltfPath, 'utf8'));
      delete gltf.images; delete gltf.textures; delete gltf.samplers;
      for (const mt of gltf.materials ?? []) { if (mt.pbrMetallicRoughness) { delete mt.pbrMetallicRoughness.baseColorTexture; delete mt.pbrMetallicRoughness.metallicRoughnessTexture; } delete mt.normalTexture; delete mt.occlusionTexture; delete mt.emissiveTexture; }
      fs.writeFileSync(gltfPath, JSON.stringify(gltf));
      const io = new NodeIO().registerExtensions([KHRDracoMeshCompression]).registerDependencies({ 'draco3d.encoder': dracoEncoder });
      const doc = await io.read(gltfPath);
      await doc.transform(quantize());
      const targetMat = doc.createMaterial('target').setBaseColorFactor([1, 0.32, 0.05, 1]);
      const catMats = new Map();
      const usedCats = new Map();
      const matFor = (dbid) => {
        const c = catOf(m.categoryIndex[String(dbid)]);
        usedCats.set(c.key, c);
        if (!catMats.has(c.key)) catMats.set(c.key, doc.createMaterial('cat:' + c.key).setBaseColorFactor([...c.color, 1]));
        return catMats.get(c.key);
      };
      for (const node of doc.getRoot().listNodes()) {
        const mesh = node.getMesh(); if (!mesh) continue;
        const mm = /^(\d+)/.exec(node.getName() ?? '');
        const dbid = mm ? Number(mm[1]) : -1;
        const mat = dbid === t.targetDbId ? targetMat : matFor(dbid);
        for (const prim of mesh.listPrimitives()) prim.setMaterial(mat);
      }
      await doc.transform(join());
      await doc.transform(draco());
      const bytes = await io.writeBinary(doc);
      fs.writeFileSync(path.join(outDir, t.issueId + '.glb'), bytes);
      index[t.issueId] = { displayId: t.displayId, modelKey: m.key, bytes: bytes.length, elems: ids.length,
        cats: [...usedCats.values()].map(c => ({ key: c.key, label: c.label, color: '#' + c.color.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('') })) };
      console.log(`  #${t.displayId}: ${ids.length} elems -> ${(bytes.length / 1024).toFixed(0)}KB`);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
}
fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 1));
console.log('done:', Object.keys(index).length, 'subsets');
