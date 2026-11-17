// app.js — 履歴グラフ実アプリの画面ロジック
// Issue 表／タイムライン／最新版との照合／APS Viewer（3D 差分）
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Forma 風ステータス表示（色バー＋英語。sample-d の FSTATUS を移植）
const FSTATUS = {
  draft: ['Draft', '#8a9aa8'], open: ['Open', '#e8a33d'], pending: ['Pending', '#d97706'],
  in_review: ['In review', '#3b82c4'], closed: ['Closed', '#4caf7d'], void: ['Void', '#8a9aa8'],
};
const STATUS_JA = { draft: '下書き', open: '未対応', pending: '対応中', in_review: '確認待ち', closed: '完了', void: '無効' };
function fmtDate(s) {
  if (!s) return '-';
  const d = new Date(s);
  return isNaN(d) ? s : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtDateTime(s) {
  if (!s) return '-';
  const d = new Date(s);
  return isNaN(d) ? s : d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

let DATA = null;             // /api/issues の応答
let selectedId = null;
let selectedPair = null;     // { from, to, version } 3D 差分の比較ペア（ピン時点の版 → 最新版。ピッカーは置かない）
let commentsCache = new Map();
const flt = { q: '', status: 'all', sort: null, page: 1, pageSize: 10 };

// ============ Issue 表 ============
const COLUMNS = [
  { id: 'displayId', label: '#', get: i => i.displayId ?? 0 },
  { id: 'title', label: 'Title', get: i => i.title ?? '' },
  { id: 'status', label: 'Status', get: i => i.status ?? '' },
  { id: 'assignee', label: 'Assignee', get: i => i.assignedToName ?? i.assignedTo ?? '' },
  { id: 'due', label: 'Due date', get: i => i.dueDate ?? '' },
  { id: 'history', label: '履歴', get: null },
];
function filteredIssues() {
  let list = (DATA?.issues ?? []).slice();
  if (flt.status !== 'all') list = list.filter(i => i.status === flt.status);
  if (flt.q) {
    const q = flt.q.toLowerCase();
    list = list.filter(i => [i.title, i.description, String(i.displayId ?? ''), i.assignedToName ?? '', i.typeLabel ?? '']
      .some(v => String(v).toLowerCase().includes(q)));
  }
  if (flt.sort) {
    const col = COLUMNS.find(c => c.id === flt.sort.key);
    if (col?.get) {
      const dir = flt.sort.dir === 'desc' ? -1 : 1;
      list.sort((a, b) => {
        const va = col.get(a), vb = col.get(b);
        if (va === '' && vb !== '') return 1; // 空は常に後ろ
        if (vb === '' && va !== '') return -1;
        return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
      });
    }
  } else {
    // 既定の並びは表示番号の降順（新しい Issue＝現在の対象モデルの Issue が先頭に来る）
    list.sort((a, b) => (b.displayId ?? 0) - (a.displayId ?? 0));
  }
  return list;
}
function miniGraph(i) {
  const h = i.history;
  const nodes = [{ cls: 'start', label: '開', title: '起票（Open）' }];
  const modelVers = [
    ...h.modelUpdates.map(m => ({ v: m.version, t: `モデル更新 V${m.version}（${fmtDate(m.publishedAt)}）` })),
    ...(h.relatedPairs ?? []).map(p => ({ v: p.version, t: `関連するモデル更新 ${p.label}（ピン対象要素が変化）` })),
  ].sort((a, b) => a.v - b.v);
  for (const m of modelVers) nodes.push({ cls: 'model', label: 'V' + m.v, title: m.t });
  if (h.stats.reopenCount > 0) nodes.push({ cls: 'reopen', label: '↩', title: `Reopen ${h.stats.reopenCount} 回` });
  if (i.status === 'closed') nodes.push({ cls: 'goal', label: '🏁', title: 'Close（ゴール）' });
  else nodes.push({ cls: 'now', label: '', title: '現在もオープン' });
  let s = '<div class="mini-track">';
  nodes.forEach((n, idx) => {
    if (idx > 0) s += `<span class="mini-line${idx === nodes.length - 1 && i.status !== 'closed' ? ' open-end' : ''}"></span>`;
    s += `<span class="mini-node ${n.cls}"><span class="dot" title="${esc(n.title)}">${esc(n.label)}</span></span>`;
  });
  return s + '</div>';
}
function buildChips() {
  const counts = { all: DATA.issues.length };
  for (const i of DATA.issues) counts[i.status] = (counts[i.status] ?? 0) + 1;
  const order = ['all', ...Object.keys(FSTATUS).filter(s => counts[s])];
  $('chips').innerHTML = order.map(s => {
    const label = s === 'all' ? 'All' : (FSTATUS[s]?.[0] ?? s);
    return `<button type="button" class="chip${flt.status === s ? ' active' : ''}" data-status="${esc(s)}">${esc(label)} <span class="n">${counts[s] ?? 0}</span></button>`;
  }).join('');
  for (const b of $('chips').querySelectorAll('.chip')) {
    b.addEventListener('click', () => { flt.status = b.dataset.status; flt.page = 1; buildChips(); buildTable(); });
  }
}
function buildTable() {
  // ヘッダ
  $('issueHead').innerHTML = '<tr>' + COLUMNS.map(c => {
    const sortable = !!c.get;
    const sorted = flt.sort?.key === c.id;
    const arr = sorted ? (flt.sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th class="${sortable ? 'sortable' : ''}${sorted ? ' sorted' : ''}" data-col="${c.id}">${esc(c.label)}<span class="arr">${arr}</span></th>`;
  }).join('') + '</tr>';
  for (const th of $('issueHead').querySelectorAll('th.sortable')) {
    th.addEventListener('click', () => {
      const key = th.dataset.col;
      if (flt.sort?.key !== key) flt.sort = { key, dir: 'asc' };
      else if (flt.sort.dir === 'asc') flt.sort = { key, dir: 'desc' };
      else flt.sort = null;
      buildTable();
    });
  }
  // 本体
  const list = filteredIssues();
  const pages = Math.max(1, Math.ceil(list.length / flt.pageSize));
  if (flt.page > pages) flt.page = pages;
  const start = (flt.page - 1) * flt.pageSize;
  const pageItems = list.slice(start, start + flt.pageSize);
  $('issueRows').innerHTML = pageItems.map(i => {
    const [label, color] = FSTATUS[i.status] ?? [i.status, '#8a9aa8'];
    const overdue = i.dueDate && i.status !== 'closed' && new Date(i.dueDate) < new Date(new Date().toDateString());
    const badges = [];
    if (i.history.stats.closeCount) badges.push(`<span class="badge">Close ${i.history.stats.closeCount}回</span>`);
    if (i.history.stats.reopenCount) badges.push(`<span class="badge reopen">Reopen ${i.history.stats.reopenCount}回</span>`);
    if (i.history.stats.modelUpdateCount) badges.push(`<span class="badge">モデル更新 ${i.history.stats.modelUpdateCount}件</span>`);
    if (i.history.stats.relatedPairCount) badges.push(`<span class="badge">関連モデル更新 ${i.history.stats.relatedPairCount}件</span>`);
    if (!i.pin) badges.push('<span class="badge">ピンなし</span>');
    return `<tr data-id="${esc(i.id)}" class="${i.id === selectedId ? 'active' : ''}">
      <td class="c-num">${i.displayId ?? ''}</td>
      <td class="c-title">${esc(i.title)}${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}</td>
      <td><span class="fst"><i style="background:${color}"></i>${esc(label)}</span></td>
      <td class="c-assignee">${esc(i.assignedToName ?? i.assignedTo ?? '—')}</td>
      <td class="c-due${overdue ? ' overdue' : ''} c-due-cell">${esc(fmtDate(i.dueDate))}</td>
      <td>${miniGraph(i)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" style="color:var(--muted)">該当する Issue がありません</td></tr>';
  for (const tr of $('issueRows').querySelectorAll('tr[data-id]')) {
    tr.addEventListener('click', () => selectIssue(tr.dataset.id, true));
  }
  $('tblCount').textContent = `${list.length} 件`;
  $('pagerInfo').textContent = `${pages} ページ中 ${flt.page} ページ目`;
  $('btnPrev').disabled = flt.page <= 1;
  $('btnNext').disabled = flt.page >= pages;
}

// ============ タイムライン ============
function issue() { return DATA?.issues.find(i => i.id === selectedId) ?? null; }
async function loadComments(id) {
  if (commentsCache.has(id)) return commentsCache.get(id);
  try {
    const j = await (await fetch(`/api/issues/${encodeURIComponent(id)}/comments`)).json();
    commentsCache.set(id, j.comments ?? []);
  } catch (e) { commentsCache.set(id, []); }
  return commentsCache.get(id);
}
// ============ ピン時点スナップショット（デモスライス） ============
// 起票 Webhook の受信をシミュレートして保存した「ピン時点の要素状態」と、
// 最新版との照合（Close 検証）を表示する。サーバ側の保存先はローカルの
// data/pin-snapshots.json（外部ストレージのモック）。本物の Webhook は未登録。
const pinSnapCache = new Map(); // issueId -> スナップショット（無い場合は null）
async function loadPinSnap(id) {
  if (pinSnapCache.has(id)) return pinSnapCache.get(id);
  let rec = null;
  try {
    const r = await fetch(`/api/issues/${encodeURIComponent(id)}/pin-snapshot`);
    if (r.ok) rec = await r.json();
  } catch (e) {}
  pinSnapCache.set(id, rec);
  return rec;
}
const VERDICT_LABEL = {
  removed: '対象要素が削除（解消方向の変化）',
  changed: '変化あり',
  unchanged: '変化なし',
  unknown: '照合できませんでした',
};
function verdictChip(v) {
  if (!v?.verdict) return '';
  return `<span class="vchip ${esc(v.verdict)}" title="ピン時点と最新版の照合結果">${esc(VERDICT_LABEL[v.verdict] ?? v.verdict)}</span>`;
}
function fmtPropVal(v) {
  if (v == null) return '（なし）';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 60 ? s.slice(0, 60) + '…' : s;
}
function renderVerify(i, ps) {
  const wrap = $('pinSnapWrap');
  if (!wrap) return;
  if (!ps) {
    // スナップショットが無い場合: 対象モデルにピンされた Issue だけ、生成ボタンを出す
    if (i.pin?.isArchitectural && i.pin?.externalId) {
      wrap.hidden = false;
      wrap.innerHTML = `<div class="pinsnap"><h3>最新版との照合</h3>
        <p class="demo-note">Webhook 受信はデモ用シミュレーションです。</p>
        <p class="muted">まだ照合がありません。起票 Webhook の受信をシミュレートすると、ピン時点の要素状態を保存し、最新版と照合します。</p>
        <button type="button" class="sim-btn" id="pinSnapSimBtn">起票 Webhook の受信をシミュレート</button></div>`;
      $('pinSnapSimBtn').addEventListener('click', async () => {
        const btn = $('pinSnapSimBtn');
        btn.disabled = true;
        btn.textContent = '処理中…';
        try {
          const r = await fetch('/api/sim/webhook', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event: 'issue.created-1.0', payload: { issueId: i.id } }),
          });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          pinSnapCache.delete(i.id);
          const rec = await loadPinSnap(i.id);
          if (selectedId === i.id) { renderVerify(i, rec); applyViewerTarget(rec); }
          buildTimeline(); // Close イベント側の判定チップも付け直す
        } catch (e) {
          btn.disabled = false;
          btn.textContent = '失敗しました — もう一度シミュレート';
        }
      });
    } else {
      wrap.hidden = true;
      wrap.innerHTML = '';
    }
    return;
  }
  const el = ps.element ?? {};
  const v = ps.verification ?? {};
  wrap.hidden = false;
  wrap.innerHTML = `<div class="pinsnap">
    <h3>最新版との照合</h3>
    <p class="demo-note">Webhook 受信はデモ用シミュレーションです。</p>
    <div>対象要素: <b>${esc(el.name ?? ps.pin?.externalId ?? '—')}</b>${el.category ? `（${esc(el.category)}）` : ''}${verdictChip(v)}</div>
    ${v.summary?.length ? `<ul>${v.summary.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${v.changedProps?.length ? `<ul>${v.changedProps.slice(0, 6).map(c => `<li>${esc(c.name)}: ${esc(fmtPropVal(c.from))} → ${esc(fmtPropVal(c.to))}</li>`).join('')}</ul>` : ''}
  </div>`;
}
async function buildTimeline() {
  const i = issue();
  if (!i) { $('tlTitle').textContent = '—'; $('tlBody').innerHTML = ''; const pw = $('pinSnapWrap'); if (pw) { pw.hidden = true; pw.innerHTML = ''; } return; }
  const myId = i.id;
  const [label] = FSTATUS[i.status] ?? [i.status];
  $('tlTitle').textContent = `#${i.displayId ?? ''} ${i.title ?? ''}`;
  $('tlMeta').innerHTML = [
    `<span class="tag">${esc(label)}</span>`,
    i.typeLabel ? `<span class="tag">${esc(i.typeLabel)}</span>` : '',
    `<span>担当: ${esc(i.assignedToName ?? i.assignedTo ?? '—')}</span>`,
    `<span>起票: ${esc(i.createdByName ?? i.createdBy ?? '—')}</span>`,
    i.pin ? `<span>ピン: ${esc(i.pin.viewName ?? 'あり')}</span>` : '<span>ピンなし</span>',
  ].join('');
  const [comments, pinSnap] = await Promise.all([loadComments(i.id), loadPinSnap(i.id)]);
  if (selectedId !== myId) return; // 待っている間に選択が切り替わっていたら、古い描画で上書きしない
  renderVerify(i, pinSnap);
  const evs = [];
  evs.push({ t: i.createdAt, cls: 'open', html: `<b>起票</b> — ${esc(i.createdByName ?? '')} が Open` });
  for (const c of comments) {
    evs.push({ t: c.createdAt, cls: 'comment', html: `<b>コメント</b> — ${esc(c.createdByName ?? '')}`, body: c.body });
  }
  for (const e of i.history.events) {
    if (e.kind === 'status') {
      if (e.to === 'closed') evs.push({ t: e.detectedAt, cls: 'goal', html: `<b>Close 🏁</b> — ${esc(STATUS_JA[e.from] ?? e.from)} <span class="st-arrow">→</span> 完了`, verifyChip: pinSnap ? verdictChip(pinSnap.verification) : '' });
      else if (e.from === 'closed') evs.push({ t: e.detectedAt, cls: 'reopen', html: `<b>Reopen</b> — 完了 <span class="st-arrow">→</span> ${esc(STATUS_JA[e.to] ?? e.to)}` });
      else evs.push({ t: e.detectedAt, cls: 'status', html: `<b>状態変更</b> — ${esc(STATUS_JA[e.from] ?? e.from)} <span class="st-arrow">→</span> ${esc(STATUS_JA[e.to] ?? e.to)}` });
    } else if (e.kind === 'assignee') {
      evs.push({ t: e.detectedAt, cls: 'status', html: `<b>担当変更</b> — ${esc(e.from ?? '—')} <span class="st-arrow">→</span> ${esc(e.to ?? '—')}` });
    }
  }
  for (const m of i.history.modelUpdates) {
    evs.push({
      t: m.publishedAt, cls: 'model',
      html: `<b>モデル更新 V${m.version}</b> — ${esc(DATA.model.name)}${m.createdBy ? `（公開者: ${esc(m.createdBy)}）` : ''}`,
    });
  }
  for (const rp of i.history.relatedPairs ?? []) {
    const chg = rp.change === 'added' ? '追加' : rp.change === 'removed' ? '削除' : '変更';
    evs.push({
      t: rp.publishedAt, cls: 'model',
      html: `<b>関連するモデル更新 — ${esc(rp.label)}</b>`,
      note: `ピン対象要素${rp.anchorName ? `「${esc(rp.anchorName)}」` : ''}が${chg}されました`,
    });
  }
  evs.sort((a, b) => String(a.t ?? '').localeCompare(String(b.t ?? '')));
  if (i.history.relatedPairsPending) {
    evs.push({ t: null, cls: 'model', html: '<b>関連するモデル更新</b> — ライブ diff で確認中…', note: 'diff ジョブの完了後に自動で表示されます' });
  }
  if (i.status !== 'closed') evs.push({ t: null, cls: 'now', html: '<b>現在</b> — オープン中' });
  $('tlBody').innerHTML = evs.map(e => `
    <div class="ev ${e.cls}">
      <span class="ev-dot"></span>
      <div class="ev-row"><span class="ev-when">${e.t ? esc(fmtDateTime(e.t)) : ''}</span><span class="ev-text">${e.html}${e.verifyChip ?? ''}${e.body ? `<div class="ev-body">${esc(e.body)}</div>` : ''}${e.note ? `<div class="ev-body">${esc(e.note)}</div>` : ''}</span></div>
    </div>`).join('');
}

// ============ 3D 差分の分類モード（UI 簡素化後は geometry 固定） ============
let diffMode = 'geometry';   // 3D 表示の「変更」の範囲: 'geometry'（形状のみ）固定
let diffGhostOld = true;     // 変更前の形状をゴースト表示するか（常時 ON）
// ============ APS Viewer による 3D 差分表示（sample-d の初期化を移植。CDN 不達の環境では注記のみ） ============
// 版ペアの2モデルを1つの Viewer に集約ロードし、diff の要素リストで表示を振り分ける:
//   変更なし: 新版のみ（旧版の同要素は隠す）／追加: 新版のみ・緑／削除: 旧版のみ・赤ゴースト
//   変更: 新版・黄、旧版はトグルでゴースト
// 要素の対応付けは diff 行の externalId → Viewer の dbId（モデルの externalId マッピング）で行う。
let viewer = null, viewerInitStarted = false;
const diffModelByVersion = new Map(); // versionNumber -> model（読み込み済みは再利用する）
let diffPairShown = null;             // { from, to } 3D 差分を表示中のペア
let diffElements = null;              // /api/diff/elements の応答（現在のモード）
let diffBusy = false;
let diffViewMode = 'overlay';         // 3D 差分の見せ方: 'overlay'（重ねて表示）| 'before'（Before のみ）| 'after'（After のみ）
let diffScope = 'focus';              // 3D 差分の表示範囲: 'focus'（差分フォーカス＝文脈を残し見通し確保＋引出線・既定）| 'full'（全体表示）
let diffViewCtx = null;               // 分類済みの表示コンテキスト（モード切替時は再取得せずこれを使い回す）
function diffStatus(msg) {
  $('viewerNote').textContent = msg;
}
// ============ カメラ・見通し・引出線ラベル（sample-d の表示方式を移植） ============
// sample-d（demo-issues-3d）の実証済み方式に合わせる:
// - カメラ: ピボット＝対象の中心、方位は現在を維持し仰角は 28° 固定、移動はグライド
//   （イージング付き。ユーザー入力で即キャンセル。sample-d SPEC §6.5）
// - 見通し: 変更なし要素を全部隠すのではなく、カメラ→対象の視線を遮る部材だけを
//   ゴースト化する occluder removal（sample-d SPEC §6.7）。静的集合（フォーカス時点の
//   視点で1回だけ計算し、カメラ移動では再計算しない）
// - 引出線ラベル: 変更要素を線で指す。画面外は隠し、重なりを避ける配置パッキング、
//   サイズは構築時に1回だけ測り、更新は transform のみ＋rAF 集約（sample-d §6.6 / v8.21）
function nodeWorldBox(dbId, model) {
  try {
    const tree = model.getInstanceTree();
    const a = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    tree.getNodeBox(dbId, a);
    if (a[0] <= a[3] && a[1] <= a[4] && a[2] <= a[5]) {
      return { min: { x: a[0], y: a[1], z: a[2] }, max: { x: a[3], y: a[4], z: a[5] } };
    }
  } catch (e) {}
  try {
    const tree = model.getInstanceTree();
    const frags = model.getFragmentList();
    const box = new THREE.Box3();
    const fb = new THREE.Box3();
    let found = false;
    tree.enumNodeFragments(dbId, (fid) => {
      frags.getWorldBounds(fid, fb);
      if (fb && !fb.isEmpty()) { box.union(fb); found = true; }
    }, true);
    if (found && !box.isEmpty()) return { min: { x: box.min.x, y: box.min.y, z: box.min.z }, max: { x: box.max.x, y: box.max.y, z: box.max.z } };
  } catch (e) {}
  return null;
}
function boxCenter(b) { return { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 }; }
function boxRadius(b) { return Math.max(0.5 * Math.hypot(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z), 0.5); }
function unionBoxes(boxes) {
  const bs = boxes.filter(Boolean);
  if (!bs.length) return null;
  const u = { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
  for (const b of bs) {
    u.min.x = Math.min(u.min.x, b.min.x); u.min.y = Math.min(u.min.y, b.min.y); u.min.z = Math.min(u.min.z, b.min.z);
    u.max.x = Math.max(u.max.x, b.max.x); u.max.y = Math.max(u.max.y, b.max.y); u.max.z = Math.max(u.max.z, b.max.z);
  }
  return u;
}
// ---- カメラのグライド（sample-d fitToElement の移植） ----
let focusAnim = null;
function cancelFocusAnim() {
  if (focusAnim) { cancelAnimationFrame(focusAnim.raf); focusAnim = null; }
}
function glideToBox(box, onArrive) {
  if (!viewer || !box || !window.THREE) return false;
  const T = window.THREE;
  const c0 = boxCenter(box);
  const c = new T.Vector3(c0.x, c0.y, c0.z);
  const radius = boxRadius(box);
  const fov = ((viewer.impl?.camera?.fov ?? 45) * Math.PI) / 180;
  const dist = (radius / Math.tan(fov / 2)) * 1.9;
  let camPos;
  try { camPos = viewer.navigation.getPosition().clone(); } catch (e) { camPos = viewer.impl.camera.position.clone(); }
  const cur = camPos.clone().sub(c);
  let az = Math.atan2(cur.y, cur.x);
  if (!isFinite(az)) az = Math.PI / 4;
  const el = (28 * Math.PI) / 180;
  const dir = new T.Vector3(Math.cos(az) * Math.cos(el), Math.sin(az) * Math.cos(el), Math.sin(el));
  const dest = c.clone().add(dir.multiplyScalar(dist));
  // setView はピボットを動かさないため、対象の中心へ先に移す（sample-d v8.20 の教訓）
  try { viewer.navigation.setPivotPoint(c); } catch (e) {}
  const fromPos = camPos.clone();
  let fromTgt;
  try { fromTgt = viewer.navigation.getTarget().clone(); } catch (e) { fromTgt = c.clone(); }
  const travel = fromPos.distanceTo(dest);
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  cancelFocusAnim();
  const up = new T.Vector3(0, 0, 1);
  if (reduceMotion || travel < 1.5) {
    try { viewer.navigation.setView(dest, c, up); } catch (e) {}
    if (onArrive) onArrive();
    return true;
  }
  const dur = Math.min(1200, Math.max(650, 450 + travel * 1.2));
  const t0 = performance.now();
  const easeInOutCubic = x => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const anim = { raf: 0 };
  focusAnim = anim;
  const step = (now) => {
    if (focusAnim !== anim) return;
    const t = Math.min(1, Math.max(0, (now - t0) / dur));
    const e = easeInOutCubic(t);
    try { viewer.navigation.setView(fromPos.clone().lerp(dest, e), fromTgt.clone().lerp(c, e), up); } catch (err) {}
    if (t < 1) { anim.raf = requestAnimationFrame(step); }
    else { focusAnim = null; if (onArrive) onArrive(); }
  };
  anim.raf = requestAnimationFrame(step);
  return true;
}
function glideToPoint(p, onArrive) {
  // ピン座標へのフォールバック（対象要素のボックスが取れないとき）。半径は仮置き
  const r = 8;
  return glideToBox({ min: { x: p.x - r, y: p.y - r, z: p.z - r }, max: { x: p.x + r, y: p.y + r, z: p.z + r } }, onArrive);
}
// ---- 手前の部材の透明化（occluder removal、sample-d computeOccluders の移植） ----
let occluderRange = (() => {
  const raw = localStorage.getItem('hgraph-occluder-range');
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 50;
})();
let hiddenOccluders = new Map(); // model -> Set(dbId): この機能がゴースト化した要素
let occHiddenTotal = 0;
let occCandidatesCache = new Map(); // model -> [{dbId, box}]
let occTarget = null; // {box} 現在の見通し対象（アンカー要素 or 変更要素全体の合体ボックス）
function segmentHitsBox(o, d, tMax, b) {
  let tmin = 0, tmax = tMax;
  for (const ax of ['x', 'y', 'z']) {
    const dd = d[ax], oo = o[ax];
    if (Math.abs(dd) < 1e-9) { if (oo < b.min[ax] || oo > b.max[ax]) return false; }
    else {
      let t1 = (b.min[ax] - oo) / dd, t2 = (b.max[ax] - oo) / dd;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      if (tmin > tmax) return false;
    }
  }
  return true;
}
function addAncestors(tree, id, set) {
  let p = id, guard = 0;
  while (p != null && guard++ < 100) {
    let parent = null;
    try { parent = tree.getNodeParentId(p); } catch (e) { break; }
    if (parent == null || parent === p) break;
    set.add(parent);
    p = parent;
  }
}
function occluderCandidates(model) {
  if (occCandidatesCache.has(model)) return occCandidatesCache.get(model);
  const tree = model.getInstanceTree();
  const out = [];
  if (tree) {
    const walk = (id) => {
      let hasFrag = false;
      tree.enumNodeChildren(id, (c) => walk(c));
      tree.enumNodeFragments(id, () => { hasFrag = true; }, false);
      if (hasFrag && id !== tree.getRootId()) {
        const box = nodeWorldBox(id, model);
        if (box) out.push({ dbId: id, box });
      }
    };
    walk(tree.getRootId());
  }
  occCandidatesCache.set(model, out);
  return out;
}
// 分類済み要素（追加／削除／変更）と対象自身・その祖先は、遮蔽物候補から外す
function occluderExclusions(model) {
  const ctx = diffViewCtx;
  const set = new Set();
  if (!ctx) return set;
  const tree = model.getInstanceTree();
  const lists = model === ctx.toM ? [ctx.addedToDb, ctx.changedToDb] : [ctx.removedDb, ctx.changedFromDb];
  for (const l of lists) for (const id of l) { set.add(id); if (tree) addAncestors(tree, id, set); }
  return set;
}
function computeOccluders(targetBox) {
  // カメラ→対象ボックス（範囲ぶん拡大）の 8 隅＋中心への 9 本の線分と交差する要素
  const range = occluderRange;
  const out = new Map();
  if (!viewer || !targetBox || range <= 0) return out;
  let cam;
  try { cam = viewer.navigation.getPosition(); } catch (e) { return out; }
  const o = { x: cam.x, y: cam.y, z: cam.z };
  const c = boxCenter(targetBox);
  const f = 1 + (range / 100) * 2;
  const ex = {
    min: { x: c.x + (targetBox.min.x - c.x) * f, y: c.y + (targetBox.min.y - c.y) * f, z: c.z + (targetBox.min.z - c.z) * f },
    max: { x: c.x + (targetBox.max.x - c.x) * f, y: c.y + (targetBox.max.y - c.y) * f, z: c.z + (targetBox.max.z - c.z) * f },
  };
  const pts = [c];
  for (const x of [ex.min.x, ex.max.x]) for (const y of [ex.min.y, ex.max.y]) for (const z of [ex.min.z, ex.max.z]) pts.push({ x, y, z });
  const segs = pts.map(p => ({ x: p.x - o.x, y: p.y - o.y, z: p.z - o.z }));
  const distC = Math.hypot(c.x - o.x, c.y - o.y, c.z - o.z);
  const ctx = diffViewCtx;
  for (const model of [ctx?.fromM, ctx?.toM].filter(Boolean)) {
    const excl = occluderExclusions(model);
    const hits = [];
    for (const cand of occluderCandidates(model)) {
      if (excl.has(cand.dbId)) continue;
      const cc = boxCenter(cand.box);
      if (Math.hypot(cc.x - o.x, cc.y - o.y, cc.z - o.z) - boxRadius(cand.box) >= distC) continue;
      if (segs.some(d => segmentHitsBox(o, d, 1, cand.box))) hits.push(cand.dbId);
    }
    if (hits.length) out.set(model, new Set(hits));
  }
  return out;
}
// 前回との差分だけを表示／非表示する（全表示→全非表示の往復によるチラつき回避、sample-d v8.21）
function applyOccluderSet(next) {
  if (!viewer) return;
  for (const model of new Set([...hiddenOccluders.keys(), ...next.keys()])) {
    const prev = hiddenOccluders.get(model) ?? new Set();
    const cur = next.get(model) ?? new Set();
    const toShow = [...prev].filter(id => !cur.has(id));
    const toHide = [...cur].filter(id => !prev.has(id));
    if (toShow.length) { try { viewer.show(toShow, model); } catch (e) {} }
    if (toHide.length) { try { viewer.hide(toHide, model); } catch (e) {} }
  }
  hiddenOccluders = next;
  occHiddenTotal = [...next.values()].reduce((s, set) => s + set.size, 0);
}
// フォーカス表示のときだけ、現在の視点で見通しを確保する。カメラ移動では再計算しない
// （静的集合。sample-d v8.29）。再計算するのは分類適用・グライド到着・スライダ変更・
// ラベルクリックで対象が変わったときだけ
function applyOccluders() {
  if (!viewer || !diffViewCtx || diffViewCtx.plain || diffScope !== 'focus' || !occTarget) {
    applyOccluderSet(new Map());
    return;
  }
  applyOccluderSet(computeOccluders(occTarget.box));
}
function occNote() {
  return occHiddenTotal ? `／手前の部材 ${occHiddenTotal} 件を透明にして見通しを確保` : '';
}
// ---- 引出線ラベル（sample-d のマーカー処理の移植） ----
const LABEL_MAX = 12; // アンカー優先＋近傍の変更で上限 12 件（画面が線だらけにならない範囲）
function shortLabelName(name) {
  const s = String(name ?? '');
  return s.length > 42 ? s.slice(0, 42) + '…' : s;
}
const LABEL_KIND = { added: ['追加', '#1e9e57'], removed: ['削除', '#d43a2f'], changed: ['変更', '#b8860b'] };
let labelItems = [];
let labelsRaf = 0;
function clearLabels() {
  labelItems = [];
  const m = $('diffMarkers'), s = $('diffLeaders');
  if (m) m.innerHTML = '';
  if (s) s.innerHTML = '';
}
function buildLabels() {
  clearLabels();
  if (!viewer || !diffViewCtx || diffViewCtx.plain || diffScope !== 'focus' || diffMode !== 'geometry' || !diffElements) return;
  const ctx = diffViewCtx;
  const T = window.THREE;
  if (!T) return;
  const cand = [];
  for (const e of diffElements.added) cand.push({ ext: e.externalId, name: e.name, model: ctx.toM, map: ctx.mapTo, kind: 'added' });
  for (const e of diffElements.changed) cand.push({ ext: e.externalId, name: e.name, model: ctx.toM, map: ctx.mapTo, kind: 'changed' });
  for (const e of diffElements.removed) cand.push({ ext: e.externalId, name: e.name, model: ctx.fromM, map: ctx.mapFrom, kind: 'removed' });
  const anchorExt = issue()?.pin?.externalId ?? null;
  const resolved = [];
  for (const c of cand) {
    const db = c.map[c.ext];
    if (db == null) continue;
    const box = nodeWorldBox(db, c.model);
    if (!box) continue;
    resolved.push({ ...c, db, box, pos: boxCenter(box), corners: [
      { x: box.min.x, y: box.min.y, z: box.min.z }, { x: box.max.x, y: box.min.y, z: box.min.z },
      { x: box.min.x, y: box.max.y, z: box.min.z }, { x: box.max.x, y: box.max.y, z: box.min.z },
      { x: box.min.x, y: box.min.y, z: box.max.z }, { x: box.max.x, y: box.min.y, z: box.max.z },
      { x: box.min.x, y: box.max.y, z: box.max.z }, { x: box.max.x, y: box.max.y, z: box.max.z },
    ] });
  }
  // アンカー要素を先頭に固定し、残りはアンカー（無ければ全体の重心）からの距離順
  const anchorItem = anchorExt ? resolved.find(r => r.ext === anchorExt) : null;
  const ref = anchorItem?.pos ?? (resolved.length ? resolved.reduce((a, r) => ({ x: a.x + r.pos.x / resolved.length, y: a.y + r.pos.y / resolved.length, z: a.z + r.pos.z / resolved.length }), { x: 0, y: 0, z: 0 }) : null);
  resolved.sort((a, b) => {
    if (a === anchorItem) return -1;
    if (b === anchorItem) return 1;
    const da = Math.hypot(a.pos.x - ref.x, a.pos.y - ref.y, a.pos.z - ref.z);
    const db2 = Math.hypot(b.pos.x - ref.x, b.pos.y - ref.y, b.pos.z - ref.z);
    return da - db2;
  });
  const picked = resolved.slice(0, LABEL_MAX);
  const markersEl = $('diffMarkers'), leadersEl = $('diffLeaders');
  if (!markersEl || !leadersEl) return;
  const SVGNS = 'http://www.w3.org/2000/svg';
  for (const r of picked) {
    const [kindLabel, color] = LABEL_KIND[r.kind];
    const el = document.createElement('div');
    el.className = 'diff-label k-' + r.kind;
    el.innerHTML = `<span class="dl-kind">${kindLabel}</span>${esc(shortLabelName(r.name))}`;
    el.title = `${kindLabel}: ${r.name}（クリックでこの要素へ移動）`;
    el.addEventListener('click', () => {
      occTarget = { box: r.box };
      glideToBox(r.box, () => applyOccluders());
    });
    markersEl.appendChild(el);
    const line = document.createElementNS(SVGNS, 'polyline');
    line.setAttribute('class', 'leader-line');
    leadersEl.appendChild(line);
    const dot = document.createElementNS(SVGNS, 'circle');
    dot.setAttribute('class', 'leader-dot');
    dot.setAttribute('r', '3.5');
    dot.setAttribute('fill', color);
    leadersEl.appendChild(dot);
    // サイズは構築時に1回だけ測る（カメラ移動のたびに読むと強制リフローでチラつく）
    labelItems.push({ el, line, dot, pos: r.pos, corners: r.corners, w: el.offsetWidth, h: el.offsetHeight });
  }
  updateLabels();
}
// 画面中央の「青ゾーン」の外側の余白帯にラベルを逃がし、縦方向に詰めて重なりを無くす
const LABEL_BLUE_ZONE = { l: 0.125, r: 0.875, t: 0.18, b: 0.74 };
function updateLabels() {
  if (!viewer || !labelItems.length || !window.THREE) return;
  const wrap = $('viewerWrap');
  if (!wrap) return;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (!W || !H) return;
  const T = window.THREE;
  let camPos, camDir;
  try {
    camPos = viewer.navigation.getPosition();
    // カメラ方向は Navigation の公式 API には無い（getWorldDirection は存在しない。
    // これを呼ぶと例外になり、ラベルの transform が一切書かれず全ラベルが左上に残る）。
    // sample-d と同じく impl.camera から取る。取れなければ注視点−位置で代用する。
    camDir = new T.Vector3();
    const cam = viewer.impl?.camera;
    if (cam?.getWorldDirection) cam.getWorldDirection(camDir);
    else {
      const tgt = viewer.navigation.getTarget();
      camDir.set(tgt.x - camPos.x, tgt.y - camPos.y, tgt.z - camPos.z).normalize();
    }
  } catch (e) { return; }
  const vis = [];
  for (const it of labelItems) {
    let anchor = null;
    const candidates = [it.pos, ...it.corners];
    for (const p of candidates) {
      const v = new T.Vector3(p.x, p.y, p.z);
      const toP = v.clone().sub(camPos);
      if (toP.lengthSq() < 1e-9) continue;
      if (camDir.dot(toP.normalize()) <= 0.02) continue; // カメラの後ろ
      let c = null;
      try { c = viewer.worldToClient(v); } catch (e) {}
      if (!c || c.x < -20 || c.x > W + 20 || c.y < -20 || c.y > H + 20) continue;
      anchor = { x: c.x, y: c.y };
      break;
    }
    if (anchor) vis.push({ it, anchor });
  }
  const B = { l: W * LABEL_BLUE_ZONE.l, r: W * LABEL_BLUE_ZONE.r, t: H * LABEL_BLUE_ZONE.t, b: H * LABEL_BLUE_ZONE.b };
  const C = { x: W / 2, y: vis.length ? vis.reduce((s, v) => s + v.anchor.y, 0) / vis.length : H / 2 };
  const rayExitRect = (cx, cy, px, py, r) => {
    const dx = px - cx, dy = py - cy;
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return { x: r.r, y: cy };
    let t = Infinity;
    if (dx > 0) t = Math.min(t, (r.r - cx) / dx); else if (dx < 0) t = Math.min(t, (r.l - cx) / dx);
    if (dy > 0) t = Math.min(t, (r.b - cy) / dy); else if (dy < 0) t = Math.min(t, (r.t - cy) / dy);
    if (!isFinite(t)) t = 0;
    return { x: cx + dx * t, y: cy + dy * t };
  };
  for (const v of vis) {
    const e = rayExitRect(C.x, C.y, v.anchor.x, v.anchor.y, B);
    let side;
    if (Math.abs(e.x - B.l) < 0.6) side = 'l'; else if (Math.abs(e.x - B.r) < 0.6) side = 'r';
    else if (Math.abs(e.y - B.t) < 0.6) side = 't'; else side = 'b';
    let lx, ly;
    if (side === 'l') { lx = e.x - v.it.w - 4; ly = e.y - v.it.h / 2; }
    else if (side === 'r') { lx = e.x + 4; ly = e.y - v.it.h / 2; }
    else if (side === 't') { lx = e.x - v.it.w / 2; ly = e.y - v.it.h - 4; }
    else { lx = e.x - v.it.w / 2; ly = e.y + 4; }
    v.side = side; v.lx = lx; v.ly = ly;
  }
  // 辺ごとに縦（横）方向へ詰めて最小間隔を確保する
  const GAP = 6;
  for (const side of ['l', 'r', 't', 'b']) {
    const grp = vis.filter(v => v.side === side);
    if (!grp.length) continue;
    const vert = side === 'l' || side === 'r';
    grp.sort((a, b) => (vert ? a.ly - b.ly : a.lx - b.lx));
    for (let iter = 0; iter < 3; iter++) {
      for (let k = 1; k < grp.length; k++) {
        const prev = grp[k - 1], cur = grp[k];
        const minPos = (vert ? prev.ly + prev.it.h : prev.lx + prev.it.w) + GAP;
        if (vert ? cur.ly < minPos : cur.lx < minPos) { if (vert) cur.ly = minPos; else cur.lx = minPos; }
      }
      for (let k = grp.length - 2; k >= 0; k--) {
        const next = grp[k + 1], cur = grp[k];
        const maxPos = (vert ? next.ly - cur.it.h : next.lx - cur.it.w) - GAP;
        if (vert ? cur.ly > maxPos : cur.lx > maxPos) { if (vert) cur.ly = maxPos; else cur.lx = maxPos; }
      }
    }
    for (let k = 1; k < grp.length; k++) { // 最終パス: 画面内に収めることより間隔を優先する
      const prev = grp[k - 1], cur = grp[k];
      const minPos = (vert ? prev.ly + prev.it.h : prev.lx + prev.it.w) + GAP;
      if (vert ? cur.ly < minPos : cur.lx < minPos) { if (vert) cur.ly = minPos; else cur.lx = minPos; }
    }
  }
  // 四隅で左右帯と上下帯のラベルが衝突したら、上下帯側を自分の軸方向へずらす
  for (let iter = 0; iter < 4; iter++) {
    let moved = false;
    for (const a of vis) for (const b of vis) {
      if (a === b) continue;
      const tb = (a.side === 't' || a.side === 'b') ? a : (b.side === 't' || b.side === 'b') ? b : null;
      const lr = tb === a ? b : tb === b ? a : null;
      if (!tb || !lr || lr.side === 't' || lr.side === 'b') continue;
      const overlapX = Math.min(a.lx + a.it.w, b.lx + b.it.w) - Math.max(a.lx, b.lx);
      const overlapY = Math.min(a.ly + a.it.h, b.ly + b.it.h) - Math.max(a.ly, b.ly);
      if (overlapX > 0 && overlapY > 0) {
        const dir = tb.lx + tb.it.w / 2 <= lr.lx + lr.it.w / 2 ? -1 : 1;
        tb.lx += dir * (overlapX + GAP);
        moved = true;
      }
    }
    if (!moved) break;
  }
  // 位置の書き込みは transform のみ（left/top は触らない）
  const inSet = new Set(vis.map(v => v.it));
  for (const it of labelItems) {
    if (!inSet.has(it)) { it.el.style.display = 'none'; it.line.style.display = 'none'; it.dot.style.display = 'none'; }
  }
  for (const v of vis) {
    const { it, anchor } = v;
    it.el.style.display = '';
    it.el.style.transform = `translate(${Math.round(v.lx)}px, ${Math.round(v.ly)}px)`;
    const ex = v.lx > anchor.x ? v.lx : v.lx + it.w;
    const ey = Math.min(Math.max(anchor.y, v.ly + 2), v.ly + it.h - 2);
    it.line.setAttribute('points', `${anchor.x},${anchor.y} ${ex},${ey}`);
    it.line.style.display = '';
    it.dot.setAttribute('cx', anchor.x);
    it.dot.setAttribute('cy', anchor.y);
    it.dot.style.display = '';
  }
}
function scheduleLabelsUpdate() {
  if (labelsRaf) return;
  labelsRaf = requestAnimationFrame(() => { labelsRaf = 0; updateLabels(); });
}
function ensureViewer() {
  return new Promise((resolve, reject) => {
    if (viewer) return resolve(viewer);
    if (!window.Autodesk?.Viewing) {
      return reject(new Error('Viewer の CDN に到達できないため、この環境では 3D を表示できません（実機ブラウザで開いてください）'));
    }
    if (viewerInitStarted) { // 初期化の完了待ち
      const iv = setInterval(() => { if (viewer) { clearInterval(iv); resolve(viewer); } }, 300);
      setTimeout(() => { clearInterval(iv); if (!viewer) reject(new Error('Viewer の初期化がタイムアウトしました')); }, 30000);
      return;
    }
    viewerInitStarted = true;
    const options = {
      env: 'AutodeskProduction', api: 'derivativeV2',
      getAccessToken: async (cb) => {
        const t = await (await fetch('/api/token')).json();
        cb(t.access_token, t.expires_in);
      },
    };
    Autodesk.Viewing.Initializer(options, () => {
      viewer = new Autodesk.Viewing.GuiViewer3D($('viewerEl'));
      viewer.start();
      // occluder removal は「消す」のではなくゴースト化する（フレームが残り文脈が読める）
      try { viewer.setGhosting(true); } catch (e) {}
      // 引出線ラベルの追随は rAF 集約（カメラ変更のたびに全件再配置しない）
      try {
        const camEv = Autodesk.Viewing.CAMERA_CHANGE_EVENT;
        if (camEv) viewer.addEventListener(camEv, scheduleLabelsUpdate);
      } catch (e) {}
      // ユーザーがビューアを触ったらグライドを即中断し、その視点で見通しを1回適用する
      const onUserNav = () => { if (focusAnim) { cancelFocusAnim(); applyOccluders(); } };
      $('viewerEl').addEventListener('pointerdown', onUserNav, true);
      $('viewerEl').addEventListener('wheel', onUserNav, { capture: true, passive: true });
      resolve(viewer);
    });
  });
}
function waitGeometry(model) {
  return new Promise(resolve => {
    let tree = null;
    try { tree = model.getInstanceTree(); } catch (e) {}
    if (tree) return resolve();
    const onGeo = (e) => {
      if (e.model === model) { viewer.removeEventListener(Autodesk.Viewing.GEOMETRY_LOADED_EVENT, onGeo); resolve(); }
    };
    viewer.addEventListener(Autodesk.Viewing.GEOMETRY_LOADED_EVENT, onGeo);
    setTimeout(() => { viewer.removeEventListener(Autodesk.Viewing.GEOMETRY_LOADED_EVENT, onGeo); resolve(); }, 90000);
  });
}
// 表示用 viewable の解決（版ごとに名前で解決する。geometry guid は版間で変動するため
// guid 直指定はしない）。従来の getDefaultGeometry() は 'Coord - Arch Walls'（壁のみ
// 1,310 要素）に落ちており、扉・藤棚・植栽・外灯等が表示できなかった。全カテゴリを含む
// 'New Construction'（7,027 要素）を正とする。解決順: ①guid 明示指定（設定がある場合のみ）
// ②名前の完全一致 ③名前の部分一致 ④バウンディングボックス体積が最大の 3D viewable
// ⑤getDefaultGeometry()。
const viewableNameByVersion = new Map(); // versionNumber -> 実際に選んだ viewable 名（表示確認用）
function pickViewable(doc, vnum) {
  const root = doc.getRoot();
  let nodes = [];
  try { nodes = root.search({ type: 'geometry', role: '3d' }, true) ?? []; } catch (e) {}
  if (!nodes.length) { try { nodes = root.search({ type: 'geometry' }, true) ?? []; } catch (e) {} }
  const wantName = DATA?.model?.viewableName ?? 'New Construction';
  const wantGuid = DATA?.model?.viewableGuid ?? null;
  let pick = null;
  if (wantGuid) pick = nodes.find(n => n.data?.guid === wantGuid) ?? null;
  if (!pick) pick = nodes.find(n => n.data?.name === wantName) ?? null;
  if (!pick) pick = nodes.find(n => String(n.data?.name ?? '').includes(wantName)) ?? null;
  if (!pick) {
    let bestVol = -1;
    for (const n of nodes) {
      const bb = n.data?.boundingBox;
      if (!bb?.min || !bb?.max) continue;
      const vol = Math.max(0, bb.max.x - bb.min.x) * Math.max(0, bb.max.y - bb.min.y) * Math.max(0, bb.max.z - bb.min.z);
      if (vol > bestVol) { bestVol = vol; pick = n; }
    }
  }
  if (!pick) pick = root.getDefaultGeometry();
  if (vnum != null) viewableNameByVersion.set(vnum, pick?.data?.name ?? '(default)');
  return pick;
}
function loadVersionModel(vnum) {
  if (diffModelByVersion.has(vnum)) return Promise.resolve(diffModelByVersion.get(vnum));
  const ver = DATA.versions.find(v => v.versionNumber === vnum);
  if (!ver) return Promise.reject(new Error('版 V' + vnum + ' が見つかりません'));
  return new Promise((resolve, reject) => {
    Autodesk.Viewing.Document.load('urn:' + ver.derivativeUrn, (doc) => {
      // keepCurrentModels: もう一方の版を残したまま集約ロードする
      viewer.loadDocumentNode(doc, pickViewable(doc, vnum), { keepCurrentModels: true })
        .then(model => { diffModelByVersion.set(vnum, model); waitGeometry(model).then(() => resolve(model)); })
        .catch(reject);
    }, (code) => reject(new Error(`V${vnum} のドキュメント読み込みに失敗しました（${code}）`)));
  });
}
function extMapping(model) { // externalId -> dbId（モデルごと）
  return new Promise((resolve, reject) => {
    let done = false;
    const ok = m => { if (!done) { done = true; resolve(m ?? {}); } };
    const ng = e => { if (!done) { done = true; reject(e instanceof Error ? e : new Error('externalId マッピングの取得に失敗しました')); } };
    try {
      const r = model.getExternalIdMapping(ok, ng);
      if (r && typeof r.then === 'function') r.then(ok, ng);
    } catch (e) { ng(e); }
  });
}
function allDbIds(model) {
  const tree = model.getInstanceTree();
  if (!tree) return [];
  const ids = [];
  const walk = (id) => { ids.push(id); tree.enumNodeChildren(id, c => walk(c)); };
  walk(tree.getRootId());
  return ids;
}
async function fetchDiffElements() {
  const { from, to } = selectedPair;
  for (let n = 0; n < 90; n++) {
    const r = await fetch(`/api/diff/elements?from=${from}&to=${to}&mode=${diffMode}`);
    const d = await r.json();
    if (r.status === 202) {
      diffStatus(`diff ジョブ実行中です（${d.status ?? ''}）。完了を待っています…`);
      await new Promise(s => setTimeout(s, 10000));
      if (!selectedPair || selectedPair.from !== from || selectedPair.to !== to) throw new Error('ペアが切り替わりました');
      continue;
    }
    if (!r.ok) throw new Error(d.error ?? ('HTTP ' + r.status));
    diffElements = d;
    return d;
  }
  throw new Error('diff ジョブが時間内に完了しませんでした');
}
function updateBaControls() {
  const has = !!diffViewCtx;
  const plain = !!diffViewCtx?.plain;
  for (const b of document.querySelectorAll('[data-bamode]')) {
    b.disabled = !has;
    b.classList.toggle('active', b.dataset.bamode === diffViewMode);
  }
  for (const b of document.querySelectorAll('[data-scope]')) {
    b.disabled = !has || plain; // all モード（plain）では分類自体が無いため表示範囲は切り替えない
    b.classList.toggle('active', b.dataset.scope === diffScope);
  }
  const occ = $('occRange');
  if (occ) {
    occ.disabled = !has || plain || diffScope !== 'focus';
    occ.value = String(occluderRange);
    $('occVal').textContent = occluderRange + '%';
  }
}
function setDiffViewMode(m) {
  diffViewMode = m;
  updateBaControls();
  applyDiffViewMode();
  applyOccluders();
  buildLabels();
}
function setDiffScope(s) {
  if (diffScope === s) return;
  diffScope = s;
  updateBaControls();
  applyDiffViewMode();
  applyOccluders();
  buildLabels();
}
// ---- 要素単位の実透過（ゴースト表示） ----
// テーマカラーの第4成分は公式仕様で「intensity（元の色との混合率）」であり透明度ではない。
// そのため削除要素の「透明＋赤」は、フラグメントのマテリアルを半透明マテリアルに
// 差し替えて実現する（APS 公式ブログの material swatch 方式: matman().addMaterial +
// FragmentList.setMaterial。統合モデルでは unconsolidate が必要な場合がある）。
// 差し替えたフラグメントは台帳に記録し、表示の再適用時に元のマテリアルへ戻す。
let matOverrideLedger = []; // { model, frags, fragId, orig }
const unconsolidatedModels = new WeakSet();
let ghostMats = null;
function ghostMaterial(kind) {
  if (ghostMats?.[kind]) return ghostMats[kind];
  const T = window.THREE ?? window.Autodesk?.Viewing?.Private?.THREE;
  if (!T?.MeshBasicMaterial) return null;
  const conf = kind === 'removed'
    ? { color: 0xd42b1a, opacity: 0.45 }
    : { color: 0xe6b326, opacity: 0.35 };
  const mat = new T.MeshBasicMaterial({ color: conf.color, transparent: true, opacity: conf.opacity, depthWrite: false });
  try { viewer.impl.matman().addMaterial('hg-ghost-' + kind, mat, true); } catch (e) {}
  (ghostMats ??= {})[kind] = mat;
  return mat;
}
function applyTransparentGhost(model, dbIds, mat) {
  if (!model || !dbIds?.length || !mat) return false;
  try {
    if (!unconsolidatedModels.has(model)) {
      try { model.unconsolidate?.(); } catch (e) {}
      unconsolidatedModels.add(model);
    }
    const tree = model.getInstanceTree();
    const frags = model.getFragmentList();
    if (!tree || typeof frags?.setMaterial !== 'function') return false;
    let applied = 0;
    for (const db of dbIds) {
      tree.enumNodeFragments(db, (fragId) => {
        if (!matOverrideLedger.some(e => e.model === model && e.fragId === fragId)) {
          let orig = null;
          try { orig = frags.getMaterial(fragId); } catch (e) {}
          matOverrideLedger.push({ model, frags, fragId, orig });
        }
        frags.setMaterial(fragId, mat);
        applied++;
      }, true);
    }
    if (applied) { try { viewer.impl.invalidate(true); } catch (e) {} }
    return applied > 0;
  } catch (e) { return false; }
}
function restoreMaterialOverrides(onlyModel = null) {
  const keep = [];
  for (const e of matOverrideLedger) {
    if (onlyModel && e.model !== onlyModel) { keep.push(e); continue; }
    try { if (e.orig) e.frags.setMaterial(e.fragId, e.orig); } catch (err) {}
  }
  matOverrideLedger = keep;
}
// 分類済みコンテキスト（diffViewCtx）に対して、表示モードに応じた表示／非表示と色付けだけを適用する。
// モード切替ではモデルも要素リストも再取得しない。
// 表示範囲（差分フォーカス／全体）の違いは、ここでの基本表示ではなく、この上に重なる
// 「手前の部材の透明化（applyOccluders）＋引出線ラベル（buildLabels）」で作る:
// 差分フォーカスでも変更のない要素は文脈として残す（sample-d の occluder removal 方式。
// 旧方式の「変更要素とその周辺以外を全部隠す」は廃止）。
function applyDiffViewMode() {
  if (!viewer || !diffViewCtx) return;
  const ctx = diffViewCtx;
  const THREE = window.THREE;
  if (!THREE) return;
  const V4 = (r, g, b, a) => new THREE.Vector4(r, g, b, a);
  const { fromM, toM } = ctx;
  const show = (model, ids) => { if (ids.length) { try { viewer.show(ids, model); } catch (e) {} } };
  const hide = (model, ids) => { if (ids.length) { try { viewer.hide(ids, model); } catch (e) {} } };
  const theme = (model, ids, v4) => { for (const db of ids) { try { viewer.setThemingColor(db, v4, model); } catch (e) {} } };
  const rest = (all, keep) => { const s = new Set(keep); return all.filter(id => !s.has(id)); };
  // 前回の isolate 状態を解除してから、明示的な表示／非表示リストで状態を作り直す
  try { viewer.isolate([], fromM); } catch (e) {}
  try { viewer.isolate([], toM); } catch (e) {}
  try { viewer.clearThemingColors(fromM); } catch (e) {}
  try { viewer.clearThemingColors(toM); } catch (e) {}
  restoreMaterialOverrides(); // 前回適用した実透過（マテリアル差し替え）を元に戻してから作り直す
  // この適用で明示表示される要素は、前に透明化した要素を含めて正の状態に戻るため、
  // 透明化の台帳はリセットする（直後に applyOccluders が現視点で再適用する）
  hiddenOccluders = new Map();
  occHiddenTotal = 0;
  if (ctx.plain) {
    // all モード: 要素単位の分類・色付けはせず、モデル単位で Before／After を切り替えるだけ
    if (diffViewMode === 'before') { show(fromM, ctx.allFrom); hide(toM, ctx.allTo); }
    else if (diffViewMode === 'after') { show(toM, ctx.allTo); hide(fromM, ctx.allFrom); }
    else { show(fromM, ctx.allFrom); show(toM, ctx.allTo); }
    return;
  }
  // 基本表示（フォーカス／全体で共通）: After は全要素、Before はモードに応じて
  // 全要素 or 削除＋変更のみ重ねる。フォーカスの「寄せ」は透明化と引出線が担う
  const visTo = diffViewMode === 'before' ? [] : ctx.allTo;
  const visFrom = diffViewMode === 'after' ? []
    : diffViewMode === 'before' ? ctx.allFrom
    : diffGhostOld ? [...ctx.removedDb, ...ctx.changedFromDb] : [...ctx.removedDb];
  show(toM, visTo);
  hide(toM, rest(ctx.allTo, visTo));
  show(fromM, visFrom);
  hide(fromM, rest(ctx.allFrom, visFrom));
  // 変更がかかっていない要素は白で表示する（UI 簡素化の要件、2026-11-17）。
  // 透明化ではなくテーマカラー白（不透明）を選んだ理由: 変更要素の色付けと同じ
  // setThemingColor の経路で数行で済み、描画も不透明パスのまま（透明化は
  // 透明パス＋ソートが全要素にかかり、ゴーストも結局は描画されるため重い）。
  const unchangedTo = rest(ctx.allTo, [...ctx.addedToDb, ...ctx.changedToDb]);
  const unchangedFrom = rest(ctx.allFrom, [...ctx.removedDb, ...ctx.changedFromDb]);
  if (diffViewMode === 'before') {
    // Before のみ: 旧版の姿で見せる（削除=赤、変更=黄、変更なし=白）
    theme(fromM, ctx.removedDb, V4(0.85, 0.16, 0.1, 0.9));
    theme(fromM, ctx.changedFromDb, V4(0.95, 0.72, 0.08, 0.9));
    theme(fromM, unchangedFrom, V4(1, 1, 1, 1));
  } else if (diffViewMode === 'after') {
    // After のみ: 新版の姿で見せる（追加=緑、変更=黄、変更なし=白）
    theme(toM, ctx.addedToDb, V4(0.1, 0.65, 0.3, 1));
    theme(toM, ctx.changedToDb, V4(0.95, 0.72, 0.08, 1));
    theme(toM, unchangedTo, V4(1, 1, 1, 1));
  } else {
    // 重ねて表示: 新版に色を付け（変更なしは白）、旧版は削除（＋ゴースト ON 時は変更の旧形状）を重ねる
    theme(toM, ctx.addedToDb, V4(0.1, 0.65, 0.3, 1));
    theme(toM, ctx.changedToDb, V4(0.95, 0.72, 0.08, 1));
    theme(toM, unchangedTo, V4(1, 1, 1, 1));
    // 削除要素は「透明＋赤」で重ねる。テーマカラーでは透明にならない（第4成分は
    // 混合率）ため、フラグメントのマテリアルを半透明の赤に差し替える。
    // 差し替えに失敗した場合のみ、従来のテーマカラー（赤の混合）に落とす。
    if (!applyTransparentGhost(fromM, ctx.removedDb, ghostMaterial('removed'))) {
      theme(fromM, ctx.removedDb, V4(0.85, 0.16, 0.1, 0.45));
    }
    if (diffGhostOld) {
      // 変更の旧形状ゴーストも同じ理由で実透過にする（失敗時はテーマカラー）
      if (!applyTransparentGhost(fromM, ctx.changedFromDb, ghostMaterial('changed'))) {
        theme(fromM, ctx.changedFromDb, V4(0.9, 0.7, 0.15, 0.35));
      }
    }
  }
}
async function applyDiffClassification() {
  const fromM = diffModelByVersion.get(selectedPair.from);
  const toM = diffModelByVersion.get(selectedPair.to);
  if (!fromM || !toM || !diffElements) return;
  const [mapFrom, mapTo] = await Promise.all([extMapping(fromM), extMapping(toM)]);
  const dbOf = (map, e) => { const db = map[e.externalId]; return db != null ? db : null; };
  const removedDb = diffElements.removed.map(e => dbOf(mapFrom, e)).filter(db => db != null);
  const changedFromDb = diffElements.changed.map(e => dbOf(mapFrom, e)).filter(db => db != null);
  const addedToDb = diffElements.added.map(e => dbOf(mapTo, e)).filter(db => db != null);
  const changedToDb = diffElements.changed.map(e => dbOf(mapTo, e)).filter(db => db != null);
  // 分類結果を表示コンテキストとして保持し、見せ方の適用は applyDiffViewMode に寄せる
  diffViewCtx = {
    from: selectedPair.from, to: selectedPair.to, fromM, toM,
    allFrom: allDbIds(fromM), allTo: allDbIds(toM),
    removedDb, changedFromDb, addedToDb, changedToDb,
    mapFrom, mapTo,
  };
  // 見通し・カメラの対象: Issue のアンカー要素を最優先。無ければ変更要素全体の合体ボックス
  const i = issue();
  const ext = i?.pin?.externalId;
  let targetBox = null;
  if (ext) {
    if (mapTo[ext] != null) targetBox = nodeWorldBox(mapTo[ext], toM);
    else if (mapFrom[ext] != null) targetBox = nodeWorldBox(mapFrom[ext], fromM);
  }
  if (!targetBox) {
    targetBox = unionBoxes([
      ...addedToDb.map(db => nodeWorldBox(db, toM)),
      ...changedToDb.map(db => nodeWorldBox(db, toM)),
      ...removedDb.map(db => nodeWorldBox(db, fromM)),
    ]);
  }
  occTarget = targetBox ? { box: targetBox } : null;
  applyDiffViewMode();
  applyOccluders();
  buildLabels();
  updateBaControls();
  const status = () => diffStatus('差分を表示中' + occNote());
  status();
  // カメラは対象の中心へグライドし、到着した視点で見通しを再適用する（静的集合のため）
  if (targetBox) glideToBox(targetBox, () => { applyOccluders(); status(); });
  else if (i?.pin?.position) glideToPoint(i.pin.position);
}
// モデルの見た目を素の状態（全表示・色なし）に戻す。段階ロードで After を先に見せるときに使う
function resetModelPresentation(model) {
  try { viewer.isolate([], model); } catch (e) {}
  try { viewer.clearThemingColors(model); } catch (e) {}
  restoreMaterialOverrides(model);
  const ids = allDbIds(model);
  if (ids.length) { try { viewer.show(ids, model); } catch (e) {} }
}
// 段階ロード: まず After（新版）だけを読み込んで表示し操作可能にする。Before（旧版）は
// 裏で読み込み、要素リストの取得も並行して進め、揃った時点で分類・色分けを適用する。
// all モードでは要素リスト自体を取得せず、色付けもしない（素表示＋Before/After 切替のみ）。
async function showDiff3D() {
  if (!selectedPair || diffBusy) return;
  diffBusy = true;
  const { from, to } = selectedPair;
  const mode = diffMode;
  const stale = () => !selectedPair || selectedPair.from !== from || selectedPair.to !== to || diffMode !== mode;
  try {
    await ensureViewer();
    // このペアに不要な版のモデルは破棄し、必要な2版は読み込み済みを再利用する
    for (const [v, m] of [...diffModelByVersion]) {
      if (v !== from && v !== to) { try { viewer.unloadModel(m); } catch (e) {} matOverrideLedger = matOverrideLedger.filter(e => e.model !== m); diffModelByVersion.delete(v); }
    }
    diffViewCtx = null; // 分類が済むまで切替ボタンは無効（古いペアの分類で切り替える事故防止）
    occTarget = null;
    clearLabels();
    updateBaControls();
    // 段階 1: After（最新版）を先に表示する
    if (!diffModelByVersion.has(to)) { diffStatus('モデルを読み込み中…'); await loadVersionModel(to); }
    if (stale()) return;
    resetModelPresentation(diffModelByVersion.get(to));
    diffPairShown = { from, to };
    diffStatus('差分を準備中…');
    const pinPos = issue()?.pin?.position;
    if (pinPos) glideToPoint(pinPos);
    // 要素リストの取得は Before のロードと並行して進める（geometry モードのみ）
    let elementsPromise = null, elementsError = null;
    if (mode === 'geometry') {
      elementsPromise = fetchDiffElements().catch(e => { elementsError = e; return null; });
    }
    // 段階 2: Before を読み込む（この間も After は操作できる）
    if (!diffModelByVersion.has(from)) await loadVersionModel(from);
    if (stale()) return;
    const fromM = diffModelByVersion.get(from);
    const toM = diffModelByVersion.get(to);
    if (mode === 'all') {
      diffViewCtx = { plain: true, from, to, fromM, toM, allFrom: allDbIds(fromM), allTo: allDbIds(toM) };
      applyDiffViewMode();
      updateBaControls();
      diffStatus('差分を表示中');
      return;
    }
    // 段階 3: 分類・色分けを適用する
    diffStatus('色分けを適用中…');
    const els = await elementsPromise;
    if (stale()) return;
    if (!els) throw elementsError ?? new Error('要素リストを取得できませんでした');
    await applyDiffClassification();
  } catch (e) {
    if (!stale()) diffStatus('3D 差分を表示できませんでした: ' + e.message);
  } finally {
    diffBusy = false;
    // 読み込み中に選択ペアが変わっていたら、新しいペアで読み直す
    if (selectedPair && (selectedPair.from !== from || selectedPair.to !== to)) showDiff3D();
  }
}
// ============ 選択・初期化 ============
function latestVersionNumber() {
  const vs = (DATA?.versions ?? []).map(v => v.versionNumber).filter(n => n != null);
  return vs.length ? Math.max(...vs) : null;
}
// ピン時点の版: スナップショットがあればその pinnedVersion。無ければサーバの
// pinnedVersionFor と同じ規則（Issue 作成時刻以前に公開された最新の版）で求める。
// 対象モデルにピンが無い Issue では null（＝差分なし、最新版のみ表示）。
function pinnedVersionOf(i, ps) {
  if (ps?.pinnedVersion != null) return ps.pinnedVersion;
  if (!i?.pin?.isArchitectural) return null;
  const cands = (DATA?.versions ?? []).filter(v => v.createdAt && i.createdAt && v.createdAt <= i.createdAt);
  if (cands.length) return cands[cands.length - 1].versionNumber;
  return DATA?.versions?.[0]?.versionNumber ?? null;
}
// ビューアの比較ペアは「ピン時点の版 → 最新版」に固定する（ピッカーは置かない）。
// ピンが無い／ピン時点が最新版そのものの場合は、最新版のみを差分配色なしで表示する。
function applyViewerTarget(ps) {
  const i = issue();
  const latest = latestVersionNumber();
  const pinned = i ? pinnedVersionOf(i, ps) : null;
  if (pinned != null && latest != null && pinned < latest) {
    selectedPair = { from: pinned, to: latest, version: latest };
    showDiff3D();
  } else {
    selectedPair = null;
    showLatestOnly();
  }
}
// ピンが無い Issue 用: 最新版だけを読み込んで素の状態で表示する
async function showLatestOnly() {
  const latest = latestVersionNumber();
  if (latest == null) return;
  const mySel = selectedId;
  const still = () => selectedId === mySel && !selectedPair;
  try {
    await ensureViewer();
    if (!still()) return;
    for (const [v, m] of [...diffModelByVersion]) {
      if (v !== latest) { try { viewer.unloadModel(m); } catch (e) {} diffModelByVersion.delete(v); }
    }
    diffViewCtx = null;
    occTarget = null;
    clearLabels();
    updateBaControls();
    if (!diffModelByVersion.has(latest)) { diffStatus('モデルを読み込み中…'); await loadVersionModel(latest); }
    if (!still()) return;
    resetModelPresentation(diffModelByVersion.get(latest));
    diffPairShown = null;
    diffStatus('最新版を表示中（ピンが無いため差分なし）');
    const pinPos = issue()?.pin?.position;
    if (pinPos) glideToPoint(pinPos);
  } catch (e) {
    if (still()) diffStatus('モデルを表示できませんでした: ' + e.message);
  }
}
// 関連ペアの判定はサーバ側でライブ diff ジョブが要るため、初回は pending になることがある。
// ジョブ完了後に自動でタイムラインへ反映するため、pending の間は /api/issues を取り直す。
let relatedPollTimer = null, relatedPollTries = 0;
function scheduleRelatedPoll() {
  clearTimeout(relatedPollTimer);
  const i = issue();
  if (!i?.history?.relatedPairsPending || relatedPollTries >= 12) return;
  relatedPollTimer = setTimeout(async () => {
    relatedPollTries++;
    const keepId = selectedId, keepPair = selectedPair;
    try {
      const r = await fetch('/api/issues');
      if (r.ok && selectedId === keepId) {
        DATA = await r.json();
        buildChips();
        buildTable();
        await buildTimeline();
        if (!selectedPair) {
          const ps = await loadPinSnap(keepId);
          if (selectedId === keepId && pinnedVersionOf(issue(), ps) != null) applyViewerTarget(ps);
        }
      }
    } catch (e) { /* 次回に再試行 */ }
    scheduleRelatedPoll();
  }, 15000);
}
async function selectIssue(id) {
  if (selectedId !== id) relatedPollTries = 0;
  selectedId = id;
  diffViewCtx = null; // Issue が変われば表示中の分類は別ペアのものになり得るため破棄
  updateBaControls();
  buildTable();
  const ps = await loadPinSnap(id);
  if (selectedId !== id) return; // 待っている間に選択が切り替わっていたら中断
  applyViewerTarget(ps);
  await buildTimeline();
  scheduleRelatedPoll();
}
async function loadAll() {
  const r = await fetch('/api/issues');
  if (!r.ok) throw new Error('Issue の取得に失敗しました（HTTP ' + r.status + '）');
  DATA = await r.json();
  $('headNote').textContent = `${DATA.project.name} — ${DATA.model.name}`;
  buildChips();
  buildTable();
  // 初期選択は、現在の対象モデルにピンされた最新の Issue を既定にする
  // （旧アイテム等、別モデルにピンされた Issue が初期選択にならないようにする）
  const byDesc = DATA.issues.slice().sort((a, b) => (b.displayId ?? 0) - (a.displayId ?? 0));
  const first = byDesc.find(i => i.pin?.isArchitectural) ?? byDesc.find(i => i.pin) ?? byDesc[0];
  if (first) selectIssue(first.id, false);
}
$('fltQ').addEventListener('input', () => { flt.q = $('fltQ').value.trim(); flt.page = 1; buildTable(); });
$('pageSize').addEventListener('change', () => { flt.pageSize = Number($('pageSize').value); flt.page = 1; buildTable(); });
$('btnPrev').addEventListener('click', () => { if (flt.page > 1) { flt.page--; buildTable(); } });
$('btnNext').addEventListener('click', () => { flt.page++; buildTable(); });
for (const b of document.querySelectorAll('[data-bamode]')) {
  b.addEventListener('click', () => setDiffViewMode(b.dataset.bamode));
}
for (const b of document.querySelectorAll('[data-scope]')) {
  b.addEventListener('click', () => setDiffScope(b.dataset.scope));
}
// 手前を消す範囲スライダ: 変更は設定として保存し、フォーカス中なら現視点で再適用する
$('occRange').addEventListener('input', () => {
  occluderRange = Number($('occRange').value);
  localStorage.setItem('hgraph-occluder-range', String(occluderRange));
  $('occVal').textContent = occluderRange + '%';
  applyOccluders();
});
updateBaControls();
$('btnRefresh').addEventListener('click', async () => {
  $('btnRefresh').disabled = true;
  try {
    const r = await (await fetch('/api/refresh', { method: 'POST' })).json();
    commentsCache.clear();
    await loadAll();
    $('headNote').textContent += `／取り込み完了: 新しい変化イベント ${r.newEvents} 件`;
  } catch (e) {
    $('errBox').style.display = 'block';
    $('errBox').textContent = '取り込みに失敗しました: ' + e.message;
  } finally { $('btnRefresh').disabled = false; }
});
loadAll().catch(e => {
  $('errBox').style.display = 'block';
  $('errBox').textContent = '読み込みに失敗しました: ' + e.message;
});
