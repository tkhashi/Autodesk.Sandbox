// extract-model-data.mjs
// Snowdon Towers（Forma 実環境）の構造モデルから要素プロパティを抽出し、
// デモ用データ elements.json を生成するスクリプト。
//
// 使い方:
//   1. sample-a-http-client の .env（APS_CLIENT_ID / APS_CLIENT_SECRET）をこのフォルダに置く
//   2. node extract-model-data.mjs
//
// 流れ: Data Management API でプロジェクト→フォルダ→モデル(.rvt)を辿り、
//       Model Derivative API の metadata / properties で要素プロパティを取得する。
//       （モデルの変換は ACC 側で完了済みのため、ここでは読み取りのみ）
import fs from 'node:fs';

const env = {};
for (const line of fs.readFileSync(new URL('./.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const BASE = 'https://developer.api.autodesk.com';
const tokRes = await fetch(BASE + '/authentication/v2/token', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    Authorization: 'Basic ' + Buffer.from(env.APS_CLIENT_ID + ':' + env.APS_CLIENT_SECRET).toString('base64'),
  },
  body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'data:read' }),
});
const token = (await tokRes.json()).access_token;
if (!token) throw new Error('token取得に失敗');
const H = { Authorization: 'Bearer ' + token };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path, poll = false) {
  for (let i = 0; i < 40; i++) {
    const r = await fetch(BASE + path, { headers: H });
    if (r.status === 200) return r.json();
    if (poll && r.status === 202) { await sleep(5000); continue; }
    throw new Error(`${path} -> ${r.status}`);
  }
  throw new Error('polling timeout: ' + path);
}

// 1) hub / project / Project Files / 03_Models を辿って .rvt を探す
const hubs = await get('/project/v1/hubs');
const hub = hubs.data[0];
const projects = await get(`/project/v1/hubs/${hub.id}/projects`);
const project = projects.data[0];
const tops = await get(`/project/v1/hubs/${hub.id}/projects/${project.id}/topFolders`);
const projectFiles = tops.data.find((f) => f.attributes.displayName === 'Project Files');
async function findRvt(folderId) {
  const c = await get(`/data/v1/projects/${project.id}/folders/${encodeURIComponent(folderId)}/contents`);
  for (const it of c.data ?? []) {
    if (it.type === 'items' && /\.rvt$/i.test(it.attributes.displayName ?? '')) return it;
    if (it.type === 'folders') { const found = await findRvt(it.id); if (found) return found; }
  }
  return null;
}
const item = await findRvt(projectFiles.id);
console.log('model:', item.attributes.displayName);

// 2) tip バージョン → URN → メタデータ（202 の間はポーリング）
const tip = await get(`/data/v1/projects/${project.id}/items/${encodeURIComponent(item.id)}/tip`);
const urn = Buffer.from(tip.data.id).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const meta = await get(`/modelderivative/v2/designdata/${urn}/metadata`);
const view = meta.data.metadata.find((m) => m.role === '3d');
const tree = await get(`/modelderivative/v2/designdata/${urn}/metadata/${view.guid}`, true);
const props = await get(`/modelderivative/v2/designdata/${urn}/metadata/${view.guid}/properties`, true);
console.log('elements with properties:', props.data.collection.length);

// 3) ツリーから objectid → カテゴリ/ファミリ/タイプ を引けるようにする
const metaByObjectId = {};
(function walk(node, ancestors) {
  const name = node.name ?? '';
  if (node.objects) { for (const c of node.objects) walk(c, [...ancestors, name]); }
  else if (ancestors.length >= 3) {
    metaByObjectId[node.objectid] = { category: ancestors.at(-3), family: ancestors.at(-2), type: ancestors.at(-1) };
  }
})(tree.data.objects[0], []);

// 4) デモで使う要素（Revit要素IDで指定）を選び、表示用に整形して保存
const PICKS = { '608201': 'ISSUE-001', '608386': 'ISSUE-002', '784236': 'ISSUE-003', '680685': 'ISSUE-004', '606873': 'ISSUE-005', '621720': 'ISSUE-006' };
const byRevitId = {};
for (const o of props.data.collection) {
  const m = o.name.match(/\[(\d+)\]$/);
  if (m) byRevitId[m[1]] = o;
}
const out = {};
for (const [revitId, issueRef] of Object.entries(PICKS)) {
  const o = byRevitId[revitId];
  if (!o) continue;
  out[issueRef] = { objectid: o.objectid, externalId: o.externalId, revitId, name: o.name, ...(metaByObjectId[o.objectid] ?? {}), properties: o.properties };
}
fs.writeFileSync(new URL('./elements.json', import.meta.url), JSON.stringify(out, null, 1));
console.log('written elements.json:', Object.keys(out).join(', '));
