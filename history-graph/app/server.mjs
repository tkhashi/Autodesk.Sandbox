// server.mjs — 履歴グラフ実アプリ v1: 実 Issue（APS Issues API）＋アプリ側スナップショット履歴
//             ＋ モデル版一覧（DM API）＋ Model Properties Diff（実行時に実 API ジョブで取得）
// 起動: node server.mjs（.env に APS_CLIENT_ID / APS_CLIENT_SECRET、.token.json に 3-legged トークンが必要。
//       認証情報の探索順: ①アプリ自身のフォルダ ②clone 配置で隣の sample-d（../../sample-d-issues-3d）
//       ③ワークスペース内の demo-issues-3d/app と sample-a-http-client。どれにも無ければ案内を出して終了する）
//
// データは全て実行時に API から取得する（事前投入データは使わない）。
// アプリ側で持つ状態は data/ のみ:
//   data/snapshots.json — Issue の status／担当者のスナップショットと変化イベント（追記型）
//   data/diff-cache/    — このアプリ自身が実 API ジョブで取得した diff 結果のキャッシュ（出所＝ジョブ実行日時つき）
//   data/pin-snapshots.json — ピン時点スナップショット（デモスライス。Webhook 受信シミュレーション経由で保存）
// 現在値は常に Forma から取得する（このアプリは「履歴の記録者」であり、状態の管理者ではない）。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ============ 設定 ============
const root = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(root, 'public');
const dataDir = path.join(root, 'data');
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
// 対象モデルは環境変数で切り替え可能（HG_ITEM_NAME / HG_LINEAGE_ID / HG_VIEWABLE_GUID）。
// 既定は正規ルートで作り直した新アイテム「Snowdon Towers Sample Architectural HG」:
// V1（対照ファイル）に対して Issue を先に起票し、その後に V2・V3 が公開される順序のため、
// モデル更新イベントが各 Issue のタイムラインに自然に付く。
// 旧アイテム（Snowdon Towers Sample Architectural.rvt）に戻す場合は
// HG_LINEAGE_ID=VwJ57NkiQ-Gy0nHLR3UmAA HG_ITEM_NAME="Snowdon Towers Sample Architectural.rvt" を指定する。
const OLD_LINEAGE_ID = 'VwJ57NkiQ-Gy0nHLR3UmAA';
const ARCH = {
  name: process.env.HG_ITEM_NAME ?? 'Snowdon Towers Sample Architectural HG.rvt',
  lineageId: process.env.HG_LINEAGE_ID ?? 'n1BdFAarT-ajJkQvheK5EA',
  // 表示用 viewable は「New Construction」を版ごとに名前で解決する（2026-11-17 実測）:
  // 従来の 'Coord - Arch Walls' は壁 1,061＋壁スイープ 249＝1,310 要素しか含まず、
  // スラブ・扉・藤棚・植栽・外灯は SVF 変換時点で含まれていない。全カテゴリを含むのは
  // 'New Construction'（7,027 要素）だけ。geometry guid は版間で変動するため guid 直指定は
  // せず、名前解決を正とする。HG_VIEWABLE_GUID は明示指定された場合のみの上書き。
  viewableName: process.env.HG_VIEWABLE_NAME ?? 'New Construction',
  viewableGuid: process.env.HG_VIEWABLE_GUID ?? null,
};
ARCH.lineage = `urn:adsk.wipprod:dm.lineage:${ARCH.lineageId}`;
const IS_OLD_ITEM = ARCH.lineageId === OLD_LINEAGE_ID;
// 実測で判明している版ごとの事情（research/v2-diff-measurement.md。旧アイテムのみ）
const VERSION_NOTES = IS_OLD_ITEM ? {
  3: '登録されたファイルが破損しており変換できない（実測記録）。内容の実体は V4',
} : {};
const versionUrn = n => `urn:adsk.wipprod:fs.file:vf.${ARCH.lineageId}?version=${n}`;
const derivativeUrn = n => Buffer.from(versionUrn(n), 'utf8').toString('base64url');
// 版 v のモデル更新イベントに対する diff ペア。旧アイテムでは V3 は変換不可なので V4 は V2 とのペアで見る
function diffPairFor(v) {
  if (VERSION_NOTES[v]) return null;
  if (IS_OLD_ITEM && v === 4) return { from: 2, to: 4, label: 'V2 → V4（実質 V3）' };
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
    snapshotUrn: issue.snapshotUrn ?? null, snapshotHasMarkups: issue.snapshotHasMarkups ?? false,
    pin: null,
  };
  const ld = (issue.linkedDocuments ?? [])[0];
  if (ld) {
    const d = ld.details ?? {};
    out.pin = {
      modelUrn: ld.urn ?? null, viewName: d.viewable?.name ?? null,
      objectId: d.objectId ?? null, externalId: d.externalId ?? null,
      position: d.position ?? null,
      // ピン時点のカメラ（Forma の画面で作ったピンは完全な viewerState を持つ。
      // API 作成ピンはキーがあっても中身が空＝カメラなし。自動スクショの視点決定に使う）
      viewerState: (d.viewerState && Object.keys(d.viewerState).length) ? d.viewerState : null,
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

// ============ Issue サムネイル（ピン時点のスナップショット画像。sample-d から移植） ============
// Issues API の issue.snapshotUrn（OSS オブジェクト）を、署名付き S3 URL 経由で取得する。
// snapshotUrn が無い Issue（API 経由で作ったピン等、Forma 側で画像が生成されていないもの）には画像が存在しない。
const snapImgCache = new Map();
async function getSnapshotImage(urn) {
  if (!snapImgCache.has(urn)) {
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
    snapImgCache.set(urn, { buf: Buffer.from(await r.arrayBuffer()), type });
  }
  return snapImgCache.get(urn);
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
    // 版の公開者は DM API の attributes.createUserName（無ければ lastModifiedUserName）に
    // 実名で入っている（批判的レビュー H4 で実測。relationships.creator は存在せず常に null だった）
    createdBy: v.attributes?.createUserName ?? v.attributes?.lastModifiedUserName ?? null,
    note: VERSION_NOTES[v.attributes?.versionNumber] ?? null,
    derivativeUrn: derivativeUrn(v.attributes?.versionNumber),
    viewableGuid: ARCH.viewableGuid,
    viewableName: ARCH.viewableName,
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
    // 新しい版の公開を検出したら、新ペアの自動スクショをキューに入れる（撮影は裏で
    // 進み、refresh 本体はブロックしない。失敗しても refresh は壊れない）
    try {
      const versions = await fetchVersions();
      const nums = versions.map(v => v.versionNumber);
      if (!Array.isArray(snap.knownVersions)) {
        snap.knownVersions = nums; // 初回は基準として記録するだけ（既存ペアへは遡らない）
        saveSnapshots(snap);
      } else {
        const fresh = nums.filter(n => !snap.knownVersions.includes(n));
        if (fresh.length) {
          snap.knownVersions = nums;
          saveSnapshots(snap);
          for (const n of fresh) {
            const pair = diffPairFor(n);
            if (pair) enqueueCapturesForPair(pair.from, pair.to);
          }
        }
      }
    } catch (e) { console.error('capture trigger failed:', e.message); }
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
    .map(v => ({ version: v.versionNumber, publishedAt: v.createdAt, createdBy: v.createdBy ?? null, note: v.note, diffPair: diffPairFor(v.versionNumber) }));
  return { events, modelUpdates, stats: { closeCount, reopenCount, modelUpdateCount: modelUpdates.length } };
}

// ============ 関連するモデル更新（ピン付き Issue × ライブ diff の要素リストで判定） ============
// 「Issue が開いている間に公開された版」だけでは、版が Issue 作成より前に公開されていた
// 場合にモデル更新イベントが1つも付かない。ピン付き Issue については、アンカー要素が
// 実際に変化した連続ペアを「関連するモデル更新」として併せて付ける。
// 判定はライブ diff の要素リストへの含有で行う（推測では付けない）:
//   added／removed リストにアンカー要素が含まれるペアは無条件に対象。
//   modified は、跨ロケールペアでは無変更要素も大量に含まれる（ロケールノイズ）ため、
//   形状シグナル（geomHash 変化・bbox 移動）か実質的な値の変化（computeValueChanged）が
//   ある要素だけを「実際に変化した」とみなす。プロパティのみの実変化（コメント追記など）は
//   valueChanged で拾う（geometry 判定には限定しない）。
function anchorChangeIn(diff, externalId) {
  const el = diff?.elements;
  if (!el || !externalId) return null;
  const a = (el.added ?? []).find(e => e.externalId === externalId);
  if (a) return { change: 'added', anchorName: a.name ?? null };
  const rm = (el.removed ?? []).find(e => e.externalId === externalId);
  if (rm) return { change: 'removed', anchorName: rm.name ?? null };
  const m = (el.modified ?? []).find(e => e.externalId === externalId);
  if (m && (m.geomChanged || m.moved || m.valueChanged)) return { change: 'changed', anchorName: m.name ?? null };
  return null;
}
function candidateDiffPairs(versions) {
  const seen = new Set();
  const out = [];
  for (const v of versions) {
    const p = diffPairFor(v.versionNumber);
    if (!p) continue;
    const key = `${p.from}-${p.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...p, version: v.versionNumber, publishedAt: v.createdAt ?? null });
  }
  return out;
}
// 候補ペアの diff が実行時キャッシュに無ければジョブを開始し、その Issue は pending とする
// （ジョブ完了後の再取得で関連ペアが付く）。
function computeRelatedPairs(issues, versions) {
  const pairDefs = candidateDiffPairs(versions);
  const diffs = new Map();
  let anyPending = false;
  for (const pd of pairDefs) {
    const got = getDiffOrStart(pd.from, pd.to);
    if (got.diff) diffs.set(`${pd.from}-${pd.to}`, got.diff);
    else anyPending = true;
  }
  const map = new Map();
  for (const issue of issues) {
    if (!issue.pin?.isArchitectural || !issue.pin?.externalId) continue;
    const pairs = [];
    for (const pd of pairDefs) {
      const d = diffs.get(`${pd.from}-${pd.to}`);
      if (!d) continue;
      const hit = anchorChangeIn(d, issue.pin.externalId);
      if (hit) pairs.push({ from: pd.from, to: pd.to, label: pd.label, version: pd.version, publishedAt: pd.publishedAt, change: hit.change, anchorName: hit.anchorName });
    }
    map.set(issue.id, { pairs, pending: anyPending });
  }
  return map;
}

// ============ Diff（実行時キャッシュ → 実 API ジョブ） ============
// 実行時キャッシュは「このアプリ自身が実 API ジョブで取得した結果」だけを保存する（format 3、
// ジョブ実行日時つき）。事前に用意されたダンプファイル等を読む経路は持たない。
// キャッシュファイル名には lineageId を含める（版番号だけだと、対象アイテムを切り替えたときに
// 別アイテムの同じ版ペアのキャッシュを誤って読んでしまうため）。
// 旧アイテムの既存キャッシュ（lineageId なしの旧名）は、そのアイテム自身の実ジョブ結果なので
// 旧アイテムを対象にしている場合に限りフォールバックで読む。
function diffCachePath(from, to) {
  return path.join(diffCacheDir, `diff-${ARCH.lineageId}-${from}-${to}.json`);
}
function loadDiffCache(from, to) {
  const candidates = [diffCachePath(from, to)];
  if (IS_OLD_ITEM) candidates.push(path.join(diffCacheDir, `diff-${from}-${to}.json`));
  for (const p of candidates) {
    try {
      const d = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (d && d.format === 3 && d.source === 'live') return d;
    } catch (e) {}
  }
  return null;
}
// プロパティの「実質的な値の変化」判定（ロケールノイズとの切り分け用）。
// 英語ロケール保存 → 日本語ロケール保存のような跨ロケールペアでは、フィールドキーが
// ロケールごとに付け替わるため、無変更の要素でも OBJECT_CHANGED に大量に現れる
// （実測: V1→V2 で 34,718 件）。そのノイズ行では「片側にしか無いキーに同じ値が入っている」
// （付け替え）か「共有キーでも prev 側が null」のどちらかで、値そのものは変わっていない。
// 実質変化とみなすのは次のいずれか:
//   (1) システムフィールド以外で、同一キーに両側とも非 null の異なる値が入っている
//   (2) 新版側の値（ASCII 文字列または数値。システムフィールド以外）が旧版側の値集合に存在しない
//       （例: ドアのコメント "diff-test" の新規追記）
// 日本語文字列同士の付け替え（ enum 表示名の翻訳など）は (2) の対象外としてノイズ側に倒す。
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
  const elements = { added: [], removed: [], modified: [] }; // 3D 差分表示用の全要素リスト（bbox の有無によらない）
  for (const r of rows) {
    const type = TYPE_MAP[r.type] ?? r.type;
    const cur = r.props ?? {}, prev = r.prev?.props ?? {};
    const category = cur[catKey] ?? prev[catKey] ?? null;
    const name = cur[nameKey] ?? prev[nameKey] ?? null;
    if (category) {
      byCategory[category] ??= { added: 0, removed: 0, modified: 0 };
      if (byCategory[category][type] !== undefined) byCategory[category][type]++;
    }
    const entry = { externalId: r.externalId ?? null, svf2Id: r.svf2Id ?? null, name };
    if (type === 'added') elements.added.push(entry);
    else if (type === 'removed') elements.removed.push(entry);
    else if (type === 'modified') {
      const geomChanged = !!(r.geomHash && r.prev?.geomHash && r.geomHash !== r.prev.geomHash);
      elements.modified.push({ ...entry, geomChanged, moved: isMoved(r), valueChanged: computeValueChanged(r, fmap) });
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
      type, externalId: r.externalId ?? null, name, category,
      bboxMin: r.bboxMin ?? null, bboxMax: r.bboxMax ?? null,
      prevBboxMin: r.prev?.bboxMin ?? null, prevBboxMax: r.prev?.bboxMax ?? null,
      geomChanged: !!(r.geomHash && r.prev?.geomHash && r.geomHash !== r.prev.geomHash),
      changedProps,
    });
  }
  return { bboxRows, byCategory, elements };
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
    const { bboxRows, byCategory, elements } = normalizeLiveRows(rows, fieldsText);
    const out = {
      format: 3, from, to, source: 'live', jobRunAt: new Date().toISOString(), stats, totalRows: rows.length,
      bboxRowCount: bboxRows.length, byCategory, bboxRows, elements,
    };
    fs.writeFileSync(diffCachePath(from, to), JSON.stringify(out));
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
    return r ? { center: bboxCenter(r), name: r.name, externalId: ext, bboxMin: r.bboxMin ?? r.prevBboxMin, bboxMax: r.bboxMax ?? r.prevBboxMax } : null;
  };
  const a = fromRow(primaryDiff);
  if (a) return a;
  // 対象要素がこのペアの diff に現れない（無変更）場合は、このアプリが取得済みの
  // 他ペアの diff（実行時キャッシュ）の bbox で代用する。対象は現在のアイテムの
  // キャッシュだけに限る（旧アイテムの旧名キャッシュは旧アイテム対象時のみ）
  const ownFile = f => f.startsWith(`diff-${ARCH.lineageId}-`) || (IS_OLD_ITEM && /^diff-\d+-\d+\.json$/.test(f));
  for (const f of fs.readdirSync(diffCacheDir)) {
    if (!ownFile(f)) continue;
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
// アンカー要素自身がこのペアでどう変化したか（要素リスト＋bbox 行から引く）。
// diff に現れなければ null（＝このペアでは対象要素自体に変更はない）。
function anchorSelfChange(diff, externalId) {
  if (!externalId || !diff) return null;
  const brow = (diff.bboxRows ?? []).find(x => x.externalId === externalId) ?? null;
  const els = diff.elements ?? {};
  for (const t of ['added', 'removed', 'modified']) {
    const e = (els[t] ?? []).find(x => x.externalId === externalId);
    if (e) return {
      type: t, name: e.name ?? brow?.name ?? null,
      geomChanged: !!e.geomChanged, moved: !!e.moved, valueChanged: !!e.valueChanged,
      changedProps: brow?.changedProps ?? [],
    };
  }
  if (brow) return { type: brow.type, name: brow.name ?? null, geomChanged: !!brow.geomChanged, moved: isMoved(brow), valueChanged: false, changedProps: brow.changedProps ?? [] };
  return null;
}
// bbox を持たない要素（部屋など）は近傍判定（bbox 中心ベース）に入らないため、そのままでは
// 室名変更のような値変化が画面のどこにも現れない。ファイル全体の「bbox を持たない modified で
// 実変化シグナルがある要素」を、名前の基底名（末尾の [要素ID] を除いたもの）でグループ化して返す。
function noBboxChangeGroups(diff) {
  const withBbox = new Set((diff.bboxRows ?? []).map(r => r.externalId));
  const groups = new Map();
  let total = 0;
  for (const e of diff.elements?.modified ?? []) {
    if (!e.externalId || withBbox.has(e.externalId)) continue;
    if (!(e.geomChanged || e.moved || e.valueChanged)) continue; // ロケールノイズのみの行は出さない
    total++;
    const base = String(e.name ?? '').replace(/\s*\[\d+\]\s*$/, '') || String(e.name ?? '');
    if (!groups.has(base)) groups.set(base, { baseName: base, count: 0, items: [] });
    const g = groups.get(base);
    g.count++;
    if (g.items.length < 20) g.items.push({ name: e.name ?? null, externalId: e.externalId });
  }
  // 単独のもの（部屋など名前で特定できる対象）を先に、同数の繰り返しは後ろに
  const list = [...groups.values()].sort((a, b) => (a.count - b.count) || a.baseName.localeCompare(b.baseName));
  return { total, groups: list.slice(0, 200), groupsTruncated: list.length > 200 };
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
    anchorName: anchor.name, anchorExternalId: anchor.externalId ?? null,
    anchorChange: anchorSelfChange(diff, anchor.externalId),
    anchorCenter: p, anchorBbox: { min: anchor.bboxMin, max: anchor.bboxMax },
    radiusFt: 30, dzFt: 6, counts, geomCounts,
    rows: all.slice(0, 400), rowsTotal: all.length, rowsTruncated: all.length > 400,
  };
}

// diff が実行時キャッシュにあればそれを返し、無ければ実 API ジョブを開始（または継続）して状態を返す
function getDiffOrStart(from, to) {
  const diff = loadDiffCache(from, to);
  if (diff) return { diff };
  const key = `${from}-${to}`;
  const job = diffJobs.get(key);
  if (!job) { runLiveDiff(from, to).catch(() => {}); return { status: 'indexing' }; }
  if (job.state === 'failed') { // 失敗していたら再試行する
    const error = job.error;
    runLiveDiff(from, to).catch(() => {});
    return { status: 'indexing', error };
  }
  if (job.state !== 'ready') return { status: job.state };
  const d2 = loadDiffCache(from, to);
  return d2 ? { diff: d2 } : { status: 'dumping' };
}

// ============ モデル更新時の自動スクショ（サーバ側ヘッドレス撮影） ============
// 新しい版の公開を検出したら、新ペア（直前版→新版）の変更箇所をサーバ側の
// ヘッドレス Chrome で撮影する（クライアントのブラウザは不要）。撮影ページ
// （public/capture.html）が APS Viewer を読み、差分ビューアと同じ見た目
// （色分け＋見通し確保＋引出線ラベル）で getScreenShot する。
// 前提: 撮影ホストから Autodesk の Viewer CDN と APS エンドポイントへ到達できること。
// 到達できない環境では撮影は失敗としてジョブログに理由つきで残り、refresh 本体は壊れない。
// 設定: HG_CAPTURE_ENABLED=0 で無効化（既定は有効）、HG_CAPTURE_MAX_CLUSTERS で
// 「その他 geometry 変化」のクラスタ撮影の上限（既定 5）、HG_CHROME_PATH で Chrome を指定。
const CAPTURE_ENABLED = (process.env.HG_CAPTURE_ENABLED ?? '1') !== '0';
const CAPTURE_MAX_CLUSTERS = Math.max(0, Number(process.env.HG_CAPTURE_MAX_CLUSTERS ?? 5) || 0);
const CAPTURE_DIR = path.join(dataDir, 'captures');
fs.mkdirSync(CAPTURE_DIR, { recursive: true });
const CAPTURE_INDEX = path.join(CAPTURE_DIR, 'index.json');
function loadCaptureIndex() {
  try {
    const s = JSON.parse(fs.readFileSync(CAPTURE_INDEX, 'utf8'));
    if (s && Array.isArray(s.jobs)) return s;
  } catch (e) {}
  return { version: 1, jobs: [] };
}
function saveCaptureIndex(s) { fs.writeFileSync(CAPTURE_INDEX, JSON.stringify(s, null, 1)); }
async function waitForDiffReady(from, to) {
  for (let n = 0; n < 160; n++) { // 15 秒 × 160 回 = 最大 40 分（index ジョブの最長実測に合わせる）
    const s = getDiffOrStart(from, to);
    if (s.diff) return s.diff;
    await new Promise(r => setTimeout(r, 15000));
  }
  return null;
}
function hasPinCamera(pin) {
  const eye = pin?.viewerState?.viewport?.eye;
  return Array.isArray(eye) && eye.length === 3 && eye.every(v => Number.isFinite(v));
}
// geometry 変化した要素（bbox を持つもの）を近接クラスタにまとめる（決定的な順序）
function clusterGeometryChanges(diff, excludeExts) {
  const rows = (diff.bboxRows ?? []).filter(r => {
    if (!r.externalId || excludeExts.has(r.externalId)) return false;
    if (!r.bboxMin && !r.prevBboxMin) return false;
    if (r.type === 'added' || r.type === 'removed') return true;
    if (r.type === 'modified') {
      const moved = JSON.stringify(r.bboxMin) !== JSON.stringify(r.prevBboxMin) || JSON.stringify(r.bboxMax) !== JSON.stringify(r.prevBboxMax);
      return r.geomChanged || moved;
    }
    return false;
  }).map(r => {
    const mn = r.type === 'removed' ? (r.prevBboxMin ?? r.bboxMin) : (r.bboxMin ?? r.prevBboxMin);
    const mx = r.type === 'removed' ? (r.prevBboxMax ?? r.bboxMax) : (r.bboxMax ?? r.prevBboxMax);
    return { externalId: r.externalId, name: r.name, kind: r.type, min: mn, max: mx, center: { x: (mn.x + mx.x) / 2, y: (mn.y + mx.y) / 2, z: (mn.z + mx.z) / 2 } };
  });
  rows.sort((a, b) => String(a.externalId).localeCompare(String(b.externalId)));
  const clusters = [];
  const CLUSTER_MAX_MEMBERS = 25; // 1クラスタ＝1画に収める上限（中心の連鎖で建物全体を吸わないため）
  for (const r of rows) {
    let best = null, bestD = Infinity;
    for (const c of clusters) {
      if (c.members.length >= CLUSTER_MAX_MEMBERS) continue;
      const d = Math.hypot(c.center.x - r.center.x, c.center.y - r.center.y, c.center.z - r.center.z);
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best && bestD <= 40) { // 近接の目安: 中心間 40（モデル単位）以内は同じ画に収める
      best.members.push(r);
      best.center = {
        x: best.members.reduce((s, m) => s + m.center.x, 0) / best.members.length,
        y: best.members.reduce((s, m) => s + m.center.y, 0) / best.members.length,
        z: best.members.reduce((s, m) => s + m.center.z, 0) / best.members.length,
      };
      best.box = {
        min: { x: Math.min(best.box.min.x, r.min.x), y: Math.min(best.box.min.y, r.min.y), z: Math.min(best.box.min.z, r.min.z) },
        max: { x: Math.max(best.box.max.x, r.max.x), y: Math.max(best.box.max.y, r.max.y), z: Math.max(best.box.max.z, r.max.z) },
      };
    } else {
      clusters.push({ members: [r], center: { ...r.center }, box: { min: { ...r.min }, max: { ...r.max } } });
    }
  }
  clusters.sort((a, b) => b.members.length - a.members.length);
  return clusters;
}
// ペアに対する撮影ジョブを計画してキューに入れる（①開いているピン付き Issue の
// アンカー変化を最優先、②その他 geometry 変化はクラスタ単位で上限つき）
async function enqueueCapturesForPair(from, to) {
  if (!CAPTURE_ENABLED) return;
  try {
    const diff = await waitForDiffReady(from, to);
    if (!diff) {
      console.error(`captures: diff V${from}->V${to} が完了しなかったため撮影を中止しました`);
      const idx = loadCaptureIndex();
      idx.jobs.push({
        id: 'cap-' + Date.now().toString(36) + '-diff', key: `diff:${from}-${to}`, from, to,
        kind: 'pair', status: 'failed', error: 'diff ジョブが完了しなかったため撮影できませんでした',
        queuedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      });
      saveCaptureIndex(idx);
      return;
    }
    const issues = await fetchIssues();
    const planned = [];
    for (const i of issues) {
      if (i.status === 'closed') continue; // 開いている Issue のみ
      if (!i.pin?.isArchitectural || !i.pin.externalId) continue;
      const ch = anchorChangeIn(diff, i.pin.externalId);
      if (!ch) continue;
      planned.push({
        key: `a:${i.id}`, kind: 'anchor', issueId: i.id, issueDisplayId: i.displayId,
        elementName: ch.anchorName ?? i.pin.externalId, externalId: i.pin.externalId,
        camera: hasPinCamera(i.pin) ? 'pin' : 'fallback', // ピンカメラが無い API ピンは代替カメラ
      });
    }
    const anchorExts = new Set(planned.map(p => p.externalId));
    const clusters = clusterGeometryChanges(diff, anchorExts);
    for (const c of clusters.slice(0, CAPTURE_MAX_CLUSTERS)) {
      planned.push({
        key: `c:${c.members[0].externalId}`, kind: 'cluster', issueId: null, issueDisplayId: null,
        elementName: c.members.length > 1 ? `${c.members[0].name} ほか ${c.members.length - 1} 件` : c.members[0].name,
        externalId: c.members[0].externalId, members: c.members.map(m => m.externalId),
        box: c.box, camera: 'computed',
      });
    }
    const idx = loadCaptureIndex();
    let added = 0;
    for (const p of planned) {
      const dup = idx.jobs.some(x => x.from === from && x.to === to && x.key === p.key && ['queued', 'running', 'done'].includes(x.status));
      if (dup) continue;
      idx.jobs.push({
        id: 'cap-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
        from, to, status: 'queued', queuedAt: new Date().toISOString(), ...p,
      });
      added++;
    }
    if (added) {
      saveCaptureIndex(idx);
      console.log(`captures: V${from} -> V${to} の撮影ジョブを ${added} 件キューに入れました`);
      processCaptureQueue();
    }
  } catch (e) {
    console.error('capture planning failed:', e.message);
  }
}
// 撮影ページへ渡す仕様（対象・カメラ・分類リスト）を組み立てる
const captureSpecs = new Map();
function diffElementsPayload(diff) {
  const pub = (e, extra = {}) => ({ externalId: e.externalId, svf2Id: e.svf2Id, name: e.name, ...extra });
  const changed = diff.elements.modified.filter(e => e.geomChanged || e.moved);
  return {
    counts: { added: diff.elements.added.length, removed: diff.elements.removed.length, changed: changed.length },
    added: diff.elements.added.map(e => pub(e)),
    removed: diff.elements.removed.map(e => pub(e)),
    changed: changed.map(e => pub(e, { geomChanged: e.geomChanged, moved: e.moved })),
  };
}
async function buildCaptureSpec(job) {
  const [versions, diff] = await Promise.all([fetchVersions(), waitForDiffReady(job.from, job.to)]);
  if (!diff) throw new Error('diff が取得できませんでした');
  const base = {
    job: { id: job.id, from: job.from, to: job.to, kind: job.kind, camera: job.camera },
    versions: versions.map(v => ({ versionNumber: v.versionNumber, derivativeUrn: v.derivativeUrn, viewableName: v.viewableName, viewableGuid: v.viewableGuid })),
    viewableName: ARCH.viewableName, viewableGuid: ARCH.viewableGuid,
    elements: diffElementsPayload(diff),
  };
  if (job.kind === 'anchor') {
    const issues = await fetchIssues();
    const i = issues.find(x => x.id === job.issueId);
    const brow = (diff.bboxRows ?? []).find(r => r.externalId === job.externalId) ?? null;
    return {
      ...base,
      target: {
        externalIds: [job.externalId], anchorExternalId: job.externalId,
        box: brow ? { min: brow.bboxMin ?? brow.prevBboxMin, max: brow.bboxMax ?? brow.prevBboxMax } : null,
        members: [{ externalId: job.externalId, name: job.elementName, kind: brow?.type ?? 'modified' }],
      },
      camera: { type: job.camera, viewerState: i?.pin?.viewerState ?? null, pinPosition: i?.pin?.position ?? null },
    };
  }
  const byExt = new Map((diff.bboxRows ?? []).map(r => [r.externalId, r]));
  return {
    ...base,
    target: {
      externalIds: job.members, anchorExternalId: null, box: job.box,
      members: job.members.map(ext => ({ externalId: ext, name: byExt.get(ext)?.name ?? ext, kind: byExt.get(ext)?.type ?? 'modified' })),
    },
    camera: { type: 'computed' },
  };
}
// 撮影用 Chrome の解決順: ①HG_CHROME_PATH（明示指定）②Playwright の Chromium
// ③/opt/meta-chromium/chrome ④PATH 上の google-chrome / chromium。
// （この VM の /opt/meta-chromium は WebGL ドメインポリシーで素の起動ができないため、
// 標準の Chromium を優先する。実機では HG_CHROME_PATH で任意の Chrome を指定できる）
function resolveChromePath() {
  if (process.env.HG_CHROME_PATH) return process.env.HG_CHROME_PATH;
  try {
    const base = path.join(os.homedir(), '.cache', 'ms-playwright');
    const dirs = fs.readdirSync(base).filter(d => d.startsWith('chromium-')).sort().reverse();
    for (const d of dirs) {
      const p = path.join(base, d, 'chrome-linux64', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  } catch (e) {}
  for (const p of ['/opt/meta-chromium/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}
// ヘッドレス Chrome を DevTools プロトコルで駆動し、撮影ページの完了報告を待つ
async function driveHeadlessCapture(job) {
  const chromePath = resolveChromePath();
  if (!chromePath || !fs.existsSync(chromePath)) throw new Error('ヘッドレス Chrome が見つかりません（HG_CHROME_PATH で指定できます）');
  const port = 9600 + Math.floor(Math.random() * 400);
  const profile = `/tmp/hg-cap-${job.id}`;
  const proc = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--window-size=1100,850', 'about:blank',
  ], { stdio: 'ignore' });
  try {
    let ok = false;
    for (let n = 0; n < 40 && !ok; n++) {
      try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); ok = r.ok; } catch (e) {}
      if (!ok) await new Promise(r => setTimeout(r, 500));
    }
    if (!ok) throw new Error('ヘッドレス Chrome の DevTools に接続できませんでした');
    const appPort = process.env.PORT ?? 3100;
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`http://localhost:${appPort}/capture.html?job=${job.id}`)}`, { method: 'PUT' })).json();
    if (!target.webSocketDebuggerUrl) throw new Error('撮影ページのタブを作成できませんでした');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let seq = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      } catch (e) {}
    };
    const cdp = (method, params = {}) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
    await cdp('Runtime.enable');
    const deadline = Date.now() + 240000;
    let final = null;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      const res = await cdp('Runtime.evaluate', { expression: 'JSON.stringify(window.__capture ?? null)', returnByValue: true });
      const raw = res?.result?.result?.value;
      if (!raw) continue;
      const st = JSON.parse(raw);
      if (st.status === 'done' || st.status === 'failed') { final = st; break; }
    }
    try { ws.close(); } catch (e) {}
    if (!final) throw new Error('撮影がタイムアウトしました（240 秒）');
    if (final.status === 'failed') throw new Error(final.error ?? '撮影ページが失敗を報告しました');
    const idx = loadCaptureIndex();
    const rec = idx.jobs.find(x => x.id === job.id);
    if (!rec || rec.status !== 'done') throw new Error('撮影ページから画像が届きませんでした');
  } finally {
    try { proc.kill('SIGKILL'); } catch (e) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }
}
let captureRunning = false;
async function processCaptureQueue() {
  if (captureRunning || !CAPTURE_ENABLED) return;
  captureRunning = true;
  try {
    for (;;) {
      const idx = loadCaptureIndex();
      const job = idx.jobs.find(x => x.status === 'queued');
      if (!job) break;
      job.status = 'running';
      job.startedAt = new Date().toISOString();
      saveCaptureIndex(idx);
      try {
        captureSpecs.set(job.id, await buildCaptureSpec(job));
        await driveHeadlessCapture(job);
      } catch (e) {
        const idx2 = loadCaptureIndex();
        const rec = idx2.jobs.find(x => x.id === job.id);
        if (rec && rec.status !== 'done') {
          rec.status = 'failed';
          rec.error = String(e.message ?? e).slice(0, 300);
          rec.finishedAt = new Date().toISOString();
          saveCaptureIndex(idx2);
        }
        console.error(`capture ${job.id} failed:`, e.message);
      } finally {
        captureSpecs.delete(job.id);
      }
    }
  } finally { captureRunning = false; }
}

