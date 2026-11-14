// extract-subsets.mjs — Issue ごとの部分ジオメトリ（対象＋周辺）を SVF から切り出して GLB 化する
//
// 前提:
//   - ../.env に APS_CLIENT_ID / APS_CLIENT_SECRET（sample-a と同じ）
//   - ../elements.json に sample-c 形式の要素データ（issueRef -> { objectid, externalId, ... }）
//   - このフォルダで npm install（svf-utils, @gltf-transform/core）
// 使い方: node extract-subsets.mjs [モデルURN] [ビューGUID]
//   既定値は Snowdon Towers 構造モデル（Structure Only ビュー）
//
// 処理: ①プロパティDB(model.sdb)をダウンロードし externalId -> 変換側 dbId の対応表を作る
//       ②フラグメントのバウンディングボックスから「周辺」要素（拡張bboxに交差・近い順・最大60件）を選ぶ
//       ③svf-utils の glTF 変換（dbId フィルタ）で対象／周辺を別々に書き出し GLB 化する
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { SVFReader, GLTFWriter, TwoLeggedAuthenticationProvider } from 'svf-utils';
import { NodeIO } from '@gltf-transform/core';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, '..');
const OUT = path.join(appRoot, 'public/assets/subsets');
fs.mkdirSync(OUT, { recursive: true });
const env = {};
for (const line of fs.readFileSync(path.join(appRoot, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const URN = process.argv[2] ?? 'dXJuOmFkc2sud2lwcHJvZDpmcy5maWxlOnZmLlpSRjFpamFyWFJTN1gzbWk3QllpRmc_dmVyc2lvbj0x';
const GUID = process.argv[3] ?? '0caacd2f-a9c4-7da9-8b99-d5762178b1de';
const elements = JSON.parse(fs.readFileSync(path.join(appRoot, 'elements.json'), 'utf8'));
const BASE = 'https://developer.api.autodesk.com';
const tokRes = await fetch(BASE + '/authentication/v2/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(env.APS_CLIENT_ID + ':' + env.APS_CLIENT_SECRET).toString('base64') },
  body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'data:read' }),
});
const token = (await tokRes.json()).access_token;

// 1) model.sdb を取得して externalId -> dbId 対応表を作る
const sdbUrn = `urn:adsk.viewing:fs.file:${URN}/output/Resource/model.sdb`;
const sdbRes = await fetch(`${BASE}/modelderivative/v2/designdata/${URN}/manifest/${encodeURIComponent(sdbUrn)}`, { headers: { Authorization: 'Bearer ' + token } });
if (!sdbRes.ok) throw new Error('model.sdb download failed: ' + sdbRes.status);
const sdbPath = path.join(here, 'model.sdb');
fs.writeFileSync(sdbPath, Buffer.from(await sdbRes.arrayBuffer()));
const db = new DatabaseSync(sdbPath);
const idmap = new Map();
for (const row of db.prepare('SELECT id, external_id FROM _objects_id').all()) idmap.set(row.external_id, row.id);
db.close();

// 2) フラグメントから dbId -> バウンディングボックス
const auth = new TwoLeggedAuthenticationProvider(env.APS_CLIENT_ID, env.APS_CLIENT_SECRET);
const reader = await SVFReader.FromDerivativeService(URN, GUID, auth);
const bbox = new Map();
for await (const frag of reader.enumerateFragments()) {
  if (!frag.bbox) continue;
  const cur = bbox.get(frag.dbID);
  if (!cur) bbox.set(frag.dbID, [...frag.bbox]);
  else for (let i = 0; i < 3; i++) { cur[i] = Math.min(cur[i], frag.bbox[i]); cur[i + 3] = Math.max(cur[i + 3], frag.bbox[i + 3]); }
}
function distToBox(b, t) {
  const d = [0, 1, 2].map(i => Math.max(t[i] - b[i + 3], b[i] - t[i + 3], 0));
  return Math.hypot(...d);
}
function neighborsOf(targetId) {
  const t = bbox.get(targetId);
  const exp = [t[0] - 10, t[1] - 10, t[2] - 6, t[3] + 10, t[4] + 10, t[5] + 6];
  const cand = [];
  for (const [id, b] of bbox) {
    if (id === targetId) continue;
    if (b[0] > exp[3] || b[3] < exp[0] || b[1] > exp[4] || b[4] < exp[1] || b[2] > exp[5] || b[5] < exp[2]) continue;
    cand.push([distToBox(b, t), id]);
  }
  cand.sort((a, b) => a[0] - b[0]);
  return cand.slice(0, 60).map(c => c[1]);
}

// 3) シーンを読んで Issue ごとに書き出す
const scene = await reader.read();
const io = new NodeIO();
const result = {};
for (const [iid, e] of Object.entries(elements)) {
  const targetId = idmap.get(e.externalId);
  if (targetId === undefined) { console.log(iid, 'skip: externalId not in sdb'); continue; }
  const neigh = neighborsOf(targetId);
  result[iid] = { targetDbId: targetId, neighborDbIds: neigh };
  for (const [label, ids] of [['target', [targetId]], ['neighbors', neigh]]) {
    const set = new Set(ids);
    const writer = new GLTFWriter({ filter: (dbid) => set.has(dbid), ignoreLineGeometry: true, ignorePointGeometry: true });
    const tmp = path.join(here, `tmp-${iid}-${label}`);
    await writer.write(scene, tmp);
    const doc = await io.read(path.join(tmp, 'output.gltf'));
    const glbPath = path.join(OUT, `${iid}-${label}.glb`);
    fs.writeFileSync(glbPath, await io.writeBinary(doc));
    result[iid][label + 'Glb'] = `assets/subsets/${iid}-${label}.glb`;
    result[iid][label + 'Bytes'] = fs.statSync(glbPath).size;
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(iid, label, ids.length, 'elements ->', result[iid][label + 'Bytes'], 'bytes');
  }
}
fs.writeFileSync(path.join(OUT, 'subsets.json'), JSON.stringify(result, null, 1));
console.log('written', path.join(OUT, 'subsets.json'));
