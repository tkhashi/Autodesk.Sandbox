// server.mjs — sample-d: 実 Issue（APS Issues API）+ 要素情報の自動付与 + Forma 風 UI + APS Viewer 表示
// 起動: node server.mjs（.env に APS_CLIENT_ID / APS_CLIENT_SECRET、.token.json に 3-legged トークンが必要）
//
// 対象モデルは data/models.json の登録簿（5モデル）。要素情報の索引（プロパティ／externalId→dbId 対応）は
// 事前生成せず、起動後に Model Derivative API から非同期に構築する（cache/ に派生キャッシュを残し、
// モデルのバージョンが変わったら作り直す）。サーバーは索引の完成を待たずに即座に起動する。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ============ 設定 ============
const root = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(root, 'public');
const BASE = 'https://developer.api.autodesk.com';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const env = {};
for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const models = JSON.parse(fs.readFileSync(path.join(root, 'data', 'models.json'), 'utf8'));
const PROJECT_ID = models[0].projectId; // 全モデル同一プロジェクト
const PID = PROJECT_ID.replace(/^b\./, ''); // Issues API は b. なし

function basicAuth() { return 'Basic ' + Buffer.from(env.APS_CLIENT_ID + ':' + env.APS_CLIENT_SECRET).toString('base64'); }
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
async function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = ''; req.on('data', c => { d += c; }); req.on('end', () => resolve(d)); req.on('error', reject);
  });
}

// ============ トークン ============
// 2-legged（アプリ認証）：有効期限内はキャッシュし、認証リクエストを繰り返さない
let token2Cache = null; // { access_token, expiresAt }
async function getToken2() {
  if (token2Cache && Date.now() < token2Cache.expiresAt) return token2Cache;
  const r = await fetch(BASE + '/authentication/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuth() },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'viewables:read data:read' }),
  });
  if (!r.ok) throw new Error('2-legged token failed: ' + r.status);
  const j = await r.json();
  token2Cache = { access_token: j.access_token, expires_in: j.expires_in, expiresAt: Date.now() + (j.expires_in - 300) * 1000 };
  return token2Cache;
}
// 3-legged（ユーザー認証、Issues API 用）：refresh token を .token.json に保持し、ローテーションに追随する
const TOKFILE = path.join(root, '.token.json');
let tok3 = JSON.parse(fs.readFileSync(TOKFILE, 'utf8'));
async function getToken3() {
  if (Date.now() - (tok3.obtained_at ?? 0) < 45 * 60000) return tok3.access_token;
  const r = await fetch(BASE + '/authentication/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuth() },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok3.refresh_token }),
  });
  if (!r.ok) throw new Error('3-legged refresh failed: ' + r.status);
  tok3 = { ...(await r.json()), obtained_at: Date.now() };
  fs.writeFileSync(TOKFILE, JSON.stringify(tok3, null, 1));
  return tok3.access_token;
}
// APS の GET（JSON）をまとめたヘルパー
async function apsGet(url, token) {
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error(`${url.split('/').slice(-2).join('/')} failed: ${r.status}`);
  return r.json();
}
// 202（処理中）を返し続ける API のポーリング（Model Derivative のプロパティ取得など）
async function pollUntilReady(url, token, label) {
  for (let i = 0; i < 120; i++) {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (r.status === 200) return r.json();
    if (r.status !== 202) throw new Error(label + ' status ' + r.status);
    await new Promise(s => setTimeout(s, 3000));
  }
  throw new Error(label + ' timeout');
}

// ============ モデル登録簿とバージョン ============
const versionCache = new Map(); // key → { at, value }（60秒）
async function getModelVersion(m) {
  const c = versionCache.get(m.key);
  if (c && Date.now() - c.at < 60000) return c.value;
  const token = (await getToken2()).access_token;
  const j = await apsGet(`${BASE}/data/v1/projects/${m.projectId}/items/${encodeURIComponent(m.lineage)}/versions`, token);
  const tip = j.data?.[0];
  const value = { versionNumber: tip?.attributes?.versionNumber ?? 1, versionId: tip?.id ?? null };
  versionCache.set(m.key, { at: Date.now(), value });
  return value;
}

