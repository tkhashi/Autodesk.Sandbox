// server.mjs — 履歴グラフ実アプリ v1: 実 Issue（APS Issues API）＋アプリ側スナップショット履歴
//             ＋ モデル版一覧（DM API）＋ Model Properties Diff（種キャッシュ／実 API ジョブ）
// 起動: node server.mjs（.env に APS_CLIENT_ID / APS_CLIENT_SECRET、.token.json に 3-legged トークンが必要。
//       認証情報の探索順: ①アプリ自身のフォルダ ②clone 配置で隣の sample-d（../../sample-d-issues-3d）
//       ③ワークスペース内の demo-issues-3d/app と sample-a-http-client。どれにも無ければ案内を出して終了する）
//
// アプリ側で持つ状態は data/ のみ:
//   data/snapshots.json — Issue の status／担当者のスナップショットと変化イベント（追記型）
//   data/diff-cache/    — 種キャッシュに無い版ペアの diff を実 API で実行した結果の正規化キャッシュ
// 現在値は常に Forma から取得する（このアプリは「履歴の記録者」であり、状態の管理者ではない）。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// ============ 設定 ============
const root = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(root, 'public');
const dataDir = path.join(root, 'data');
const seedDir = path.join(root, 'seed');
const diffCacheDir = path.join(dataDir, 'diff-cache');
fs.mkdirSync(diffCacheDir, { recursive: true });
const BASE = 'https://developer.api.autodesk.com';
const IDX = `${BASE}/construction/index/v2`;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

// 認証情報（.env / .token.json）は sample-d と共有する。探索順:
//   ① アプリ自身のフォルダ
//   ② clone 配置で隣にある sample-d（Autodesk.Sandbox/sample-d-issues-3d）
//   ③ ワークスペース内の sample-d / sample-a（従来のフォールバック）
const CRED_DIRS = [...new Set([
  root,
  path.join(root, '..', '..', 'sample-d-issues-3d'),
  path.join(os.homedir(), 'workspace', 'forma-hands-on', 'demo-issues-3d', 'app'),
  path.join(os.homedir(), 'workspace', 'forma-hands-on', 'sample-a-http-client'),
].map(p => path.resolve(p)))];
const ENV_FILE = CRED_DIRS.map(d => path.join(d, '.env')).find(p => fs.existsSync(p));
if (!ENV_FILE) {
  console.error('.env が見つかりません。sample-d のフォルダから .env と .token.json をこのフォルダにコピーしてください: ' + root);
  console.error('探索した場所: ' + CRED_DIRS.map(d => path.join(d, '.env')).join(' / '));
  process.exit(1);
}
const env = {};
for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
console.log('credentials: .env =', ENV_FILE);
// トークンファイルは複数箇所にあり、リフレッシュしたら全てに書き戻す（運用ルール）
const TOKEN_FILES = CRED_DIRS.map(d => path.join(d, '.token.json'));

const PROJECT_ID = 'b.031a6e68-ccdf-4a29-b8a5-50a2a3ecac25'; // Snowdon Towers
const PID = PROJECT_ID.replace(/^b\./, ''); // Issues API / Index API は b. なし
const ARCH = {
  name: 'Snowdon Towers Sample Architectural.rvt',
  lineage: 'urn:adsk.wipprod:dm.lineage:VwJ57NkiQ-Gy0nHLR3UmAA',
  lineageId: 'VwJ57NkiQ-Gy0nHLR3UmAA',
  viewableGuid: '7738212f-d458-662f-cb9c-cf7c761af18d',
};
// 実測で判明している版ごとの事情（research/v2-diff-measurement.md）
const VERSION_NOTES = {
  3: '登録されたファイルが破損しており変換できない（実測記録）。内容の実体は V4',
};
const versionUrn = n => `urn:adsk.wipprod:fs.file:vf.${ARCH.lineageId}?version=${n}`;
const derivativeUrn = n => Buffer.from(versionUrn(n), 'utf8').toString('base64url');
// 版 v のモデル更新イベントに対する diff ペア。V3 は変換不可なので V4 は V2 とのペアで見る
function diffPairFor(v) {
  if (VERSION_NOTES[v]) return null;
  if (v === 4) return { from: 2, to: 4, label: 'V2 → V4（実質 V3）' };
  if (v >= 2) return { from: v - 1, to: v, label: `V${v - 1} → V${v}` };
  return null;
}

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
const sleep = ms => new Promise(s => setTimeout(s, ms));

