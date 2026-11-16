// hg-create-issues.mjs — HG アイテムの V1 に対してピン付き Issue を5件作成する（正規ルート: V1 に起票）。
// ペイロード形式は VERIFICATION.md / seed 系スクリプトで実証済みの完全形。
// トークンはファイルから読むだけ（リフレッシュしない。並行測定との競合回避）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const DEMO_DIR = path.join(root, 'demo-issues-3d', 'app');
const BASE = 'https://developer.api.autodesk.com';
const PID = '031a6e68-ccdf-4a29-b8a5-50a2a3ecac25';
const LINEAGE = 'urn:adsk.wipprod:dm.lineage:n1BdFAarT-ajJkQvheK5EA';
const VIEW = {
  id: '08203144-4bc1-6e3f-52e3-bbf7852af4e1',
  viewableId: '29948af7-066b-44c9-b460-4e3a3567113b-001921a9',
  guid: '08203144-4bc1-6e3f-52e3-bbf7852af4e1',
  name: 'Coord - Arch Walls', is3D: true,
};
// ピン座標 = Revit 共有座標の bbox 中心 + OFF（#43/#44/#46 の実ピンで検証済みの較正値）
const OFF = { x: -417664.09, y: -78738.41, z: -251.53 };
const pin = (cx, cy, cz) => ({ x: +(cx + OFF.x).toFixed(2), y: +(cy + OFF.y).toFixed(2), z: +(cz + OFF.z).toFixed(2) });

const tok = JSON.parse(fs.readFileSync(path.join(DEMO_DIR, '.token.json'), 'utf8'));
const ageMin = (Date.now() - (tok.obtained_at ?? 0)) / 60000;
console.log('token age (min):', ageMin.toFixed(1));
if (ageMin > 50) { console.error('ABORT: token too old'); process.exit(1); }
const H = { Authorization: 'Bearer ' + tok.access_token, 'Content-Type': 'application/json' };

// subtype / 担当者は既存の #43 から引き継ぐ
const list = await (await fetch(`${BASE}/construction/issues/v1/projects/${PID}/issues?limit=100`, { headers: H })).json();
const src = (list.results ?? []).find(i => i.displayId === 43);
if (!src) { console.error('source issue #43 not found'); process.exit(1); }
console.log('subtype:', src.issueSubtypeId, '| assignedTo:', src.assignedTo, '| assignedToType:', src.assignedToType, '| createdBy(user):', src.createdBy);
const CREATED_BY = src.createdBy;

// アンカーは HG V1 インデックス実測値（diff-rows/idx-hg-v1.ndjson）
const ISSUES = [
  {
    key: 'shrub',
    title: '屋上テラスに植栽が未設置（追加の確認）',
    description: 'V1 時点では屋上テラスに植栽（Switchgrass）が未設置です。設計変更で追加予定のため、設置位置と数量を確認してください。ピンは設置予定位置、アンカーはその直下のテラス床です。',
    objectId: 6714, externalId: '98fc0674-037e-46de-b878-c5e65f1bd3b9-0015523d', anchorName: '床 [1397309]',
    position: pin(417631.283, 78722.118, 256.515), // 植栽の出現位置そのもの
  },
  {
    key: 'pergola',
    title: '藤棚（Pergola Modern）の撤去検討',
    description: '屋上テラスの藤棚（Pergola Modern）について、撤去の要否を検討中です。関係者と協議のうえ判断してください。',
    objectId: 6701, externalId: '8f3a5315-0c53-46b4-bd66-7fe172228201-0010d68d', anchorName: 'Pergola Modern [1103501]',
    position: pin(417633.717, 78727.499, 257.531),
  },
  {
    key: 'bollard',
    title: '屋上テラス外灯2基の位置確認',
    description: '屋上テラスの外灯（Bollard Light）2基について、設置位置が図面どおりか現地で確認してください。ピンはうち1基、もう1基も近傍にあります。',
    objectId: 6882, externalId: 'c527d6db-3cd7-41e5-bb3a-3dcd744150fb-001f5688', anchorName: 'Bollard Light [2053768]',
    position: pin(417632.521, 78724.824, 256.616),
  },
  {
    key: 'door',
    title: 'ドアへの確認メモ追記の検討',
    description: '対象ドアのプロパティ（Comments）に確認メモを追記するか検討してください。追記する場合は文面を統一すること。',
    objectId: 5597, externalId: 'ee03061f-d7b4-4e6a-b397-fa44f24a42a7-000d8e6c', anchorName: 'Door-Passage-Single-Flush [888428]',
    position: pin(417621.185, 78718.857, 257.327),
  },
  {
    key: 'room-wall',
    title: '2F 室名と壁位置の見直し',
    description: '2F の室名（Studio Unit）の妥当性と、対象壁の位置（柱芯／柱面）を見直してください。ピンは見直し対象の壁です。',
    objectId: 3019, externalId: '45ed4799-d124-4abc-8e2b-9d29089bad28-000b6d49', anchorName: '標準壁 [748873]',
    position: pin(417625.063, 78710.745, 246.062),
  },
];

const created = [];
for (const it of ISSUES) {
  const body = {
    title: it.title,
    description: it.description,
    issueSubtypeId: src.issueSubtypeId,
    status: 'open',
    assignedTo: src.assignedTo ?? undefined,
    assignedToType: src.assignedTo ? (src.assignedToType ?? 'user') : undefined,
    linkedDocuments: [{
      type: 'TwoDVectorPushpin',
      urn: LINEAGE,
      createdBy: CREATED_BY,
      createdAt: new Date().toISOString(),
      createdAtVersion: 1,
      closedBy: null, closedAt: null, closedAtVersion: null,
      details: { viewable: VIEW, position: it.position, objectId: it.objectId, externalId: it.externalId },
    }],
  };
  const r = await fetch(`${BASE}/construction/issues/v1/projects/${PID}/issues`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  console.log(`POST ${it.key} -> ${r.status} displayId=${j?.displayId} id=${j?.id}`);
  if (r.status !== 201 || !j?.id) { console.error(JSON.stringify(j).slice(0, 500)); process.exit(1); }
  // GET でピンの永続化を確認
  const chk = await (await fetch(`${BASE}/construction/issues/v1/projects/${PID}/issues/${j.id}`, { headers: H })).json();
  const ld = (chk.linkedDocuments ?? [])[0];
  const ok = ld && ld.urn === LINEAGE && ld.createdAtVersion === 1 && ld.details?.objectId === it.objectId && ld.details?.externalId === it.externalId;
  console.log(`   GET verify: pin persisted=${!!ok} status=${chk.status} placements=${(chk.placements ?? []).length}`);
  if (!ok) { console.error('pin mismatch:', JSON.stringify(ld).slice(0, 500)); process.exit(1); }
  created.push({ key: it.key, displayId: chk.displayId, id: chk.id, title: it.title, status: chk.status, anchorName: it.anchorName, objectId: it.objectId, externalId: it.externalId, position: it.position });
}
fs.writeFileSync(path.join(here, 'hg-issues-result.json'), JSON.stringify(created, null, 1));
console.log('\ncreated:', created.length, '-> hg-issues-result.json');
