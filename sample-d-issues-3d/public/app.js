// app.js — sample-d の画面ロジック（Issue 一覧／詳細／ビューア／一覧モード）
let DATA = null, selected = null, focusedId = null;
let viewer = null, viewerModelKey = null, rootLoaded = false, geoLoaded = false, tSelect = 0;
let viewerReady = false, desiredModelKey = null;
let blinkTimer = null, blinkOn = false;
const captured = new Map(); // Issue ごとのビューアキャプチャ（スナップショットの代替）
const $ = id => document.getElementById(id);
const LS_COLS = 'sampled-cols-v2', LS_PAGE = 'sampled-pagesize-v2', LS_GHOST = 'sampled-ghost-transparency'; // ユーザー設定の保存キー（互換のため変更しない）
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function issue() { return DATA?.issues.find(i => i.id === selected); }
function issuesOnCurrentModel() { return DATA.issues.filter(x => x.modelKey === viewerModelKey && x.targetDbId); }
function focusedIssue() { return DATA?.issues.find(i => i.id === focusedId); }
const STATUS = { draft: '下書き', open: '未対応', pending: '対応中', in_review: '確認待ち', closed: '完了', void: '無効' };
const FSTATUS = { // Forma 風ステータス表示（色バー＋英語）
  draft: ['Draft', '#8a9aa8'], open: ['Open', '#e8a33d'], pending: ['Pending', '#d97706'],
  in_review: ['In review', '#3b82c4'], closed: ['Closed', '#4caf7d'], void: ['Void', '#8a9aa8'],
};
function fmtDate(s) {
  if (!s) return '-';
  const d = new Date(s + (s.length === 10 ? 'T00:00:00' : ''));
  return isNaN(d) ? s : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function levelOf(e) { return e?.['Level'] ?? e?.['Base Level'] ?? e?.['Reference Level'] ?? e?.['Host Level'] ?? '—'; }
function nameOf(e) { return /\[\d+\]\s*$/.test(e.name) ? e.name : `${e.name} [${e.revitId}]`; }
function locOf(e) { return e?.['Column Location Mark'] ?? e?.['Mark'] ?? e?.['Type Mark'] ?? '—'; }
function modelVersion(i) { const m = DATA?.models.find(x => x.key === i.modelKey); return m?.version != null ? 'V' + m.version : ''; }
function setStatV(t) { $('statV').innerHTML = t; }

// ---- 列定義：Forma の列＋モデル情報から自動追加される列 ----
const PROP_LABELS = {
  'Type Name': 'タイプ名', 'Level': '階', 'Base Level': '基準レベル', 'Reference Level': '参照レベル',
  'Host Level': 'ホストレベル', 'Top Level': '上部レベル', 'Schedule Level': 'スケジュールレベル',
  'Column Location Mark': '位置（通り芯）', 'Mark': 'マーク', 'Type Mark': 'タイプマーク',
  'Structural Material': '材質', 'Structural Usage': '構造用途', 'Category': 'カテゴリ',
  'Family Name': 'ファミリ名', 'Length': '長さ', 'Area': '面積', 'Volume': '体積', 'Elevation from Level': 'レベルからの標高',
};
let COLUMNS = [];
let visibleCols = new Set(JSON.parse(localStorage.getItem(LS_COLS) ?? 'null') ?? ['title', 'status', 'type', 'assignee', 'due', 'start', 'placement']);
function buildColumns() {
  const cols = [
    { id: 'title', label: 'Title', grp: 'Issue', cell: 'title', get: i => i.title },
    { id: 'status', label: 'Status', grp: 'Issue', cell: 'fstatus', get: i => i.status },
    { id: 'type', label: 'Type', grp: 'Issue', cell: 'type', get: i => i.typeLabel ?? '—' },
    { id: 'assignee', label: 'Assigned to', grp: 'Issue', cell: 'assignee', get: i => i.assignedToName ?? '' },
    { id: 'due', label: 'Due date', grp: 'Issue', cell: 'text', get: i => fmtDate(i.dueDate) },
    { id: 'start', label: 'Start date', grp: 'Issue', cell: 'text', get: i => fmtDate(i.startDate) },
    { id: 'placement', label: 'Placement', grp: 'Issue', cell: 'placement', get: i => i.modelFullName ?? '' },
    { id: 'id', label: 'ID', grp: 'Issue', cell: 'text', get: i => i.displayId, mono: true },
    { id: 'created', label: '作成日', grp: 'Issue', cell: 'text', get: i => (i.createdAt ?? '').slice(0, 10) || '—', mono: true },
    { id: 'published', label: '公開', grp: 'Issue', cell: 'text', get: i => i.published ? '公開' : '未公開' },
    { id: 'comments', label: 'コメント', grp: 'Issue', cell: 'text', get: i => i.commentCount ?? 0, mono: true },
    { id: 'attachments', label: '添付', grp: 'Issue', cell: 'text', get: i => i.attachmentCount ?? 0, mono: true },
    { id: 'element', label: '対象要素', grp: 'モデル情報', cell: 'text', get: i => i.element ? nameOf(i.element) : (i.pin ? '対象外モデルのピン' : 'ピンなし') },
    { id: 'model', label: 'モデル', grp: 'モデル情報', cell: 'text', get: i => i.modelName ?? '—' },
    { id: 'level', label: '階', grp: 'モデル情報', cell: 'text', get: i => i.element ? levelOf(i.element) : '—' },
    { id: 'loc', label: '位置', grp: 'モデル情報', cell: 'text', get: i => i.element ? locOf(i.element) : '—' },
  ];
  const freq = new Map();
  for (const i of DATA.issues) if (i.element) for (const k of Object.keys(i.element)) {
    if (['name', 'revitId', 'objectid'].includes(k)) continue;
    freq.set(k, (freq.get(k) ?? 0) + 1);
  }
  for (const [k] of [...freq.entries()].sort((a, b) => b[1] - a[1])) {
    cols.push({ id: 'prop:' + k, label: PROP_LABELS[k] ?? k, grp: 'モデル情報（自動）', cell: 'text', get: i => i.element?.[k] ?? '—' });
  }
  const caLabels = new Set();
  for (const i of DATA.issues) for (const ca of i.customAttributes ?? []) {
    const label = ca.title ?? ca.name ?? ca.attributeId ?? ca.id;
    if (label) caLabels.add(String(label));
  }
  for (const label of caLabels) {
    cols.push({
      id: 'ca:' + label, label, grp: 'カスタム属性', cell: 'text',
      get: i => { const ca = (i.customAttributes ?? []).find(c => String(c.title ?? c.name ?? c.attributeId ?? c.id) === label); return ca?.value ?? '—'; },
    });
  }
  COLUMNS = cols;
  renderColMenu();
}
function renderColMenu() {
  const grps = [...new Set(COLUMNS.map(c => c.grp))];
  $('colMenu').innerHTML = '<input type="text" id="colFilter" placeholder="列名で絞り込み" style="width:100%;box-sizing:border-box;padding:5px 8px;border:1px solid #b9c9d6;border-radius:6px;font-size:12.5px;margin-bottom:4px">' + grps.map(g =>
    `<div class="grp">${esc(g)}</div>` + COLUMNS.filter(c => c.grp === g).map(c =>
      `<label data-label="${esc(c.label.toLowerCase())}"><input type="checkbox" data-col="${esc(c.id)}" ${visibleCols.has(c.id) ? 'checked' : ''}> ${esc(c.label)}</label>`).join('')
  ).join('');
  $('colFilter').addEventListener('input', () => {
    const q = $('colFilter').value.trim().toLowerCase();
    for (const lb of $('colMenu').querySelectorAll('label[data-label]')) lb.style.display = !q || lb.dataset.label.includes(q) ? '' : 'none';
    for (const g of $('colMenu').querySelectorAll('.grp')) {
      let n = g.nextElementSibling, any = false;
      while (n && !n.classList.contains('grp')) { if (n.style.display !== 'none') any = true; n = n.nextElementSibling; }
      g.style.display = any ? '' : 'none';
    }
  });
  $('colFilter').addEventListener('click', (e) => e.stopPropagation());
  for (const cb of $('colMenu').querySelectorAll('input[data-col]')) {
    cb.addEventListener('change', () => {
      if (cb.checked) visibleCols.add(cb.dataset.col); else visibleCols.delete(cb.dataset.col);
      localStorage.setItem(LS_COLS, JSON.stringify([...visibleCols]));
      buildTable();
    });
  }
}
$('btnCols').addEventListener('click', (e) => { e.stopPropagation(); $('colMenu').hidden = !$('colMenu').hidden; });
document.addEventListener('click', (e) => { if (!$('colMenu').hidden && !e.target.closest('.colmenu-wrap')) $('colMenu').hidden = true; });

// ---- Issue 一覧 ----
let PAGE_SIZE = Number(localStorage.getItem(LS_PAGE) ?? 5);
if (![5, 10, 25, 50, 100].includes(PAGE_SIZE)) PAGE_SIZE = 5;
$('pageSize').value = String(PAGE_SIZE);
$('pageSize').addEventListener('change', () => { PAGE_SIZE = Number($('pageSize').value); localStorage.setItem(LS_PAGE, String(PAGE_SIZE)); page = 1; buildTable(); });
let page = 1;
const flt = { q: '', status: 'all', sort: 'id' };
function visibleIssues() {
  const q = flt.q.trim().toLowerCase();
  const list = DATA.issues.filter(i => {
    if (flt.status !== 'all' && i.status !== flt.status) return false;
    if (q) {
      const hay = `${i.title} ${i.description ?? ''} ${i.element?.name ?? ''} ${i.modelName ?? ''} ${i.displayId}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const by = {
    'id': (a, b) => a.displayId - b.displayId,
    'id-desc': (a, b) => b.displayId - a.displayId,
    'due': (a, b) => String(a.dueDate ?? '9999').localeCompare(String(b.dueDate ?? '9999')),
    'due-desc': (a, b) => String(b.dueDate ?? '').localeCompare(String(a.dueDate ?? '')),
    'title': (a, b) => a.title.localeCompare(b.title, 'ja'),
  };
  return list.sort(by[flt.sort] ?? by.id);
}
function cellHtml(c, i) {
  const v = c.get(i);
  switch (c.cell) {
    case 'fstatus': { const [label, color] = FSTATUS[i.status] ?? [i.status, '#8a9aa8']; return `<span class="fst"><i style="background:${color}"></i>${esc(label)}</span>`; }
    case 'type': return i.typeLabel ? `<span class="tchip"><span class="code">${esc(i.typeCode ?? '')}</span><span class="lbl">${esc(i.typeLabel)}</span></span>` : '—';
    case 'assignee': return i.assignedToName ? esc(i.assignedToName) : '<span class="unspec">Unspecified</span>';
    case 'placement': return i.modelFullName ? `<span class="place">${esc(i.modelFullName)}</span>${modelVersion(i) ? `<span class="vpill">${esc(modelVersion(i))}</span>` : ''}` : '-';
    case 'title': return `<span class="titlecell">${i.targetDbId ? `<button class="vbtn" data-view="${i.id}">3D</button>` : '<span class="vbtn-spacer"></span>'}<b style="font-weight:600">${esc(v)}</b></span>`;
    default: return esc(v);
  }
}
function buildTable() {
  const cols = COLUMNS.filter(c => visibleCols.has(c.id));
  $('issueHead').innerHTML = '<tr>' + cols.map(c => `<th>${esc(c.label)}</th>`).join('') + '</tr>';
  const list = visibleIssues();
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  page = Math.min(Math.max(1, page), pages);
  const slice = list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  $('issueRows').innerHTML = slice.map(i =>
    `<tr data-id="${i.id}" class="${i.id === selected ? 'sel' : ''}">` +
    cols.map(c => `<td class="${c.mono ? 'mono' : ''}">${cellHtml(c, i)}</td>`).join('') +
    '</tr>'
  ).join('') || '<tr><td colspan="99" style="color:#68798a">条件に合う Issue はありません。</td></tr>';
  for (const tr of $('issueRows').children) if (tr.dataset.id) tr.addEventListener('click', () => selectIssue(tr.dataset.id));
  for (const b of $('issueRows').querySelectorAll('button[data-view]')) {
    b.addEventListener('click', (e) => { e.stopPropagation(); showInViewer(b.dataset.view); });
  }
  $('pagerInfo').textContent = `${page} / ${pages} ページ（全 ${list.length} 件）`;
  $('btnPrev').disabled = page <= 1;
  $('btnNext').disabled = page >= pages;
}
function markSelectedRow() {
  for (const tr of $('issueRows').children) tr.classList.toggle('sel', tr.dataset.id === selected);
}
$('fltQ').addEventListener('input', () => { flt.q = $('fltQ').value; page = 1; buildTable(); });
$('fltStatus').addEventListener('change', () => { flt.status = $('fltStatus').value; page = 1; buildTable(); });
$('fltSort').addEventListener('change', () => { flt.sort = $('fltSort').value; page = 1; buildTable(); });
$('btnPrev').addEventListener('click', () => { page--; buildTable(); });
$('btnNext').addEventListener('click', () => { page++; buildTable(); });

// ---- 詳細パネル ----
function statusOptions(i) {
  let list = null;
  if (Array.isArray(i.permittedStatuses) && i.permittedStatuses.length) {
    list = i.permittedStatuses.map(s => typeof s === 'string' ? s : (s.status ?? s.value ?? s.id)).filter(Boolean);
  }
  if (!list || !list.length) list = Object.keys(STATUS);
  if (!list.includes(i.status)) list = [i.status, ...list];
  return [...new Set(list)];
}
function setDetailThumb(i) {
  const img = $('dtThumb');
  img.onerror = () => { if (i.modelKey && !img.dataset.fbk) { img.dataset.fbk = '1'; img.src = '/api/thumbnail?model=' + encodeURIComponent(i.modelKey); } else img.hidden = true; };
  img.onload = () => { img.hidden = false; };
  delete img.dataset.fbk;
  if (i.snapshotUrn) img.src = '/api/snapshot?urn=' + encodeURIComponent(i.snapshotUrn);
  else if (captured.has(i.id)) img.src = captured.get(i.id);
  else if (i.modelKey) img.src = '/api/thumbnail?model=' + encodeURIComponent(i.modelKey);
  else img.hidden = true;
}
function selectIssue(id) {
  selected = id;
  markSelectedRow();
  const i = issue();
  if (!i) { $('detailPanel').hidden = true; return; }
  $('detailPanel').hidden = false;
  $('dtId').textContent = `Issue #${i.displayId}`;
  $('dtTitle').value = i.title ?? '';
  $('dtStatus').innerHTML = statusOptions(i).map(s => `<option value="${esc(s)}" ${s === i.status ? 'selected' : ''}>${esc(STATUS[s] ?? s)}</option>`).join('');
  $('dtType').innerHTML = i.typeLabel ? `<span class="tchip"><span class="code">${esc(i.typeCode ?? '')}</span><span class="lbl">${esc(i.typeLabel)}</span></span>` : '—';
  $('dtDue').value = i.dueDate ?? '';
  $('dtDesc').value = i.description ?? '';
  $('dtAssignee').textContent = i.assignedToName ?? 'Unspecified';
  $('dtWatchers').textContent = i.watcherNames?.length ? i.watcherNames.join(', ') : '—';
  $('dtPlacement').innerHTML = i.modelFullName ? `<span class="place">${esc(i.modelFullName)}</span>${modelVersion(i) ? `<span class="vpill">${esc(modelVersion(i))}</span>` : ''}` : '—';
  $('dtNote').textContent = '';
  $('dtErr').textContent = '';
  setDetailThumb(i);
  const e = i.element;
  $('dtElement').innerHTML = e ? Object.entries(e)
    .filter(([k]) => !['revitId', 'objectid'].includes(k))
    .map(([k, v]) => `<dt>${esc(PROP_LABELS[k] ?? k)}</dt><dd>${esc(v)}</dd>`).join('')
    : '<dd style="color:#68798a">対象要素なし（ピンなし、または対象外モデル）</dd>';
  $('dtShow3d').disabled = !i.targetDbId;
  if (overviewOn) { // 一覧モード中は選択の赤とラベルの強調を追随させる
    colorIssueElements();
    refreshMarkerSel();
  }
}
$('dtClose').addEventListener('click', () => { $('detailPanel').hidden = true; });
$('dtShow3d').addEventListener('click', () => { if (selected) showInViewer(selected); });
$('dtSave').addEventListener('click', async () => {
  const i = issue();
  if (!i) return;
  const patch = {
    title: $('dtTitle').value,
    status: $('dtStatus').value,
    dueDate: $('dtDue').value || null,
    description: $('dtDesc').value,
  };
  $('dtNote').textContent = '';
  $('dtErr').textContent = '';
  $('dtSave').disabled = true;
  try {
    const r = await fetch('/api/issues/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: i.id, patch }) });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(j?.error?.message ?? j?.detail ?? ('HTTP ' + r.status));
    await reloadIssues();
    $('dtNote').textContent = '保存しました（Forma 側に反映済み）';
  } catch (e) {
    $('dtErr').textContent = '保存に失敗しました：' + e.message;
  } finally {
    $('dtSave').disabled = false;
  }
});
async function reloadIssues() {
  const keep = selected;
  DATA = await (await fetch('/api/issues')).json();
  if (!Array.isArray(DATA.issues)) throw new Error(DATA.error ?? 'サーバーの応答が不正です');
  buildColumns();
  buildTable();
  if (keep) selectIssue(keep);
}

// 索引（モデル情報）がサーバー側で非同期に構築される間は、軽い状態確認だけをポーリングし、
// 完了した時点で Issue を一度だけ取り直して付与を反映する（Issue 全体の再取得を繰り返さない）
async function reloadIssuesSoft() {
  const keep = selected, keepPage = page;
  const j = await (await fetch('/api/issues')).json();
  if (!Array.isArray(j.issues)) return;
  DATA = j;
  buildColumns();
  page = keepPage;
  buildTable();
  const editing = $('detailPanel').contains(document.activeElement);
  if (keep && !editing) selectIssue(keep);
}
function watchIndexStatus() {
  const el = $('idxStat');
  const showFailed = () => {
    el.hidden = false;
    el.textContent = '一部のモデル情報の構築に失敗しました（そのモデルの Issue は要素情報なしで表示しています）。';
  };
  if ((DATA?.models ?? []).some(m => m.indexStatus === 'error')) showFailed();
  if (!(DATA?.models ?? []).some(m => m.indexStatus === 'building' || m.indexStatus === 'idle')) return;
  let tries = 0;
  const tick = async () => {
    let ms = [];
    try { ms = (await (await fetch('/api/index-status')).json()).models ?? []; } catch (e) {}
    const pending = ms.filter(m => m.indexStatus === 'building' || m.indexStatus === 'idle');
    if (pending.length && tries++ < 60) {
      el.hidden = false;
      el.textContent = `モデル情報を API から構築中…（${pending.map(m => m.short).join('、')}）`;
      setTimeout(tick, 3000);
      return;
    }
    if (pending.length) {
      el.hidden = false;
      el.textContent = 'モデル情報の構築に時間がかかっています。ページを再読み込みすると状態が更新されます。';
      return;
    }
    try { await reloadIssuesSoft(); } catch (e) {}
    if (ms.some(m => m.indexStatus === 'error')) showFailed();
    else el.hidden = true;
  };
  tick();
}

// ---- ビューア表示（専用ボタンから） ----
function showInViewer(id) {
  exitOverview(false); // フォーカス表示に移るので一覧モードは解除
  selected = id;
  focusedId = id;
  tSelect = performance.now();
  selectIssue(id);
  const i = issue();
  if (i?.modelKey) ensureViewerModel(i.modelKey);
  applySelection();
}

// ---- Viewer の対象ハイライト：赤く点滅 ----
function stopBlink() {
  if (blinkTimer) { clearInterval(blinkTimer); blinkTimer = null; }
  blinkOn = false;
}
function startBlink(dbId) {
  stopBlink();
  if (!viewer) return;
  const V4 = window.THREE?.Vector4 ?? Autodesk.Viewing.Private.THREE.Vector4;
  const paint = (r, g, b) => { try { viewer.setThemingColor(dbId, new V4(r, g, b, 1)); } catch (e) {} };
  paint(1, 0.05, 0.05); blinkOn = true;
  blinkTimer = setInterval(() => {
    if (!viewer) { stopBlink(); return; }
    blinkOn = !blinkOn;
    if (blinkOn) paint(1, 0.05, 0.05);
    else paint(1, 0.78, 0.78);
  }, 650);
}

// ビューアの実描画をキャプチャして、その Issue のサムネイルにする（API ではスナップショットを生成できないため）
let captureTimer = null;
function scheduleCapture(i) {
  if (captured.has(i.id) || typeof viewer?.getScreenshot !== 'function') return;
  if (captureTimer) clearTimeout(captureTimer);
  captureTimer = setTimeout(() => {
    try {
      viewer.getScreenshot(560, 350, (res) => {
        const done = (url) => { if (url) { captured.set(i.id, url); if (selected === i.id) setDetailThumb(issue()); } };
        if (typeof res === 'string' && res.startsWith('data:')) done(res);
        else if (res instanceof Blob) done(URL.createObjectURL(res));
      });
    } catch (e) {}
  }, 900);
}

// ---- 指摘事項一覧をモデルに表示（一覧モード。Autodesk 公式 IconMarkupExtension サンプルの方式） ----
// 該当要素を status 色でハイライトし、要素位置に title の HTML ラベルを重ねる。ラベルの位置は
// カメラ変更などのイベントで worldToClient により更新する。ラベルをクリックすると詳細に表示する。
let overviewOn = false;
const STATUS3D = { // 3D ハイライト色（表のステータス色に合わせる。pending だけ区別のため紫）
  draft: [0.54, 0.60, 0.66], open: [0.91, 0.64, 0.24], pending: [0.55, 0.36, 0.96],
  in_review: [0.23, 0.51, 0.77], closed: [0.30, 0.69, 0.49], void: [0.54, 0.60, 0.66],
};
let markerItems = [];
function v4(r, g, b, a = 1) { const V = window.THREE?.Vector4 ?? Autodesk.Viewing.Private.THREE.Vector4; return new V(r, g, b, a); }
function syncOverviewBtn() { window.dispatchEvent(new CustomEvent('demo-overview-state', { detail: overviewOn })); }
// 要素のワールド中心（サンプルと同じくインスタンスのワールド境界を合成。未ロードなら null）
function nodeWorldBox(dbId) {
  try {
    const tree = viewer.model.getInstanceTree?.();
    const instances = viewer.model.getInstances?.();
    if (tree?.enumNodeInstances && instances) {
      const nodeBox = new Autodesk.Viewing.Math.Box3(), instBox = new Autodesk.Viewing.Math.Box3();
      let found = false;
      tree.enumNodeInstances(dbId, (iid) => {
        if (instances.getGeometry(iid)) { instances.getWorldBounds(iid, instBox); nodeBox.union(instBox); found = true; }
      }, true);
      if (found) return { min: { x: nodeBox.min.x, y: nodeBox.min.y, z: nodeBox.min.z }, max: { x: nodeBox.max.x, y: nodeBox.max.y, z: nodeBox.max.z } };
    }
  } catch (e) {}
  try {
    const tree = viewer.model.getInstanceTree();
    const box = new Autodesk.Viewing.Private.THREE.Box3();
    tree.getNodeBox(dbId, box);
    if (box && !(box.isEmpty && box.isEmpty())) return { min: { x: box.min.x, y: box.min.y, z: box.min.z }, max: { x: box.max.x, y: box.max.y, z: box.max.z } };
  } catch (e) {}
  return null;
}
function nodeWorldCenter(dbId) {
  const b = nodeWorldBox(dbId);
  return b ? { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 } : null;
}
// 引き出し線の先端は、ハイライトされる部材の上の点にする（ピンの位置を部材の範囲内に寄せた点。ピンが無ければ部材の中心）
function anchorFor(issue) {
  const box = nodeWorldBox(issue.targetDbId);
  if (!box) return issue.pin?.position ?? null;
  const p = issue.pin?.position;
  if (!p) return { x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2, z: (box.min.z + box.max.z) / 2 };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  return { x: clamp(p.x, box.min.x, box.max.x), y: clamp(p.y, box.min.y, box.max.y), z: clamp(p.z, box.min.z, box.max.z) };
}
function colorIssueElements() {
  if (!viewer) return;
  for (const i of issuesOnCurrentModel()) {
    const c = STATUS3D[i.status] ?? [0.6, 0.6, 0.6];
    try { viewer.setThemingColor(i.targetDbId, v4(c[0], c[1], c[2], 1)); } catch (e) {}
  }
  const sel = issue(); // 表で選択中の Issue は赤
  if (sel && sel.modelKey === viewerModelKey && sel.targetDbId) {
    try { viewer.setThemingColor(sel.targetDbId, v4(1, 0.08, 0.08, 1)); } catch (e) {}
  }
}
function clearMarkers() {
  markerItems = [];
  const l = $('markers'); if (l) l.innerHTML = '';
  const s = $('leaders'); if (s) s.innerHTML = '';
}
function refreshMarkerSel() { // 選択中のラベルと引き出し線を赤にする
  for (const it of markerItems) {
    const on = it.id === selected;
    it.el.classList.toggle('sel', on);
    it.line.style.stroke = on ? '#e03131' : '';
  }
}
function buildMarkers() {
  clearMarkers();
  const layer = $('markers');
  const svg = $('leaders');
  const seen = new Map();
  for (const i of issuesOnCurrentModel()) {
    const pos = anchorFor(i);
    if (!pos) continue;
    const key = `${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}`;
    const stack = seen.get(key) ?? 0; seen.set(key, stack + 1);
    const el = document.createElement('div');
    el.className = 'issue-label' + (i.id === selected ? ' sel' : '');
    el.style.borderLeftColor = FSTATUS[i.status]?.[1] ?? '#999';
    el.textContent = i.title;
    el.title = `#${i.displayId} ${i.title}`;
    el.addEventListener('click', () => {
      selectIssue(i.id);
      if (overviewOn) { colorIssueElements(); refreshMarkerSel(); }
    });
    layer.appendChild(el);
    // 引き出し線（ピン位置の点＋線）で、ラベルがどの箇所を指すかを示す
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    line.setAttribute('class', 'leader-line');
    if (i.id === selected) line.style.stroke = '#e03131';
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('class', 'leader-dot');
    dot.setAttribute('r', '3.5');
    dot.style.fill = FSTATUS[i.status]?.[1] ?? '#999';
    svg.appendChild(line);
    svg.appendChild(dot);
    markerItems.push({ el, line, dot, pos, stack, id: i.id, dbId: i.targetDbId });
  }
  updateMarkers();
}
function updateMarkers() {
  if (!viewer || !markerItems.length) return;
  const T = Autodesk.Viewing.Math;
  let cam = null, dir = null;
  try { cam = viewer.impl.camera; dir = new T.Vector3(); cam.getWorldDirection(dir); } catch (e) {}
  for (const it of markerItems) {
    try {
      const p = new T.Vector3(it.pos.x, it.pos.y, it.pos.z);
      let behind = false;
      if (cam && dir) behind = p.clone().sub(cam.position).dot(dir) <= 0;
      const v = viewer.worldToClient(p);
      const visible = !behind && (typeof viewer.isNodeVisible === 'function' ? viewer.isNodeVisible(it.dbId) : true);
      const disp = visible ? '' : 'none';
      it.el.style.display = disp; it.line.style.display = disp; it.dot.style.display = disp;
      if (!visible) continue;
      const w = it.el.offsetWidth, h = it.el.offsetHeight;
      const gap = 26 + it.stack * (h + 8); // ラベルはピン位置の上に浮かせ、間を引き出し線でつなぐ
      it.el.style.left = Math.floor(v.x - w / 2) + 'px';
      it.el.style.top = Math.floor(v.y - gap - h) + 'px';
      it.line.setAttribute('points', `${v.x},${v.y - 5} ${v.x},${v.y - gap + 2}`);
      it.dot.setAttribute('cx', v.x);
      it.dot.setAttribute('cy', v.y);
    } catch (e) {
      it.el.style.display = 'none'; it.line.style.display = 'none'; it.dot.style.display = 'none';
    }
  }
}
function enterOverview() {
  if (!viewer || !geoLoaded) return;
  stopBlink();
  try {
    if (typeof viewer.setGhosting === 'function') viewer.setGhosting(true);
    const dbIds = issuesOnCurrentModel().map(i => i.targetDbId);
    // ゴースト表示は切らない：Issue の要素だけを実体表示にし、それ以外はゴーストのまま残す
    if (dbIds.length) viewer.isolate(dbIds);
    else viewer.showAll();
  } catch (e) {}
  viewer.clearThemingColors();
  colorIssueElements();
  buildMarkers();
  const n = issuesOnCurrentModel().length;
  setStatV(`指摘事項一覧を表示中（このモデルの Issue ${n} 件）。色はステータス別、選択中は赤。Issue の要素以外はゴースト表示です。ラベルをクリックすると詳細が開きます。`);
  syncOverviewBtn();
}
function exitOverview(restore = true) {
  overviewOn = false;
  clearMarkers();
  if (viewer) viewer.clearThemingColors();
  syncOverviewBtn();
  if (restore) { if (selected) focusedId = selected; applySelection(); }
}
function toggleOverview() {
  if (overviewOn) { exitOverview(true); return; }
  overviewOn = true;
  syncOverviewBtn();
  if (viewer && geoLoaded) enterOverview();
  else setStatV('モデルの読み込みが終わったら、指摘事項一覧を表示します。');
}
window.addEventListener('resize', () => { if (overviewOn) updateMarkers(); });

// ---- ゴースト透明度（ゴースト表示に使うフェード用マテリアルの不透明度を調整する） ----
let ghostTransparency = (() => {
  const raw = localStorage.getItem(LS_GHOST);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? Math.min(97, Math.max(0, n)) : 90;
})();
function applyGhostOpacity() {
  if (!viewer) return;
  const opacity = 1 - ghostTransparency / 100;
  try {
    const impl = viewer.impl;
    const mat = impl.fadeMaterial ?? impl.renderer?.()?.fadeMaterial ?? impl._renderer?.fadeMaterial ?? impl.glrenderer?.()?.fadeMaterial ?? null;
    if (!mat) return;
    const solid = opacity >= 0.99; // 透明度0%はゴーストオフ相当：元のモデルと同じ見え方にする
    mat.opacity = opacity;
    mat.transparent = !solid;
    mat.depthWrite = solid;
    mat.needsUpdate = true;
    mat.variants?.forEach(v => { v.opacity = opacity; v.transparent = !solid; v.depthWrite = solid; v.needsUpdate = true; });
    impl.invalidate?.(true);
  } catch (e) {}
}
function syncGhostBtn() {
  const p = $('ghostPanel');
  window.dispatchEvent(new CustomEvent('demo-ghost-state', { detail: p ? !p.hidden : false }));
}
function toggleGhostPanel() {
  const p = $('ghostPanel');
  if (!p) return;
  p.hidden = !p.hidden;
  if (!p.hidden) { $('ghostRange').value = ghostTransparency; $('ghostVal').textContent = ghostTransparency + '%'; }
  syncGhostBtn();
}
const ghostRangeEl = $('ghostRange');
if (ghostRangeEl) ghostRangeEl.addEventListener('input', () => {
  ghostTransparency = Number(ghostRangeEl.value);
  $('ghostVal').textContent = ghostTransparency + '%';
  localStorage.setItem(LS_GHOST, String(ghostTransparency));
  applyGhostOpacity();
});

// フォーカス中の Issue を Viewer に反映
function applySelection() {
  if (overviewOn) return;
  const i = focusedIssue();
  if (!viewer || !rootLoaded || !i) return;
  if (!i.targetDbId || i.modelKey !== viewerModelKey) {
    if (!i.targetDbId) { stopBlink(); viewer.showAll(); viewer.clearThemingColors(); setStatV('この Issue は対象モデルへのピンがないため、モデル全体を表示しています。'); }
    return;
  }
  if (!viewer.model?.getFragmentList?.()) return;
  try {
    if (typeof viewer.setGhosting === 'function') viewer.setGhosting(true);
    viewer.isolate([i.targetDbId]); // 残すのは対象だけ：壁の向こう・地中の対象でもゴースト越しに見える
    viewer.clearThemingColors();
    viewer.fitToView([i.targetDbId]);
  } catch (e) { return; }
  startBlink(i.targetDbId);
  if (geoLoaded) {
    setStatV(`<b>#${i.displayId}</b> の対象要素を表示中（対象以外はゴースト表示）。`);
    scheduleCapture(i);
  }
}

function setupViewer(modelKey) {
  const m = DATA?.models.find(x => x.key === modelKey);
  if (!m || !window.Autodesk) return;
  if (viewer && viewerModelKey === modelKey) return;
  if (viewer) { stopBlink(); clearMarkers(); try { viewer.finish(); } catch (e) {} viewer = null; }
  $('viewerWrap').innerHTML = '';
  const msg = $('viewerMsg'); if (msg) msg.remove();
  viewerModelKey = modelKey; rootLoaded = false; geoLoaded = false;
  viewer = new Autodesk.Viewing.GuiViewer3D($('viewerWrap'));
  viewer.start();
  viewer.loadExtension('DemoToolbarExtension').catch(() => {});
  const updMarkers = () => { if (overviewOn) updateMarkers(); };
  viewer.addEventListener(Autodesk.Viewing.CAMERA_CHANGE_EVENT, updMarkers);
  viewer.addEventListener(Autodesk.Viewing.ISOLATE_EVENT, updMarkers);
  viewer.addEventListener(Autodesk.Viewing.HIDE_EVENT, updMarkers);
  viewer.addEventListener(Autodesk.Viewing.SHOW_EVENT, updMarkers);
  viewer.addEventListener(Autodesk.Viewing.MODEL_ROOT_LOADED_EVENT, () => {
    rootLoaded = true;
    applyGhostOpacity();
    applySelection();
    setStatV(`モデル（${esc(m.short)}）の読み込み中…`);
  });
  viewer.addEventListener(Autodesk.Viewing.GEOMETRY_LOADED_EVENT, () => {
    geoLoaded = true;
    applyGhostOpacity();
    if (overviewOn) { enterOverview(); return; }
    applySelection();
    const i = focusedIssue();
    setStatV(`モデルの読み込みが完了しました。` + (i?.targetDbId && i.modelKey === viewerModelKey ? ` <b>#${i.displayId}</b> の対象要素を表示中（選択から ${((performance.now() - tSelect) / 1000).toFixed(1)} 秒）。` : ''));
  });
  viewer.addEventListener(Autodesk.Viewing.PROGRESS_UPDATE_EVENT, (e) => {
    if (!geoLoaded && typeof e.percent === 'number') setStatV(`モデル（${esc(m.short)}）を読み込んでいます（逐次配信）… ${Math.round(e.percent)}%`);
  });
  Autodesk.Viewing.Document.load('urn:' + m.urn, (doc) => {
    viewer.loadDocumentNode(doc, doc.getRoot().getDefaultGeometry());
    setStatV(`モデル（${esc(m.short)}）を読み込んでいます（逐次配信）…`);
  }, (code, msg2) => setStatV('モデルの読み込みに失敗しました：' + code + ' ' + esc(msg2 ?? '')));
}

function ensureViewerModel(modelKey) {
  desiredModelKey = modelKey;
  if (!viewerReady) return;
  if (viewerModelKey !== modelKey) setupViewer(modelKey);
}

// ---- Viewer ツールバー拡張（再フォーカスボタン） ----
if (window.Autodesk?.Viewing?.Extension) {
  class DemoToolbarExtension extends Autodesk.Viewing.Extension {
    load() {
      const viewer = this.viewer;
      const add = () => {
        if (this.group || !viewer.toolbar) return;
        this.btnFocus = new Autodesk.Viewing.UI.Button('demo-focus-target');
        this.btnFocus.setToolTip('対象要素にフォーカス');
        this.btnFocus.addClass('tb-focus-btn');
        this.btnFocus.onClick = () => window.dispatchEvent(new CustomEvent('demo-focus-target'));
        this.btnOverview = new Autodesk.Viewing.UI.Button('demo-toggle-overview');
        this.btnOverview.setToolTip('指摘事項一覧をモデルに表示');
        this.btnOverview.addClass('tb-overview-btn');
        this.btnOverview.onClick = () => window.dispatchEvent(new CustomEvent('demo-toggle-overview'));
        window.addEventListener('demo-overview-state', (e) => { try { this.btnOverview.setState(e.detail ? 0 : 1); } catch (err) {} });
        this.btnGhost = new Autodesk.Viewing.UI.Button('demo-ghost-opacity');
        this.btnGhost.setToolTip('ゴースト透明度');
        this.btnGhost.addClass('tb-ghost-btn');
        this.btnGhost.onClick = () => window.dispatchEvent(new CustomEvent('demo-toggle-ghost-panel'));
        window.addEventListener('demo-ghost-state', (e) => { try { this.btnGhost.setState(e.detail ? 0 : 1); } catch (err) {} });
        this.group = new Autodesk.Viewing.UI.ControlGroup('demo-toolbar-group');
        this.group.addControl(this.btnFocus);
        this.group.addControl(this.btnOverview);
        this.group.addControl(this.btnGhost);
        viewer.toolbar.addControl(this.group);
      };
      if (viewer.toolbar) add();
      else viewer.addEventListener(Autodesk.Viewing.TOOLBAR_CREATED_EVENT, add);
      return true;
    }
    unload() {
      if (this.group && this.viewer.toolbar) this.viewer.toolbar.removeControl(this.group);
      this.group = null;
      return true;
    }
  }
  Autodesk.Viewing.theExtensionManager.registerExtension('DemoToolbarExtension', DemoToolbarExtension);
}
window.addEventListener('demo-focus-target', () => { exitOverview(false); applySelection(); });
window.addEventListener('demo-toggle-overview', () => toggleOverview());
window.addEventListener('demo-toggle-ghost-panel', () => toggleGhostPanel());

async function initViewer() {
  if (!window.Autodesk) {
    const msg = $('viewerMsg');
    if (msg) msg.textContent = 'Viewer ライブラリを読み込めませんでした（この環境からは Autodesk の CDN に届きません）。通常のブラウザ環境で開いてください。';
    setStatV('Viewer：未初期化（CDN に到達できませんでした）');
    return;
  }
  const options = {
    env: 'AutodeskProduction', api: 'derivativeV2',
    getAccessToken: async (cb) => {
      try { const t = await (await fetch('/api/token')).json(); cb(t.access_token, t.expires_in); }
      catch (e) { setStatV('トークンの取得に失敗しました。'); }
    },
  };
  Autodesk.Viewing.Initializer(options, () => {
    viewerReady = true;
    setupViewer(desiredModelKey ?? focusedIssue()?.modelKey ?? DATA?.models[0]?.key ?? 'dach');
  });
}

initViewer();
(async () => {
  try {
    DATA = await (await fetch('/api/issues')).json();
    if (!Array.isArray(DATA.issues)) throw new Error(DATA.error ?? 'サーバーの応答が不正です');
    const statusSel = $('fltStatus');
    for (const st of [...new Set(DATA.issues.map(i => i.status))]) {
      const o = document.createElement('option');
      o.value = st; o.textContent = 'ステータス：' + (STATUS[st] ?? st);
      statusSel.appendChild(o);
    }
    buildColumns();
    buildTable();
    const first = DATA.issues.find(i => i.targetDbId) ?? DATA.issues[0];
    if (first) selectIssue(first.id); // 詳細だけ開く。ビューア表示は専用ボタンから
    watchIndexStatus();
  } catch (e) {
    setStatV('Issue の取得に失敗しました：' + e.message);
  }
})();