// ============ 要素索引（API から非同期に構築、cache/ に派生キャッシュ） ============
const indexCacheDir = path.join(root, 'cache');
fs.mkdirSync(indexCacheDir, { recursive: true });
for (const m of models) {
  m.propsIndex = null; m.ext2dbid = null; m.indexStatus = 'idle'; m.indexError = null; m.indexVersionId = null;
  try { // 前回構築した派生キャッシュがあれば即座に使う
    const c = JSON.parse(fs.readFileSync(path.join(indexCacheDir, 'index-' + m.key + '.json'), 'utf8'));
    if (c?.propsIndex && c?.ext2dbid) {
      m.propsIndex = c.propsIndex; m.ext2dbid = c.ext2dbid;
      m.indexVersionId = c.versionId ?? null; m.indexStatus = 'ready';
    }
  } catch (e) {}
}
let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch (e) {}
async function buildIndex(m) {
  if (m.indexStatus === 'building') return;
  m.indexStatus = 'building'; m.indexError = null;
  const t0 = Date.now();
  try {
    if (!DatabaseSync) throw new Error('node:sqlite が使えません（Node 22.5+ が必要です）');
    const token = (await getToken2()).access_token;
    // プロパティ一式 → externalId → プロパティ（平坦化）
    const props = await pollUntilReady(`${BASE}/modelderivative/v2/designdata/${m.derivativeUrn}/metadata/${m.viewableGuid}/properties?forceget=true`, token, 'properties');
    const propsIndex = {};
    for (const o of props.data?.collection ?? []) {
      if (!o.externalId) continue;
      const entry = { name: o.name, revitId: o.name?.match(/\[(\d+)\]\s*$/)?.[1] ?? null, objectid: o.objectid };
      for (const g of Object.values(o.properties ?? {})) for (const [k, v] of Object.entries(g)) {
        if (!k.startsWith('_') && entry[k] === undefined) entry[k] = v;
      }
      propsIndex[o.externalId] = entry;
    }
    // model.sdb（変換データ同梱のプロパティ DB）→ externalId → Viewer の dbId
    const sdbUrn = `urn:adsk.viewing:fs.file:${m.derivativeUrn}/output/Resource/model.sdb`;
    const sr = await fetch(`${BASE}/modelderivative/v2/designdata/${m.derivativeUrn}/manifest/${encodeURIComponent(sdbUrn)}`, { headers: { Authorization: 'Bearer ' + token } });
    if (!sr.ok) throw new Error('sdb status ' + sr.status);
    const sdbPath = path.join(indexCacheDir, 'tmp-' + m.key + '.sdb');
    fs.writeFileSync(sdbPath, Buffer.from(await sr.arrayBuffer()));
    const db = new DatabaseSync(sdbPath);
    const ext2dbid = {};
    for (const row of db.prepare('SELECT id, external_id FROM _objects_id').all()) ext2dbid[row.external_id] = row.id;
    db.close();
    fs.rmSync(sdbPath, { force: true });
    m.propsIndex = propsIndex; m.ext2dbid = ext2dbid; m.indexStatus = 'ready';
    const ver = await getModelVersion(m).catch(() => null);
    m.indexVersionId = ver?.versionId ?? null;
    fs.writeFileSync(path.join(indexCacheDir, 'index-' + m.key + '.json'), JSON.stringify({ versionId: m.indexVersionId, builtAt: new Date().toISOString(), propsIndex, ext2dbid }));
    console.log(`index built: ${m.key} (props ${Object.keys(propsIndex).length}, map ${Object.keys(ext2dbid).length}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    m.indexStatus = 'error'; m.indexError = String(e?.message ?? e);
    console.error('index build failed:', m.key, e);
  }
}
function initIndexes() {
  for (const m of models) {
    if (m.indexStatus === 'ready') {
      // キャッシュ使用中でも、モデルのバージョンが変わっていたら作り直す
      getModelVersion(m).then(ver => {
        if (ver?.versionId && m.indexVersionId && ver.versionId !== m.indexVersionId) buildIndex(m);
      }).catch(() => {});
    } else {
      buildIndex(m);
    }
  }
}

// ============ Issues（タイプ／メンバーは10分キャッシュ） ============
function ttlCache(ttlMs) {
  let box = null;
  return async (fn) => {
    if (box && Date.now() - box.at < ttlMs) return box.value;
    const value = await fn().catch(() => null);
    if (value) box = { at: Date.now(), value };
    return value ?? new Map();
  };
}
const getIssueTypes = ttlCache(10 * 60000);
const getProjectUsers = ttlCache(10 * 60000);
async function loadIssueTypes(token) {
  const j = await apsGet(`${BASE}/construction/issues/v1/projects/${PID}/issue-types?include=subtypes`, token);
  const map = new Map();
  for (const t of j.results ?? []) for (const s of t.subtypes ?? []) {
    map.set(s.id, { typeTitle: t.title, subtypeTitle: s.title, code: s.code ?? null });
  }
  return map;
}
async function loadProjectUsers(token) {
  const j = await apsGet(`${BASE}/construction/admin/v1/projects/${PROJECT_ID}/users?limit=200`, token);
  const map = new Map();
  for (const u of j.results ?? []) if (u.autodeskId) map.set(u.autodeskId, u.name ?? null);
  return map;
}

function enrich(issue, types, users, tips) {
  const st = issue.issueSubtypeId ? types.get(issue.issueSubtypeId) ?? null : null;
  const out = {
    id: issue.id, displayId: issue.displayId, title: issue.title, description: issue.description,
    status: issue.status, dueDate: issue.dueDate, startDate: issue.startDate ?? null,
    assignedTo: issue.assignedTo, assignedToName: issue.assignedTo ? (users.get(issue.assignedTo) ?? null) : null,
    watcherNames: (issue.watchers ?? []).map(w => users.get(w) ?? w),
    published: issue.published,
    typeLabel: st ? `${st.typeTitle} > ${st.subtypeTitle}` : null,
    typeCode: st?.code ?? null,
    createdAt: issue.createdAt, openedBy: issue.openedBy, openedAt: issue.openedAt, createdBy: issue.createdBy,
    snapshotUrn: issue.snapshotUrn ?? null, snapshotHasMarkups: issue.snapshotHasMarkups ?? false,
    permittedStatuses: issue.permittedStatuses ?? null, customAttributes: issue.customAttributes ?? [],
    attachmentCount: issue.attachmentCount ?? 0, commentCount: issue.commentCount ?? 0,
    pin: null, element: null, targetDbId: null, modelKey: null, modelName: null, modelFullName: null,
    changeState: 'na', change: null, tipVersion: null,
  };
  const ld = (issue.linkedDocuments ?? [])[0];
  if (!ld) return out;
  const d = ld.details ?? {};
  out.pin = { modelUrn: ld.urn, viewName: d.viewable?.name ?? null, objectId: d.objectId ?? null, externalId: d.externalId ?? null, position: d.position ?? null, createdAtVersion: ld.createdAtVersion ?? null };
  const m = models.find(x => x.lineage === ld.urn);
  if (!m || !d.externalId) return out;
  out.modelKey = m.key;
  out.modelName = m.short;
  out.modelFullName = m.name;
  // バージョン間 Diff（ピン時点の版 → 最新版）による対象要素の変更。索引の有無とは独立に判定する
  const tip = tips?.get(m.key) ?? null;
  out.tipVersion = tip;
  const from = ld.createdAtVersion ?? null;
  if (from != null && tip != null && from < tip) {
    const pair = diffStore.get(diffPairKey(m.key, from, tip));
    if (!pair || pair.state === 'building') { out.changeState = 'building'; out.change = { fromVersion: from, toVersion: tip }; }
    else if (pair.state === 'failed') { out.changeState = 'failed'; out.change = { fromVersion: from, toVersion: tip }; }
    else {
      const e = pair.byExt.get(d.externalId) ?? null;
      out.changeState = 'ready';
      out.change = {
        fromVersion: from, toVersion: tip, type: e?.type ?? null,
        geomChanged: !!e?.geomChanged, moved: !!e?.moved, moveMeters: e?.moveMeters ?? null,
        valueChanged: !!e?.valueChanged, changedProps: e?.changedProps ?? [], pairCounts: pair.counts,
      };
    }
  }
  if (!m.ext2dbid || !m.propsIndex) return out; // 索引を構築中（または失敗）のモデルは、付与なしで返す
  const dbId = m.ext2dbid[d.externalId];
  if (dbId === undefined) return out;
  out.targetDbId = dbId;
  out.element = m.propsIndex[d.externalId] ?? null;
  return out;
}
async function fetchIssues() {
  const token = await getToken3();
  const [types, users, vers] = await Promise.all([
    getIssueTypes(() => loadIssueTypes(token)),
    getProjectUsers(() => loadProjectUsers(token)),
    Promise.all(models.map(m => getModelVersion(m).catch(() => null))),
  ]);
  const tips = new Map(models.map((m, ix) => [m.key, vers[ix]?.versionNumber ?? null]));
  const all = [];
  for (let offset = 0; offset < 200; offset += 50) { // ページング（最大200件まで）
    const j = await apsGet(`${BASE}/construction/issues/v1/projects/${PID}/issues?limit=50&offset=${offset}`, token);
    const page = j.results ?? [];
    all.push(...page);
    if (page.length < 50) break;
  }
  const enriched = all.filter(i => !i.deleted).map(i => enrich(i, types, users, tips));
  planDiffs(enriched); // 必要な Diff ペア（ピン時点 → 最新）が無ければ裏で開始する
  return enriched;
}

// Issue 一覧の短期キャッシュ（初回表示の待ちを削る）。
// 取得済みの一覧を30秒使い回し、期限切れ後は手元の分を即座に返しながら裏で
// 取り直す。編集（/api/issues/update）が成功したら即座に捨てる。
// 索引の構築中は付与内容が変わるので、キャッシュせず毎回ライブで取る。
const ISSUES_TTL = 30000;
let issuesBox = null;      // { at, value }
let issuesInflight = null; // 取得は同時に1本だけ
function refreshIssues() {
  if (issuesInflight) return issuesInflight;
  issuesInflight = fetchIssues()
    .then(value => { issuesBox = { at: Date.now(), value }; return value; })
    .finally(() => { issuesInflight = null; });
  return issuesInflight;
}
async function getIssuesCached() {
  if (models.some(m => m.indexStatus !== 'ready')) return fetchIssues();
  if ([...diffStore.values()].some(p => p.state === 'building')) return fetchIssues(); // Diff 取得中も付与が変わるのでライブで取る
  if (!issuesBox) return refreshIssues();
  if (Date.now() - issuesBox.at >= ISSUES_TTL) refreshIssues().catch(() => {});
  return issuesBox.value;
}
async function updateIssue(id, patch) {
  const token = await getToken3();
  const r = await fetch(`${BASE}/construction/issues/v1/projects/${PID}/issues/${id}`, {
    method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// ============ バージョン間 Diff（Model Properties API：ピン時点の版 → 最新版） ============
// Issue の対象要素が「ピンした時点の版」から「最新版」の間にどう変わったかを、
// Model Properties API（construction/index/v2）の索引＋Diff ジョブで取得する。
// ペア単位で非同期に実行し、結果は cache/diff-{key}-v{from}-v{to}.json に残す（再起動後はそれを読む）。
// 判定基準は履歴グラフでの実測に合わせる：ロケール差異（英語ロケール保存→日本語ロケール保存等）で
// フィールドキーが付け替わると、無変更の要素でも大量に OBJECT_CHANGED に現れる（V1→V2 で34,718件）。
// そのノイズ行は「片側にしか無いキーに同じ値」か「共有キーでも旧側が null」のどちらかで値自体は
// 変わっていないため、形状ハッシュ・bbox の移動・値の実質変化でふるい分ける。
const IDX = `${BASE}/construction/index/v2`;
const diffStore = new Map(); // `${key}:${from}:${to}` → { state, counts, byExt, error, runAt }
const diffPairKey = (key, from, to) => `${key}:${from}:${to}`;
const diffCacheFile = (key, from, to) => path.join(indexCacheDir, `diff-${key}-v${from}-v${to}.json`);
function loadDiffCaches() {
  for (const f of fs.readdirSync(indexCacheDir)) {
    const mm = f.match(/^diff-(.+)-v(\d+)-v(\d+)\.json$/);
    if (!mm) continue;
    try {
      const c = JSON.parse(fs.readFileSync(path.join(indexCacheDir, f), 'utf8'));
      if (c?.entries) diffStore.set(diffPairKey(mm[1], +mm[2], +mm[3]), { state: 'ready', counts: c.counts ?? null, byExt: new Map(c.entries), error: null, runAt: c.runAt ?? null });
    } catch (e) {}
  }
}
loadDiffCaches();
const sleepMs = ms => new Promise(s => setTimeout(s, ms));
async function apsCall3(method, url, body) {
  const t = await getToken3();
  const r = await fetch(url, {
    method, headers: { Authorization: 'Bearer ' + t, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) {}
  return { status: r.status, json, text };
}
async function apsText3(url) {
  const t = await getToken3();
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + t } });
  if (!r.ok) throw new Error('GET ' + url.split('/').slice(-2).join('/') + ' failed: ' + r.status);
  return r.text(); // fields / properties は gzip の NDJSON で返ることがある（fetch が解凍する）
}
function versionUrn(m, n) { return `urn:adsk.wipprod:fs.file:vf.${m.lineage.replace('urn:adsk.wipprod:dm.lineage:', '')}?version=${n}`; }
async function ensureDiffIndex(m, n) {
  const { json } = await apsCall3('POST', `${IDX}/projects/${PID}/indexes:batch-status`, { versions: [{ versionUrn: versionUrn(m, n) }] });
  const ix = json?.indexes?.[0];
  if (!ix?.indexId) throw new Error(`V${n} の索引 ID が返りませんでした`);
  for (let i = 0; i < 80; i++) {
    const { json: j2 } = await apsCall3('GET', `${IDX}/projects/${PID}/indexes/${ix.indexId}`);
    if (j2?.state === 'FINISHED') return ix.indexId;
    if (j2?.state === 'FAILED') throw new Error(`V${n} の索引が FAILED になりました`);
    await sleepMs(15000);
  }
  throw new Error(`V${n} の索引がタイムアウトしました`);
}
function isMovedRow(r) { // bbox の純平行移動（最小・最大が同じベクトルで動いた）
  if (!r.bboxMin || !r.prev?.bboxMin || !r.bboxMax || !r.prev?.bboxMax) return false;
  const d = ['x', 'y', 'z'].map(k => Math.round((r.bboxMin[k] - r.prev.bboxMin[k]) * 1000));
  const d2 = ['x', 'y', 'z'].map(k => Math.round((r.bboxMax[k] - r.prev.bboxMax[k]) * 1000));
  return d.join() === d2.join() && d.some(v => v !== 0);
}
function moveMetersOf(r) { // bbox 中心の移動距離（索引の座標はフィート → メートル換算）
  if (!r.bboxMin || !r.prev?.bboxMin || !r.bboxMax || !r.prev?.bboxMax) return null;
  const c = (mn, mx) => [(mn.x + mx.x) / 2, (mn.y + mx.y) / 2, (mn.z + mx.z) / 2];
  const a = c(r.bboxMin, r.bboxMax), b = c(r.prev.bboxMin, r.prev.bboxMax);
  return Math.round(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 0.3048 * 100) / 100;
}
// プロパティの「実質的な値の変化」判定（ロケールノイズとの切り分け。履歴グラフと同一基準）
// 実質変化とみなすのは: (1) システムフィールド以外で、同一キーに両側とも非 null の異なる値
// (2) 新版側の値（ASCII 文字列または数値。システムフィールド以外）が旧版側の値集合に存在しない
function computeValueChanged(r, fmap) {
  const cur = r.props ?? {}, prev = r.prev?.props ?? {};
  const isSys = k => { const f = fmap.get(k); return !!f && String(f.category ?? '').startsWith('__'); };
  for (const k of Object.keys(cur)) {
    if (isSys(k)) continue;
    if (k in prev && prev[k] != null && cur[k] != null && JSON.stringify(prev[k]) !== JSON.stringify(cur[k])) return true;
  }
  const prevVals = new Set();
  for (const v of Object.values(prev)) if (v != null) prevVals.add(JSON.stringify(v));
  for (const [k, v] of Object.entries(cur)) {
    if (isSys(k) || v == null || v === '') continue;
    if (typeof v === 'number' || (typeof v === 'string' && /^[\x00-\x7F]+$/.test(v))) {
      if (!prevVals.has(JSON.stringify(v))) return true;
    }
  }
  return false;
}
function realChangedProps(r, fmap) { // 実質変化したプロパティだけを（名前, 旧値, 新値）で返す
  const cur = r.props ?? {}, prev = r.prev?.props ?? {};
  const isSys = k => { const f = fmap.get(k); return !!f && String(f.category ?? '').startsWith('__'); };
  const prevVals = new Set();
  for (const v of Object.values(prev)) if (v != null) prevVals.add(JSON.stringify(v));
  const clip = v => typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : v;
  const out = [];
  for (const k of Object.keys(cur)) {
    if (isSys(k)) continue;
    const f = fmap.get(k);
    if (!f) continue;
    if (k in prev && prev[k] != null && cur[k] != null && JSON.stringify(prev[k]) !== JSON.stringify(cur[k])) {
      out.push({ name: f.name, prev: clip(prev[k]), cur: clip(cur[k]) });
    } else if (!(k in prev) || prev[k] == null) {
      const v = cur[k];
      if (v != null && v !== '' && (typeof v === 'number' || (typeof v === 'string' && /^[\x00-\x7F]+$/.test(v))) && !prevVals.has(JSON.stringify(v))) {
        out.push({ name: f.name, prev: null, cur: clip(v) });
      }
    }
  }
  return out.slice(0, 12);
}
const DIFF_TYPE = { OBJECT_ADDED: 'added', OBJECT_REMOVED: 'removed', OBJECT_CHANGED: 'modified' };
function normalizeDiffRows(rows, fieldsText) {
  const fmap = new Map();
  for (const line of fieldsText.split('\n')) {
    if (!line.trim()) continue;
    try { const d = JSON.parse(line); fmap.set(d.key, d); } catch (e) {}
  }
  let nameKey = null;
  for (const [k, v] of fmap) if (v.category === '__name__') nameKey = k;
  const byExt = new Map();
  const counts = { added: 0, removed: 0, modifiedReal: 0, modifiedRaw: 0 };
  for (const r of rows) {
    const type = DIFF_TYPE[r.type] ?? r.type;
    if (!r.externalId) continue;
    const cur = r.props ?? {}, prev = r.prev?.props ?? {};
    const name = cur[nameKey] ?? prev[nameKey] ?? null;
    if (type === 'added') { counts.added++; byExt.set(r.externalId, { type, name }); }
    else if (type === 'removed') { counts.removed++; byExt.set(r.externalId, { type, name }); }
    else if (type === 'modified') {
      counts.modifiedRaw++;
      const geomChanged = !!(r.geomHash && r.prev?.geomHash && r.geomHash !== r.prev.geomHash);
      const moved = isMovedRow(r);
      const valueChanged = computeValueChanged(r, fmap);
      if (!(geomChanged || moved || valueChanged)) continue; // 見かけ上の変更は保持しない（＝実質変更なしとして扱う）
      counts.modifiedReal++;
      byExt.set(r.externalId, {
        type, name, geomChanged, moved, moveMeters: moveMetersOf(r), valueChanged,
        changedProps: valueChanged ? realChangedProps(r, fmap) : [],
      });
    }
  }
  return { byExt, counts };
}
async function runDiffPair(m, from, to) {
  const pk = diffPairKey(m.key, from, to);
  const job = { state: 'building', counts: null, byExt: null, error: null, runAt: null };
  diffStore.set(pk, job);
  const t0 = Date.now();
  try {
    await ensureDiffIndex(m, from);
    await ensureDiffIndex(m, to);
    const { json } = await apsCall3('POST', `${IDX}/projects/${PID}/diffs:batch-status`, { diffs: [{ prevVersionUrn: versionUrn(m, from), curVersionUrn: versionUrn(m, to) }] });
    const d = Array.isArray(json) ? json[0] : json?.diffs?.[0];
    if (!d?.diffId) throw new Error('diffId が返りませんでした');
    const durl = `${IDX}/projects/${PID}/diffs/${d.diffId}`;
    let stats = null;
    for (let i = 0; i < 80; i++) {
      const { json: j2 } = await apsCall3('GET', durl);
      if (j2?.state === 'FINISHED') { stats = j2.stats; break; }
      if (j2?.state === 'FAILED') throw new Error('diff FAILED: ' + JSON.stringify(j2.errors ?? null));
      await sleepMs(15000);
    }
    if (!stats) throw new Error('diff がタイムアウトしました');
    const fieldsText = await apsText3(`${durl}/fields`);
    const rows = [];
    let emptyStreak = 0;
    for (let a = 0; a <= 46000; a += 2000) { // SVF2Id の範囲ごとに全行を取得する（履歴グラフと同一手順）
      const create = await apsCall3('POST', `${durl}/queries`, { query: { $between: ['s.SVF2Id', a, a + 1999] } });
      if (create.status !== 200 && create.status !== 201) throw new Error(`range ${a}: query create ${create.status}`);
      const qid = create.json.queryId;
      let st = create.json.state;
      for (let i = 0; i < 60 && st !== 'FINISHED'; i++) {
        await sleepMs(4000);
        const { json: qj } = await apsCall3('GET', `${durl}/queries/${qid}`);
        st = qj?.state;
        if (st === 'FAILED') throw new Error(`range ${a}: query FAILED`);
      }
      if (st !== 'FINISHED') throw new Error(`range ${a}: query timeout`);
      const text = await apsText3(`${durl}/queries/${qid}/properties`);
      for (const line of text.split('\n')) if (line.trim()) rows.push(JSON.parse(line));
      if (!text.trim()) { emptyStreak++; if (emptyStreak >= 2 && a > 36000) break; } else emptyStreak = 0;
    }
    const { byExt, counts } = normalizeDiffRows(rows, fieldsText);
    job.state = 'ready'; job.counts = counts; job.byExt = byExt; job.runAt = new Date().toISOString();
    fs.writeFileSync(diffCacheFile(m.key, from, to), JSON.stringify({ from, to, runAt: job.runAt, stats, counts, entries: [...byExt] }));
    console.log(`diff ready: ${m.key} V${from}->V${to} counts=${JSON.stringify(counts)} rows=${rows.length} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  } catch (e) {
    job.state = 'failed'; job.error = String(e?.message ?? e);
    console.error('diff failed:', pk, e);
  }
}
let diffQueue = Promise.resolve(); // Diff ジョブは1本ずつ直列に流す
function ensureDiffPair(m, from, to) {
  const pk = diffPairKey(m.key, from, to);
  const cur = diffStore.get(pk);
  if (cur && (cur.state === 'ready' || cur.state === 'building')) return;
  diffStore.set(pk, { state: 'building', counts: null, byExt: null, error: null, runAt: null });
  diffQueue = diffQueue.then(() => runDiffPair(m, from, to)).catch(() => {});
}
function planDiffs(enriched) {
  for (const i of enriched) {
    if (!i.modelKey || !i.pin?.externalId || i.pin.createdAtVersion == null || i.tipVersion == null) continue;
    if (i.pin.createdAtVersion >= i.tipVersion) continue;
    const m = models.find(x => x.key === i.modelKey);
    if (m) ensureDiffPair(m, i.pin.createdAtVersion, i.tipVersion);
  }
}
function modelDiffStatus(key) {
  let any = false, failed = false;
  for (const [pk, p] of diffStore) {
    if (!pk.startsWith(key + ':')) continue;
    any = true;
    if (p.state === 'building') return 'building';
    if (p.state === 'failed') failed = true;
  }
  return any ? (failed ? 'failed' : 'ready') : 'na';
}

// ============ 画像（モデルサムネイル／Issue スナップショット。メモリキャッシュ） ============
const thumbCache = new Map();
const snapCache = new Map();
async function getThumbnail(m) {
  if (!thumbCache.has(m.key)) {
    const t = (await getToken2()).access_token;
    const r = await fetch(`${BASE}/modelderivative/v2/designdata/${m.derivativeUrn}/thumbnail`, { headers: { Authorization: 'Bearer ' + t } });
    if (!r.ok) throw new Error('thumbnail failed: ' + r.status);
    thumbCache.set(m.key, Buffer.from(await r.arrayBuffer()));
  }
  return thumbCache.get(m.key);
}
async function getSnapshot(urn) {
  // snapshotUrn（OSS オブジェクト）→ 署名付き S3 URL 経由で取得（旧 OSS 直 GET は廃止済み）
  if (!snapCache.has(urn)) {
    const rest = urn.slice('urn:adsk.objects:os.object:'.length);
    const slash = rest.indexOf('/');
    const bucket = rest.slice(0, slash), object = rest.slice(slash + 1);
    const t = await getToken3();
    const sr = await fetch(`${BASE}/oss/v2/buckets/${bucket}/objects/${encodeURIComponent(object)}/signeds3download`, { headers: { Authorization: 'Bearer ' + t } });
    if (!sr.ok) throw new Error('snapshot sign failed: ' + sr.status);
    const r = await fetch((await sr.json()).url);
    if (!r.ok) throw new Error('snapshot download failed: ' + r.status);
    const s3type = r.headers.get('content-type') ?? '';
    const type = s3type.startsWith('image/') ? s3type : (object.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg');
    snapCache.set(urn, { buf: Buffer.from(await r.arrayBuffer()), type });
  }
  return snapCache.get(urn);
}

// ============ 要素＋周辺の OBJ 抽出（OBJ ビューア用。Model Derivative の OBJ ジョブで objectIds を指定する） ============
import { createHash } from 'node:crypto';
let tokenJobsCache = null; // 変換ジョブ投入用の広いスコープの 2-legged トークン
async function getTokenJobs() {
  if (tokenJobsCache && Date.now() < tokenJobsCache.expiresAt) return tokenJobsCache.access_token;
  const r = await fetch(BASE + '/authentication/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuth() },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'data:read data:write data:create viewables:read' }),
  });
  if (!r.ok) throw new Error('jobs token failed: ' + r.status);
  const j = await r.json();
  tokenJobsCache = { access_token: j.access_token, expiresAt: Date.now() + (j.expires_in - 300) * 1000 };
  return tokenJobsCache.access_token;
}
const LEVEL_KEYS = ['Level', 'Reference Level', 'Base Level', 'Base Constraint', 'Top Level']; // 壁は Base Constraint が階に相当する
function levelOf(e) { for (const k of LEVEL_KEYS) if (e?.[k]) return String(e[k]); return null; }
function parseMark(mark) {
  const m = String(mark ?? '').match(/^([A-Za-z]+(?:\.\d+)?)-(\d+)$/);
  return m ? { g: m[1], n: Number(m[2]) } : null;
}
function markAdjacent(a, b) {
  if (a.g === b.g) return Math.abs(a.n - b.n) === 1;
  return a.n === b.n && a.g.length === 1 && b.g.length === 1 && Math.abs(a.g.charCodeAt(0) - b.g.charCodeAt(0)) === 1;
}
// 周辺要素の簡易抽出：隣接する通り芯を最優先し、同タイプ・同じ階で補う（最大48件）
function pickNeighbors(model, targetExtId) {
  const idx = model.propsIndex;
  const t = idx[targetExtId];
  if (!t) return [];
  const tLevel = levelOf(t);
  const tMark = parseMark(t['Column Location Mark']);
  const scored = [];
  for (const [ext, e] of Object.entries(idx)) {
    if (ext === targetExtId || e.objectid == null) continue;
    const mk = parseMark(e['Column Location Mark']);
    let score = null;
    if (tMark && mk && (markAdjacent(tMark, mk) || (mk.g === tMark.g && mk.n === tMark.n))) score = 0;
    else if (tLevel && levelOf(e) === tLevel && t['Type Name'] && e['Type Name'] === t['Type Name']) score = 1;
    else if (tLevel && levelOf(e) === tLevel) score = 2;
    if (score !== null) scored.push({ extId: ext, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, 48);
}
function objGroupDbIds(objText) {
  return [...objText.matchAll(/^g Obj\.(\d+)\s*$/gm)].map(m => Number(m[1]));
}
async function extractObj(model, objectIds, expectedDbIds, targetDbId) {
  const hash = createHash('sha1').update(model.key + ':' + [...objectIds].sort((a, b) => a - b).join(',')).digest('hex').slice(0, 16);
  const cacheFile = path.join(indexCacheDir, 'extract-' + hash + '.json');
  try { const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); if (c?.obj) return c.obj; } catch (e) {}
  const token = await getTokenJobs();
  const jr = await fetch(BASE + '/modelderivative/v2/designdata/job', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { urn: model.derivativeUrn },
      output: { destination: { region: 'us' }, formats: [{ type: 'obj', advanced: { modelGuid: model.viewableGuid, objectIds, exportFileStructure: 'single' } }] },
    }),
  });
  if (!jr.ok) throw new Error('obj job failed: ' + jr.status);
  const tried = new Set();
  for (let i = 0; i < 48; i++) {
    await new Promise(s => setTimeout(s, 5000));
    const mj = await apsGet(`${BASE}/modelderivative/v2/designdata/${model.derivativeUrn}/manifest`, token);
    const ders = (mj.derivatives ?? []).filter(d => d.outputType === 'obj' && d.status === 'success');
    for (const der of ders) {
      // OBJ の成果物は同じ derivative の children に蓄積されるため、先頭ではなく .obj の子をすべて照合する
      for (const child of der.children ?? []) {
        const urn = child.urn;
        if (!urn || !urn.toLowerCase().endsWith('.obj') || tried.has(urn)) continue;
        tried.add(urn);
        const dr = await fetch(`${BASE}/modelderivative/v2/designdata/${model.derivativeUrn}/manifest/${encodeURIComponent(urn)}`, { headers: { Authorization: 'Bearer ' + token } });
        if (!dr.ok) continue;
        const obj = await dr.text();
        const groups = objGroupDbIds(obj);
        // 要求した要素集合と中身が一致するか、内容で照合する（過去のジョブの成果物と取り違えないため）
        if (groups.includes(targetDbId) && groups.every(g => expectedDbIds.has(g)) && groups.length >= Math.ceil(expectedDbIds.size * 0.5)) {
          fs.writeFileSync(cacheFile, JSON.stringify({ obj }));
          return obj;
        }
      }
    }
    const anyObj = (mj.derivatives ?? []).find(d => d.outputType === 'obj');
    if (anyObj?.status === 'failed') throw new Error('obj job failed in translation');
  }
  throw new Error('obj job timeout');
}

