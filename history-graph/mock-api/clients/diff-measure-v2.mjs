// diff-measure-v2.mjs — [MOCK TEST COPY] 元: research/diff-measure-v2.mjs
// モック用改変点: BASE / .env / .token.json を環境変数で差し替え可能にした
// (APS_BASE_URL, APS_ENV_FILE, APS_TOKEN_FILE, APS_TOKEN_FILE2)。実環境のファイルには触らない。
// ログと diff-rows/ はこのコピーと同じフォルダ (clients/) に出る。
// 前提: V2 登録済み（モックでは upload クライアントを先に流すこと）。手順: V1/V2 インデックス作成→FINISHED → diff ジョブ→統計 →
// diff fields 取得 → changeType 別クエリで変更要素の明細行を取得し diff-rows/ に保存。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const DEMO_DIR = path.join(root, 'demo-issues-3d', 'app');
const SAMPLE_A_DIR = path.join(root, 'sample-a-http-client');
const BASE = process.env.APS_BASE_URL || 'https://developer.api.autodesk.com';
const IDX = `${BASE}/construction/index/v2`;
const TOKEN_FILE = process.env.APS_TOKEN_FILE || path.join(DEMO_DIR, '.token.json');
const TOKEN_FILE2 = process.env.APS_TOKEN_FILE2 || path.join(SAMPLE_A_DIR, '.token.json');
const PID = '031a6e68-ccdf-4a29-b8a5-50a2a3ecac25';
const V1 = 'urn:adsk.wipprod:fs.file:vf.VwJ57NkiQ-Gy0nHLR3UmAA?version=1';
const V2 = 'urn:adsk.wipprod:fs.file:vf.VwJ57NkiQ-Gy0nHLR3UmAA?version=2';
const OUTDIR = path.join(here, 'diff-rows');
fs.mkdirSync(OUTDIR, { recursive: true });

const env = {};
for (const line of fs.readFileSync(process.env.APS_ENV_FILE || path.join(DEMO_DIR, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const basicAuth = () => 'Basic ' + Buffer.from(env.APS_CLIENT_ID + ':' + env.APS_CLIENT_SECRET).toString('base64');

const log = [];
function rec(step, method, url, status, note, body) {
  const e = { step, method, url, status, note };
  if (body !== undefined) e.body = body;
  log.push(e);
  console.log(`[${step}] ${method} ${url.replace(BASE, '')} -> ${status}${note ? ' | ' + note : ''}`);
  if (body !== undefined) console.log('   body:', JSON.stringify(body).slice(0, 700));
}
const trim = (t) => { try { return JSON.parse(t); } catch { return t.slice(0, 500); } };
function saveLog() { fs.writeFileSync(path.join(here, 'v2-diff-log.json'), JSON.stringify(log, null, 1)); }
const sleep = ms => new Promise(s => setTimeout(s, ms));

let tok3 = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
async function refresh3() {
  const r = await fetch(BASE + '/authentication/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuth() },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok3.refresh_token }),
  });
  if (!r.ok) { rec('token-refresh', 'POST', '/authentication/v2/token', r.status, 'FAILED', trim(await r.text())); saveLog(); throw new Error('refresh failed'); }
  tok3 = { ...(await r.json()), obtained_at: Date.now() };
  const s = JSON.stringify(tok3, null, 1);
  fs.writeFileSync(TOKEN_FILE, s);
  fs.writeFileSync(TOKEN_FILE2, s);
  rec('token-refresh', 'POST', '/authentication/v2/token', r.status, 'refreshed; wrote back to BOTH .token.json files');
}
async function ensureToken() { if (Date.now() - (tok3.obtained_at ?? 0) > 45 * 60000) await refresh3(); }
await ensureToken();
rec('token-refresh', '-', '-', 0, 'token ready');

async function call(method, url, body) {
  await ensureToken();
  const r = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + tok3.access_token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, json: trim(text), raw: text };
}
async function fetchText(url) {
  await ensureToken();
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + tok3.access_token } });
  if (!r.ok) return { status: r.status, text: await r.text() };
  const buf = Buffer.from(await r.arrayBuffer());
  let text;
  try { text = zlib.gunzipSync(buf).toString('utf8'); } catch { text = buf.toString('utf8'); }
  return { status: r.status, text };
}

