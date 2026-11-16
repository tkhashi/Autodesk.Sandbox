// probe-model-properties.mjs — [MOCK TEST COPY] 元: research/probe-model-properties.mjs
// モック用改変点: BASE / .env / .token.json / models.json を環境変数で差し替え可能にした
// (APS_BASE_URL, APS_ENV_FILE, APS_TOKEN_FILE, APS_TOKEN_FILE2, APS_MODELS_FILE)。
// 実環境の .env / .token.json には一切触らない。ログはこのコピーと同じフォルダに出る。
// 目的: indexes:batch-status / クエリ作成→ポーリング→結果取得 / diffs:batch-status の疎通確認。
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
  if (body !== undefined) console.log('   body:', JSON.stringify(body).slice(0, 600));
}
const trim = (t) => { try { return JSON.parse(t); } catch { return t.slice(0, 500); } };

// ---------- トークン ----------
let tok3 = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
async function refresh3() {
  const r = await fetch(BASE + '/authentication/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuth() },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok3.refresh_token }),
  });
  if (!r.ok) { rec('token-refresh', 'POST', '/authentication/v2/token', r.status, 'FAILED', trim(await r.text())); throw new Error('refresh failed'); }
  tok3 = { ...(await r.json()), obtained_at: Date.now() };
  const s = JSON.stringify(tok3, null, 1);
  fs.writeFileSync(TOKEN_FILE, s);
  fs.writeFileSync(TOKEN_FILE2, s);
  rec('token-refresh', 'POST', '/authentication/v2/token', r.status, 'refreshed; wrote back to BOTH .token.json files');
}
if (Date.now() - (tok3.obtained_at ?? 0) > 45 * 60000) await refresh3();
else rec('token-refresh', '-', '-', 0, 'existing 3-legged token still fresh, no refresh');
const T3 = tok3.access_token;

// JWT の scope クレームだけ確認（値は出さない）
try {
  const payload = JSON.parse(Buffer.from(T3.split('.')[1], 'base64url').toString());
  rec('token-scope', '-', '3-legged JWT payload', 0, 'scopes=' + JSON.stringify(payload.scope));
} catch { rec('token-scope', '-', '-', 0, 'could not decode JWT payload'); }

async function getToken2() {
  const r = await fetch(BASE + '/authentication/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuth() },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'data:read' }),
  });
  if (!r.ok) throw new Error('2-legged failed ' + r.status);
  return (await r.json()).access_token;
}
const T2 = await getToken2();
rec('token-2legged', 'POST', '/authentication/v2/token', 200, 'client_credentials scope=data:read');

async function call(method, url, token, body) {
  const r = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, json: trim(text), raw: text };
}
const sleep = (ms) => new Promise(s => setTimeout(s, ms));

// ---------- 対象モデル ----------
const models = JSON.parse(fs.readFileSync(process.env.APS_MODELS_FILE || path.join(DEMO_DIR, 'data', 'models.json'), 'utf8'));
const m = models.find(x => x.key === 'snowdon');
const projectId = m.projectId.replace(/^b\./, '');

// DM: バージョン一覧（2-legged）
{
  const url = `${BASE}/data/v1/projects/${m.projectId}/items/${encodeURIComponent(m.lineage)}/versions`;
  const { status, json } = await call('GET', url, T2);
  const vers = json?.data ?? [];
  rec('dm-versions', 'GET', `/data/v1/projects/.../items/{snowdon lineage}/versions`, status,
    `versions=${vers.length}; numbers=${vers.map(v => v.attributes?.versionNumber).join(',')}`);
  var versionUrn = vers[0]?.id;
}
if (!versionUrn) throw new Error('no version urn');
console.log('versionUrn:', versionUrn);

// ---------- 1) indexes:batch-status（3-legged / 本命） ----------
let indexId;
{
  const url = `${IDX}/projects/${projectId}/indexes:batch-status`;
  const { status, json } = await call('POST', url, T3, { versions: [{ versionUrn }] });
  const ix = json?.indexes?.[0];
  indexId = ix?.indexId;
  rec('index-batch-status-3legged', 'POST', `/construction/index/v2/projects/{pid}/indexes:batch-status`, status,
    ix ? `state=${ix.state} indexId=${ix.indexId}` : 'no index object', json);
}

// ---------- 1b) indexes:batch-status（2-legged / user context 必須の確認） ----------
{
  const url = `${IDX}/projects/${projectId}/indexes:batch-status`;
  const { status, json } = await call('POST', url, T2, { versions: [{ versionUrn }] });
  rec('index-batch-status-2legged', 'POST', `/construction/index/v2/projects/{pid}/indexes:batch-status`, status,
    'negative test: 2-legged token', json);
}

// ---------- 1c) コレクション GET（未文書化の疎通プローブ） ----------
{
  const url = `${IDX}/projects/${projectId}/indexes`;
  const { status, json } = await call('GET', url, T3);
  rec('index-collection-get', 'GET', `/construction/index/v2/projects/{pid}/indexes`, status,
    'undocumented collection GET probe', json);
}