// ============ ピン時点スナップショットと Close 検証（デモスライス、SPEC §7.9） ============
// 狙い: Issue 起票の瞬間にピンが指した要素の「その時点の状態」を保存しておき、
// 後から最新版と照合して「Close 時点で対象がどう変わったか」を判定できるようにする。
// デモ前提（本番配線はしない）:
//   - Webhook は本物を登録しない。POST /api/sim/webhook が本物と同じ形のペイロード
//     （event 名＋payload）を受け、受信後の処理は本物の受け口と同じ経路
//     （processIssueCreatedWebhook: Issue を API で GET → ピン抽出 → 要素状態の保存 → 照合）を通す。
//   - 保存先は data/pin-snapshots.json で、外部ストレージのモックとして扱う。
//   - 要素の状態は、その版の Model Properties インデックスの実データから復元する
//     （事前投入データは使わない）。変換ジョブは投げない。
const PIN_SNAP_FILE = path.join(dataDir, 'pin-snapshots.json');
function loadPinSnaps() {
  try {
    const s = JSON.parse(fs.readFileSync(PIN_SNAP_FILE, 'utf8'));
    if (s && s.snapshots) return s;
  } catch (e) {}
  return { version: 1, snapshots: {} };
}
function savePinSnaps(s) { fs.writeFileSync(PIN_SNAP_FILE, JSON.stringify(s, null, 1)); }

