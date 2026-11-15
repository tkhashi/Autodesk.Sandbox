// build-model-data.mjs — モデルから model-data.json（Issue定義＋全要素の距離データ）を生成する
//
// 前提:
//   - ../.env に APS_CLIENT_ID / APS_CLIENT_SECRET
//   - このフォルダで npm install（svf-utils）
//   - 対象モデルは Forma（ACC）にアップロード済みで変換完了していること
// 使い方: node build-model-data.mjs <DMのlineage ID> <プロジェクトID(b.付き)>
// 処理: ①tip バージョンから derivative URN を得る ②メタデータ／プロパティ／オブジェクトツリー取得
//       ③model.sdb で externalId -> 変換側 dbId の対応表を作る ④SVF フラグメントから bbox 索引を作る
//       ⑤下記 ISSUES の対象要素ごとに、全要素との距離（近い順）を計算して ../model-data.json に書く
// Issue の対象要素は Revit ID で指定する。対象モデルを差し替えたら ISSUES を編集すること。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createFetchReader, getToken } from '../lib/fetch-reader.mjs';

const ISSUES = [
  { id: 'ISSUE-001', revitId: '4192228', title: '木柱のほぞ接合部、差し込み量の確認', status: '対応中', type: '品質', assignee: '木工事・大工班 佐藤', due: '2026-11-20', elemName: 'Tragwerkstütze Holz（木柱）', typeName: '100x100', loc: '通り芯 A(1)-1' },
  { id: 'ISSUE-002', revitId: '1495760', title: '鉄骨梁の高力ボルト、本締め未完了（仮ボルトのまま）', status: '未対応', type: '品質', assignee: '鉄骨工事・山田工業 田中', due: '2026-11-18', elemName: 'HEB Träger（鉄骨梁）', typeName: 'HE 160 B', loc: 'Mark T3.1' },
  { id: 'ISSUE-003', revitId: '1093293', title: 'コンクリート柱にジャンカ（豆板）の発生', status: '未対応', type: '品質', assignee: '躯体工事・コンクリート班 鈴木', due: '2026-11-21', elemName: 'Ortbeton Stütze（RC柱）', typeName: 'Ortbeton 300x300', loc: '通り芯 B-1(1) / Mark S1.1' },
  { id: 'ISSUE-004', revitId: '1077641', title: 'スラブ配筋のかぶり不足・スペーサー数量の確認', status: '確認待ち', type: '品質', assignee: '鉄筋工事・鉄筋班 高橋', due: '2026-11-19', elemName: 'Floor（床スラブ）', typeName: 'Ortbeton 250', loc: 'Mark D2.1' },
  { id: 'ISSUE-005', revitId: '1162041', title: '瓦屋根 棟部の納まりと瓦のズレ', status: '対応中', type: '品質', assignee: '屋根工事・瓦班 伊藤', due: '2026-11-25', elemName: 'Basic Roof（瓦屋根）', typeName: 'Ziegeldach 360', loc: '屋根面全体' },
  { id: 'ISSUE-006', revitId: '1300808', title: 'トップライト（屋根天窓）パネル周りのシーリング不良', status: '未対応', type: '品質', assignee: '金属・ガラス工事 渡辺', due: '2026-11-22', elemName: 'Systemelement（天窓パネル）', typeName: 'Dachverglasung', loc: 'Dachverglasung' },
];

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, '..');
const env = {};
for (const line of fs.readFileSync(path.join(appRoot, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim();
}
const [lineage, project] = process.argv.slice(2);
if (!lineage || !project) { console.error('usage: node build-model-data.mjs <lineageId> <projectId>'); process.exit(1); }
const BASE = 'https://developer.api.autodesk.com';
const token = await getToken(env);
const H = { Authorization: 'Bearer ' + token };
async function getPoll(url, label) {
  for (let i = 0; i < 80; i++) {
    const r = await fetch(url, { headers: H });
    if (r.status === 200) return r.json();
    if (r.status !== 202 && r.status !== 204) throw new Error(label + ' status ' + r.status);
    await new Promise(s => setTimeout(s, 4000));
  }
  throw new Error(label + ' timeout');
}
const tip = await (await fetch(`${BASE}/data/v1/projects/${project}/items/${encodeURIComponent(lineage)}/tip`, { headers: H })).json();
const urn = tip.data.relationships.derivatives.data.id;
const meta = await getPoll(`${BASE}/modelderivative/v2/designdata/${urn}/metadata`, 'metadata');
const view = meta.data.metadata.find(v => v.role === '3d');
const props = await getPoll(`${BASE}/modelderivative/v2/designdata/${urn}/metadata/${view.guid}/properties?forceget=true`, 'properties');
const tree = await getPoll(`${BASE}/modelderivative/v2/designdata/${urn}/metadata/${view.guid}`, 'objecttree');
const sdbUrn = `urn:adsk.viewing:fs.file:${urn}/output/Resource/model.sdb`;
const sdbRes = await fetch(`${BASE}/modelderivative/v2/designdata/${urn}/manifest/${encodeURIComponent(sdbUrn)}`, { headers: H });
const sdbPath = path.join(here, 'model.sdb');
fs.writeFileSync(sdbPath, Buffer.from(await sdbRes.arrayBuffer()));
const db = new DatabaseSync(sdbPath);
const idmap = new Map();
for (const row of db.prepare('SELECT id, external_id FROM _objects_id').all()) idmap.set(row.external_id, row.id);
db.close();
const reader = await createFetchReader({ urn, guid: view.guid, token });
const bbox = new Map();
for await (const frag of reader.enumerateFragments()) {
  if (!frag.bbox) continue;
  const cur = bbox.get(frag.dbID);
  if (!cur) bbox.set(frag.dbID, [...frag.bbox]);
  else for (let i = 0; i < 3; i++) { cur[i] = Math.min(cur[i], frag.bbox[i]); cur[i + 3] = Math.max(cur[i + 3], frag.bbox[i + 3]); }
}
const catOf = new Map();
(function walk(n, anc) {
  if (n.objects) for (const c of n.objects) walk(c, [...anc, n.name ?? '']);
  else catOf.set(n.objectid, anc[1] ?? '');
})(tree.data.objects[0], []);
const byRevit = new Map();
for (const o of props.data.collection) {
  const m = /\[(\d+)\]$/.exec(o.name ?? '');
  if (m) byRevit.set(m[1], o);
}
const FT2M = 0.3048;
const distFt = (b, t) => Math.hypot(...[0, 1, 2].map(i => Math.max(t[i] - b[i + 3], b[i] - t[i + 3], 0)));
const LEVELKEYS = ['Base Level', 'Reference Level', 'Level', 'Top Level'];
const issues = ISSUES.map(iss => {
  const o = byRevit.get(iss.revitId);
  if (!o) throw new Error('element not found: ' + iss.revitId);
  const sid = idmap.get(o.externalId);
  const t = bbox.get(sid);
  const flat = {};
  for (const vals of Object.values(o.properties)) Object.assign(flat, vals);
  const level = LEVELKEYS.map(k => flat[k]).find(Boolean) ?? '';
  const cand = [];
  for (const [dbid, b] of bbox) if (dbid !== sid) cand.push({ dbId: dbid, distM: +(distFt(b, t) * FT2M).toFixed(2) });
  cand.sort((a, b) => a.distM - b.distM);
  return { id: iss.id, title: iss.title, status: iss.status, type: iss.type, assignee: iss.assignee, due: iss.due, elemName: iss.elemName, category: catOf.get(o.objectid) ?? '', typeName: iss.typeName, level, loc: iss.loc, revitId: iss.revitId, targetDbId: sid, candidates: cand };
});
const out = { model: { name: 'DACHsampleproject.rvt', urn, guid: view.guid, totalElements: bbox.size }, issues };
fs.writeFileSync(path.join(appRoot, 'model-data.json'), JSON.stringify(out, null, 1));
console.log('written model-data.json | elements:', bbox.size, '| issues:', issues.length);
