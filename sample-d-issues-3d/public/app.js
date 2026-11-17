// app.js — sample-d の画面ロジック（Issue 一覧／詳細／ビューア／一覧モード）
let DATA = null, selected = null, focusedId = null;
let viewer = null, viewerModelKey = null, rootLoaded = false, geoLoaded = false, tSelect = 0;
// 重ね表示（最新版を主表示＋旧版をゴーストで重ねる。v8.35）の状態
let ghostModel = null, ghostGeoLoaded = false, overlayData = null, overlayApplied = false, overlayExpected = false, overlayFetchTimer = null;
const overlayDisabledKeys = new Set(); // 重ね表示の準備に失敗したモデルは、通常表示（基準版のみ）に切り替える
let viewerReady = false, desiredModelKey = null;
let fittedFor = null; // カメラのフィットを実行済みの対象（モデル: Issue）。フィットは1回だけにする
let pendingFocusId = null; // 読み込み中・モデル切替中に 3D ボタンで指定された Issue（読み込み完了時にカメラを寄せる）
const captured = new Map(); // Issue ごとのビューアキャプチャ（スナップショットの代替）
const $ = id => document.getElementById(id);
const LS_COLS = 'sampled-cols-v2', LS_PAGE = 'sampled-pagesize-v2', LS_GHOST = 'sampled-ghost-transparency'; // ユーザー設定の保存キー（互換のため変更しない）
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function issue() { return DATA?.issues.find(i => i.id === selected); }
function issuesOnCurrentModel() { return DATA.issues.filter(x => x.modelKey === viewerModelKey && (x.targetDbId || (overlayData?.status === 'ready' && x.targetDbIdLatest))); }
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
// バージョン間 Diff（ピン時点 → 最新）による対象要素の変更表示
function changeText(i) {
  if (i.changeState === 'building') return '取得中';
  if (i.changeState === 'failed') return '取得失敗';
  if (i.changeState !== 'ready' || !i.change) return '—';
  if (i.change.type === 'added') return '追加';
  if (i.change.type === 'removed') return '削除';
  if (i.change.type === 'modified') return '変更あり';
  return '変更なし';
}
const CHG_COLOR = { '変更あり': '#d97706', '削除': '#c0453e', '追加': '#4caf7d', '変更なし': '#8a9aa8', '取得中': '#3b82c4', '取得失敗': '#c0453e' };
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
let sortCol = null;
try { sortCol = JSON.parse(localStorage.getItem('sampled-sort') ?? 'null'); } catch (e) { sortCol = null; }
let visibleCols = new Set(JSON.parse(localStorage.getItem(LS_COLS) ?? 'null') ?? ['title', 'status', 'type', 'assignee', 'due', 'start', 'placement', 'change']);
if (!localStorage.getItem('sampled-change-col')) { visibleCols.add('change'); localStorage.setItem('sampled-change-col', '1'); } // 「変更」列の追加に伴う一度きりのマージ
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
    { id: 'change', label: '変更', grp: 'モデル情報', cell: 'change', get: i => changeText(i) },
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
// 列ヘッダクリック用の汎用ソート：数値・日付・文字列（日本語、数値混じり対応）。
// 空値（''／'—'／null）は昇順・降順どちらでも常に最後。
function sortByColumn(list, col, dir) {
  const val = (i) => {
    try {
      let v = col.get(i);
      if (col.id === 'status') v = FSTATUS[v]?.[0] ?? v;
      return v;
    } catch (e) { return null; }
  };
  return list.sort((x, y) => {
    const a = val(x), b = val(y);
    const ea = a == null || a === '' || a === '—' || a === '-';
    const eb = b == null || b === '' || b === '—' || b === '-';
    if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
    let c;
    if (typeof a === 'number' && typeof b === 'number') c = a - b;
    else {
      const sa = String(a), sb = String(b);
      const na = parseFloat(sa.replace(/,/g, '')), nb = parseFloat(sb.replace(/,/g, ''));
      if (!Number.isNaN(na) && !Number.isNaN(nb) && /^[\d.,\s+\-/]+/.test(sa) && /^[\d.,\s+\-/]+/.test(sb)) c = na - nb;
      else c = sa.localeCompare(sb, 'ja', { numeric: true });
    }
    return c * dir;
  });
}
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
  if (sortCol) {
    const col = COLUMNS.find(c => c.id === sortCol.id);
    if (col) return sortByColumn(list, col, sortCol.dir);
  }
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
    case 'change': { const t = changeText(i); return t === '—' ? '—' : `<span class="fst"><i style="background:${CHG_COLOR[t]}"></i>${esc(t)}</span>`; }
    case 'title': return `<span class="titlecell">${(i.targetDbId || i.targetDbIdLatest) ? `<button class="vbtn" data-view="${i.id}">3D</button>` : '<span class="vbtn-spacer"></span>'}<b style="font-weight:600">${esc(v)}</b></span>`;
    default: return esc(v);
  }
}
function buildTable() {
  const cols = COLUMNS.filter(c => visibleCols.has(c.id));
  $('issueHead').innerHTML = '<tr>' + cols.map(c => {
    const active = sortCol?.id === c.id;
    const arrow = active ? ` <span class="arr">${sortCol.dir === 1 ? '▲' : '▼'}</span>` : '';
    return `<th class="sortable${active ? ' sorted' : ''}" data-col="${esc(c.id)}" title="クリックでソート（昇順→降順→解除）">${esc(c.label)}${arrow}</th>`;
  }).join('') + '</tr>';
  for (const th of $('issueHead').querySelectorAll('th[data-col]')) {
    th.addEventListener('click', () => {
      const id = th.dataset.col;
      if (sortCol?.id !== id) sortCol = { id, dir: 1 };
      else if (sortCol.dir === 1) sortCol = { id, dir: -1 };
      else sortCol = null;
      localStorage.setItem('sampled-sort', JSON.stringify(sortCol));
      page = 1;
      buildTable();
    });
  }
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
$('fltSort').addEventListener('change', () => { flt.sort = $('fltSort').value; sortCol = null; localStorage.setItem('sampled-sort', 'null'); page = 1; buildTable(); });
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
// 詳細パネルの表示切替。右カラムの出現・消滅でビューアの幅が変わるため、
// レイアウト確定後に Viewer へリサイズを伝える
function setDetailVisible(on) {
  const p = $('detailPanel');
  if (p.hidden === !on) return;
  p.hidden = !on;
  requestAnimationFrame(() => { try { viewer?.resize(); } catch (e) {} });
}
function selectIssue(id) {
  selected = id;
  markSelectedRow();
  const i = issue();
  if (!i) { setDetailVisible(false); return; }
  setDetailVisible(true);
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
  renderDetailChange(i);
  $('dtShow3d').disabled = !(i.targetDbId || i.targetDbIdLatest);
  if (overviewOn) { // 一覧モード中は選択の赤とラベルの強調を追随させる
    colorIssueElements();
    refreshMarkerSel();
  }
  if (viewerMode === 'obj') showObjForSelected();
}
function fmtChgVal(v) { if (v == null) return '（なし）'; const s = String(v); return s.length > 60 ? s.slice(0, 60) + '…' : s; }
function renderDetailChange(i) {
  const el = $('dtChange');
  const c = i.change;
  if (i.changeState === 'building' && c) { el.innerHTML = `変更情報を取得中…（V${c.fromVersion} → V${c.toVersion}）`; return; }
  if (i.changeState === 'failed' && c) { el.innerHTML = `変更情報の取得に失敗しました（V${c.fromVersion} → V${c.toVersion}）`; return; }
  if (i.changeState !== 'ready' || !c) {
    el.innerHTML = (i.pin && i.modelKey) ? '比較対象なし（ピン時点と最新が同じバージョンです）' : '—';
    return;
  }
  let verdict, color;
  if (c.type === 'added') { verdict = '対象要素は最新版で追加された要素です'; color = CHG_COLOR['追加']; }
  else if (c.type === 'removed') { verdict = '対象要素は最新版では削除されています'; color = CHG_COLOR['削除']; }
  else if (c.type === 'modified') { verdict = '対象要素に変更があります'; color = CHG_COLOR['変更あり']; }
  else { verdict = '対象要素に実質的な変更はありません'; color = CHG_COLOR['変更なし']; }
  let h = `<span class="fst"><i style="background:${color}"></i>V${c.fromVersion} → V${c.toVersion}：${esc(verdict)}</span>`;
  if (c.type === 'modified') {
    const sig = [];
    if (c.geomChanged) sig.push('形状の変更');
    if (c.moved) sig.push('移動' + (c.moveMeters ? `（約 ${c.moveMeters} m）` : ''));
    if (c.valueChanged) sig.push('プロパティの変更');
    if (sig.length) h += `<br>${esc(sig.join('／'))}`;
    if (c.changedProps?.length) h += '<br>' + c.changedProps.map(p => `${esc(p.name)}：${esc(fmtChgVal(p.prev))} → ${esc(fmtChgVal(p.cur))}`).join('<br>');
  }
  if (c.pairCounts) h += `<br><span style="color:#68798a">モデル全体では 追加 ${c.pairCounts.added}・削除 ${c.pairCounts.removed}・実質変更 ${c.pairCounts.modifiedReal} 件（見かけ上の変更 ${c.pairCounts.modifiedRaw - c.pairCounts.modifiedReal} 件は判定から除外）</span>`;
  el.innerHTML = h;
}
$('dtClose').addEventListener('click', () => setDetailVisible(false));
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
  // 表示中のモデルが重ね表示に対応したのに、ビューアが通常表示で作られていたら作り直す
  const cm = DATA.models.find(x => x.key === viewerModelKey);
  if (viewer && viewerMode === 'aps' && cm?.latest && !overlayExpected && !overlayDisabledKeys.has(cm.key)) {
    const v = viewer; viewer = null; viewerModelKey = null;
    try { v?.finish(); } catch (e) {}
    setupViewer(cm.key);
  }
}
function watchIndexStatus() {
  const el = $('idxStat');
  const showFailed = () => {
    el.hidden = false;
    el.textContent = '一部のモデル情報の構築に失敗しました（そのモデルの Issue は要素情報なしで表示しています）。';
  };
  if ((DATA?.models ?? []).some(m => m.indexStatus === 'error')) showFailed();
  if (!(DATA?.models ?? []).some(m => m.indexStatus === 'building' || m.indexStatus === 'idle' || m.diffStatus === 'building' || m.overlayStatus === 'building')) return;
  let tries = 0;
  const tick = async () => {
    let ms = [];
    try { ms = (await (await fetch('/api/index-status')).json()).models ?? []; } catch (e) {}
    const pending = ms.filter(m => m.indexStatus === 'building' || m.indexStatus === 'idle' || m.diffStatus === 'building' || m.overlayStatus === 'building');
    const maxTries = pending.some(m => m.diffStatus === 'building') ? 400 : 60; // Diff は索引より時間がかかるため長めに待つ
    if (pending.length && tries++ < maxTries) {
      el.hidden = false;
      el.textContent = `モデル情報・変更情報を API から構築中…（${pending.map(m => m.short).join('、')}）`;
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

// ---- ビューア切り替え（APS Viewer / OBJ ビューア） ----
const LS_MODE = 'sampled-viewer-mode';
let viewerMode = localStorage.getItem(LS_MODE) === 'obj' ? 'obj' : 'aps';
const extractCache = new Map();
let objViewFailed = false;
let objLoading = null;
// OBJ ビューア（three.js）は重いので常時読み込まない。OBJ モードが初めて必要になった
// 時点でだけ読み込む（初回表示の軽さのため。2026-11-16 の「初回読み込みが重い」体感への対応）。
function ensureObjViewer() {
  if (window.ObjView || objViewFailed || objLoading) return;
  objLoading = import('./obj-viewer.js').catch(() => { window.__objViewerFailed?.(); });
}
window.__objViewerReady = () => { if (viewerMode === 'obj') showObjForSelected(); };
window.__objViewerFailed = () => { objViewFailed = true; if (viewerMode === 'obj') setStatV('OBJ ビューアのライブラリ（three.js）を読み込めませんでした。ネットワーク接続を確認してください。'); };
function applyViewerModeVisual() {
  const obj = viewerMode === 'obj';
  $('viewerOuter').classList.toggle('obj-mode', obj);
  $('objWrap').hidden = !obj;
  $('viewerWrap').style.display = obj ? 'none' : '';
  for (const b of $('viewerSwitch').querySelectorAll('button')) b.classList.toggle('on', b.dataset.vm === viewerMode);
}
function setViewerMode(m) {
  viewerMode = m;
  localStorage.setItem(LS_MODE, m);
  applyViewerModeVisual();
  if (m === 'obj') { ensureObjViewer(); showObjForSelected(); }
  else { try { viewer?.resize(); } catch (e) {} }
  updateFocusPin();
}
for (const b of $('viewerSwitch').querySelectorAll('button')) b.addEventListener('click', () => setViewerMode(b.dataset.vm));
applyViewerModeVisual();
if (viewerMode === 'obj') ensureObjViewer(); // 前回 OBJ モードで終わっていた場合だけ、最初から読み込む
async function showObjForSelected() {
  if (!DATA) return;
  const i = issue();
  if (!window.ObjView) { if (objViewFailed) setStatV('OBJ ビューアを読み込めませんでした。'); return; }
  if (!i?.targetDbId) { ObjView.showMessage('この Issue には対象要素がないため、OBJ で切り出せません。'); setStatV('OBJ 表示：対象要素のない Issue です。'); return; }
  const t0 = performance.now();
  try {
    let res = extractCache.get(i.id);
    if (!res) {
      ObjView.showMessage('指摘箇所と周辺を OBJ で抽出しています…');
      setStatV(`<b>#${i.displayId}</b> の箇所＋周辺を OBJ で抽出中…`);
      res = await (await fetch('/api/extract?issue=' + encodeURIComponent(i.id))).json();
      if (res.error) throw new Error(res.error);
      extractCache.set(i.id, res);
    }
    ObjView.show(res.obj, res.targetDbId);
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    setStatV(`<b>#${i.displayId}</b> の箇所＋周辺を表示中（対象1件＋周辺 ${Math.max(0, res.included.length - 1)} 件、同じ階・隣接通り芯などで抽出、${secs} 秒）。対象は赤で表示しています。`);
  } catch (e) {
    ObjView.showMessage('OBJ の抽出に失敗しました：' + (e?.message ?? e));
    setStatV('OBJ の抽出に失敗しました：' + esc(String(e?.message ?? e)));
  }
}

// ---- ビューア表示（専用ボタンから） ----
function showInViewer(id) {
  if (viewerMode === 'obj') { selectIssue(id); return; } // OBJ モードでは抽出表示に切り替える
  selected = id;
  focusedId = id;
  fittedFor = null; // 明示的な表示操作なので、カメラのフィットをやり直してよい
  tSelect = performance.now();
  selectIssue(id);
  const i = issue();
  if (i?.modelKey) ensureViewerModel(i.modelKey);
  if (overviewOn) {
    // 一覧モードは維持したまま、その Issue にカメラを寄せる（ラベル・引き出し線は残す）
    const t = i && effTarget(i);
    if (viewer && geoLoaded && t && i.modelKey === viewerModelKey) {
      if (!fitToElement(t.dbId, t.model)) { try { viewer.fitToView([t.dbId]); } catch (e) {} }
      colorIssueElements();
      refreshMarkerSel();
      applyOccluderClearing();
      updateMarkers();
    } else if (i?.targetDbId || i?.targetDbIdLatest) {
      pendingFocusId = id; // 読み込み中・モデル切替中は、完了した時点で寄せる
    }
  } else {
    applySelection();
  }
}

// ---- Viewer の対象ハイライト ----
// 色替え（theming）の点滅は、そのたびに画面全体の再描画が走って負荷が高いので使わない。
// 対象要素は濃い赤で一度だけ塗り（再描画は1回）、「ここだよ」の合図は画面上のピン
// （#focusPin。CSS アニメーションなので 3D 描画には触らない）で出す。
function paintFocusTarget(dbId, model) {
  if (!viewer) return;
  try { viewer.setThemingColor(dbId, v4(1, 0.05, 0.05, 1), model); } catch (e) {}
}
// フォーカス中要素の位置にピンを重ねる。位置合わせはカメラ等のイベント時のみで、
// アニメーション自体は CSS が担うため、3D の再描画は発生しない。
function updateFocusPin() {
  const el = $('focusPin');
  if (!el) return;
  const i = focusedIssue();
  const ft = i && effTarget(i);
  if (!viewer || !rootLoaded || overviewOn || viewerMode !== 'aps' || !i || i.modelKey !== viewerModelKey || (!ft && !i.targetDbId)) { el.hidden = true; return; }
  const pos = anchorFor(i) ?? pinAnchorFor(i); // 読み込み中はピン座標で先行表示
  if (!pos) { el.hidden = true; return; }
  try {
    const T = THREE;
    const p = new T.Vector3(pos.x, pos.y, pos.z);
    const cam = viewer.impl.camera; const dir = new T.Vector3(); cam.getWorldDirection(dir);
    if (p.clone().sub(cam.position).dot(dir) <= 0) { el.hidden = true; return; }
    if (geoLoaded && ft && ft.model === viewer.model && typeof viewer.isNodeVisible === 'function' && !viewer.isNodeVisible(ft.dbId)) { el.hidden = true; return; }
    const v = viewer.worldToClient(p);
    el.style.left = Math.floor(v.x) + 'px';
    el.style.top = Math.floor(v.y) + 'px';
    el.hidden = false;
  } catch (e) { el.hidden = true; }
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
let overviewOn = true; // 既定で一覧モード ON（2026-11-16 ユーザー指示）
const STATUS3D = { // 3D ハイライト色（表のステータス色に合わせる。pending だけ区別のため紫）
  draft: [0.54, 0.60, 0.66], open: [0.91, 0.64, 0.24], pending: [0.55, 0.36, 0.96],
  in_review: [0.23, 0.51, 0.77], closed: [0.30, 0.69, 0.49], void: [0.54, 0.60, 0.66],
};
let markerItems = [];
let markersBuiltFor = null; // マーカーを構築済みのモデル＋状態のキー（再構築の省略用）
function v4(r, g, b, a = 1) { const V = window.THREE?.Vector4 ?? Autodesk.Viewing.Private.THREE.Vector4; return new V(r, g, b, a); }
function syncOverviewBtn() { window.dispatchEvent(new CustomEvent('demo-overview-state', { detail: overviewOn })); }
// 要素のワールド境界ボックス（未ロードなら null）
// 注意：InstanceTree.getNodeBox(dbId, out) の out は THREE.Box3 ではなく
// [minx, miny, minz, maxx, maxy, maxz] の数値配列（LMV 本体の実装で確認。2026-11-16）。
// Box3 を渡すと min/max が初期値（+∞/−∞）のままになり、常に「ボックスなし」になって
// ラベル・引き出し線・フォーカスピンが全て消える（実機報告で発覚した不具合の真因）。
function nodeWorldBox(dbId, model) {
  const mdl = model ?? viewer.model;
  try {
    const tree = mdl.getInstanceTree();
    const a = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    tree.getNodeBox(dbId, a);
    if (a[0] <= a[3] && a[1] <= a[4] && a[2] <= a[5]) {
      return { min: { x: a[0], y: a[1], z: a[2] }, max: { x: a[3], y: a[4], z: a[5] } };
    }
  } catch (e) {}
  try {
    // 予備：フラグメントのワールド境界を合成する
    const tree = mdl.getInstanceTree();
    const frags = mdl.getFragmentList();
    const box = new Autodesk.Viewing.Private.THREE.Box3();
    const fb = new Autodesk.Viewing.Private.THREE.Box3();
    let found = false;
    tree.enumNodeFragments(dbId, (fid) => {
      frags.getWorldBounds(fid, fb);
      if (fb && !fb.isEmpty()) { box.union(fb); found = true; }
    }, true);
    if (found && !box.isEmpty()) return { min: { x: box.min.x, y: box.min.y, z: box.min.z }, max: { x: box.max.x, y: box.max.y, z: box.max.z } };
  } catch (e) {}
  return null;
}
// Issue の対象要素が「今どのモデル（シーン）の、どの dbId か」を返す。
// 重ね表示が有効な間は、最新版に要素があれば最新版の要素を、無ければ旧版の
// ゴースト要素を指す。重ね表示の準備が整うまではボックスアンカーを使わない
// （基準版の dbId を最新版のシーンで引くと別要素を指してしまうため、
// その間はピン座標の先行表示にフォールバックする）。
function effTarget(issue) {
  if (!issue || issue.modelKey !== viewerModelKey || !viewer) return null;
  if (overlayExpected && overlayData?.status !== 'ready') return null;
  if (overlayData?.status === 'ready') {
    if (issue.targetDbIdLatest != null) return { dbId: issue.targetDbIdLatest, model: viewer.model };
    if (issue.targetDbId != null && ghostModel) return { dbId: issue.targetDbId, model: ghostModel };
    return null;
  }
  if (issue.targetDbId != null) return { dbId: issue.targetDbId, model: viewer.model };
  return null;
}
// 引き出し線の先端は、読み込み完了後はハイライトされる部材そのものの中心にする。
// 部材ボックスは Viewer 実行時 API から取るので、ハイライトや fitToView と同じ空間で必ず部材の上に来る。
function anchorFor(issue) {
  const t = effTarget(issue);
  if (!t) return null;
  const box = nodeWorldBox(t.dbId, t.model);
  if (!box) return null;
  return { x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2, z: (box.min.z + box.max.z) / 2 };
}
// 読み込み中に使う先行アンカー：Issue のピン座標（Issues API 由来）。
// Forma 画面で起票されたピンの座標は Viewer のワールド座標そのものであることを
// 2026-11-16 にローカルリグで実測した（対象部材を色付けし、ピン座標の投影点が部材の上に
// 重なることを目視確認。globalOffset を足した点は部材から外れた）。
// ただし API 起票のピン（スナップショットなし）には例外がある：履歴グラフ実験で起票された
// #43〜47 は SVF2 側の座標系（Revit 内部座標 − refPoint）で記録されており、そのまま投影すると
// 実物から大きくずれる（2026-11-17 実測。ピンの値は「内部座標中心 − refPoint」と小数第2位まで
// 一致）。対象要素が表示中のモデルに存在しない（＝ボックスへ付け直せない）場合に限り、
// models.json の pinFrame（実測した変換）でシーン座標へ変換して先行表示する。
// サーバー側の索引は使わず、Forma（Issues API）が持つデータだけで先行表示する。
function pinAnchorFor(issue) {
  const p = issue?.pin?.position;
  if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.z !== 'number') return null;
  const mf = DATA?.models.find(x => x.key === issue.modelKey)?.pinFrame;
  const go = viewer?.model?.getData?.()?.globalOffset;
  if (mf && go && !issue.snapshotUrn && !issue.targetDbId) {
    const [rx, ry, rz] = mf.refPoint, A = mf.affine;
    const sx = p.x + rx, sy = p.y + ry, sz = p.z + rz;
    return {
      x: A[0][0] * sx + A[0][1] * sy + A[0][2] * sz + A[0][3] - go.x,
      y: A[1][0] * sx + A[1][1] * sy + A[1][2] * sz + A[1][3] - go.y,
      z: A[2][0] * sx + A[2][1] * sy + A[2][2] * sz + A[2][3] - go.z,
    };
  }
  return { x: p.x, y: p.y, z: p.z };
}
// マーカー構築済みキーは段階も含める：読み込み中（ピン座標アンカー）→ 完了後
// （ボックスアンカー）でキーが変わり、完了時に作り直されて線の先が部材に合い直す。
function markersKey() {
  return viewerModelKey + ':' + issuesOnCurrentModel().map(x => x.id + '|' + x.status).join(',') + (geoLoaded ? ':g' : ':e') + (overlayData?.status === 'ready' ? ':ov' : '');
}
function colorIssueElements() {
  if (!viewer) return;
  for (const i of issuesOnCurrentModel()) {
    const t = effTarget(i);
    if (!t) continue;
    const c = STATUS3D[i.status] ?? [0.6, 0.6, 0.6];
    try { viewer.setThemingColor(t.dbId, v4(c[0], c[1], c[2], 1), t.model); } catch (e) {}
  }
  const sel = issue(); // 表で選択中の Issue は赤
  const st = sel && effTarget(sel);
  if (st) {
    try { viewer.setThemingColor(st.dbId, v4(1, 0.08, 0.08, 1), st.model); } catch (e) {}
  }
}
function clearMarkers() {
  markerItems = [];
  markersBuiltFor = null;
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
    const pos = anchorFor(i) ?? pinAnchorFor(i); // 読み込み中はピン座標で先行表示し、完了後の再構築でボックス中心に合い直す
    if (!pos) continue;
    const et = effTarget(i);
    const bb = et ? nodeWorldBox(et.dbId, et.model) : null;
    const corners = bb ? [0, 1].flatMap(xi => [0, 1].flatMap(yi => [0, 1].map(zi => ({
      x: xi ? bb.max.x : bb.min.x, y: yi ? bb.max.y : bb.min.y, z: zi ? bb.max.z : bb.min.z,
    })))) : null;
    const key = `${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}`;
    const stack = seen.get(key) ?? 0; seen.set(key, stack + 1);
    const el = document.createElement('div');
    el.className = 'issue-label' + (i.id === selected ? ' sel' : '');
    el.style.left = '0px'; el.style.top = '0px'; // 配置は transform で行う（left/top の書き換えはレイアウトを引くため）
    el.style.borderLeftColor = FSTATUS[i.status]?.[1] ?? '#999';
    el.textContent = i.title;
    el.title = `#${i.displayId} ${i.title}`;
    el.addEventListener('click', () => {
      selectIssue(i.id);
      if (overviewOn) { colorIssueElements(); refreshMarkerSel(); applyOccluderClearing(); }
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
    markerItems.push({ el, line, dot, pos, corners, stack, id: i.id, dbId: i.targetDbId, w: el.offsetWidth || 0, h: el.offsetHeight || 0 });
  }
  updateMarkers();
}
// ラベルの配置（2026-11-16 ユーザー仕様）：ラベルは対象の直上には置かず、画面中央の
// 「青エリア」（ラベル禁止域）の外周＝赤エリアに散らす。中心点は、表示中の指摘箇所の
// 2D 座標の重心（ただし X は必ず画面中央）で動的に決め、中心点から指摘箇所を通る
// 放射線が青エリアの境界を出る位置にラベルを置き、引き出し線で結ぶ。
const BLUE_ZONE = { l: 0.125, r: 0.875, t: 0.18, b: 0.74 }; // 青エリア（画面に対する割合）
function rayExitRect(C, P, R) {
  const dx = P.x - C.x, dy = P.y - C.y;
  if (Math.hypot(dx, dy) < 1e-6) return { x: (R.l + R.r) / 2, y: R.t, side: 'top' };
  let t0 = 0, t1 = Infinity;
  if (Math.abs(dx) < 1e-9) { if (C.x < R.l || C.x > R.r) return null; }
  else { let ta = (R.l - C.x) / dx, tb = (R.r - C.x) / dx; if (ta > tb) { const s = ta; ta = tb; tb = s; } t0 = Math.max(t0, ta); t1 = Math.min(t1, tb); }
  if (Math.abs(dy) < 1e-9) { if (C.y < R.t || C.y > R.b) return null; }
  else { let ta = (R.t - C.y) / dy, tb = (R.b - C.y) / dy; if (ta > tb) { const s = ta; ta = tb; tb = s; } t0 = Math.max(t0, ta); t1 = Math.min(t1, tb); }
  if (!Number.isFinite(t1) || t1 < 0 || t0 > t1) return null;
  const x = C.x + dx * t1, y = C.y + dy * t1;
  const dl = Math.abs(x - R.l), dr = Math.abs(x - R.r), dt = Math.abs(y - R.t), db = Math.abs(y - R.b);
  const m = Math.min(dl, dr, dt, db);
  const side = m === dt ? 'top' : m === db ? 'bottom' : m === dl ? 'left' : 'right';
  return { x, y, side };
}
function updateMarkers() {
  if (!viewer || !markerItems.length) return;
  const T = THREE;
  let cam = null, dir = null;
  try { cam = viewer.impl.camera; dir = new T.Vector3(); cam.getWorldDirection(dir); } catch (e) {}
  const layer = $('markers');
  const W = layer?.clientWidth ?? 0, H = layer?.clientHeight ?? 0;
  // まず表示中の指摘箇所の 2D 座標を集める
  const vis = [];
  for (const it of markerItems) {
    try {
      // 代表点：中心がカメラの後ろでも、ボックスの隅が前にあればそれを使う。
      // 非表示状態（isNodeVisible）では判定しない：手前消去や配信の都合で
      // 一時的に隠れた要素のラベルまで消えてしまうため（実機報告）。
      const candPts = [it.pos, ...(it.corners ?? [])];
      let v = null;
      for (const cp of candPts) {
        const p = new T.Vector3(cp.x, cp.y, cp.z);
        if (cam && dir && p.clone().sub(cam.position).dot(dir) <= 0) continue;
        const q = viewer.worldToClient(p);
        // 画面内に指摘箇所がなければ、ラベルも表示しない（ユーザー指示）
        if (q && q.x >= 0 && q.x <= W && q.y >= 0 && q.y <= H) { v = q; break; }
      }
      const visible = !!v;
      const disp = visible ? '' : 'none';
      if (it._disp !== disp) { it._disp = disp; it.el.style.display = disp; it.line.style.display = disp; it.dot.style.display = disp; }
      if (visible) {
        if (!it.w) { it.w = it.el.offsetWidth || 120; it.h = it.el.offsetHeight || 22; }
        vis.push({ it, v });
      }
    } catch (e) {
      if (it._disp !== 'none') { it._disp = 'none'; it.el.style.display = 'none'; it.line.style.display = 'none'; it.dot.style.display = 'none'; }
    }
  }
  if (!vis.length || !W || !H) return;
  // 中心点：X は画面中央、Y は指摘箇所の重心
  const C = { x: W / 2, y: vis.reduce((s, o) => s + o.v.y, 0) / vis.length };
  const R = { l: BLUE_ZONE.l * W, r: BLUE_ZONE.r * W, t: BLUE_ZONE.t * H, b: BLUE_ZONE.b * H };
  // 各ラベルの置き場所（放射線と青エリア境界の交点→外側へ少し押し出す）
  for (const o of vis) {
    const ex = rayExitRect(C, o.v, R) ?? { x: Math.min(Math.max(o.v.x, 8), W - 8), y: R.t, side: 'top' };
    o.side = ex.side;
    o.lx = ex.x; o.ly = ex.y;
    const w = o.it.w || 120, h = o.it.h || 22;
    if (ex.side === 'top') o.ly -= h / 2 + 4;
    else if (ex.side === 'bottom') o.ly += h / 2 + 4;
    else if (ex.side === 'left') o.lx -= w / 2 + 4;
    else o.lx += w / 2 + 4;
  }
  // ラベル同士は絶対に被らない（ユーザー指示）：辺ごとに最小間隔を保つ詰め込みを
  // 前後両方向から繰り返し、最後は間隔を守ることを画面端より優先する。
  const placedAll = [];
  for (const side of ['top', 'bottom', 'left', 'right']) {
    const g = vis.filter(o => o.side === side);
    if (!g.length) continue;
    const horiz = side === 'top' || side === 'bottom';
    const size = o => horiz ? (o.it.w || 120) : (o.it.h || 22);
    const L = horiz ? W : H;
    const get = o => horiz ? o.lx : o.ly;
    const set = (o, val) => { if (horiz) o.lx = val; else o.ly = val; };
    g.sort((a, b) => get(a) - get(b));
    for (let iter = 0; iter < 3; iter++) {
      for (let k = 0; k < g.length; k++) {
        const o = g[k], lo = size(o) / 2 + 6, hi = L - size(o) / 2 - 6;
        const need = k ? get(g[k - 1]) + (size(g[k - 1]) + size(o)) / 2 + 6 : lo;
        set(o, Math.min(Math.max(get(o), need), hi));
      }
      for (let k = g.length - 1; k >= 0; k--) {
        const o = g[k], lo = size(o) / 2 + 6, hi = L - size(o) / 2 - 6;
        const need = k < g.length - 1 ? get(g[k + 1]) - (size(g[k + 1]) + size(o)) / 2 - 6 : hi;
        set(o, Math.max(Math.min(get(o), need), lo));
      }
    }
    // 最終保証：間隔だけは絶対に守る（少しはみ出しても重なりよりまし）
    for (let k = 1; k < g.length; k++) {
      const need = (size(g[k - 1]) + size(g[k])) / 2 + 6;
      if (get(g[k]) < get(g[k - 1]) + need) set(g[k], get(g[k - 1]) + need);
    }
    const last = g[g.length - 1];
    const over = get(last) + size(last) / 2 + 6 - L;
    if (over > 0) for (const o of g) set(o, get(o) - over);
    placedAll.push(...g);
  }
  // 辺をまたぐ隅での衝突を全体で最終チェックし、自分の辺方向へ逃がす
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (let a = 0; a < placedAll.length; a++) {
      for (let b = a + 1; b < placedAll.length; b++) {
        const A = placedAll[a], B = placedAll[b];
        const aw = A.it.w || 120, ah = A.it.h || 22;
        const bw = B.it.w || 120, bh = B.it.h || 22;
        const ox = (aw + bw) / 2 - Math.abs(A.lx - B.lx);
        const oy = (ah + bh) / 2 - Math.abs(A.ly - B.ly);
        if (ox > 0 && oy > 0) {
          const bHoriz = B.side === 'top' || B.side === 'bottom';
          if (bHoriz) B.lx += (B.lx >= A.lx ? ox + 2 : -(ox + 2));
          else B.ly += (B.ly >= A.ly ? oy + 2 : -(oy + 2));
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  // 配置して引き出し線を結ぶ
  for (const o of vis) {
    const { it, v } = o;
    const w = it.w || 120, h = it.h || 22;
    it.el.style.transform = `translate(${Math.floor(o.lx - w / 2)}px, ${Math.floor(o.ly - h / 2)}px)`;
    it.line.setAttribute('points', `${v.x},${v.y} ${o.lx},${o.ly}`);
    it.dot.setAttribute('cx', v.x);
    it.dot.setAttribute('cy', v.y);
  }
}
function enterOverview() {
  if (!viewer || !geoLoaded) return;
  applyOccluderClearing(); // 選択中の Issue の手前の部材だけを消す
  viewer.clearThemingColors();
  if (overlayApplied) applyOverlayColors(); // 重ね表示の色付け（Diff）を Issue 色の下に敷き直す
  colorIssueElements();
  const mkey = markersKey();
  if (markersBuiltFor !== mkey) { buildMarkers(); markersBuiltFor = mkey; }
  updateFocusPin(); // 一覧モード中はフォーカスピンを隠す
  if (pendingFocusId) { // 読み込み中に 3D ボタンで指定されていたら、この時点でカメラを寄せる
    const pi = DATA?.issues.find(x => x.id === pendingFocusId);
    pendingFocusId = null;
    const pt = pi && effTarget(pi);
    if (pt && pi.modelKey === viewerModelKey) {
      if (!fitToElement(pt.dbId, pt.model)) { try { viewer.fitToView([pt.dbId]); } catch (e) {} }
      colorIssueElements(); refreshMarkerSel(); applyOccluderClearing(); updateMarkers();
    }
  }
  const n = issuesOnCurrentModel().length;
  setStatV(`指摘事項一覧を表示中（このモデルの Issue ${n} 件）。色はステータス別、選択中は赤。${occHiddenCount ? '選択中の Issue の手前にある部材 ' + occHiddenCount + ' 件を透明（フレームのみ表示）にして、奥を見通せるようにしています。' : ''}ラベルをクリックすると詳細が開きます。`);
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
  else if (viewer && rootLoaded) {
    const k = markersKey();
    if (markersBuiltFor !== k) { buildMarkers(); markersBuiltFor = k; }
    setStatV('モデルの読み込み中：ピン位置で指摘箇所を先行表示しています。読み込みが終わると部材の位置に合わせ直します。');
  }
  else setStatV('モデルの読み込みが終わったら、指摘事項一覧を表示します。');
}
window.addEventListener('resize', () => { if (overviewOn) updateMarkers(); updateFocusPin(); });

// ---- 対象の手前の部材を透明にする（ゴースト表示でフレームだけ残す） ----
// 目的（2026-11-16 ユーザー定義）：建物の奥にある部材や、部材と部材の間にある
// 部材を見えるようにすること。方式は、カメラと対象の間にある部材だけを特定して
// Viewer 標準の非表示（hide）で消す。材質には一切触らないため、全体透明化で
// 頻発した描画の不安定さ（材質書き換えの競合・描画順の乱れ）が起きない。
// 消す範囲はスライダで調整する（対象のボックスを広げた分だけ広く消す。0% はオフ）。
// カメラを動かしたら見通しが追随するよう、移動後に再計算する（デバウンス付き）。
const LS_OCC = 'sampled-occluder-range';
let occluderRange = (() => {
  const raw = localStorage.getItem(LS_OCC);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 50;
})();
let hiddenOccluders = new Set(); // この機能が消した要素（戻す時に使う）
let occHiddenCount = 0;          // 直近の消去件数（ステータス表示用）
let occTargetDbId = null;        // 消去の対象要素
let streamingNow = false;        // 逐次配信中か（エッジ制御用）

// エッジ（部材の輪郭線）は逐次配信中だけ切る（描画負荷の軽減）。
function updateEdges() {
  if (!viewer) return;
  try { viewer.setDisplayEdges(!streamingNow); } catch (e) {}
}

// この機能が消した要素をすべて戻す
function clearOccluders() {
  applyOccluderSet(new Set());
  occTargetDbId = null;
}

// 線分（始点 o、方向 d、パラメータ 0..tMax）がボックス b と交わるか（スラブ法）
function segmentHitsBox(o, d, tMax, b) {
  let tmin = 0, tmax = tMax;
  for (const ax of ['x', 'y', 'z']) {
    if (Math.abs(d[ax]) < 1e-9) { if (o[ax] < b.min[ax] || o[ax] > b.max[ax]) return false; }
    else {
      let t1 = (b.min[ax] - o[ax]) / d[ax], t2 = (b.max[ax] - o[ax]) / d[ax];
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      if (tmin > tmax) return false;
    }
  }
  return true;
}

// カメラと対象（targetDbId）の間にある要素の dbId 一覧を返す。
// 判定：カメラから「拡大した対象ボックスの8隅＋中心」へ引いた線分のどれかが、
// 要素のボックスと対象より手前で交わるか。対象自身・その祖先と子孫・この
// モデルの他の Issue 要素は消さない。
// 要素の祖先を除外集合へ追加する。LMV の正しいメソッド名は getNodeParentId
// （getNodeParent は存在せず、呼び出すと例外で computeOccluders 全体が死ぬ。
// v8.16 で祖先除外を入れた時に混入し、手前消去が全く効かなくなっていた）
function addAncestors(tree, id, set) {
  let cur = id;
  for (let depth = 0; depth < 64; depth++) {
    let p = null;
    try { p = tree.getNodeParentId(cur); } catch (e) { break; }
    if (p == null || p <= 0 || p === cur || set.has(p)) break;
    set.add(p);
    cur = p;
  }
}
function computeOccluders(targetDbId) {
  const tree = viewer.model.getInstanceTree();
  const tBox = nodeWorldBox(targetDbId);
  if (!tree || !tBox) return [];
  const cam = viewer.navigation.getPosition();
  const C = { x: cam.x, y: cam.y, z: cam.z };
  const center = { x: (tBox.min.x + tBox.max.x) / 2, y: (tBox.min.y + tBox.max.y) / 2, z: (tBox.min.z + tBox.max.z) / 2 };
  const f = 1 + occluderRange / 100 * 2; // 消す範囲（対象ボックスの拡大率。50%→2倍、100%→3倍）
  const exMin = { x: center.x - (center.x - tBox.min.x) * f, y: center.y - (center.y - tBox.min.y) * f, z: center.z - (center.z - tBox.min.z) * f };
  const exMax = { x: center.x + (tBox.max.x - center.x) * f, y: center.y + (tBox.max.y - center.y) * f, z: center.z + (tBox.max.z - center.z) * f };
  const ends = [center];
  for (const x of [exMin.x, exMax.x]) for (const y of [exMin.y, exMax.y]) for (const z of [exMin.z, exMax.z]) ends.push({ x, y, z });
  const rays = ends.map(e => ({ o: C, d: { x: e.x - C.x, y: e.y - C.y, z: e.z - C.z } }));
  const distC = Math.hypot(center.x - C.x, center.y - C.y, center.z - C.z);
  const excluded = new Set([targetDbId]);
  addAncestors(tree, targetDbId, excluded);
  (function mark(id) { excluded.add(id); tree.enumNodeChildren(id, c => mark(c)); })(targetDbId);
  // 他の Issue 要素とその祖先も消さない（祖先を消すと配下の Issue 要素ごと消えてしまう）
  for (const i of issuesOnCurrentModel()) {
    const t = effTarget(i);
    if (!t || t.model !== viewer.model) continue; // 主表示（最新版）のシーンにある要素だけが対象
    excluded.add(t.dbId);
    addAncestors(tree, t.dbId, excluded);
  }
  const result = [];
  for (const cand of occluderCandidates()) {
    if (excluded.has(cand.dbId)) continue;
    const b = cand.box;
    const bcx = (b.min.x + b.max.x) / 2, bcy = (b.min.y + b.max.y) / 2, bcz = (b.min.z + b.max.z) / 2;
    const br = Math.hypot(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z) / 2;
    if (Math.hypot(bcx - C.x, bcy - C.y, bcz - C.z) - br < distC) {
      for (const r of rays) { if (segmentHitsBox(r.o, r.d, 1, b)) { result.push(cand.dbId); break; } }
    }
  }
  return result;
}

// 描画される要素（自身のフラグメントを持つノード）とそのボックスの一覧。
// モデル単位でキャッシュし、消去の再計算では幾何判定だけを行う（高速化）。
let occCache = null;
function occluderCandidates() {
  if (occCache?.modelKey === viewerModelKey) return occCache.list;
  const tree = viewer.model.getInstanceTree();
  const list = [];
  if (tree) {
    (function walk(id) {
      let own = 0;
      tree.enumNodeFragments(id, () => own++, false);
      if (own > 0) { const b = nodeWorldBox(id); if (b) list.push({ dbId: id, box: b }); }
      tree.enumNodeChildren(id, c => walk(c));
    })(tree.getRootId());
  }
  occCache = { modelKey: viewerModelKey, list };
  return list;
}

// 選択中の Issue の要素について、手前の部材を消し直す
// 非表示セットを差分だけで適用する。以前は再計算のたびに「全部戻してから
// 消し直す」ため、カメラ移動や Issue 切替のたびに表示状態の組み替えが走って
// 描画がバタついていた（実機報告：操作するとちらつく）
function applyOccluderSet(next) {
  const toShow = [...hiddenOccluders].filter(id => !next.has(id));
  const toHide = [...next].filter(id => !hiddenOccluders.has(id));
  if (viewer && toShow.length) { try { viewer.show(toShow); } catch (e) {} }
  if (viewer && toHide.length) { try { viewer.hide(toHide); } catch (e) {} }
  hiddenOccluders = next;
  occHiddenCount = next.size;
}
function applyOccluderClearing() {
  if (!viewer || !geoLoaded || viewerMode !== 'aps' || occluderRange <= 0) { applyOccluderSet(new Set()); occTargetDbId = null; return 0; }
  const i = issue() ?? focusedIssue();
  const t = i && effTarget(i);
  // 手前消去は主表示モデル（最新版）の要素に対してだけ行う。対象が旧版ゴースト側にある場合は行わない
  if (!t || t.model !== viewer.model || i.modelKey !== viewerModelKey) { applyOccluderSet(new Set()); occTargetDbId = null; return 0; }
  try {
    const occ = computeOccluders(t.dbId);
    applyOccluderSet(new Set(occ));
    occTargetDbId = t.dbId;
    if (overviewOn) setStatV(`<b>#${i.displayId}</b> の見通しのため、手前の部材 <b>${occ.length} 件</b>を透明にしています（フレームのみ表示・範囲 ${occluderRange}%）。`);
    return occ.length;
  } catch (e) {
    console.error('手前の部材の特定に失敗しました', e);
    setStatV('手前の部材の特定に失敗しました：' + esc(e?.message ?? e));
    return 0;
  }
}

// 透明セットは Issue を選んだ時点（フォーカス視点）で1回だけ決めて固定する。
// 以前はカメラが止まるたびに再計算して付け替えていたが、その付け替えのたびに
// 半透明の部材が一瞬ちらついた（実機報告）。カメラ移動では再計算しない
// （2026-11-16、ユーザーが「付け替えをやめる案」を選択）。再計算するのは
// Issue の切替・範囲スライダの変更・モデルの読み込み完了の時だけ。
// フォーカス移動中に保留した分は、到着時（fitToElement の完了処理）か、
// ユーザーが移動を中断した時に1回だけ適用する。

function syncGhostBtn() {
  const p = $('ghostPanel');
  window.dispatchEvent(new CustomEvent('demo-ghost-state', { detail: p ? !p.hidden : false }));
}
function toggleGhostPanel() {
  const p = $('ghostPanel');
  if (!p) return;
  p.hidden = !p.hidden;
  if (!p.hidden) { $('ghostRange').value = occluderRange; $('ghostVal').textContent = occluderRange + '%'; }
  syncGhostBtn();
}
const ghostRangeEl = $('ghostRange');
if (ghostRangeEl) ghostRangeEl.addEventListener('input', () => {
  occluderRange = Number(ghostRangeEl.value);
  $('ghostVal').textContent = occluderRange + '%';
  localStorage.setItem(LS_OCC, String(occluderRange));
  if (occluderRange <= 0) clearOccluders();
  else applyOccluderClearing();
});

// 対象要素へカメラを寄せる。Viewer 標準の fitToView だと部材が画面いっぱいに
// なって近すぎるため、部材のボックスから距離を計算して「引き」で収める
// （2026-11-16 ユーザー指示）。
let focusAnim = null; // フォーカス移動アニメーションの状態（ユーザー操作で中断する）
function cancelFocusAnim() { if (focusAnim) { cancelAnimationFrame(focusAnim.raf); focusAnim = null; } }
function fitToElement(dbId, model) {
  const box = nodeWorldBox(dbId, model);
  if (!box) return false;
  try {
    const T = THREE;
    const c = new T.Vector3((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2);
    const dx = box.max.x - box.min.x, dy = box.max.y - box.min.y, dz = box.max.z - box.min.z;
    const radius = Math.max(0.5 * Math.sqrt(dx * dx + dy * dy + dz * dz), 0.5);
    const fov = (((viewer.impl.camera.fov ?? 45) * Math.PI) / 180);
    const dist = (radius / Math.tan(fov / 2)) * 1.9; // 1.9 は「引き」の余裕分
    // 方向は「現在の方位だけを引き継ぎ、仰角は 28° に固定」して作り直す。
    // 以前は現在のカメラ方向と上方向をそのまま引き継いでいたため、全体表示の
    // 急な斜め方向がそのまま近接ビューになり「斜め」に見えた（実機報告）。
    // 上方向は常にワールド Z に固定し、水平が傾かないようにする。
    const cur = viewer.impl.camera.position.clone().sub(c);
    let az = Math.atan2(cur.y, cur.x);
    if (!isFinite(az)) az = Math.PI / 4;
    const el = (28 * Math.PI) / 180;
    const dir = new T.Vector3(Math.cos(az) * Math.cos(el), Math.sin(az) * Math.cos(el), Math.sin(el));
    const dest = c.clone().add(dir.multiplyScalar(dist));
    // 回転中心（ピボット）も対象へ合わせる。setView はピボットを動かさないため、
    // 放っておくと原点中心の回転になり、回すたびにビューが斜めに振れる（実測で確認）
    try { viewer.navigation.setPivotPoint(c); } catch (e) {}
    // 滑らかに移動する。setView は瞬間移動なので、イージング付きで補間する
    // （移動中にユーザーが操作したら cancelFocusAnim で譲る）
    const fromPos = viewer.impl.camera.position.clone();
    const fromTgt = viewer.navigation.getTarget().clone();
    const travel = fromPos.distanceTo(dest);
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    cancelFocusAnim();
    if (reduceMotion || travel < 1.5) { viewer.navigation.setView(dest, c, new T.Vector3(0, 0, 1)); return true; }
    const dur = Math.min(1200, Math.max(650, 450 + travel * 1.2));
    const t0 = performance.now();
    const ease = (x) => x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    const anim = { raf: 0 };
    focusAnim = anim;
    const step = (now) => {
      if (focusAnim !== anim) return;
      const t = Math.min(1, Math.max(0, (now - t0) / dur));
      const e = ease(t);
      viewer.navigation.setView(fromPos.clone().lerp(dest, e), fromTgt.clone().lerp(c, e), new T.Vector3(0, 0, 1));
      if (t < 1) anim.raf = requestAnimationFrame(step);
      else { focusAnim = null; if (occTargetDbId) applyOccluderClearing(); } // 到着した視点で透明セットを1回だけ確定する
    };
    anim.raf = requestAnimationFrame(step);
    return true;
  } catch (e) { return false; }
}

// フォーカス中の Issue を Viewer に反映
function applySelection() {
  if (overviewOn) return;
  const i = focusedIssue();
  if (!viewer || !rootLoaded || !i) return;
  const t = effTarget(i);
  if (!t || i.modelKey !== viewerModelKey) {
    if (!i.targetDbId && !i.targetDbIdLatest) { clearOccluders(); viewer.showAll(); viewer.clearThemingColors(); if (overlayApplied) { applyOverlayColors(); hideGhostKeep(); } setStatV('この Issue は対象モデルへのピンがないため、モデル全体を表示しています。'); }
    updateFocusPin();
    return;
  }
  if (!viewer.model?.getFragmentList?.()) return;
  try {
    viewer.clearThemingColors();
    if (overlayApplied) applyOverlayColors(); // 重ね表示の色付けはクリアのたびに重ね直す
    // カメラのフィットは、形状の読み込みが終わってから対象ごとに1回だけ行う。
    // 読み込み途中のイベント（ルート読み込み時など）で繰り返すと、不完全な範囲への
    // フィット（モデル全体の俯瞰表示など）と競合して画面が跳ぶ（2026-11-15/16 報告）。
    // 明示的なフォーカス操作（3D ボタン／ツールバーのフォーカスボタン）は fittedFor を
    // リセットするので、その場合はもう一度フィットする。
    const fkey = viewerModelKey + ':' + i.id;
    if (fittedFor !== fkey && (geoLoaded || rootLoaded)) {
      if (fitToElement(t.dbId, t.model)) fittedFor = fkey;
      else if (geoLoaded && t.model === viewer.model) { try { viewer.fitToView([t.dbId]); } catch (e) {} fittedFor = fkey; }
    }
    if (focusAnim) {
      // フォーカスの移動アニメーション中：透明化はまだ適用しない。
      // 移動開始時点の視点で計算すると、到着時にもう一度付け替わり、
      // 半透明の部材が一瞬ちらつく（実機報告）。到着時に1回だけ適用する
      // （fitToElement の完了処理が occTargetDbId を見て適用する）。
      occTargetDbId = t.model === viewer.model ? t.dbId : null;
    } else {
      applyOccluderClearing(); // 対象の手前の部材だけを透明にする（材質には触らない）
    }
  } catch (e) { return; }
  paintFocusTarget(t.dbId, t.model);
  updateFocusPin();
  if (geoLoaded) {
    setStatV(`<b>#${i.displayId}</b> の対象要素を表示中（${occHiddenCount ? '手前の部材 ' + occHiddenCount + ' 件を透明にして見通しを確保' : '手前の部材は透明にしていません'}）。`);
    scheduleCapture(i);
  }
}

// 表示する viewable の geometry ノードを選ぶ。
// models.json の guid はグラフィックスリソース（SVF）の guid で、geometry ノード自身の
// guid とは別物。findByGuid(guid) はリソースノードを返してしまい、それをそのまま
// loadDocumentNode に渡すと Viewer が「The file extension loaded into the Viewer is
// not supported」エラーになる（v8.34 初版の回帰、2026-11-17 実機報告）。
// そのため「配下にその guid のリソースを含む geometry ノード」を探して返す。
// 見つからなければ既定ジオメトリにフォールバックする。
function pickViewableNode(doc, guid) {
  const root = doc.getRoot();
  if (guid && root.traverse) {
    let found = null;
    root.traverse((n) => {
      if (found) return true;
      if (n.isGeometry && n.isGeometry()) {
        let hit = false;
        n.traverse((c) => { if (c.data && c.data.guid === guid) { hit = true; return true; } });
        if (hit) { found = n; return true; }
      }
    });
    if (found) return found;
  }
  return root.getDefaultGeometry();
}

function setupViewer(modelKey) {
  const m = DATA?.models.find(x => x.key === modelKey);
  if (!m || !window.Autodesk) return;
  if (viewer && viewerModelKey === modelKey) return;
  if (viewer) { clearMarkers(); try { viewer.finish(); } catch (e) {} viewer = null; }
  $('viewerWrap').innerHTML = '';
  setViewerLoading(`モデル（${esc(m.short)}）を読み込んでいます…`);
  viewerModelKey = modelKey; rootLoaded = false; geoLoaded = false; fittedFor = null; hiddenOccluders = new Set(); occHiddenCount = 0; occTargetDbId = null; occCache = null; streamingNow = true;
  ghostModel = null; ghostGeoLoaded = false; overlayData = null; overlayApplied = false;
  if (overlayFetchTimer) { clearTimeout(overlayFetchTimer); overlayFetchTimer = null; }
  overlayExpected = !!(m.latest && !overlayDisabledKeys.has(modelKey));
  if (overlayExpected) fetchOverlay(modelKey);
  viewer = new Autodesk.Viewing.GuiViewer3D($('viewerWrap'));
  viewer.start();
  // 手前の部材は「消す」のではなく透明にする：Viewer のゴースト表示を有効にすると、
  // hide した部材がフレーム（輪郭）だけを残して透けて見える（ユーザー指定 2026-11-16）
  try { viewer.setGhosting(true); } catch (e) {}
  viewer.loadExtension('DemoToolbarExtension').then(() => syncOverviewBtn()).catch(() => {});
  let markersRaf = 0;
  const updMarkers = () => {
    if (markersRaf) return; // カメラ移動中は毎フレームではなく描画フレーム単位に間引く
    markersRaf = requestAnimationFrame(() => { markersRaf = 0; if (overviewOn) updateMarkers(); updateFocusPin(); });
  };
  viewer.addEventListener(Autodesk.Viewing.CAMERA_CHANGE_EVENT, updMarkers);
  viewer.addEventListener(Autodesk.Viewing.ISOLATE_EVENT, updMarkers);
  viewer.addEventListener(Autodesk.Viewing.HIDE_EVENT, updMarkers);
  viewer.addEventListener(Autodesk.Viewing.SHOW_EVENT, updMarkers);
  viewer.addEventListener(Autodesk.Viewing.MODEL_ROOT_LOADED_EVENT, () => {
    rootLoaded = true;
    applySelection();
    // 形状のストリーミング完了を待たず、ピン座標でラベル＋引き出し線を先行表示する
    if (overviewOn) { const k = markersKey(); if (markersBuiltFor !== k) { buildMarkers(); markersBuiltFor = k; } }
    updateFocusPin();
    setStatV(`モデル（${esc(m.short)}）の読み込み中…`);
  });
  viewer.addEventListener(Autodesk.Viewing.GEOMETRY_LOADED_EVENT, (e) => {
    // 重ね表示の旧版（ゴースト）モデルの読み込み完了は、主表示側の完了処理と分ける
    if (overlayExpected && e?.model && viewer.model && e.model !== viewer.model) {
      ghostGeoLoaded = true;
      if (!ghostModel) ghostModel = e.model;
      maybeApplyOverlay();
      return;
    }
    geoLoaded = true;
    streamingNow = false;
    occCache = null; // 候補（要素ボックス）キャッシュは形状確定後に作り直す
    updateEdges();
    setViewerLoading(null);
    if (overviewOn) { enterOverview(); return; }
    applySelection();
    const i = focusedIssue();
    setStatV(`モデルの読み込みが完了しました。` + (i && effTarget(i) ? ` <b>#${i.displayId}</b> の対象要素を表示中（選択から ${((performance.now() - tSelect) / 1000).toFixed(1)} 秒）。` : ''));
  });
  viewer.addEventListener(Autodesk.Viewing.PROGRESS_UPDATE_EVENT, (e) => {
    if (!geoLoaded && typeof e.percent === 'number') {
      setStatV(`モデル（${esc(m.short)}）を読み込んでいます（逐次配信）… ${Math.round(e.percent)}%`);
      setViewerLoading(`モデル（${esc(m.short)}）を読み込んでいます… ${Math.round(e.percent)}%`);
      updMarkers(); // 先行表示中のラベル／ピンを、配信中の視点変化にも追随させる（rAF で間引き済み）
    }
  });
  // 既定ジオメトリ任せにしない：Snowdon 建築の既定は壁だけの viewable「Coord - Arch Walls」で、
  // 外灯・藤棚・植栽などがそもそも描画されなかった（2026-11-17 ユーザー指摘）。
  // models.json で指定した viewable（全カテゴリの「New Construction」等）を明示的に開く。
  // 重ね表示（v8.35）：新しい版があるモデルは、最新版を主表示として先に読み込み、
  // 基準版を2つ目のモデルとして重ねる（主表示が viewer.model になるよう先に読む）。
  const primaryUrn = overlayExpected ? m.latest.urn : m.urn;
  const primaryGuid = overlayExpected ? m.latest.guid : m.guid;
  Autodesk.Viewing.Document.load('urn:' + primaryUrn, (doc) => {
    viewer.loadDocumentNode(doc, pickViewableNode(doc, primaryGuid));
    setStatV(`モデル（${esc(m.short)}）を読み込んでいます（逐次配信）…`);
    if (overlayExpected) {
      Autodesk.Viewing.Document.load('urn:' + m.urn, (doc2) => {
        viewer.loadDocumentNode(doc2, pickViewableNode(doc2, m.guid), { keepCurrentModels: true })
          .then(model => { ghostModel = model; maybeApplyOverlay(); })
          .catch(() => {});
      }, () => {});
    }
  }, (code, msg2) => { setStatV('モデルの読み込みに失敗しました：' + code + ' ' + esc(msg2 ?? '')); setViewerLoading('モデルの読み込みに失敗しました：' + code); });
}

// ---- 重ね表示（最新版＋旧版ゴースト） ----
// サーバーから「基準版 → 最新版」の変更要素集合（両版の dbId）を取得する。
// 取得中は数秒おきに再試行し、失敗したら通常表示（基準版のみ）に切り替える。
function fetchOverlay(key, tries = 0) {
  fetch('/api/overlay?model=' + encodeURIComponent(key)).then(r => r.json()).then(j => {
    if (viewerModelKey !== key || !overlayExpected) return; // 既に別のモデルへ切り替わっていたら捨てる
    if (j.status === 'ready') {
      overlayData = j;
      maybeApplyOverlay();
      if (geoLoaded) { // アンカーが最新版に切り替わるので、マーカーと選択表示を作り直す
        markersBuiltFor = null;
        if (overviewOn) { colorIssueElements(); const k = markersKey(); buildMarkers(); markersBuiltFor = k; updateMarkers(); }
        else applySelection();
      }
    } else if (j.status === 'building' && tries < 40) {
      overlayFetchTimer = setTimeout(() => fetchOverlay(key, tries + 1), 4000);
    } else if (j.status === 'failed' || j.status === 'na') {
      overlayDisabledKeys.add(key);
      overlayExpected = false;
      setStatV('重ね表示の準備に失敗したため、通常表示（ピン時点の版）に切り替えました。');
      const v = viewer; viewer = null; viewerModelKey = null; // setupViewer の同一モデル早期リターンを回避して作り直す
      try { v?.finish(); } catch (e) {}
      setupViewer(key);
    }
  }).catch(() => {
    if (viewerModelKey === key && overlayExpected && tries < 40) overlayFetchTimer = setTimeout(() => fetchOverlay(key, tries + 1), 4000);
  });
}
function maybeApplyOverlay() {
  if (!overlayExpected || overlayApplied || overlayData?.status !== 'ready' || !ghostModel || !ghostGeoLoaded) return;
  applyOverlay();
}
// 旧版モデルの大半を完全に消し、削除・変更前の要素だけをゴースト（半透明フレーム）で残す。
// 完全に消す方は hide ではなく setNodeOff を使う：ゴースト表示が有効な間は hide した
// 要素がフレームとして残ってしまうため（履歴グラフ側で発生した「白い屋根」問題と同じ）。
function applyOverlay() {
  overlayApplied = true;
  const keep = new Set([...overlayData.removed, ...overlayData.changedBase]);
  try {
    const f2d = ghostModel.getData().fragments.fragId2dbId;
    const vm = ghostModel.visibilityManager;
    for (const id of new Set(Object.values(f2d))) {
      if (!keep.has(id)) { try { vm.setNodeOff(id, true); } catch (e) {} }
    }
  } catch (e) {}
  applyOverlayColors();
  hideGhostKeep();
  // Issue の色（ステータス色・選択色）を Diff 色の上に重ね直す
  if (overviewOn) colorIssueElements();
  else { const i = focusedIssue(); const t = i && effTarget(i); if (t) paintFocusTarget(t.dbId, t.model); }
  setStatV(`重ね表示：最新版 V${overlayData.toVersion} を表示し、旧版 V${overlayData.fromVersion} の削除要素（赤）と変更前の位置（黄）をゴーストで重ねています。最新版の追加要素は緑、変更要素は黄で表示します。`);
}
// 旧版のゴースト要素（削除・変更前）を半透明フレーム表示にする。showAll 等で
// 戻されてしまった場合に呼び直せるよう分離している
function hideGhostKeep() {
  if (!overlayData || !ghostModel) return;
  try { viewer.hide([...overlayData.removed, ...overlayData.changedBase], ghostModel); } catch (e) {}
}
// 重ね表示の色付けだけを行う（theming のクリア後に重ね直せるよう分離）
function applyOverlayColors() {
  if (!overlayData || overlayData.status !== 'ready') return;
  if (ghostModel) {
    try { for (const id of overlayData.changedBase) viewer.setThemingColor(id, v4(1, 0.8, 0.1, 1), ghostModel); } catch (e) {}
    try { for (const id of overlayData.removed) viewer.setThemingColor(id, v4(1, 0.15, 0.15, 1), ghostModel); } catch (e) {}
  }
  try { for (const id of overlayData.added) viewer.setThemingColor(id, v4(0.2, 0.8, 0.3, 1)); } catch (e) {}
  try { for (const id of overlayData.changed) viewer.setThemingColor(id, v4(1, 0.8, 0.1, 1)); } catch (e) {}
}

// ビューアの読み込み表示（#viewerMsg）を実際の状態に合わせて出し分ける。
// 以前は HTML に静的に書かれた「モデルを読み込んでいます…」で、実際には読み込んで
// いない時にも出続けていた（2026-11-16 ユーザー指摘）。
function setViewerLoading(text) {
  const msg = $('viewerMsg'); if (!msg) return;
  if (text) { msg.style.display = ''; const t = $('viewerMsgText'); if (t) t.textContent = text; }
  else msg.style.display = 'none';
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
        this.btnGhost.setToolTip('対象の手前を消す');
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
window.addEventListener('demo-focus-target', () => {
  const i = issue() ?? focusedIssue();
  const t = i && effTarget(i);
  if (!viewer || !t || i.modelKey !== viewerModelKey) return;
  if (!fitToElement(t.dbId, t.model)) { try { viewer.fitToView([t.dbId]); } catch (e) {} }
  fittedFor = viewerModelKey + ':' + i.id;
  if (overviewOn) { colorIssueElements(); updateMarkers(); applyOccluderClearing(); }
  else applySelection();
});
window.addEventListener('demo-toggle-overview', () => toggleOverview());
window.addEventListener('demo-toggle-ghost-panel', () => toggleGhostPanel());
// フォーカスの移動中にユーザーがビューアを操作したら、アニメーションを譲る
for (const ev of ['pointerdown', 'wheel']) {
  document.getElementById('viewerWrap')?.addEventListener(ev, () => {
    const wasAnim = !!focusAnim;
    cancelFocusAnim();
    if (wasAnim && occTargetDbId) applyOccluderClearing(); // 中断した視点で保留中の透明セットを1回だけ確定する
  }, { passive: true });
}

async function initViewer() {
  if (!window.Autodesk) {
    setViewerLoading('Viewer ライブラリを読み込めませんでした（この環境からは Autodesk の CDN に届きません）。通常のブラウザ環境で開いてください。');
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
    // Issue データがまだ届いていない間は、ここでモデルを読み始めない。
    // 先に始めると一覧の先頭モデル（DACH・最大 132MB）で読み込みが始まり、
    // データ到着後に選択中の Issue のモデルへ切り替わって読み込みが二重になる
    // （実機報告：ロードが遅い）。データ到着側の初期処理が正しいモデルで始める。
    if (DATA) setupViewer(desiredModelKey ?? focusedIssue()?.modelKey ?? DATA.models[0]?.key ?? 'dach');
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
    const first = DATA.issues.find(i => i.targetDbId || i.targetDbIdLatest) ?? DATA.issues[0];
    if (first) selectIssue(first.id); // 詳細だけ開く。ビューア表示は専用ボタンから
    // 初期化の競合対策：Viewer の準備が先に終わっていて、データ未着でモデルを
    // 作れなかった場合は、データが揃ったこの時点で必ずモデル読み込みを始める
    if (viewerReady && !viewer) setupViewer(focusedIssue()?.modelKey ?? DATA.models[0]?.key ?? 'dach');
    watchIndexStatus();
  } catch (e) {
    $('issueRows').innerHTML = '<tr><td colspan="99" style="color:#c0392b">Issue の取得に失敗しました。</td></tr>';
    setViewerLoading('Issue データを読み込めませんでした。');
    setStatV('Issue の取得に失敗しました：' + e.message);
  }
})();