async function idxCall(method, url, body) {
  const t = await getToken3();
  const r = await fetch(url, {
    method, headers: { Authorization: 'Bearer ' + t, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) {}
  return { status: r.status, json };
}
// 単一版インデックスの確保（runLiveDiff の ensureIndex と同じ手順）
async function ensureIndexShared(urn) {
  const { json } = await idxCall('POST', `${IDX}/projects/${PID}/indexes:batch-status`, { versions: [{ versionUrn: urn }] });
  const ix = json?.indexes?.[0];
  if (!ix?.indexId) throw new Error('indexId が返りませんでした');
  for (let i = 0; i < 80; i++) {
    const { json: j2 } = await idxCall('GET', `${IDX}/projects/${PID}/indexes/${ix.indexId}`);
    if (j2?.state === 'FINISHED') return ix.indexId;
    if (j2?.state === 'FAILED') throw new Error('index FAILED');
    await sleep(15000);
  }
  throw new Error('index timeout');
}
const indexFieldsCache = new Map();
async function indexFields(indexId) {
  if (indexFieldsCache.has(indexId)) return indexFieldsCache.get(indexId);
  const text = await apsText(`${IDX}/projects/${PID}/indexes/${indexId}/fields`, await getToken3());
  const fmap = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const d = JSON.parse(line); fmap.set(d.key, d); } catch (e) {}
  }
  indexFieldsCache.set(indexId, fmap);
  return fmap;
}
async function queryIndexRows(indexId, lo, hi) {
  const base = `${IDX}/projects/${PID}/indexes/${indexId}`;
  const create = await idxCall('POST', `${base}/queries`, { query: { $between: ['s.SVF2Id', lo, hi] } });
  if (create.status !== 200 && create.status !== 201) throw new Error(`index query create ${create.status}`);
  const qid = create.json.queryId;
  let st = create.json.state;
  for (let i = 0; i < 60 && st !== 'FINISHED'; i++) {
    await sleep(3000);
    const { json } = await idxCall('GET', `${base}/queries/${qid}`);
    st = json?.state;
    if (st === 'FAILED') throw new Error('index query FAILED');
  }
  if (st !== 'FINISHED') throw new Error('index query timeout');
  const text = await apsText(`${base}/queries/${qid}/properties`, await getToken3());
  const rows = [];
  for (const line of text.split('\n')) if (line.trim()) rows.push(JSON.parse(line));
  return rows;
}
// インデックス行を「要素の状態」に正規化する（プロパティはフィールド定義で読み取り名に直す）
function normalizeElementState(row, fmap, versionNumber) {
  let nameKey = null, catKey = null;
  for (const [k, v] of fmap) {
    if (v.category === '__name__') nameKey = k;
    if (v.category === '__category__' && v.name === 'Category') catKey = k;
  }
  const props = [];
  for (const [k, v] of Object.entries(row.props ?? {})) {
    const f = fmap.get(k);
    props.push({ name: f?.name ?? k, category: f?.category ?? null, value: v });
  }
  props.sort((a, b) => String(a.category).localeCompare(String(b.category)) || String(a.name).localeCompare(String(b.name)));
  return {
    version: versionNumber, found: true,
    svf2Id: row.svf2Id ?? null, externalId: row.externalId ?? null,
    name: (nameKey ? row.props?.[nameKey] : null) ?? null,
    category: (catKey ? row.props?.[catKey] : null) ?? null,
    bboxMin: row.bboxMin ?? null, bboxMax: row.bboxMax ?? null,
    geomHash: row.geomHash ?? null, propsHash: row.propsHash ?? null,
    props,
  };
}
// 指定版における要素の状態を取得する。externalId の直接クエリは API が受理しない
// （$eq は 400、実測）ため、ピンの objectId（＝インデックスの svf2Id）をヒントに
// 範囲を広げながら引き、externalId で照合する。最後は全域スキャンで「存在しない」
// ことまで確定させる（削除判定の根拠）。
const elementStateCache = new Map();
async function fetchElementState(versionNumber, externalId, svf2IdHint) {
  const key = `${versionNumber}:${externalId}`;
  if (elementStateCache.has(key)) return elementStateCache.get(key);
  const indexId = await ensureIndexShared(versionUrn(versionNumber));
  const fmap = await indexFields(indexId);
  const scan = async (lo, hi) => {
    const rows = await queryIndexRows(indexId, lo, hi);
    return rows.find(r => r.externalId === externalId) ?? null;
  };
  let row = null;
  if (Number.isFinite(svf2IdHint)) {
    for (const w of [256, 2048]) {
      row = await scan(Math.max(0, svf2IdHint - w), svf2IdHint + w);
      if (row) break;
    }
  }
  if (!row) {
    for (let a = 0; a <= 48000 && !row; a += 4000) row = await scan(a, a + 3999);
  }
  const state = row ? normalizeElementState(row, fmap, versionNumber) : { version: versionNumber, found: false, externalId };
  elementStateCache.set(key, state);
  return state;
}
// ピン時点の状態と最新版の状態の照合（Close 検証）。
// 判定: removed（最新版に存在しない）／ changed（形状・移動・bbox・プロパティのいずれか）／ unchanged。
function compareElementStates(a, b) {
  const base = { geomChanged: false, moved: false, moveVector: null, bboxChanged: false, changedProps: [], changedPropCount: 0 };
  if (!a?.found) return { ...base, verdict: 'unknown', summary: ['ピン時点の対象要素を取得できませんでした'] };
  if (!b?.found) return { ...base, verdict: 'removed', summary: ['対象要素が最新版に存在しません（削除＝解消方向の変化）'] };
  const summary = [];
  let moved = false, moveVector = null, bboxChanged = false;
  if (a.bboxMin && b.bboxMin && a.bboxMax && b.bboxMax) {
    const dMin = ['x', 'y', 'z'].map(k => b.bboxMin[k] - a.bboxMin[k]);
    const dMax = ['x', 'y', 'z'].map(k => b.bboxMax[k] - a.bboxMax[k]);
    const sameVec = dMin.every((v, i) => Math.round(v * 1000) === Math.round(dMax[i] * 1000));
    if (sameVec && dMin.some(v => Math.round(v * 1000) !== 0)) {
      moved = true;
      moveVector = { x: Math.round(dMin[0] * 1000) / 1000, y: Math.round(dMin[1] * 1000) / 1000, z: Math.round(dMin[2] * 1000) / 1000 };
      summary.push(`位置が移動しました（Δx ${moveVector.x}, Δy ${moveVector.y}, Δz ${moveVector.z}、モデル単位）`);
    } else if (JSON.stringify(a.bboxMin) !== JSON.stringify(b.bboxMin) || JSON.stringify(a.bboxMax) !== JSON.stringify(b.bboxMax)) {
      bboxChanged = true;
      summary.push('外形（bbox）が変化しました');
    }
  }
  const geomChanged = !!(a.geomHash && b.geomHash && a.geomHash !== b.geomHash);
  if (geomChanged) summary.push('形状（geomHash）が変化しました');
  const keyOf = p => `${p.category ?? ''}::${p.name}`;
  const pick = s => new Map((s.props ?? []).filter(p => !String(p.category ?? '').startsWith('__')).map(p => [keyOf(p), p]));
  const am = pick(a), bm = pick(b);
  const changedProps = [];
  for (const k of new Set([...am.keys(), ...bm.keys()])) {
    const pa = am.get(k), pb = bm.get(k);
    const va = pa?.value ?? null, vb = pb?.value ?? null;
    if (JSON.stringify(va) !== JSON.stringify(vb)) {
      changedProps.push({ name: (pb ?? pa)?.name ?? k, category: (pb ?? pa)?.category ?? null, from: va, to: vb });
    }
  }
  if (changedProps.length) {
    summary.push(`プロパティが ${changedProps.length} 件変化しました（${changedProps.slice(0, 3).map(c => c.name).join('、')}${changedProps.length > 3 ? ' ほか' : ''}）`);
  }
  const changed = moved || bboxChanged || geomChanged || changedProps.length > 0;
  return {
    verdict: changed ? 'changed' : 'unchanged',
    geomChanged, moved, moveVector, bboxChanged,
    changedProps: changedProps.slice(0, 20), changedPropCount: changedProps.length,
    summary: changed ? summary : ['形状・位置・プロパティに変化はありません'],
  };
}
// ピンが打たれた版＝Issue 作成時刻以前に公開された最新の版（作成後に公開された版にはピンできない）
function pinnedVersionFor(issue, versions) {
  const cands = versions.filter(v => v.createdAt && issue.createdAt && v.createdAt <= issue.createdAt);
  return cands.length ? cands[cands.length - 1].versionNumber : (versions[0]?.versionNumber ?? null);
}
async function fetchIssueById(issueId) {
  const token = await getToken3();
  const [types, users] = await Promise.all([
    getIssueTypes(() => loadIssueTypes(token)),
    getProjectUsers(() => loadProjectUsers(token)),
  ]);
  const j = await apsGet(`${BASE}/construction/issues/v1/projects/${PID}/issues/${issueId}`, token);
  return enrichIssue(j, types, users);
}
// Webhook 受信後の処理本体。本物の受け口でも同じ経路を通す想定で、
// 「Issue を API で GET → ピン抽出 → ピン時点の要素状態を保存 → 最新版と照合」を行う。
async function processIssueCreatedWebhook(payload) {
  const p = payload?.payload ?? payload ?? {};
  const issueId = p.issueId ?? p.id ?? p.resourceId ?? payload?.issueId ?? null;
  if (!issueId) throw new Error('webhook ペイロードから issueId を取り出せませんでした');
  const issue = await fetchIssueById(issueId);
  const out = { issueId, displayId: issue.displayId, title: issue.title, pinFound: !!issue.pin };
  if (!issue.pin?.externalId || !issue.pin.isArchitectural) {
    out.note = '対象モデルへのピンが無いため、要素スナップショットは作成しませんでした';
    return out;
  }
  const versions = await fetchVersions();
  const pinnedVersion = pinnedVersionFor(issue, versions);
  const latestVersion = versions[versions.length - 1]?.versionNumber ?? pinnedVersion;
  const pinState = await fetchElementState(pinnedVersion, issue.pin.externalId, issue.pin.objectId);
  const latestState = latestVersion === pinnedVersion ? pinState
    : await fetchElementState(latestVersion, issue.pin.externalId, issue.pin.objectId);
  const verification = { comparedVersion: latestVersion, checkedAt: new Date().toISOString(), ...compareElementStates(pinState, latestState) };
  const store = loadPinSnaps();
  store.snapshots[issueId] = {
    issueId, displayId: issue.displayId, title: issue.title,
    source: 'webhook-sim', simulated: true,
    event: payload?.event ?? 'issue.created-1.0',
    receivedAt: new Date().toISOString(),
    pin: { position: issue.pin.position ?? null, externalId: issue.pin.externalId, objectId: issue.pin.objectId ?? null, viewName: issue.pin.viewName ?? null },
    pinnedVersion,
    element: pinState,
    verification,
  };
  savePinSnaps(store);
  return { ...out, pinnedVersion, elementFound: pinState.found, comparedVersion: latestVersion, verdict: verification.verdict, summary: verification.summary };
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
      const related = computeRelatedPairs(issues, versions);
      const merged = issues.map(i => {
        const h = buildHistory(i, snap, versions);
        const rel = related.get(i.id);
        let relatedPairs = rel?.pairs ?? [];
        if (relatedPairs.length && h.modelUpdates.length) {
          // 「開いている間に公開された版」と同じペアは二重に付けない
          const have = new Set(h.modelUpdates.filter(m => m.diffPair).map(m => `${m.diffPair.from}-${m.diffPair.to}`));
          relatedPairs = relatedPairs.filter(p => !have.has(`${p.from}-${p.to}`));
        }
        return {
          ...i,
          history: {
            ...h,
            relatedPairs,
            relatedPairsPending: rel?.pending ?? false,
            stats: { ...h.stats, relatedPairCount: relatedPairs.length },
          },
        };
      });
      return sendJson(res, 200, {
        project: { id: PROJECT_ID, name: 'Snowdon Towers' },
        model: { name: ARCH.name, lineage: ARCH.lineage, viewableName: ARCH.viewableName, viewableGuid: ARCH.viewableGuid },
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
    const tm = url.pathname.match(/^\/api\/issues\/([^/]+)\/thumbnail$/);
    if (tm) {
      // ピン時点のサムネイル（issue.snapshotUrn）をサーバ側でプロキシ配信する。
      // snapshotUrn が無い Issue には画像が存在しないので 404（画面側は表示自体を省略する）
      const issues = await fetchIssues();
      const issue = issues.find(i => i.id === decodeURIComponent(tm[1]));
      if (!issue?.snapshotUrn) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('no thumbnail'); }
      const img = await getSnapshotImage(issue.snapshotUrn);
      res.writeHead(200, { 'Content-Type': img.type, 'Cache-Control': 'max-age=3600' });
      return res.end(img.buf);
    }
    if (url.pathname === '/api/versions') {
      const versions = await fetchVersions();
      return sendJson(res, 200, { model: ARCH.name, versions });
    }
    // ---- ピン時点スナップショット／Webhook 受信シミュレーション（デモスライス、SPEC §7.9） ----
    const psm = url.pathname.match(/^\/api\/issues\/([^/]+)\/pin-snapshot$/);
    if (psm && req.method === 'GET') {
      const rec = loadPinSnaps().snapshots[decodeURIComponent(psm[1])];
      if (!rec) return sendJson(res, 404, { error: 'ピン時点スナップショットはまだありません（Webhook 受信シミュレーションで生成されます）' });
      return sendJson(res, 200, rec);
    }
    if (url.pathname === '/api/sim/webhook' && req.method === 'POST') {
      // 本物の Issues Webhook と同じ形のペイロードを受ける口（デモ用シミュレーション。
      // 本物の Webhook 登録はしていない）。受信後の処理は本物の受け口と同じ経路を通す。
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch (e) {}
      const r = await processIssueCreatedWebhook(body);
      return sendJson(res, 200, { ok: true, simulated: true, ...r });
    }
    if (url.pathname === '/api/sim/webhook/hg' && req.method === 'POST') {
      // 管理用: 対象モデルにピンされた Issue（HG では #48〜52）を「起票 Webhook が来た」
      // ていで同じ経路に流し、スナップショットを一括生成する（再実行可能）。
      const issues = await fetchIssues();
      const targets = issues.filter(i => i.pin?.isArchitectural && i.pin?.externalId);
      const results = [];
      for (const i of targets) {
        try {
          const r = await processIssueCreatedWebhook({ event: 'issue.created-1.0', payload: { issueId: i.id } });
          results.push(r);
        } catch (e) { results.push({ issueId: i.id, displayId: i.displayId, error: String(e?.message ?? e) }); }
      }
      return sendJson(res, 200, { ok: true, simulated: true, count: results.length, results });
    }
    if (url.pathname === '/api/refresh' && req.method === 'POST') {
      const r = await refreshSnapshots();
      return sendJson(res, 200, r);
    }
    // ---- 自動スクショ ----
    if (url.pathname === '/api/captures' && req.method === 'GET') {
      const idx = loadCaptureIndex();
      let jobs = idx.jobs;
      const f = Number(url.searchParams.get('from')), t = Number(url.searchParams.get('to'));
      if (Number.isFinite(f) && Number.isFinite(t)) jobs = jobs.filter(x => x.from === f && x.to === t);
      return sendJson(res, 200, { enabled: CAPTURE_ENABLED, maxClusters: CAPTURE_MAX_CLUSTERS, jobs });
    }
    const capSpecMatch = url.pathname.match(/^\/api\/captures\/spec\/([\w-]+)$/);
    if (capSpecMatch && req.method === 'GET') {
      const spec = captureSpecs.get(capSpecMatch[1]);
      if (!spec) return sendJson(res, 404, { error: '撮影仕様が見つかりません（ジョブ実行中のみ有効）' });
      return sendJson(res, 200, spec);
    }
    const capImgMatch = url.pathname.match(/^\/api\/captures\/([\w-]+)\/image$/);
    if (capImgMatch && req.method === 'GET') {
      const idx = loadCaptureIndex();
      const rec = idx.jobs.find(x => x.id === capImgMatch[1]);
      if (!rec?.file) return sendJson(res, 404, { error: '画像がありません' });
      const filePath = path.join(CAPTURE_DIR, rec.file);
      if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: '画像ファイルがありません' });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(filePath));
    }
    if (capImgMatch && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch (e) {}
      const idx = loadCaptureIndex();
      const rec = idx.jobs.find(x => x.id === capImgMatch[1]);
      if (!rec) return sendJson(res, 404, { error: 'capture job not found' });
      if (!body.png) return sendJson(res, 400, { error: 'png が必要です' });
      const file = `${rec.id}.png`;
      fs.writeFileSync(path.join(CAPTURE_DIR, file), Buffer.from(body.png, 'base64'));
      rec.status = 'done';
      rec.file = file;
      rec.error = null;
      rec.finishedAt = new Date().toISOString();
      saveCaptureIndex(idx);
      return sendJson(res, 200, { ok: true });
    }
    const capFailMatch = url.pathname.match(/^\/api\/captures\/([\w-]+)\/fail$/);
    if (capFailMatch && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch (e) {}
      const idx = loadCaptureIndex();
      const rec = idx.jobs.find(x => x.id === capFailMatch[1]);
      if (!rec) return sendJson(res, 404, { error: 'capture job not found' });
      if (rec.status !== 'done') {
        rec.status = 'failed';
        rec.error = String(body.error ?? '撮影ページが失敗を報告しました').slice(0, 300);
        rec.finishedAt = new Date().toISOString();
        saveCaptureIndex(idx);
      }
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === '/api/captures/run' && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch (e) {}
      const from = Number(body.from), to = Number(body.to);
      const versions = await fetchVersions();
      const okPair = Number.isFinite(from) && Number.isFinite(to) && from < to &&
        versions.some(v => v.versionNumber === from) && versions.some(v => v.versionNumber === to);
      if (!okPair) return sendJson(res, 400, { error: '版ペアが不正です' });
      if (!CAPTURE_ENABLED) return sendJson(res, 400, { error: '自動スクショは無効化されています（HG_CAPTURE_ENABLED=0）' });
      enqueueCapturesForPair(from, to);
      return sendJson(res, 202, { ok: true, queued: true, from, to });
    }
    if (url.pathname === '/api/diff') {
      const from = Number(url.searchParams.get('from'));
      const to = Number(url.searchParams.get('to'));
      const issueId = url.searchParams.get('issue');
      if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) {
        return sendJson(res, 400, { error: 'from / to には異なる版番号が必要です' });
      }
      const got = getDiffOrStart(from, to);
      if (!got.diff) {
        return sendJson(res, 202, { status: got.status, from, to, error: got.error ?? null, note: '実 API で diff ジョブを実行中です。しばらくして再取得してください' });
      }
      const diff = got.diff;
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
        from, to, source: diff.source, jobRunAt: diff.jobRunAt ?? null, stats: diff.stats,
        totalRows: diff.totalRows, bboxRowCount: diff.bboxRowCount,
        byCategory: diff.byCategory, nearPin, pinNote,
        noBbox: issueId ? noBboxChangeGroups(diff) : null,
      });
    }
    if (url.pathname === '/api/diff/elements') {
      // 3D 差分表示用の要素 ID リスト（ライブ diff ジョブの結果からのみ組み立てる）
      // mode=geometry（既定）: 「変更」は形状シグナル（geomHash 変化・bbox 移動）のある要素のみ。
      //   「変更」の生件数はロケールノイズが支配的（V1→V2 で 34,718 件）なため、既定では形状分だけに絞る。
      // mode=all: プロパティのみの変更を含む全「変更」。
      const from = Number(url.searchParams.get('from'));
      const to = Number(url.searchParams.get('to'));
      const mode = url.searchParams.get('mode') === 'all' ? 'all' : 'geometry';
      if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) {
        return sendJson(res, 400, { error: 'from / to には異なる版番号が必要です' });
      }
      const got = getDiffOrStart(from, to);
      if (!got.diff) {
        return sendJson(res, 202, { status: got.status, from, to, error: got.error ?? null, note: '実 API で diff ジョブを実行中です。しばらくして再取得してください' });
      }
      const diff = got.diff;
      const el = diff.elements ?? { added: [], removed: [], modified: [] };
      const changed = mode === 'all' ? el.modified : el.modified.filter(e => e.geomChanged || e.moved);
      return sendJson(res, 200, {
        from, to, mode, source: diff.source, jobRunAt: diff.jobRunAt ?? null, stats: diff.stats,
        counts: { added: el.added.length, removed: el.removed.length, changed: changed.length, modifiedTotal: el.modified.length },
        added: el.added, removed: el.removed, changed,
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