// ---------- 1) V1 / V2 インデックス ----------
async function ensureIndex(versionUrn, label) {
  const { status, json } = await call('POST', `${IDX}/projects/${PID}/indexes:batch-status`, { versions: [{ versionUrn }] });
  const ix = json?.indexes?.[0];
  rec(`index-batch-${label}`, 'POST', '/construction/index/v2/projects/{pid}/indexes:batch-status', status,
    ix ? `state=${ix.state} indexId=${ix.indexId}` : 'no index', status >= 300 ? json : undefined);
  if (!ix?.indexId) { saveLog(); throw new Error('no indexId for ' + label); }
  const url = `${IDX}/projects/${PID}/indexes/${ix.indexId}`;
  for (let i = 0; i < 80; i++) {
    const { status: s2, json: j2 } = await call('GET', url);
    if (i % 4 === 0 || j2?.state === 'FINISHED' || j2?.state === 'FAILED')
      rec(`index-poll-${label}`, 'GET', '.../indexes/{indexId}', s2, `state=${j2?.state} objects=${j2?.stats?.objects ?? '-'}`);
    if (j2?.state === 'FINISHED') return ix.indexId;
    if (j2?.state === 'FAILED') { saveLog(); throw new Error('index FAILED for ' + label); }
    await sleep(15000);
  }
  throw new Error('index poll timeout for ' + label);
}
const idxV1 = await ensureIndex(V1, 'v1');
const idxV2 = await ensureIndex(V2, 'v2');
console.log('indexIds:', idxV1, idxV2);

// ---------- 2) Diff ジョブ ----------
let diffId, diffStats;
{
  const { status, json } = await call('POST', `${IDX}/projects/${PID}/diffs:batch-status`,
    { diffs: [{ prevVersionUrn: V1, curVersionUrn: V2 }] });
  const d = Array.isArray(json) ? json[0] : json?.diffs?.[0];
  rec('diff-batch-status', 'POST', '/construction/index/v2/projects/{pid}/diffs:batch-status', status,
    d ? `state=${d.state} diffId=${d.diffId}` : 'no diff object', status >= 300 || !d ? json : undefined);
  if (!d?.diffId) { saveLog(); throw new Error('no diffId'); }
  diffId = d.diffId;
  const durl = `${IDX}/projects/${PID}/diffs/${diffId}`;
  for (let i = 0; i < 80; i++) {
    const { status: s2, json: j2 } = await call('GET', durl);
    if (i % 4 === 0 || j2?.state === 'FINISHED' || j2?.state === 'FAILED')
      rec('diff-poll', 'GET', '.../diffs/{diffId}', s2, `state=${j2?.state} stats=${JSON.stringify(j2?.stats ?? null)} errors=${JSON.stringify(j2?.errors ?? null)}`);
    if (j2?.state === 'FINISHED') { diffStats = j2?.stats; break; }
    if (j2?.state === 'FAILED') { saveLog(); throw new Error('diff FAILED: ' + JSON.stringify(j2?.errors ?? null)); }
    await sleep(15000);
  }
}
console.log('DIFF STATS:', JSON.stringify(diffStats));
const durl = `${IDX}/projects/${PID}/diffs/${diffId}`;

// ---------- 3) Diff fields ----------
{
  const { status, text } = await fetchText(`${durl}/fields`);
  rec('diff-fields', 'GET', '.../diffs/{diffId}/fields', status, `bytes=${text.length}`);
  if (status === 200) {
    fs.writeFileSync(path.join(OUTDIR, 'diff-fields.ndjson'), text);
    const keys = text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l).key; } catch { return '?'; } });
    rec('diff-fields-keys', '-', '-', 0, 'keys=' + keys.join(','));
  }
}

// ---------- 4) changeType 別クエリ ----------
async function runDiffQuery(label, query) {
  const { status, json } = await call('POST', `${durl}/queries`, { query });
  rec(`diff-query-create-${label}`, 'POST', '.../diffs/{diffId}/queries', status,
    `query=${JSON.stringify(query)} state=${json?.state ?? ''} queryId=${json?.queryId ?? ''}`, status >= 300 ? json : undefined);
  if (status !== 200 || !json?.queryId) return null;
  const qurl = `${durl}/queries/${json.queryId}`;
  for (let i = 0; i < 40; i++) {
    const { status: s2, json: j2 } = await call('GET', qurl);
    if (j2?.state === 'FINISHED' || j2?.state === 'FAILED') {
      rec(`diff-query-poll-${label}`, 'GET', '.../queries/{queryId}', s2, `state=${j2?.state}`);
      if (j2?.state === 'FAILED') return null;
      break;
    }
    await sleep(10000);
  }
  const { status: s3, text } = await fetchText(`${qurl}/properties`);
  const rows = text.split('\n').filter(Boolean);
  rec(`diff-query-properties-${label}`, 'GET', '.../queries/{queryId}/properties', s3, `rows=${rows.length}`);
  if (s3 === 200) fs.writeFileSync(path.join(OUTDIR, `diff-${label}.ndjson`), text);
  return rows;
}
for (const ct of ['OBJECT_ADDED', 'OBJECT_REMOVED', 'OBJECT_CHANGED']) {
  await runDiffQuery(ct.toLowerCase().replace('object_', ''), { $eq: ['s.changeType', `'${ct}'`] });
}

saveLog();
console.log('\nDONE. diffId=', diffId, 'stats=', JSON.stringify(diffStats));
fs.writeFileSync(path.join(here, 'v2-diff-result.json'), JSON.stringify({ idxV1, idxV2, diffId, diffStats }, null, 1));
