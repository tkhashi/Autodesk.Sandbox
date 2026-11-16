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
      if (e?.pair) { selectedPair = { ...e.pair, version: e.version }; buildTimeline(); loadDiff(); updateViewerButton(); }
    });
  }
}

// ============ 差分ビュー ============
function countsChips(stats, geom) {
  let s = `<span class="dc a">追加 ${stats.added}</span><span class="dc d">削除 ${stats.removed}</span><span class="dc c">変更 ${stats.modified}</span>`;
  if (geom) s += `<span class="dc g">うち形状シグナル 追加 ${geom.added}／削除 ${geom.removed}／変更 ${geom.modified}</span>`;
  return s;
}
function plotSVG(d) {
  const np = d.nearPin;
  if (!np || !np.rows.length) return '';
  const rows = np.rows.slice(0, 120);
  const cx = np.anchorCenter.x, cy = np.anchorCenter.y;
  const R = 34; // 表示範囲（ft）
  const W = 400, H = 260, scale = (W / 2) / R;
  const X = v => W / 2 + (v - cx) * scale;
  const Y = v => H / 2 - (v - cy) * scale;
  const rect = (mn, mx, fill, stroke, dash) => {
    if (!mn || !mx) return '';
    const x = X(mn.x), y = Y(mx.y), w = Math.max(1.5, (mx.x - mn.x) * scale), h = Math.max(1.5, (mx.y - mn.y) * scale);
    if (x > W || y > H || x + w < 0 || y + h < 0) return '';
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${fill}" fill-opacity="0.55" stroke="${stroke}" stroke-width="1"${dash ? ' stroke-dasharray="3 2"' : ''}/>`;
  };
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="ピン周辺の差分（上面図・bbox）">`;
  s += `<rect x="0" y="0" width="${W}" height="${H}" fill="#fbfcfb"/>`;
  s += `<circle cx="${W / 2}" cy="${H / 2}" r="${30 * scale}" fill="none" stroke="#b9c9d6" stroke-dasharray="4 3"/>`;
  for (const r of rows) {
    if (r.type === 'added') s += rect(r.bboxMin, r.bboxMax, '#1e9e57', '#1e9e57');
    else if (r.type === 'removed') s += rect(r.prevBboxMin, r.prevBboxMax, '#d43a2f', '#d43a2f', true);
    else {
      s += rect(r.prevBboxMin, r.prevBboxMax, 'none', '#b8860b', true);
      s += rect(r.bboxMin, r.bboxMax, '#b8860b', '#b8860b');
    }
  }
  if (np.anchorBbox) s += rect(np.anchorBbox.min, np.anchorBbox.max, 'none', '#b91c1c');
  s += `<circle cx="${W / 2}" cy="${H / 2}" r="4" fill="#b91c1c" stroke="#fff" stroke-width="1.5"/>`;
  s += `<text x="${W / 2 + 8}" y="${H / 2 - 8}" font-size="11" font-weight="700" fill="#b91c1c">対象要素</text>`;
  return s + '</svg>';
}
async function loadDiff() {
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
      setTimeout(() => { if (selectedPair && selectedPair.from === from && selectedPair.to === to) loadDiff(); }, 10000);
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
      <div class="legend"><span><i class="la"></i>追加</span><span><i class="ld"></i>削除（旧位置）</span><span><i class="lc"></i>変更</span></div>
      <ul>${listItems || '<li>周辺に bbox を持つ変更はありません</li>'}</ul>
      ${np.rowsTruncated ? `<p class="diff-note">周辺 ${np.rowsTotal} 件中、形状シグナルのある行を優先して ${np.rows.length} 件まで表示しています。</p>` : ''}
      <p class="diff-note">「変更」件数には Revit の再保存に伴うプロパティ表記の揺れ（ロケール差など）が大量に含まれます。実際に形が変わった目安は「形状シグナル」（形状ハッシュ変化・bbox 移動）の件数です。近傍の判定はヒューリスティクスであり、この Issue の修正そのものとは限りません。</p>`;
  }
  $('diffBody').innerHTML = `<div class="diff-body"><div class="diff-flex">
    <div class="plan-box"><header><span>V${from} → V${to}（上面図・bbox）</span><span>${d.source === 'seed' ? '実測キャッシュ' : d.source}</span></header>${plotSVG(d) || '<div class="diff-empty">描画できる周辺要素がありません</div>'}</div>
    <div class="diff-side">${side}</div>
  </div></div>`;
}

// ============ APS Viewer（sample-d の初期化を移植。CDN 不達の環境では注記のみ） ============
let viewer = null, viewerInitStarted = false;
function updateViewerButton() {
  $('btnViewer').disabled = !(issue() && selectedPair);
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
function openViewer() {
  const i = issue();
  if (!i || !selectedPair) return;
  const ver = DATA.versions.find(v => v.versionNumber === selectedPair.version);
  if (!ver) return;
  if (!window.Autodesk?.Viewing) {
    $('viewerNote').textContent = 'Viewer の CDN に到達できないため、この環境では 3D を表示できません（実機ブラウザで開いてください）。';
    return;
  }
  $('viewerNote').textContent = `V${ver.versionNumber} を読み込み中…`;
  const start = () => {
    Autodesk.Viewing.Document.load('urn:' + ver.derivativeUrn, (doc) => {
      viewer.loadDocumentNode(doc, doc.getRoot().getDefaultGeometry()).then(() => {
        $('viewerNote').textContent = `V${ver.versionNumber} を表示中${i.pin ? '（ピン位置にフィット）' : ''}`;
        focusPin();
      }).catch(e => { $('viewerNote').textContent = 'モデルの読み込みに失敗しました: ' + e; });
    }, (code, msg) => { $('viewerNote').textContent = `ドキュメントの読み込みに失敗しました（${code}）`; });
  };
  if (viewer) { start(); return; }
  if (viewerInitStarted) return;
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
    start();
  });
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
$('btnViewer').addEventListener('click', openViewer);
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
