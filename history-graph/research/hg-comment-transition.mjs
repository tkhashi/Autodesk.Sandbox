// hg-comment-transition.mjs — HG の新 Issue 5件にコメントを投稿し、ステータスを遷移させる。
// #48〜51 → closed、#52 → in_review。トークンはファイルから読むだけ（リフレッシュしない）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const DEMO_DIR = path.join(root, 'demo-issues-3d', 'app');
const BASE = 'https://developer.api.autodesk.com';
const PID = '031a6e68-ccdf-4a29-b8a5-50a2a3ecac25';

const tok = JSON.parse(fs.readFileSync(path.join(DEMO_DIR, '.token.json'), 'utf8'));
const ageMin = (Date.now() - (tok.obtained_at ?? 0)) / 60000;
console.log('token age (min):', ageMin.toFixed(1));
if (ageMin > 50) { console.error('ABORT: token too old'); process.exit(1); }
const H = { Authorization: 'Bearer ' + tok.access_token, 'Content-Type': 'application/json' };

const created = JSON.parse(fs.readFileSync(path.join(here, 'hg-issues-result.json'), 'utf8'));
const PLAN = {
  shrub: { comment: '現地を確認しました。テラス床の仕上がりに問題はなく、植栽の追加手配を進めます。モデル更新で植栽が追加されたことを確認し、本件は完了とします。', status: 'closed' },
  pergola: { comment: '関係者と協議の結果、藤棚は撤去する方針で合意しました。モデル更新で撤去が反映されたことを確認し、本件は完了とします。', status: 'closed' },
  bollard: { comment: '現地で2基とも確認しました。モデル更新で位置の見直しが反映されており、是正済みのため本件は完了とします。', status: 'closed' },
  door: { comment: 'モデル更新側で、対象ドアのプロパティに確認メモが追記されていることを確認しました。本件は完了とします。', status: 'closed' },
  'room-wall': { comment: '室名と壁位置の見直し内容を確認しました。反映は次版で行う予定のため、本件はレビュー中とします。', status: 'in_review' },
};

const results = [];
for (const it of created) {
  const plan = PLAN[it.key];
  // コメント投稿
  const cr = await fetch(`${BASE}/construction/issues/v1/projects/${PID}/issues/${it.id}/comments`, {
    method: 'POST', headers: H, body: JSON.stringify({ body: plan.comment }),
  });
  const cj = await cr.json().catch(() => null);
  console.log(`#${it.displayId} comment POST -> ${cr.status} id=${cj?.id ?? '-'}`);
  if (cr.status !== 201 && cr.status !== 200) { console.error(JSON.stringify(cj).slice(0, 400)); process.exit(1); }
  // ステータス遷移
  const pr = await fetch(`${BASE}/construction/issues/v1/projects/${PID}/issues/${it.id}`, {
    method: 'PATCH', headers: H, body: JSON.stringify({ status: plan.status }),
  });
  const pj = await pr.json().catch(() => null);
  console.log(`#${it.displayId} PATCH status=${plan.status} -> ${pr.status} now=${pj?.status}`);
  if (pr.status !== 200 || pj?.status !== plan.status) { console.error(JSON.stringify(pj).slice(0, 400)); process.exit(1); }
  results.push({ displayId: it.displayId, key: it.key, commentId: cj?.id ?? null, finalStatus: pj.status });
}
fs.writeFileSync(path.join(here, 'hg-transition-result.json'), JSON.stringify(results, null, 1));
console.log('\ndone:', JSON.stringify(results));