// ============ HTTP ルーティング ============
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/token') {
      const t = await getToken2();
      const remain = Math.max(60, Math.floor((t.expiresAt - Date.now()) / 1000));
      return sendJson(res, 200, { access_token: t.access_token, expires_in: remain });
    }
    if (url.pathname === '/api/issues') {
      const issues = await getIssuesCached();
      const vers = await Promise.all(models.map(getModelVersion));
      return sendJson(res, 200, {
        models: models.map((m, i) => ({ key: m.key, name: m.name, short: m.short, version: vers[i].versionNumber, urn: m.derivativeUrn, guid: m.viewableGuid, indexStatus: m.indexStatus, diffStatus: modelDiffStatus(m.key) })),
        issues, fetchedAt: new Date().toISOString(),
      });
    }
    if (url.pathname === '/api/index-status') { // 索引の構築状態だけを返す軽いエンドポイント（画面のポーリング用）
      return sendJson(res, 200, { models: models.map(m => ({ key: m.key, short: m.short, indexStatus: m.indexStatus, diffStatus: modelDiffStatus(m.key) })) });
    }
    if (url.pathname === '/api/extract') {
      // Issue の対象要素＋周辺（同じ階・隣接通り芯など）を OBJ で切り出す
      const issues = await getIssuesCached();
      const issue = issues.find(i => i.id === url.searchParams.get('issue'));
      if (!issue?.modelKey || !issue.pin?.externalId) return sendJson(res, 404, { error: 'この Issue には対象要素がありません' });
      const model = models.find(m => m.key === issue.modelKey);
      if (!model.propsIndex || !model.ext2dbid) return sendJson(res, 409, { error: 'モデル情報を構築中です', indexStatus: model.indexStatus });
      const targetEntry = model.propsIndex[issue.pin.externalId];
      if (!targetEntry?.objectid) return sendJson(res, 404, { error: '対象要素が索引にありません' });
      const neighbors = pickNeighbors(model, issue.pin.externalId);
      const objectIds = [...new Set([targetEntry.objectid, ...neighbors.map(n => model.propsIndex[n.extId].objectid)])];
      const oidToDbId = new Map();
      for (const [ext, e] of Object.entries(model.propsIndex)) if (e.objectid != null && model.ext2dbid[ext] != null) oidToDbId.set(e.objectid, model.ext2dbid[ext]);
      const expectedDbIds = new Set(objectIds.map(oid => oidToDbId.get(oid)).filter(x => x != null));
      const obj = await extractObj(model, objectIds, expectedDbIds, issue.targetDbId);
      const dbIdToName = new Map();
      for (const [ext, dbId] of Object.entries(model.ext2dbid)) dbIdToName.set(dbId, model.propsIndex[ext]?.name ?? null);
      const included = objGroupDbIds(obj).map(dbId => ({ dbId, name: dbIdToName.get(dbId) ?? null, target: dbId === issue.targetDbId }));
      return sendJson(res, 200, { modelKey: model.key, targetDbId: issue.targetDbId, neighborCount: neighbors.length, included, obj });
    }
    if (url.pathname === '/api/issues/update' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const patch = {};
      for (const k of ['title', 'description', 'status', 'dueDate']) if (body.patch && k in body.patch) patch[k] = body.patch[k];
      if (!body.id || !Object.keys(patch).length) return sendJson(res, 400, { error: 'id and patch required' });
      const r = await updateIssue(body.id, patch);
      if (r.status >= 200 && r.status < 300) issuesBox = null; // 編集が通ったら一覧キャッシュを捨てて古い内容を見せない
      return sendJson(res, r.status, r.body ?? { error: 'empty response' });
    }
    if (url.pathname === '/api/thumbnail') {
      const m = models.find(x => x.key === url.searchParams.get('model')) ?? models[0];
      const buf = await getThumbnail(m);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600' });
      return res.end(buf);
    }
    if (url.pathname === '/api/snapshot') {
      const urn = url.searchParams.get('urn') ?? '';
      if (!urn.startsWith('urn:adsk.objects:os.object:')) { res.writeHead(404); return res.end('no snapshot'); }
      const c = await getSnapshot(urn);
      res.writeHead(200, { 'Content-Type': c.type, 'Cache-Control': 'max-age=3600' });
      return res.end(c.buf);
    }
  } catch (e) {
    console.error('api error:', e);
    return sendJson(res, 502, { error: String(e?.message ?? e) });
  }
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
  const file = path.join(pub, rel);
  if (!file.startsWith(pub) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
const port = process.env.PORT ?? 3000;
initIndexes(); // 索引の非同期構築を開始（サーバーは待たずに起動する）
server.listen(port, () => { console.log(`sample-d server: http://localhost:${port}`); });
refreshIssues().catch(() => {}); // 初回表示の待ちを削るため、認証・タイプ・メンバー・一覧を先に温めておく