// ---------- 2) インデックス状態ポーリング ----------
if (indexId) {
  const url = `${IDX}/projects/${projectId}/indexes/${indexId}`;
  for (let i = 0; i < 40; i++) {
    const { status, json } = await call('GET', url, T3);
    rec('index-poll', 'GET', `/construction/index/v2/projects/{pid}/indexes/{indexId}`, status,
      `state=${json?.state} objects=${json?.stats?.objects ?? '-'}`);
    if (json?.state === 'FINISHED' || json?.state === 'FAILED') { var finalIndex = json; break; }
    await sleep(15000);
  }
  // manifest
  {
    const { status, json } = await call('GET', `${url}/manifest`, T3);
    rec('index-manifest', 'GET', `.../indexes/{indexId}/manifest`, status,
      json?.status ? `manifest status=${json.status} seedFiles=${json.seedFiles?.length}` : '', status === 200 ? undefined : json);
  }
  // fields（json.gz の NDJSON）
  {
    const r = await fetch(`${url}/fields`, { headers: { Authorization: 'Bearer ' + T3 } });
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer());
      let text;
      try { text = zlib.gunzipSync(buf).toString('utf8'); } catch { text = buf.toString('utf8'); }
      const lines = text.split('\n').filter(Boolean);
      const keys = lines.slice(0, 12).map(l => { try { return JSON.parse(l).key; } catch { return '?'; } });
      rec('index-fields', 'GET', `.../indexes/{indexId}/fields`, r.status, `fieldCount=${lines.length} firstKeys=${keys.join(',')}`);
    } else {
      rec('index-fields', 'GET', `.../indexes/{indexId}/fields`, r.status, '', trim(await r.text()));
    }
  }
  // ---------- 2b) クエリ作成 → ポーリング → 結果取得 ----------
  let queryId;
  for (const field of ['s.SVF2Id', 's.svf2Id']) {
    const { status, json } = await call('POST', `${url}/queries`, T3, { query: { $between: [field, 1, 50] } });
    rec('query-create', 'POST', `.../indexes/{indexId}/queries`, status,
      `filter: ${field} between 1 and 50; state=${json?.state ?? ''} queryId=${json?.queryId ?? ''}`, status === 200 ? undefined : json);
    if (status === 200) { queryId = json?.queryId; var usedField = field; break; }
  }
  if (queryId) {
    const qurl = `${url}/queries/${queryId}`;
    for (let i = 0; i < 40; i++) {
      const { status, json } = await call('GET', qurl, T3);
      rec('query-poll', 'GET', `.../indexes/{indexId}/queries/{queryId}`, status, `state=${json?.state}`);
      if (json?.state === 'FINISHED' || json?.state === 'FAILED') break;
      await sleep(10000);
    }
    const r = await fetch(`${qurl}/properties`, { headers: { Authorization: 'Bearer ' + T3 } });
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer());
      let text;
      try { text = zlib.gunzipSync(buf).toString('utf8'); } catch { text = buf.toString('utf8'); }
      const rows = text.split('\n').filter(Boolean);
      rec('query-properties', 'GET', `.../queries/{queryId}/properties`, r.status,
        `rows=${rows.length} (filter ${usedField} 1..50)`);
    } else {
      rec('query-properties', 'GET', `.../queries/{queryId}/properties`, r.status, '', trim(await r.text()));
    }
  }
}

// ---------- 3) Diff 疎通 ----------
// 3a) prev=V1, cur=V2（存在しない）→ エラー内容を記録
{
  const curV2 = versionUrn.replace(/\?version=\d+$/, '?version=2');
  const { status, json } = await call('POST', `${IDX}/projects/${projectId}/diffs:batch-status`, T3,
    { diffs: [{ prevVersionUrn: versionUrn, curVersionUrn: curV2 }] });
  rec('diff-v1-vs-nonexistent-v2', 'POST', `/construction/index/v2/projects/{pid}/diffs:batch-status`, status,
    'prev=V1 cur=V2(does not exist)', json);
}
// 3b) prev=V1, cur=V1（同一バージョン同士）→ 通れば diff パイプライン自体の疎通証拠
{
  const { status, json } = await call('POST', `${IDX}/projects/${projectId}/diffs:batch-status`, T3,
    { diffs: [{ prevVersionUrn: versionUrn, curVersionUrn: versionUrn }] });
  const d = Array.isArray(json) ? json[0] : json?.diffs?.[0];
  rec('diff-v1-vs-v1', 'POST', `/construction/index/v2/projects/{pid}/diffs:batch-status`, status,
    d ? `state=${d.state} diffId=${d.diffId}` : '', json);
  if (d?.diffId) {
    const durl = `${IDX}/projects/${projectId}/diffs/${d.diffId}`;
    for (let i = 0; i < 24; i++) {
      const { status: s2, json: j2 } = await call('GET', durl, T3);
      rec('diff-poll', 'GET', `/construction/index/v2/projects/{pid}/diffs/{diffId}`, s2,
        `state=${j2?.state} stats=${JSON.stringify(j2?.stats ?? null)}`);
      if (j2?.state === 'FINISHED' || j2?.state === 'FAILED') break;
      await sleep(15000);
    }
  }
}

fs.writeFileSync(path.join(here, 'probe-model-properties-log.json'), JSON.stringify(log, null, 1));
console.log('\nLOG WRITTEN: research/probe-model-properties-log.json (' + log.length + ' entries)');