// ============ トークン（sample-d から移植。リフレッシュ時は全トークンファイルへ書き戻す） ============
let token2Cache = null;
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
let tok3 = null;
function loadTok3() {
  // 一番新しい obtained_at のトークンファイルを読む
  let best = null;
  for (const f of TOKEN_FILES) {
    try {
      const t = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!best || (t.obtained_at ?? 0) > (best.obtained_at ?? 0)) best = t;
    } catch (e) {}
  }
  if (!best) throw new Error('.token.json が見つかりません');
  tok3 = best;
}
try {
  loadTok3();
} catch (e) {
  console.error('.token.json が見つかりません。sample-d のフォルダから .env と .token.json をこのフォルダにコピーしてください: ' + root);
  console.error('探索した場所: ' + TOKEN_FILES.join(' / '));
  process.exit(1);
}
async function getToken3() {
  if (Date.now() - (tok3.obtained_at ?? 0) < 45 * 60000) return tok3.access_token;
  const r = await fetch(BASE + '/authentication/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuth() },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok3.refresh_token }),
  });
  if (!r.ok) throw new Error('3-legged refresh failed: ' + r.status);
  tok3 = { ...(await r.json()), obtained_at: Date.now() };
  const s = JSON.stringify(tok3, null, 1);
  for (const f of TOKEN_FILES) { try { fs.writeFileSync(f, s); } catch (e) { console.error('token write-back failed:', f, e.message); } }
  console.log('3-legged token refreshed; wrote back to', TOKEN_FILES.length, 'token files');
  return tok3.access_token;
}
async function apsGet(url, token) {
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error(`${url.replace(BASE, '')} failed: ${r.status}`);
  return r.json();
}
async function apsText(url, token) { // diff の fields / properties は gzip の NDJSON で返ることがある
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error(`${url.replace(BASE, '')} failed: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  try { return zlib.gunzipSync(buf).toString('utf8'); } catch { return buf.toString('utf8'); }
}

// ============ Issues（タイプ／メンバーは10分キャッシュ。sample-d から移植） ============
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

function enrichIssue(issue, types, users) {
  const st = issue.issueSubtypeId ? types.get(issue.issueSubtypeId) ?? null : null;
  const out = {
    id: issue.id, displayId: issue.displayId, title: issue.title, description: issue.description,
    status: issue.status, dueDate: issue.dueDate, startDate: issue.startDate ?? null,
    assignedTo: issue.assignedTo ?? null,
    assignedToName: issue.assignedTo ? (users.get(issue.assignedTo) ?? null) : null,
    createdAt: issue.createdAt, createdBy: issue.createdBy ?? null,
    createdByName: issue.createdBy ? (users.get(issue.createdBy) ?? null) : null,
    openedAt: issue.openedAt ?? null,
    typeLabel: st ? `${st.typeTitle} > ${st.subtypeTitle}` : null,
    commentCount: issue.commentCount ?? 0, attachmentCount: issue.attachmentCount ?? 0,
    pin: null,
  };
  const ld = (issue.linkedDocuments ?? [])[0];
  if (ld) {
    const d = ld.details ?? {};
    out.pin = {
      modelUrn: ld.urn ?? null, viewName: d.viewable?.name ?? null,
      objectId: d.objectId ?? null, externalId: d.externalId ?? null,
      position: d.position ?? null,
      isArchitectural: ld.urn === ARCH.lineage,
    };
  }
  return out;
}
async function fetchIssues() {
  const token = await getToken3();
  const [types, users] = await Promise.all([
    getIssueTypes(() => loadIssueTypes(token)),
    getProjectUsers(() => loadProjectUsers(token)),
  ]);
  const all = [];
  for (let offset = 0; offset < 500; offset += 50) {
    const j = await apsGet(`${BASE}/construction/issues/v1/projects/${PID}/issues?limit=50&offset=${offset}`, token);
    const page = j.results ?? [];
    all.push(...page);
    if (page.length < 50) break;
  }
  return all.filter(i => !i.deleted).map(i => enrichIssue(i, types, users));
}
async function fetchComments(issueId) {
  const token = await getToken3();
  const users = await getProjectUsers(() => loadProjectUsers(token));
  const all = [];
  for (let offset = 0; offset < 500; offset += 100) {
    const j = await apsGet(`${BASE}/construction/issues/v1/projects/${PID}/issues/${issueId}/comments?limit=100&offset=${offset}`, token);
    const page = j.results ?? [];
    all.push(...page);
    if (page.length < 100) break;
  }
  return all.map(c => ({
    id: c.id, body: c.body ?? '', createdAt: c.createdAt,
    createdBy: c.createdBy ?? null,
    createdByName: c.createdBy ? (users.get(c.createdBy) ?? null) : null,
  })).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

// ============ モデル版一覧（DM API） ============
let versionsBox = null;
async function fetchVersions() {
  if (versionsBox && Date.now() - versionsBox.at < 60000) return versionsBox.value;
  const token = (await getToken2()).access_token;
  const j = await apsGet(`${BASE}/data/v1/projects/${PROJECT_ID}/items/${encodeURIComponent(ARCH.lineage)}/versions`, token);
  const value = (j.data ?? []).map(v => ({
    versionNumber: v.attributes?.versionNumber ?? null,
    urn: v.id,
    createdAt: v.attributes?.createTime ?? v.attributes?.lastModifiedTime ?? null,
    lastModifiedAt: v.attributes?.lastModifiedTime ?? null,
    createdBy: v.relationships?.creator?.data?.id ?? null,
    note: VERSION_NOTES[v.attributes?.versionNumber] ?? null,
    derivativeUrn: derivativeUrn(v.attributes?.versionNumber),
    viewableGuid: ARCH.viewableGuid,
  })).filter(v => v.versionNumber != null).sort((a, b) => a.versionNumber - b.versionNumber);
  versionsBox = { at: Date.now(), value };
  return value;
}

// ============ スナップショット履歴（アプリ側で持つ状態の本体） ============
const SNAP_FILE = path.join(dataDir, 'snapshots.json');
function loadSnapshots() {
  try {
    const s = JSON.parse(fs.readFileSync(SNAP_FILE, 'utf8'));
    if (s && s.issues && Array.isArray(s.events)) return s;
  } catch (e) {}
  return { version: 1, updatedAt: null, refreshCount: 0, issues: {}, events: [] };
}
function saveSnapshots(s) { fs.writeFileSync(SNAP_FILE, JSON.stringify(s, null, 1)); }
let snapInflight = null;
async function refreshSnapshots() {
  if (snapInflight) return snapInflight;
  snapInflight = (async () => {
    const issues = await fetchIssues();
    const snap = loadSnapshots();
    const now = new Date().toISOString();
    const newEvents = [];
    for (const i of issues) {
      const prev = snap.issues[i.id];
      const cur = {
        displayId: i.displayId, title: i.title, status: i.status,
        assignedTo: i.assignedTo, assignedToName: i.assignedToName,
        lastSeenAt: now, firstSeenAt: prev?.firstSeenAt ?? now,
      };
      if (prev) {
        if (prev.status !== i.status) {
          newEvents.push({ issueId: i.id, kind: 'status', from: prev.status, to: i.status, detectedAt: now });
        }
        if ((prev.assignedTo ?? null) !== (i.assignedTo ?? null)) {
          newEvents.push({
            issueId: i.id, kind: 'assignee',
            from: prev.assignedToName ?? prev.assignedTo, to: i.assignedToName ?? i.assignedTo,
            fromId: prev.assignedTo, toId: i.assignedTo, detectedAt: now,
          });
        }
      }
      snap.issues[i.id] = cur;
    }
    snap.events.push(...newEvents);
    snap.updatedAt = now;
    snap.refreshCount++;
    saveSnapshots(snap);
    console.log(`snapshots refreshed: ${issues.length} issues, +${newEvents.length} events (total ${snap.events.length})`);
    return { issueCount: issues.length, newEvents: newEvents.length, totalEvents: snap.events.length, updatedAt: now };
  })().finally(() => { snapInflight = null; });
  return snapInflight;
}
// Issue ごとの履歴（スナップショット由来イベント＋モデル更新イベント＋派生指標）を組み立てる
function buildHistory(issue, snap, versions) {
  const events = snap.events.filter(e => e.issueId === issue.id);
  let closeCount = 0, reopenCount = 0;
  for (const e of events) {
    if (e.kind === 'status' && e.to === 'closed') closeCount++;
    if (e.kind === 'status' && e.from === 'closed') reopenCount++;
  }
  const lastClose = issue.status === 'closed'
    ? [...events].reverse().find(e => e.kind === 'status' && e.to === 'closed') : null;
  const modelUpdates = versions
    .filter(v => v.createdAt && issue.createdAt && v.createdAt > issue.createdAt)
    .filter(v => !lastClose || v.createdAt <= lastClose.detectedAt)
    .map(v => ({ version: v.versionNumber, publishedAt: v.createdAt, note: v.note, diffPair: diffPairFor(v.versionNumber) }));
  return { events, modelUpdates, stats: { closeCount, reopenCount, modelUpdateCount: modelUpdates.length } };
}

// ============ Diff（種キャッシュ → 実行時キャッシュ → 実 API ジョブ） ============
function loadDiffCache(from, to) {
  for (const f of [path.join(seedDir, `diff-${from}-${to}.json`), path.join(diffCacheDir, `diff-${from}-${to}.json`)]) {
    try {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      return { ...d, source: f.startsWith(seedDir) ? 'seed' : 'cache' };
    } catch (e) {}
  }
  return null;
}
const TYPE_MAP = { OBJECT_ADDED: 'added', OBJECT_REMOVED: 'removed', OBJECT_CHANGED: 'modified' };
function normalizeLiveRows(rows, fieldsText) {
  const fmap = new Map();
  for (const line of fieldsText.split('\n')) {
    if (!line.trim()) continue;
    try { const d = JSON.parse(line); fmap.set(d.key, d); } catch (e) {}
  }
  let nameKey = null, catKey = null;
  for (const [k, v] of fmap) {
    if (v.category === '__name__') nameKey = k;
    if (v.category === '__category__' && v.name === 'Category') catKey = k;
  }
  const bboxRows = [];
  const byCategory = {};
  for (const r of rows) {
    const type = TYPE_MAP[r.type] ?? r.type;
    const cur = r.props ?? {}, prev = r.prev?.props ?? {};
    const category = cur[catKey] ?? prev[catKey] ?? null;
    if (category) {
      byCategory[category] ??= { added: 0, removed: 0, modified: 0 };
      if (byCategory[category][type] !== undefined) byCategory[category][type]++;
    }
    if (!r.bboxMin && !r.prev?.bboxMin) continue;
    let changedProps = [];
    if (type === 'modified') {
      const keys = new Set([...Object.keys(cur), ...Object.keys(prev)]);
      for (const k of keys) {
        if (JSON.stringify(cur[k]) !== JSON.stringify(prev[k])) {
          const f = fmap.get(k);
          if (f && !f.category.startsWith('__')) changedProps.push(f.name);
        }
      }
      changedProps = [...new Set(changedProps)].slice(0, 12);
    }
    bboxRows.push({
      type, externalId: r.externalId ?? null, name: cur[nameKey] ?? prev[nameKey] ?? null, category,
      bboxMin: r.bboxMin ?? null, bboxMax: r.bboxMax ?? null,
      prevBboxMin: r.prev?.bboxMin ?? null, prevBboxMax: r.prev?.bboxMax ?? null,
      geomChanged: !!(r.geomHash && r.prev?.geomHash && r.geomHash !== r.prev.geomHash),
      changedProps,
    });
  }
  return { bboxRows, byCategory };
}
// 実 API の index + diff ジョブ（research/diff-generic.mjs から移植。非同期に進め、状態を diffJobs に持つ）
const diffJobs = new Map();
async function runLiveDiff(from, to) {
  const key = `${from}-${to}`;
  const job = { state: 'indexing', startedAt: new Date().toISOString(), error: null, stats: null };
  diffJobs.set(key, job);
  try {
    const token = await getToken3();
    const call = async (method, url, body) => {
      const t = await getToken3();
      const r = await fetch(url, {
        method, headers: { Authorization: 'Bearer ' + t, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch (e) {}
      return { status: r.status, json };
    };
    async function ensureIndex(urn) {
      const { json } = await call('POST', `${IDX}/projects/${PID}/indexes:batch-status`, { versions: [{ versionUrn: urn }] });
      const ix = json?.indexes?.[0];
      if (!ix?.indexId) throw new Error('indexId が返りませんでした');
      for (let i = 0; i < 80; i++) {
        const { json: j2 } = await call('GET', `${IDX}/projects/${PID}/indexes/${ix.indexId}`);
        if (j2?.state === 'FINISHED') return ix.indexId;
        if (j2?.state === 'FAILED') throw new Error('index FAILED');
        await sleep(15000);
      }
      throw new Error('index timeout');
    }
    const prevUrn = versionUrn(from), curUrn = versionUrn(to);
    await ensureIndex(prevUrn);
    await ensureIndex(curUrn);
    job.state = 'diffing';
    const { json } = await call('POST', `${IDX}/projects/${PID}/diffs:batch-status`, { diffs: [{ prevVersionUrn: prevUrn, curVersionUrn: curUrn }] });
    const d = Array.isArray(json) ? json[0] : json?.diffs?.[0];
    if (!d?.diffId) throw new Error('diffId が返りませんでした');
    const durl = `${IDX}/projects/${PID}/diffs/${d.diffId}`;
    let stats = null;
    for (let i = 0; i < 80; i++) {
      const { json: j2 } = await call('GET', durl);
      if (j2?.state === 'FINISHED') { stats = j2.stats; break; }
      if (j2?.state === 'FAILED') throw new Error('diff FAILED: ' + JSON.stringify(j2.errors ?? null));
      await sleep(15000);
    }
    if (!stats) throw new Error('diff timeout');
    job.stats = stats;
    job.state = 'dumping';
    const fieldsText = await apsText(`${durl}/fields`, await getToken3());
    const rows = [];
    async function fetchRange(a, b) {
      const create = await call('POST', `${durl}/queries`, { query: { $between: ['s.SVF2Id', a, b] } });
      if (create.status !== 200 && create.status !== 201) throw new Error(`range ${a}-${b}: create ${create.status}`);
      const qid = create.json.queryId;
      let st = create.json.state;
      for (let i = 0; i < 60 && st !== 'FINISHED'; i++) {
        await sleep(4000);
        const { json: qj } = await call('GET', `${durl}/queries/${qid}`);
        st = qj?.state;
        if (st === 'FAILED') throw new Error(`range ${a}-${b}: query FAILED`);
      }
      const text = await apsText(`${durl}/queries/${qid}/properties`, await getToken3());
      return text;
    }
    let emptyStreak = 0;
    for (let a = 0; a <= 46000; a += 2000) {
      const text = await fetchRange(a, a + 1999);
      for (const line of text.split('\n')) if (line.trim()) rows.push(JSON.parse(line));
      if (!text.trim()) { emptyStreak++; if (emptyStreak >= 2 && a > 36000) break; } else emptyStreak = 0;
    }
    const { bboxRows, byCategory } = normalizeLiveRows(rows, fieldsText);
    const out = {
      from, to, source: 'live', stats, totalRows: rows.length,
      bboxRowCount: bboxRows.length, byCategory, bboxRows,
    };
    fs.writeFileSync(path.join(diffCacheDir, `diff-${from}-${to}.json`), JSON.stringify(out));
    job.state = 'ready';
    console.log(`live diff ready: ${key} stats=${JSON.stringify(stats)} rows=${rows.length}`);
  } catch (e) {
    job.state = 'failed';
    job.error = String(e?.message ?? e);
    console.error('live diff failed:', key, e);
  }
}
// ピン近傍の絞り込み（viewer-mock と同じ基準：水平 30ft 以内・上下 ±6ft）
// 注意：Issues API のピン座標は Viewer 座標系、diff の bbox は Revit 共有座標系で、
// ピンは要素上の一点であって中心ではないため、座標同士を直接は比べられない。
// そこで「ピン対象要素の bbox 中心（共有座標系）」をアンカーにして近傍を数える。
function bboxCenter(r) {
  const b = r.bboxMin && r.bboxMax ? r : (r.prevBboxMin && r.prevBboxMax ? r : null);
  if (!b) return null;
  const mn = b.bboxMin ?? b.prevBboxMin, mx = b.bboxMax ?? b.prevBboxMax;
  return { x: (mn.x + mx.x) / 2, y: (mn.y + mx.y) / 2, z: (mn.z + mx.z) / 2 };
}
function findPinAnchor(issue, primaryDiff) {
  const ext = issue.pin?.externalId;
  if (!ext) return null;
  const fromRow = (diff) => {
    const r = diff?.bboxRows?.find(x => x.externalId === ext);
    return r ? { center: bboxCenter(r), name: r.name, bboxMin: r.bboxMin ?? r.prevBboxMin, bboxMax: r.bboxMax ?? r.prevBboxMax } : null;
  };
  const a = fromRow(primaryDiff);
  if (a) return a;
  // 対象要素がこのペアの diff に現れない（無変更）場合は、他のペアの実測 bbox で代用する
  for (const f of fs.readdirSync(seedDir)) {
    if (!f.startsWith('diff-')) continue;
    try { const a2 = fromRow(JSON.parse(fs.readFileSync(path.join(seedDir, f), 'utf8'))); if (a2) return a2; } catch (e) {}
  }
  for (const f of fs.readdirSync(diffCacheDir)) {
    if (!f.startsWith('diff-')) continue;
    try { const a3 = fromRow(JSON.parse(fs.readFileSync(path.join(diffCacheDir, f), 'utf8'))); if (a3) return a3; } catch (e) {}
  }
  return null;
}
function isMoved(r) { // bbox の純平行移動（最小・最大が同じベクトルで動いた）
  if (!r.bboxMin || !r.prevBboxMin || !r.bboxMax || !r.prevBboxMax) return false;
  const d = ['x', 'y', 'z'].map(k => Math.round((r.bboxMin[k] - r.prevBboxMin[k]) * 1000));
  const d2 = ['x', 'y', 'z'].map(k => Math.round((r.bboxMax[k] - r.prevBboxMax[k]) * 1000));
  return d.join() === d2.join() && d.some(v => v !== 0);
}
function nearPinRows(diff, anchor) {
  const p = anchor.center;
  const all = [];
  const counts = { added: 0, removed: 0, modified: 0 };
  const geomCounts = { added: 0, removed: 0, modified: 0 }; // 形状シグナル（geomHash 変化 or 移動）がある行だけ
  for (const r of diff.bboxRows) {
    const c = bboxCenter(r);
    if (!c) continue;
    const dh = Math.hypot(c.x - p.x, c.y - p.y);
    const dz = Math.abs(c.z - p.z);
    if (dh > 30 || dz > 6) continue;
    const signal = r.geomChanged || isMoved(r);
    if (counts[r.type] !== undefined) counts[r.type]++;
    if (signal && geomCounts[r.type] !== undefined) geomCounts[r.type]++;
    all.push({ ...r, signal });
  }
  all.sort((a, b) => (b.signal - a.signal) || String(a.name).localeCompare(String(b.name)));
  return {
    anchorName: anchor.name, anchorCenter: p, anchorBbox: { min: anchor.bboxMin, max: anchor.bboxMax },
    radiusFt: 30, dzFt: 6, counts, geomCounts,
    rows: all.slice(0, 400), rowsTotal: all.length, rowsTruncated: all.length > 400,
  };
}

// ============ HTTP ルーティング ============
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/token') { // APS Viewer 用 2-legged（sample-d と同じ）
      const t = await getToken2();
      const remain = Math.max(60, Math.floor((t.expiresAt - Date.now()) / 1000));
      return sendJson(res, 200, { access_token: t.access_token, expires_in: remain });
    }
    if (url.pathname === '/api/issues') {
      const [issues, versions] = await Promise.all([fetchIssues(), fetchVersions()]);
      const snap = loadSnapshots();
      const merged = issues.map(i => ({ ...i, history: buildHistory(i, snap, versions) }));
      return sendJson(res, 200, {
        project: { id: PROJECT_ID, name: 'Snowdon Towers' },
        model: { name: ARCH.name, lineage: ARCH.lineage },
        versions, issues: merged,
        snapshot: { updatedAt: snap.updatedAt, refreshCount: snap.refreshCount, eventCount: snap.events.length },
        fetchedAt: new Date().toISOString(),
      });
    }
    const cm = url.pathname.match(/^\/api\/issues\/([^/]+)\/comments$/);
    if (cm) {
      const comments = await fetchComments(decodeURIComponent(cm[1]));
      return sendJson(res, 200, { comments });
    }
    if (url.pathname === '/api/versions') {
      const versions = await fetchVersions();
      return sendJson(res, 200, { model: ARCH.name, versions });
    }
    if (url.pathname === '/api/refresh' && req.method === 'POST') {
      const r = await refreshSnapshots();
      return sendJson(res, 200, r);
    }
    if (url.pathname === '/api/diff') {
      const from = Number(url.searchParams.get('from'));
      const to = Number(url.searchParams.get('to'));
      const issueId = url.searchParams.get('issue');
      if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) {
        return sendJson(res, 400, { error: 'from / to には異なる版番号が必要です' });
      }
      let diff = loadDiffCache(from, to);
      if (!diff) {
        const key = `${from}-${to}`;
        const job = diffJobs.get(key);
        if (!job || job.state === 'failed') {
          if (!job) runLiveDiff(from, to).catch(() => {});
          return sendJson(res, 202, { status: job?.state ?? 'indexing', from, to, error: job?.error ?? null, note: '実 API で diff ジョブを実行中です。しばらくして再取得してください' });
        }
        if (job.state !== 'ready') return sendJson(res, 202, { status: job.state, from, to });
        diff = loadDiffCache(from, to);
        if (!diff) return sendJson(res, 202, { status: 'dumping', from, to });
      }
      let nearPin = null, pinNote = null;
      if (issueId) {
        const issues = await fetchIssues();
        const issue = issues.find(i => i.id === issueId);
        if (!issue?.pin?.position) pinNote = 'この Issue にはピンがないため、ファイル全体の件数のみ表示します';
        else if (!issue.pin.isArchitectural) pinNote = 'この Issue のピンは別モデルのため、近傍の絞り込みは行いません';
        else {
          const anchor = findPinAnchor(issue, diff);
          if (!anchor) pinNote = 'ピン対象要素の bbox が diff データに無いため、近傍の絞り込みはできません（ファイル全体の件数のみ表示します）';
          else nearPin = nearPinRows(diff, anchor);
        }
      }
      return sendJson(res, 200, {
        from, to, source: diff.source, stats: diff.stats,
        totalRows: diff.totalRows, bboxRowCount: diff.bboxRowCount,
        byCategory: diff.byCategory, nearPin, pinNote,
      });
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
const port = process.env.PORT ?? 3100;
server.listen(port, () => { console.log(`history-graph server: http://localhost:${port}`); });
refreshSnapshots().catch(e => console.error('initial snapshot refresh failed:', e.message)); // 起動時に履歴の種を作る
