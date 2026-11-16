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
async function buildTimeline() {
  const i = issue();
  if (!i) { $('tlTitle').textContent = '—'; $('tlBody').innerHTML = ''; return; }
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
  if (selectedId !== myId) return; // 待っている間に選択が切り替わっていたら、古い描画で上書きしない
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
  for (const rp of i.history.relatedPairs ?? []) {
    const chg = rp.change === 'added' ? '追加' : rp.change === 'removed' ? '削除' : '変更';
    evs.push({
      t: rp.publishedAt, cls: 'model', pair: { from: rp.from, to: rp.to, label: rp.label }, version: rp.version,
      html: `<b>関連するモデル更新 — ${esc(rp.label)}</b>`,
      note: `ピン対象要素${rp.anchorName ? `「${esc(rp.anchorName)}」` : ''}がこのペアで${chg}されました（ライブ diff で判定）`,
    });
  }
  evs.sort((a, b) => String(a.t ?? '').localeCompare(String(b.t ?? '')));
  if (i.history.relatedPairsPending) {
    evs.push({ t: null, cls: 'model', html: '<b>関連するモデル更新</b> — ライブ diff で確認中…', note: 'diff ジョブの完了後に自動で表示されます' });
  }
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
      if (e?.pair) applyPair({ ...e.pair, version: e.version }, true);
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
// ---- 版ペアのピッカー（Issue やイベントの選択とは独立に任意ペアを指定できる） ----
function pairLabel(from, to) {
  if (from === 2 && to === 4) return 'V2 → V4（実質 V3）';
  return `V${from} → V${to}`;
}
function populatePairPicker() {
  const opts = (DATA?.versions ?? []).map(v =>
    `<option value="${v.versionNumber}">V${v.versionNumber}${v.note ? '（変換不可）' : ''}</option>`).join('');
  $('pairFrom').innerHTML = opts;
  $('pairTo').innerHTML = opts;
  const vers = (DATA?.versions ?? []).map(v => v.versionNumber);
  if (vers.length) {
    $('pairFrom').value = String(vers[0]);
    $('pairTo').value = String(vers[vers.length - 1]);
  }
  syncPairPicker();
}
function syncPairPicker() {
  if (!selectedPair) return;
  if ([...$('pairFrom').options].some(o => Number(o.value) === selectedPair.from)) $('pairFrom').value = String(selectedPair.from);
  if ([...$('pairTo').options].some(o => Number(o.value) === selectedPair.to)) $('pairTo').value = String(selectedPair.to);
}
// ペアを確定し、ピッカー・タイムラインのハイライト・差分表示を一貫して動かす
function applyPair(pair, auto3d) {
  selectedPair = {
    from: pair.from, to: pair.to,
    version: pair.version ?? pair.to,
    label: pair.label ?? pairLabel(pair.from, pair.to),
  };
  diffViewCtx = null; // ペアが変わったら分類コンテキストは破棄（モード切替ボタンは無効に戻る）
  updateBaControls();
  renderDiffLegend();
  $('pairNote').textContent = '';
  syncPairPicker();
  buildTimeline().then(() => loadDiff(auto3d));
  updateViewerButton();
}
async function loadDiff(auto3d) {
  const i = issue();
  if (!selectedPair) {
    $('diffTitle').textContent = '差分ビュー';
    $('diffCounts').innerHTML = '';
    $('diffBody').innerHTML = '<div class="diff-empty">タイムラインのモデル更新イベントを選ぶか、上のピッカーで版ペアを指定すると差分が出ます。</div>';
    return;
  }
  const { from, to } = selectedPair;
  $('diffTitle').textContent = `差分ビュー — ${selectedPair.label ?? `V${from} → V${to}`}`;
  renderDiffLegend();
  $('diffBody').innerHTML = '<div class="diff-empty">読み込み中…</div>';
  let d;
  try {
    const r = await fetch(`/api/diff?from=${from}&to=${to}${i ? `&issue=${encodeURIComponent(i.id)}` : ''}`);
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
  if (!i) {
    side = '<p class="diff-note">Issue を選ぶと、そのピンの周辺にある変更の内訳も表示します。</p>';
  } else if (d.pinNote) {
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
    <div class="legend"><span><i class="la"></i>追加（After のみ・緑）</span><span><i class="ld"></i>削除（Before のみ・赤ゴースト）</span><span><i class="lc"></i>変更（After・黄／Before はゴースト）</span><span>変更なしは After のみ表示</span><span>※ Before／After の対応表はビューア脇の凡例に常時表示</span></div>
    ${diffMode === 'all' ? '<p class="diff-note">all モードでは 3D ビューアの色分けは行いません（色分けは geometry モードのみ）。all では件数とピン周辺の内訳が対象で、3D 側は版ペアの素表示（Before／After の切替のみ）になります。</p>' : '<p class="diff-note">3D は段階ロードです（After を先に表示し、Before が揃ったら色分けを適用）。表示範囲の既定は「差分フォーカス」（変更要素とその周辺のみ）で、ビューア脇のボタンで「全体表示」に切り替えられます。</p>'}
    <div class="diff-side">${side}</div>
  </div>`;
  for (const b of $('diffBody').querySelectorAll('[data-dmode]')) {
    b.addEventListener('click', () => {
      if (diffMode === b.dataset.dmode) return;
      diffMode = b.dataset.dmode;
      for (const x of $('diffBody').querySelectorAll('[data-dmode]')) x.classList.toggle('active', x.dataset.dmode === diffMode);
      diffViewCtx = null; // 要素リストが変わるので分類コンテキストは破棄する
      updateBaControls();
      reapplyDiff3D();
    });
  }
  $('diffGhostOld').addEventListener('change', () => {
    diffGhostOld = $('diffGhostOld').checked;
    // ゴースト切替は見せ方だけの変更なので、分類済みなら再取得せずに適用し直す
    if (diffViewCtx && diffPairShown && selectedPair && diffPairShown.from === selectedPair.from && diffPairShown.to === selectedPair.to) {
      applyDiffViewMode();
      renderDiffLegend();
    } else reapplyDiff3D();
  });
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
let diffViewMode = 'overlay';         // 3D 差分の見せ方: 'overlay'（重ねて表示）| 'before'（Before のみ）| 'after'（After のみ）
let diffScope = 'focus';              // 3D 差分の表示範囲: 'focus'（差分フォーカス＝変更要素とその周辺のみ・既定）| 'full'（全体表示）
let diffViewCtx = null;               // 分類済みの表示コンテキスト（モード切替時は再取得せずこれを使い回す）
function updateViewerButton() {
  $('btnViewer').disabled = !selectedPair;
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
// ---- Before／After の凡例と表示モード切替 ----
// 凡例はビューア脇に常時表示し、版ペアが変われば版番号が追従する。
function baModeLabel() {
  if (!selectedPair) return '';
  if (diffViewMode === 'before') return `Before のみ（V${selectedPair.from} の姿だけを表示）`;
  if (diffViewMode === 'after') return `After のみ（V${selectedPair.to} の姿だけを表示）`;
  return '重ねて表示（Before と After を重ねる）';
}
function scopeLabel() {
  return diffScope === 'focus' ? '差分フォーカス（変更要素とその周辺のみ表示）' : '全体表示（全要素を表示）';
}
function renderDiffLegend() {
  const el = $('diffLegend');
  if (!el) return;
  if (!selectedPair) {
    el.innerHTML = '<p class="dl-empty">差分ペアを選ぶと、Before／After の対応と色の意味がここに出ます。</p>';
    return;
  }
  const { from, to } = selectedPair;
  const plain = !!diffViewCtx?.plain;
  el.innerHTML = `
    <div class="dl-head">
      <span class="dl-ver dl-before">Before = V${from}（旧版）</span>
      <span class="dl-arrow">→</span>
      <span class="dl-ver dl-after">After = V${to}（新版）</span>
      <span class="dl-cur">現在の表示: ${esc(baModeLabel())}${plain ? '（all モード: 色分けなし）' : `／${esc(scopeLabel())}`}</span>
    </div>
    <ul class="dl-list">
      <li><i class="sw sw-a"></i><b>追加</b>（After にのみ存在する要素）: After の要素を<b>緑</b>で表示</li>
      <li><i class="sw sw-d"></i><b>削除</b>（Before にのみ存在する要素）: Before の要素を<b>赤いゴースト</b>で表示</li>
      <li><i class="sw sw-c"></i><b>変更</b>（両版に存在し変化した要素）: After の要素を<b>黄</b>で表示し、Before の要素を<b>薄黄ゴースト</b>で重ねて表示（ゴースト OFF のときは After のみ）</li>
      <li><i class="sw sw-n"></i><b>変更なし</b>: After の要素を通常表示（Before の同要素は重ねない）</li>
    </ul>
    ${diffMode === 'all' ? '<p class="dl-note">現在のモード（all）では 3D の色分けは行いません（色分けは geometry モードのみ）。all の件数と要素の内訳は差分ビュー側で確認してください。3D 側は版ペアの素表示（Before／After の切替のみ）になります。</p>' : ''}
    ${diffViewCtx && !plain && diffScope === 'focus' ? '<p class="dl-note">差分フォーカス中: 変更要素とその周辺（同じグループの要素）だけを表示しています。全要素を見る場合は「全体表示」に切り替えてください。</p>' : ''}
    ${diffViewCtx ? '' : '<p class="dl-note">「Before のみ／After のみ」「差分フォーカス／全体表示」の切り替えボタンは、3D 差分を表示したあと有効になります。</p>'}`;
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
  const note = $('baNote');
  if (note) note.textContent = has
    ? (plain ? `表示中: ${pairLabel(diffViewCtx.from, diffViewCtx.to)}（all モード: 3D 色分けなし）` : `表示中: ${pairLabel(diffViewCtx.from, diffViewCtx.to)}`)
    : '3D 差分を表示すると切り替えできます';
}
function setDiffViewMode(m) {
  diffViewMode = m;
  updateBaControls();
  renderDiffLegend();
  applyDiffViewMode();
}
function setDiffScope(s) {
  if (diffScope === s) return;
  diffScope = s;
  updateBaControls();
  renderDiffLegend();
  applyDiffViewMode();
}
// ---- 差分フォーカスの「周辺」計算 ----
// 変更要素の親グループ配下（兄弟サブツリー）を「周辺」とする。大きすぎるグループ
// （階全体など）は周辺に含めるとフォーカスにならないため、サイズ上限を超えたら除外する。
function subtreeIds(tree, root, limit) {
  const out = [];
  const walk = (id) => { if (out.length > limit) return; out.push(id); tree.enumNodeChildren(id, c => walk(c)); };
  walk(root);
  return out.length > limit ? null : out;
}
function siblingContextDbIds(model, seedIds) {
  const tree = model.getInstanceTree();
  if (!tree || !seedIds.length) return [];
  const seeds = new Set(seedIds);
  const ctx = new Set();
  const parents = new Set();
  for (const id of seeds) {
    let p = null;
    try { p = tree.getNodeParentId(id); } catch (e) {}
    if (p != null && p !== tree.getRootId()) parents.add(p);
  }
  for (const p of parents) {
    const sub = subtreeIds(tree, p, 3000);
    if (!sub) continue;
    for (const id of sub) if (!seeds.has(id)) ctx.add(id);
  }
  return [...ctx];
}
// 分類済みコンテキスト（diffViewCtx）に対して、表示モード×表示範囲に応じた表示／非表示と色付けだけを適用する。
// モード切替ではモデルも要素リストも再取得しない。
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
  if (ctx.plain) {
    // all モード: 要素単位の分類・色付けはせず、モデル単位で Before／After を切り替えるだけ
    if (diffViewMode === 'before') { show(fromM, ctx.allFrom); hide(toM, ctx.allTo); }
    else if (diffViewMode === 'after') { show(toM, ctx.allTo); hide(fromM, ctx.allFrom); }
    else { show(fromM, ctx.allFrom); show(toM, ctx.allTo); }
    return;
  }
  // 表示集合: 表示範囲（全体／フォーカス）× Before/After モードで決める
  let visFrom, visTo;
  if (diffScope === 'focus') {
    // 差分フォーカス: 変更要素とその周辺だけを出す。変更のない要素は両版とも隠す
    visTo = diffViewMode === 'before' ? [] : [...ctx.addedToDb, ...ctx.changedToDb, ...ctx.contextToDb];
    visFrom = diffViewMode === 'after' ? []
      : (diffViewMode === 'before' || diffGhostOld)
        ? [...ctx.removedDb, ...ctx.changedFromDb, ...ctx.contextFromDb]
        : [...ctx.removedDb, ...ctx.contextFromDb];
  } else {
    // 全体表示: 従来どおり（After は全要素、Before はモードに応じて全要素 or 削除＋変更のみ重ねる）
    visTo = diffViewMode === 'before' ? [] : ctx.allTo;
    visFrom = diffViewMode === 'after' ? []
      : diffViewMode === 'before' ? ctx.allFrom
      : diffGhostOld ? [...ctx.removedDb, ...ctx.changedFromDb] : [...ctx.removedDb];
  }
  show(toM, visTo);
  hide(toM, rest(ctx.allTo, visTo));
  show(fromM, visFrom);
  hide(fromM, rest(ctx.allFrom, visFrom));
  if (diffViewMode === 'before') {
    // Before のみ: 旧版の姿で見せる（削除=赤、変更=黄）
    theme(fromM, ctx.removedDb, V4(0.85, 0.16, 0.1, 0.9));
    theme(fromM, ctx.changedFromDb, V4(0.95, 0.72, 0.08, 0.9));
  } else if (diffViewMode === 'after') {
    // After のみ: 新版の姿で見せる（追加=緑、変更=黄）
    theme(toM, ctx.addedToDb, V4(0.1, 0.65, 0.3, 1));
    theme(toM, ctx.changedToDb, V4(0.95, 0.72, 0.08, 1));
  } else {
    // 重ねて表示: 新版に色を付け、旧版は削除（＋ゴースト ON 時は変更の旧形状）を重ねる
    theme(toM, ctx.addedToDb, V4(0.1, 0.65, 0.3, 1));
    theme(toM, ctx.changedToDb, V4(0.95, 0.72, 0.08, 1));
    theme(fromM, ctx.removedDb, V4(0.85, 0.16, 0.1, 0.45));
    if (diffGhostOld) theme(fromM, ctx.changedFromDb, V4(0.9, 0.7, 0.15, 0.35));
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
  // 分類結果を表示コンテキストとして保持し、見せ方の適用は applyDiffViewMode に寄せる。
  // contextFromDb／contextToDb は差分フォーカス用の「周辺」（変更要素の兄弟サブツリー）
  diffViewCtx = {
    from: selectedPair.from, to: selectedPair.to, fromM, toM,
    allFrom: allDbIds(fromM), allTo: allDbIds(toM),
    removedDb, changedFromDb, addedToDb, changedToDb,
    contextFromDb: siblingContextDbIds(fromM, [...removedDb, ...changedFromDb]),
    contextToDb: siblingContextDbIds(toM, [...addedToDb, ...changedToDb]),
  };
  applyDiffViewMode();
  updateBaControls();
  renderDiffLegend();
  // ピン対象要素があればそこへフィット（無ければピン座標へ）
  const i = issue();
  let fitted = false;
  const ext = i?.pin?.externalId;
  if (ext) {
    if (mapTo[ext] != null) { try { viewer.fitToView([mapTo[ext]], toM); fitted = true; } catch (e) {} }
    else if (mapFrom[ext] != null) { try { viewer.fitToView([mapFrom[ext]], fromM); fitted = true; } catch (e) {} }
  }
  if (!fitted) focusPin();
  diffStatus(`色分け適用済み — 3D 差分を表示中: V${selectedPair.from} → V${selectedPair.to}（追加 ${diffElements.counts.added}／削除 ${diffElements.counts.removed}／変更 ${diffElements.counts.changed}${diffMode === 'geometry' ? '・形状のみ' : '・プロパティのみ含む'}／${scopeLabel()}）`);
}
// モデルの見た目を素の状態（全表示・色なし）に戻す。段階ロードで After を先に見せるときに使う
function resetModelPresentation(model) {
  try { viewer.isolate([], model); } catch (e) {}
  try { viewer.clearThemingColors(model); } catch (e) {}
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
      if (v !== from && v !== to) { try { viewer.unloadModel(m); } catch (e) {} diffModelByVersion.delete(v); }
    }
    diffViewCtx = null; // 分類が済むまで切替ボタンは無効（古いペアの分類で切り替える事故防止）
    updateBaControls();
    renderDiffLegend();
    // 段階 1: After を先に表示する
    if (!diffModelByVersion.has(to)) { diffStatus(`After（V${to}・新版）を読み込み中…`); await loadVersionModel(to); }
    if (stale()) return;
    resetModelPresentation(diffModelByVersion.get(to));
    diffPairShown = { from, to };
    diffStatus(`After（V${to}）を表示中 — Before（V${from}・旧版）を読み込み中…`);
    focusPin();
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
      renderDiffLegend();
      diffStatus(`3D 表示中: V${from} → V${to}（all モードのため 3D 色分けはなし — 色分けは geometry モードのみ）`);
      return;
    }
    // 段階 3: 分類・色分けを適用する
    diffStatus(`Before（V${from}）の読み込み完了 — 分類と色分けを適用中…`);
    const els = await elementsPromise;
    if (stale()) return;
    if (!els) throw elementsError ?? new Error('要素リストを取得できませんでした');
    await applyDiffClassification();
  } catch (e) {
    if (!stale()) diffStatus('3D 差分を表示できませんでした: ' + e.message);
  } finally { diffBusy = false; }
}
function reapplyDiff3D() {
  // モード／ゴーストの切替: 表示中のペアが現在の選択と同じなら、モデルは再利用して分類だけやり直す
  if (diffPairShown && selectedPair && diffPairShown.from === selectedPair.from && diffPairShown.to === selectedPair.to) {
    showDiff3D();
  }
}

// ============ 選択・初期化 ============
function defaultPairFor(i) {
  // 既定の差分ペア：diffPair を持つ最新のモデル更新。無ければ関連するモデル更新の最新ペア
  const withPair = (i?.history.modelUpdates ?? []).filter(m => m.diffPair);
  if (withPair.length) {
    const m = withPair[withPair.length - 1];
    return { ...m.diffPair, version: m.version };
  }
  const rel = i?.history.relatedPairs ?? [];
  if (rel.length) {
    const rp = rel[rel.length - 1];
    return { from: rp.from, to: rp.to, version: rp.version, label: rp.label };
  }
  return null;
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
          const p = defaultPairFor(issue());
          if (p) { selectedPair = p; syncPairPicker(); loadDiff(false); updateViewerButton(); }
        }
      }
    } catch (e) { /* 次回に再試行 */ }
    scheduleRelatedPoll();
  }, 15000);
}
function selectIssue(id, scrollTimeline) {
  if (selectedId !== id) relatedPollTries = 0;
  selectedId = id;
  const i = issue();
  selectedPair = defaultPairFor(i);
  diffViewCtx = null; // Issue が変われば表示中の分類は別ペアのものになり得るため破棄
  updateBaControls();
  renderDiffLegend();
  syncPairPicker();
  buildTable();
  buildTimeline().then(() => { loadDiff(); });
  updateViewerButton();
  scheduleRelatedPoll();
}
async function loadAll() {
  const r = await fetch('/api/issues');
  if (!r.ok) throw new Error('Issue の取得に失敗しました（HTTP ' + r.status + '）');
  DATA = await r.json();
  $('headNote').textContent = `${DATA.project.name} — ${DATA.model.name}（V${DATA.versions.map(v => v.versionNumber).join(' / ')}）／履歴スナップショット: ${DATA.snapshot.refreshCount} 回・変化イベント ${DATA.snapshot.eventCount} 件`;
  populatePairPicker();
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
for (const b of document.querySelectorAll('[data-bamode]')) {
  b.addEventListener('click', () => setDiffViewMode(b.dataset.bamode));
}
for (const b of document.querySelectorAll('[data-scope]')) {
  b.addEventListener('click', () => setDiffScope(b.dataset.scope));
}
updateBaControls();
$('btnPair').addEventListener('click', () => {
  const from = Number($('pairFrom').value);
  const to = Number($('pairTo').value);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) {
    $('pairNote').textContent = 'From と To には異なる版を選んでください';
    return;
  }
  applyPair({ from, to, version: to }, true);
});
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
