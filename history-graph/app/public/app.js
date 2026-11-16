// app.js — 履歴グラフ実アプリ v1 の画面ロジック
// Issue 表（sample-d のトンマナ＋モックのページング/ソート/検索）／タイムライン／差分ビュー／APS Viewer
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
let selectedPair = null;     // { from, to, version } 選択中のモデル更新イベントの diff ペア
let commentsCache = new Map();
const flt = { q: '', status: 'all', sort: null, page: 1, pageSize: 5 };

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
    list.sort((a, b) => (a.displayId ?? 0) - (b.displayId ?? 0));
  }
  return list;
}
function miniGraph(i) {
  const h = i.history;
  const nodes = [{ cls: 'start', label: '開', title: '起票（Open）' }];
  for (const m of h.modelUpdates) nodes.push({ cls: 'model', label: 'V' + m.version, title: `モデル更新 V${m.version}（${fmtDate(m.publishedAt)}）` });
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
async function buildTimeline() {
  const i = issue();
  if (!i) { $('tlTitle').textContent = '—'; $('tlBody').innerHTML = ''; return; }
  const [label] = FSTATUS[i.status] ?? [i.status];
  $('tlTitle').textContent = `#${i.displayId ?? ''} ${i.title ?? ''}`;
  $('tlMeta').innerHTML = [
    `<span class="tag">${esc(label)}</span>`,
    i.typeLabel ? `<span class="tag">${esc(i.typeLabel)}</span>` : '',
    `<span>担当: ${esc(i.assignedToName ?? i.assignedTo ?? '—')}</span>`,
    `<span>起票: ${esc(i.createdByName ?? i.createdBy ?? '—')}</span>`,
    i.pin ? `<span>ピン: ${esc(i.pin.viewName ?? 'あり')}</span>` : '<span>ピンなし</span>',
  ].join('');
  // ピン時点のサムネイル（Forma が Issue 作成時に保存したビュー画像）。
  // snapshotUrn が無い Issue では表示自体を省略する（プレースホルダは出さない）
  const tw = $('tlThumbWrap'), timg = $('tlThumb');
  if (i.snapshotUrn) {
    tw.hidden = false;
    timg.onerror = () => { tw.hidden = true; };
    timg.src = `/api/issues/${encodeURIComponent(i.id)}/thumbnail`;
  } else {
    tw.hidden = true;
    timg.removeAttribute('src');
  }
  const comments = await loadComments(i.id);
  const evs = [];
  evs.push({ t: i.createdAt, cls: 'open', html: `<b>起票</b> — ${esc(i.createdByName ?? '')} が Open` });
  for (const c of comments) {
    evs.push({ t: c.createdAt, cls: 'comment', html: `<b>コメント</b> — ${esc(c.createdByName ?? '')}`, body: c.body });
  }
  for (const e of i.history.events) {
    if (e.kind === 'status') {
      if (e.to === 'closed') evs.push({ t: e.detectedAt, cls: 'goal', html: `<b>Close 🏁</b> — ${esc(STATUS_JA[e.from] ?? e.from)} <span class="st-arrow">→</span> 完了`, note: 'スナップショット検出時刻' });
      else if (e.from === 'closed') evs.push({ t: e.detectedAt, cls: 'reopen', html: `<b>Reopen</b> — 完了 <span class="st-arrow">→</span> ${esc(STATUS_JA[e.to] ?? e.to)}`, note: 'スナップショット検出時刻' });
      else evs.push({ t: e.detectedAt, cls: 'status', html: `<b>状態変更</b> — ${esc(STATUS_JA[e.from] ?? e.from)} <span class="st-arrow">→</span> ${esc(STATUS_JA[e.to] ?? e.to)}`, note: 'スナップショット検出時刻' });
    } else if (e.kind === 'assignee') {
      evs.push({ t: e.detectedAt, cls: 'status', html: `<b>担当変更</b> — ${esc(e.from ?? '—')} <span class="st-arrow">→</span> ${esc(e.to ?? '—')}`, note: 'スナップショット検出時刻' });
    }
  }
  for (const m of i.history.modelUpdates) {
    evs.push({
      t: m.publishedAt, cls: 'model', pair: m.diffPair, version: m.version,
      html: `<b>モデル更新 V${m.version}</b> — ${esc(DATA.model.name)}`,
      note: m.note ?? (m.diffPair ? `差分: ${m.diffPair.label}` : ''),
    });
  }
  evs.sort((a, b) => String(a.t ?? '').localeCompare(String(b.t ?? '')));
  if (i.status !== 'closed') evs.push({ t: null, cls: 'now', html: '<b>現在</b> — オープン中' });
  $('tlBody').innerHTML = evs.map((e, idx) => `
    <div class="ev ${e.cls}${e.pair && selectedPair && e.pair.from === selectedPair.from && e.pair.to === selectedPair.to ? ' selected' : ''}">
      <span class="ev-dot"></span>
      ${e.pair
        ? `<button type="button" class="ev-row" data-ev="${idx}"><span class="ev-when">${esc(fmtDateTime(e.t))}</span><span class="ev-text">${e.html}${e.note ? `<div class="ev-body">${esc(e.note)}</div>` : ''}</span></button>`
        : `<div class="ev-row"><span class="ev-when">${e.t ? esc(fmtDateTime(e.t)) : ''}</span><span class="ev-text">${e.html}${e.body ? `<div class="ev-body">${esc(e.body)}</div>` : ''}${e.note ? `<div class="ev-body">${esc(e.note)}</div>` : ''}</span></div>`}
    </div>`).join('');
  for (const b of $('tlBody').querySelectorAll('button.ev-row')) {
    b.addEventListener('click', () => {
      const e = evs[Number(b.dataset.ev)];
      if (e?.pair) { selectedPair = { ...e.pair, version: e.version }; buildTimeline(); loadDiff(true); updateViewerButton(); }
    });
  }
}

// ============ 差分ビュー ============
let diffMode = 'geometry';   // 3D 表示の「変更」の範囲: 'geometry'（形状のみ・既定）| 'all'（プロパティのみも含む）
let diffGhostOld = true;     // 変更前の形状をゴースト表示するか
function countsChips(stats, geom) {
  let s = `<span class="dc a">追加 ${stats.added}</span><span class="dc d">削除 ${stats.removed}</span><span class="dc c">変更 ${stats.modified}</span>`;
  if (geom) s += `<span class="dc g">うち形状シグナル 追加 ${geom.added}／削除 ${geom.removed}／変更 ${geom.modified}</span>`;
  return s;
}
async function loadDiff(auto3d) {
  const i = issue();
  if (!i || !selectedPair) {
    $('diffTitle').textContent = '差分ビュー';
    $('diffCounts').innerHTML = '';
    $('diffBody').innerHTML = '<div class="diff-empty">タイムラインの「モデル更新」イベントを選ぶと、その版ペアの差分が出ます。</div>';
    return;
  }
  const { from, to } = selectedPair;
  $('diffTitle').textContent = `差分ビュー — ${selectedPair.label ?? `V${from} → V${to}`}`;
  $('diffBody').innerHTML = '<div class="diff-empty">読み込み中…</div>';
  let d;
  try {
    const r = await fetch(`/api/diff?from=${from}&to=${to}&issue=${encodeURIComponent(i.id)}`);
    d = await r.json();
    if (r.status === 202) {
      $('diffBody').innerHTML = `<div class="diff-empty">実 API で diff ジョブを実行中です（${esc(d.status ?? '')}）。10 秒後に自動で再取得します。</div>`;
      setTimeout(() => { if (selectedPair && selectedPair.from === from && selectedPair.to === to) loadDiff(auto3d); }, 10000);
      return;
    }
    if (!r.ok) throw new Error(d.error ?? ('HTTP ' + r.status));
  } catch (e) {
    $('diffBody').innerHTML = `<div class="diff-empty">差分を取得できませんでした: ${esc(e.message)}</div>`;
    return;
  }
  $('diffCounts').innerHTML = countsChips(d.stats, null);
  const np = d.nearPin;
  let side = '';
  if (d.pinNote) {
    side = `<p class="diff-note">${esc(d.pinNote)}</p>`;
  } else if (np) {
    $('diffCounts').innerHTML = countsChips(d.stats, np.geomCounts);
    const listItems = np.rows.slice(0, 30).map(r => {
      const props = r.changedProps?.length ? `（${esc(r.changedProps.slice(0, 4).join('、'))}）` : '';
      return `<li class="${r.signal ? 'sig' : ''}">${esc(r.type === 'added' ? '追加' : r.type === 'removed' ? '削除' : '変更')}：${esc(r.name ?? r.externalId ?? '')}${props}</li>`;
    }).join('');
    side = `
      <p class="diff-near">ピン周辺（対象要素「${esc(np.anchorName ?? '')}」の中心から水平 ${np.radiusFt}ft／上下 ±${np.dzFt}ft）: 追加 ${np.counts.added}／削除 ${np.counts.removed}／変更 ${np.counts.modified} 件（bbox を持つ行のみ）</p>
      <ul>${listItems || '<li>周辺に bbox を持つ変更はありません</li>'}</ul>
      ${np.rowsTruncated ? `<p class="diff-note">周辺 ${np.rowsTotal} 件中、形状シグナルのある行を優先して ${np.rows.length} 件まで表示しています。</p>` : ''}
      <p class="diff-note">「変更」件数には Revit の再保存に伴うプロパティ表記の揺れ（ロケール差など）が大量に含まれます。実際に形が変わった目安は「形状シグナル」（形状ハッシュ変化・bbox 移動）の件数です。近傍の判定はヒューリスティクスであり、この Issue の修正そのものとは限りません。</p>`;
  }
  if (d.jobRunAt) side += `<p class="diff-note">diff データはこのアプリが ${esc(fmtDateTime(d.jobRunAt))} に Model Properties API のジョブで取得しました。</p>`;
  $('diffBody').innerHTML = `<div class="diff-body">
    <div class="diff-controls">
      <div class="dc-group" role="group" aria-label="3D表示の対象">
        <span class="dc-label">3D表示の「変更」:</span>
        <button type="button" class="dc-btn${diffMode === 'geometry' ? ' active' : ''}" data-dmode="geometry">形状が変わったもののみ（既定）</button>
        <button type="button" class="dc-btn${diffMode === 'all' ? ' active' : ''}" data-dmode="all">プロパティのみの変更も含める</button>
      </div>
      <label class="dc-check"><input type="checkbox" id="diffGhostOld" ${diffGhostOld ? 'checked' : ''}> 変更前の形状をゴースト表示</label>
      <button type="button" class="btn primary" id="btnDiff3d">差分を 3D で表示</button>
      <span class="dc-status" id="diff3dStatus"></span>
    </div>
    <div class="legend"><span><i class="la"></i>追加（新版のみ・緑）</span><span><i class="ld"></i>削除（旧版のみ・赤ゴースト）</span><span><i class="lc"></i>変更（新版・黄／旧版はゴースト）</span><span>変更なしは新版のみ表示</span></div>
    <div class="diff-side">${side}</div>
  </div>`;
  for (const b of $('diffBody').querySelectorAll('[data-dmode]')) {
    b.addEventListener('click', () => {
      if (diffMode === b.dataset.dmode) return;
      diffMode = b.dataset.dmode;
      for (const x of $('diffBody').querySelectorAll('[data-dmode]')) x.classList.toggle('active', x.dataset.dmode === diffMode);
      reapplyDiff3D();
    });
  }
  $('diffGhostOld').addEventListener('change', () => { diffGhostOld = $('diffGhostOld').checked; reapplyDiff3D(); });
  $('btnDiff3d').addEventListener('click', () => showDiff3D());
  if (auto3d) showDiff3D();
}

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
function updateViewerButton() {
  $('btnViewer').disabled = !(issue() && selectedPair);
}
function diffStatus(msg) {
  const el = $('diff3dStatus');
  if (el) el.textContent = msg;
  $('viewerNote').textContent = msg;
}
function focusPin() {
  const i = issue();
  if (!viewer || !i?.pin?.position) return;
  try {
    const p = i.pin.position;
    const THREE = window.THREE;
    if (!THREE) return;
    const pos = new THREE.Vector3(p.x + 45, p.y + 45, p.z + 45);
    const tgt = new THREE.Vector3(p.x, p.y, p.z);
    viewer.navigation.setView(pos, tgt);
  } catch (e) { /* フィット失敗は致命的ではない */ }
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
function loadVersionModel(vnum) {
  if (diffModelByVersion.has(vnum)) return Promise.resolve(diffModelByVersion.get(vnum));
  const ver = DATA.versions.find(v => v.versionNumber === vnum);
  if (!ver) return Promise.reject(new Error('版 V' + vnum + ' が見つかりません'));
  return new Promise((resolve, reject) => {
    Autodesk.Viewing.Document.load('urn:' + ver.derivativeUrn, (doc) => {
      // keepCurrentModels: もう一方の版を残したまま集約ロードする
      viewer.loadDocumentNode(doc, doc.getRoot().getDefaultGeometry(), { keepCurrentModels: true })
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
async function applyDiffClassification() {
  const fromM = diffModelByVersion.get(selectedPair.from);
  const toM = diffModelByVersion.get(selectedPair.to);
  if (!fromM || !toM || !diffElements) return;
  const THREE = window.THREE;
  if (!THREE) return;
  const V4 = (r, g, b, a) => new THREE.Vector4(r, g, b, a);
  const [mapFrom, mapTo] = await Promise.all([extMapping(fromM), extMapping(toM)]);
  const dbOf = (map, e) => { const db = map[e.externalId]; return db != null ? db : null; };
  // 旧版: 削除（＋トグル時は変更の旧形状）だけを残し、残りは全て隠す
  const removedDb = diffElements.removed.map(e => dbOf(mapFrom, e)).filter(db => db != null);
  const changedFromDb = diffElements.changed.map(e => dbOf(mapFrom, e)).filter(db => db != null);
  const keepFrom = diffGhostOld ? [...removedDb, ...changedFromDb] : [...removedDb];
  try { viewer.clearThemingColors(fromM); } catch (e) {}
  try {
    if (keepFrom.length) viewer.isolate(keepFrom, fromM);
    else viewer.hide(allDbIds(fromM), fromM);
  } catch (e) {}
  for (const db of removedDb) { try { viewer.setThemingColor(db, V4(0.85, 0.16, 0.1, 0.45), fromM); } catch (e) {} }
  if (diffGhostOld) for (const db of changedFromDb) { try { viewer.setThemingColor(db, V4(0.9, 0.7, 0.15, 0.35), fromM); } catch (e) {} }
  // 新版: 追加=緑、変更=黄（変更なし・追加・変更はそのまま表示）
  try { viewer.clearThemingColors(toM); } catch (e) {}
  for (const e of diffElements.added) { const db = dbOf(mapTo, e); if (db != null) { try { viewer.setThemingColor(db, V4(0.1, 0.65, 0.3, 1), toM); } catch (err) {} } }
  for (const e of diffElements.changed) { const db = dbOf(mapTo, e); if (db != null) { try { viewer.setThemingColor(db, V4(0.95, 0.72, 0.08, 1), toM); } catch (err) {} } }
  // ピン対象要素があればそこへフィット（無ければピン座標へ）
  const i = issue();
  let fitted = false;
  const ext = i?.pin?.externalId;
  if (ext) {
    if (mapTo[ext] != null) { try { viewer.fitToView([mapTo[ext]], toM); fitted = true; } catch (e) {} }
    else if (mapFrom[ext] != null) { try { viewer.fitToView([mapFrom[ext]], fromM); fitted = true; } catch (e) {} }
  }
  if (!fitted) focusPin();
  diffStatus(`3D 差分を表示中: V${selectedPair.from} → V${selectedPair.to}（追加 ${diffElements.counts.added}／削除 ${diffElements.counts.removed}／変更 ${diffElements.counts.changed}${diffMode === 'geometry' ? '・形状のみ' : '・プロパティのみ含む'}）`);
}
async function showDiff3D() {
  if (!issue() || !selectedPair || diffBusy) return;
  diffBusy = true;
  try {
    await ensureViewer();
    const { from, to } = selectedPair;
    // このペアに不要な版のモデルは破棄し、必要な2版は読み込み済みを再利用する
    for (const [v, m] of [...diffModelByVersion]) {
      if (v !== from && v !== to) { try { viewer.unloadModel(m); } catch (e) {} diffModelByVersion.delete(v); }
    }
    if (!diffModelByVersion.has(from)) { diffStatus(`V${from}（旧版）を読み込み中…`); await loadVersionModel(from); }
    if (!diffModelByVersion.has(to)) { diffStatus(`V${to}（新版）を読み込み中…`); await loadVersionModel(to); }
    diffPairShown = { from, to };
    diffStatus('要素リストを取得中…');
    await fetchDiffElements();
    await applyDiffClassification();
  } catch (e) {
    diffStatus('3D 差分を表示できませんでした: ' + e.message);
  } finally { diffBusy = false; }
}
function reapplyDiff3D() {
  // モード／ゴーストの切替: 表示中のペアが現在の選択と同じなら、モデルは再利用して分類だけやり直す
  if (diffPairShown && selectedPair && diffPairShown.from === selectedPair.from && diffPairShown.to === selectedPair.to) {
    showDiff3D();
  }
}

// ============ 選択・初期化 ============
function selectIssue(id, scrollTimeline) {
  selectedId = id;
  const i = issue();
  // 既定の差分ペア：diffPair を持つ最新のモデル更新
  const withPair = (i?.history.modelUpdates ?? []).filter(m => m.diffPair);
  selectedPair = withPair.length ? { ...withPair[withPair.length - 1].diffPair, version: withPair[withPair.length - 1].version } : null;
  buildTable();
  buildTimeline().then(() => { loadDiff(); });
  updateViewerButton();
}
async function loadAll() {
  const r = await fetch('/api/issues');
  if (!r.ok) throw new Error('Issue の取得に失敗しました（HTTP ' + r.status + '）');
  DATA = await r.json();
  $('headNote').textContent = `${DATA.project.name} — ${DATA.model.name}（V${DATA.versions.map(v => v.versionNumber).join(' / ')}）／履歴スナップショット: ${DATA.snapshot.refreshCount} 回・変化イベント ${DATA.snapshot.eventCount} 件`;
  buildChips();
  buildTable();
  const first = DATA.issues.slice().sort((a, b) => (a.displayId ?? 0) - (b.displayId ?? 0))[0];
  if (first) selectIssue(first.id, false);
}
$('fltQ').addEventListener('input', () => { flt.q = $('fltQ').value.trim(); flt.page = 1; buildTable(); });
$('pageSize').addEventListener('change', () => { flt.pageSize = Number($('pageSize').value); flt.page = 1; buildTable(); });
$('btnPrev').addEventListener('click', () => { if (flt.page > 1) { flt.page--; buildTable(); } });
$('btnNext').addEventListener('click', () => { flt.page++; buildTable(); });
$('btnViewer').addEventListener('click', () => showDiff3D());
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
