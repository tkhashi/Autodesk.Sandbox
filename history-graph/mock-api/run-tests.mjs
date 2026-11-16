// run-tests.mjs — APS モックサーバー + クライアントコピーの統合テストランナー
// 使い方: node run-tests.mjs   (モックを起動し、ネガティブテスト→クライアント実行→検証→終了)
// 実環境には一切アクセスしない (クライアントは APS_BASE_URL でモックに向けられる)。
import { spawn } from 'node:child_process';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENTS = path.join(here, 'clients');
const PORT = Number(process.env.MOCK_PORT || 4517);
const BASE = `http://localhost:${PORT}`;
const PID_DM = 'b.031a6e68-ccdf-4a29-b8a5-50a2a3ecac25';
const PID_MP = '031a6e68-ccdf-4a29-b8a5-50a2a3ecac25';
const ARCH_LINEAGE = 'urn:adsk.wipprod:dm.lineage:VwJ57NkiQ-Gy0nHLR3UmAA';
const STRUCT_V1 = 'urn:adsk.wipprod:fs.file:vf.ZRF1ijarXRS7X3mi7BYiFg?version=1';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise(s => setTimeout(s, ms));

// ---------- モック起動 ----------
const server = spawn('node', [path.join(here, 'server.mjs')], { env: { ...process.env, MOCK_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
server.stderr.on('data', d => process.stderr.write('[mock] ' + d));
async function waitHealth() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + '/health'); if (r.ok) return; } catch {}
    await sleep(200);
  }
  throw new Error('mock server did not start');
}

// ---------- クライアント実行 ----------
function resetTokens() {
  const seed = JSON.stringify({ access_token: 'seed', refresh_token: 'mock-refresh-seed', obtained_at: 0 }, null, 1);
  fs.writeFileSync(path.join(CLIENTS, '.token.mock.json'), seed);
  fs.writeFileSync(path.join(CLIENTS, '.token.mock2.json'), seed);
}
function runClient(script, extraEnv = {}) {
  return new Promise((resolve) => {
    resetTokens();
    const env = {
      ...process.env,
      APS_BASE_URL: BASE,
      APS_ENV_FILE: path.join(CLIENTS, '.env.mock'),
      APS_TOKEN_FILE: path.join(CLIENTS, '.token.mock.json'),
      APS_TOKEN_FILE2: path.join(CLIENTS, '.token.mock2.json'),
      APS_UPLOAD_FILE: path.join(CLIENTS, 'test-upload.rvt'),
      APS_MODELS_FILE: path.join(CLIENTS, 'models.mock.json'),
      ...extraEnv,
    };
    const p = spawn('node', [path.join(CLIENTS, script)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('close', code => resolve({ code, out }));
  });
}

// ---------- ネガティブテスト ----------
async function getUserToken() {
  const r = await fetch(BASE + '/authentication/v2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'mock-refresh-seed' }),
  });
  return (await r.json()).access_token;
}
async function getAppToken() {
  const r = await fetch(BASE + '/authentication/v2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'data:read' }),
  });
  return (await r.json()).access_token;
}
async function call(method, url, token, body) {
  const r = await fetch(BASE + url, {
    method,
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  await r.text();
  return r.status;
}
async function negativeTests() {
  const T = await getUserToken();
  const APP = await getAppToken();
  const storage = `/data/v1/projects/${PID_DM}/storage`;
  const versions = `/data/v1/projects/${PID_DM}/versions`;
  const goodStorage = { jsonapi: { version: '1.0' }, data: { type: 'objects', attributes: { name: 'x.rvt' }, relationships: { target: { data: { type: 'folders', id: 'urn:adsk.wipprod:fs.folder:co.X' } } } } };

  check('neg: storage missing attributes.name -> 400', (await call('POST', storage, T, { data: { type: 'objects', attributes: {}, relationships: goodStorage.data.relationships } })) === 400);
  check('neg: storage data.type != objects -> 400', (await call('POST', storage, T, { data: { type: 'items', attributes: { name: 'x.rvt' }, relationships: goodStorage.data.relationships } })) === 400);
  check('neg: storage missing relationships.target -> 400', (await call('POST', storage, T, { data: { type: 'objects', attributes: { name: 'x.rvt' } } })) === 400);
  check('neg: version missing relationships.item -> 400', (await call('POST', versions, T, { data: { type: 'versions', attributes: { name: 'x.rvt', extension: { type: 'versions:autodesk.core:File', version: '1.0' } }, relationships: { storage: { data: { type: 'objects', id: 'urn:adsk.objects:os.object:wip.dm.prod/nope.rvt' } } } } })) === 400);
  check('neg: version with unknown storage object -> 400', (await call('POST', versions, T, { data: { type: 'versions', attributes: { name: 'x.rvt', extension: { type: 'versions:autodesk.core:File', version: '1.0' } }, relationships: { item: { data: { type: 'items', id: ARCH_LINEAGE } }, storage: { data: { type: 'objects', id: 'urn:adsk.objects:os.object:wip.dm.prod/nope.rvt' } } } } })) === 400);
  check('neg: version bad extension.type -> 400', (await call('POST', versions, T, { data: { type: 'versions', attributes: { name: 'x.rvt', extension: { type: 'versions:autodesk.core:Item', version: '1.0' } }, relationships: { item: { data: { type: 'items', id: ARCH_LINEAGE } }, storage: { data: { type: 'objects', id: 'urn:adsk.objects:os.object:wip.dm.prod/nope.rvt' } } } } })) === 400);
  check('neg: complete upload missing uploadKey -> 400', (await call('POST', '/oss/v2/buckets/wip.dm.prod/objects/x.rvt/signeds3upload', T, {})) === 400);
  check('neg: complete upload unknown uploadKey -> 404', (await call('POST', '/oss/v2/buckets/wip.dm.prod/objects/x.rvt/signeds3upload', T, { uploadKey: 'no-such-key' })) === 404);
  check('neg: signeds3upload parts=0 -> 400', (await call('GET', '/oss/v2/buckets/wip.dm.prod/objects/x.rvt/signeds3upload?parts=0', T)) === 400);
  check('neg: no Authorization header -> 401', (await call('GET', `/data/v1/projects/${PID_DM}/items/${encodeURIComponent(ARCH_LINEAGE)}/versions`, null)) === 401);
  check('neg: old route POST items/{id}/versions -> 404', (await call('POST', `/data/v1/projects/${PID_DM}/items/${encodeURIComponent(ARCH_LINEAGE)}/versions`, T, {})) === 404);
  check('neg: old route POST items/{id}/storage -> 404', (await call('POST', `/data/v1/projects/${PID_DM}/items/${encodeURIComponent(ARCH_LINEAGE)}/storage`, T, {})) === 404);
  check('neg: old route POST folders/{id}/storage -> 404', (await call('POST', `/data/v1/projects/${PID_DM}/folders/urn%3Aadsk.wipprod%3Afs.folder%3Aco.X/storage`, T, {})) === 404);

  const idxBase = `/construction/index/v2/projects/${PID_MP}`;
  check('neg: MP app-only token -> 403', (await call('POST', `${idxBase}/indexes:batch-status`, APP, { versions: [{ versionUrn: STRUCT_V1 }] })) === 403);
  check('neg: indexes:batch-status empty body -> 400', (await call('POST', `${idxBase}/indexes:batch-status`, T, {})) === 400);
  check('neg: indexes:batch-status entry without versionUrn -> 400', (await call('POST', `${idxBase}/indexes:batch-status`, T, { versions: [{}] })) === 400);
  check('neg: diffs:batch-status missing curVersionUrn -> 400', (await call('POST', `${idxBase}/diffs:batch-status`, T, { diffs: [{ prevVersionUrn: STRUCT_V1 }] })) === 400);
  check('neg: GET indexes collection (undocumented) -> 404', (await call('GET', `${idxBase}/indexes`, T)) === 404);
  // クエリ検証用に index を1つ作る
  const r = await fetch(BASE + `${idxBase}/indexes:batch-status`, { method: 'POST', headers: { Authorization: 'Bearer ' + T, 'Content-Type': 'application/json' }, body: JSON.stringify({ versions: [{ versionUrn: STRUCT_V1 }] }) });
  const indexId = (await r.json()).indexes[0].indexId;
  check('neg: query create without query -> 400', (await call('POST', `${idxBase}/indexes/${indexId}/queries`, T, {})) === 400);
  check('neg: query create unsupported operator -> 400', (await call('POST', `${idxBase}/indexes/${indexId}/queries`, T, { query: { $foo: ['s.SVF2Id', 1] } })) === 400);
}

// ---------- メイン ----------
await waitHealth();
console.log('mock server up:', BASE);
await negativeTests();

// テスト用アップロードファイル (12MB -> 10MB チャンク x2)
{
  const p = path.join(CLIENTS, 'test-upload.rvt');
  if (!fs.existsSync(p)) fs.writeFileSync(p, Buffer.alloc(12 * 1024 * 1024, 7));
}

// 1) upload クライアント: 元ルート (items) では定義どおり失敗すること
{
  const { code, out } = await runClient('upload-v2-official.mjs', { APS_VERSION_ROUTE: 'items' });
  check('client upload (original items route) fails at version creation', code !== 0 && /create version failed/.test(out), `exit=${code}`);
}
// 2) upload クライアント: 公式ルート (projects/versions) で全フロー成功
{
  const { code, out } = await runClient('upload-v2-official.mjs', { APS_VERSION_ROUTE: 'projects' });
  let v2 = null;
  try { v2 = JSON.parse(fs.readFileSync(path.join(CLIENTS, 'upload-v2-official-result.json'), 'utf8')); } catch {}
  check('client upload (documented projects route) succeeds', code === 0 && !!v2?.v2Urn?.endsWith('?version=2'), `exit=${code} v2Urn=${v2?.v2Urn ?? ''}`);
}
// 3) diff 実測クライアント: index x2 -> diff -> stats/明細パース
{
  const { code } = await runClient('diff-measure-v2.mjs');
  let res = null;
  try { res = JSON.parse(fs.readFileSync(path.join(CLIENTS, 'v2-diff-result.json'), 'utf8')); } catch {}
  const rows = (f) => { try { return fs.readFileSync(path.join(CLIENTS, 'diff-rows', f), 'utf8').split('\n').filter(Boolean).length; } catch { return -1; } };
  check('client diff-measure succeeds', code === 0, `exit=${code}`);
  check('diff stats = added 1 / removed 1 / modified 3', res?.diffStats?.added === 1 && res?.diffStats?.removed === 1 && res?.diffStats?.modified === 3, JSON.stringify(res?.diffStats ?? null));
  check('diff rows: added=1 removed=1 changed=3', rows('diff-added.ndjson') === 1 && rows('diff-removed.ndjson') === 1 && rows('diff-changed.ndjson') === 3,
    `added=${rows('diff-added.ndjson')} removed=${rows('diff-removed.ndjson')} changed=${rows('diff-changed.ndjson')}`);
}
// 4) probe クライアント: index クエリ + diff (V1 vs V1) + ネガティブ系の再現
{
  const { code } = await runClient('probe-model-properties.mjs');
  let log = [];
  try { log = JSON.parse(fs.readFileSync(path.join(CLIENTS, 'probe-model-properties-log.json'), 'utf8')); } catch {}
  const find = (step) => log.filter(e => e.step === step);
  check('client probe succeeds', code === 0, `exit=${code}`);
  check('probe: index reaches FINISHED', find('index-poll').some(e => /state=FINISHED/.test(e.note ?? '')), '');
  check('probe: index query returns 50 rows ($between SVF2Id 1..50)', find('query-properties').some(e => /rows=50/.test(e.note ?? '')), find('query-properties')[0]?.note ?? 'no entry');
  check('probe: 2-legged batch-status -> 403 (matches real API)', find('index-batch-status-2legged').some(e => e.status === 403), '');
  check('probe: undocumented GET indexes -> 404 (matches real API)', find('index-collection-get').some(e => e.status === 404), '');
  check('probe: V1-vs-V1 diff FINISHED with 0/0/0', find('diff-poll').some(e => /state=FINISHED/.test(e.note ?? '') && /"added":0,"removed":0,"modified":0/.test(e.note ?? '')), find('diff-poll').at(-1)?.note ?? 'no entry');
}

// 5) V2->V3(実質) diff: 実測統計 51/33/374 + 代表行 (部屋名変更・壁移動)
{
  const T = await getUserToken();
  const H = { Authorization: 'Bearer ' + T, 'Content-Type': 'application/json' };
  const mp = `/construction/index/v2/projects/${PID_MP}`;
  const archUrn = (v) => `urn:adsk.wipprod:fs.file:vf.VwJ57NkiQ-Gy0nHLR3UmAA?version=${v}`;
  // V3 を登録 (storage -> 署名付きアップロード -> バージョン作成)
  const stRes = await fetch(BASE + `/data/v1/projects/${PID_DM}/storage`, { method: 'POST', headers: H, body: JSON.stringify({ jsonapi: { version: '1.0' }, data: { type: 'objects', attributes: { name: 'Snowdon Towers Sample Architectural_v3.rvt' }, relationships: { target: { data: { type: 'folders', id: 'urn:adsk.wipprod:fs.folder:co.X' } } } } }) });
  const objectId = (await stRes.json()).data.id;
  const objectKey = objectId.split('/').pop();
  const sign = await (await fetch(BASE + `/oss/v2/buckets/wip.dm.prod/objects/${objectKey}/signeds3upload?parts=1`, { headers: H })).json();
  const partBuf = Buffer.alloc(1024, 3);
  const putRes = await fetch(sign.urls[0], { method: 'PUT', body: partBuf });
  await fetch(BASE + `/oss/v2/buckets/wip.dm.prod/objects/${objectKey}/signeds3upload`, { method: 'POST', headers: H, body: JSON.stringify({ uploadKey: sign.uploadKey, size: partBuf.length, eTags: [putRes.headers.get('etag')] }) });
  const verRes = await fetch(BASE + `/data/v1/projects/${PID_DM}/versions`, { method: 'POST', headers: H, body: JSON.stringify({ jsonapi: { version: '1.0' }, data: { type: 'versions', attributes: { name: 'Snowdon Towers Sample Architectural.rvt', extension: { type: 'versions:autodesk.core:File', version: '1.0' } }, relationships: { item: { data: { type: 'items', id: ARCH_LINEAGE } }, storage: { data: { type: 'objects', id: objectId } } } } }) });
  const verJson = await verRes.json();
  check('v3 registration succeeds (?version=3)', verRes.status === 201 && (verJson?.data?.id ?? '').endsWith('?version=3'), `status=${verRes.status} id=${verJson?.data?.id ?? ''}`);
  // index V2 / V3
  async function makeIndex(urn) {
    const r = await fetch(BASE + mp + '/indexes:batch-status', { method: 'POST', headers: H, body: JSON.stringify({ versions: [{ versionUrn: urn }] }) });
    const id = (await r.json()).indexes[0].indexId;
    for (let i = 0; i < 6; i++) { const g = await (await fetch(BASE + `${mp}/indexes/${id}`, { headers: H })).json(); if (g.state === 'FINISHED') break; }
    return id;
  }
  await makeIndex(archUrn(2));
  await makeIndex(archUrn(3));
  // diff V2->V3
  const dRes = await fetch(BASE + mp + '/diffs:batch-status', { method: 'POST', headers: H, body: JSON.stringify({ diffs: [{ prevVersionUrn: archUrn(2), curVersionUrn: archUrn(3) }] }) });
  const diffId = (await dRes.json()).diffs[0].diffId;
  let dStats = null;
  for (let i = 0; i < 6; i++) { const g = await (await fetch(BASE + `${mp}/diffs/${diffId}`, { headers: H })).json(); if (g.state === 'FINISHED') { dStats = g.stats; break; } }
  check('diff V2->V3 stats = added 51 / removed 33 / modified 374 (実測)', dStats?.added === 51 && dStats?.removed === 33 && dStats?.modified === 374, JSON.stringify(dStats));
  async function diffQuery(query) {
    const r = await fetch(BASE + `${mp}/diffs/${diffId}/queries`, { method: 'POST', headers: H, body: JSON.stringify({ query }) });
    const qid = (await r.json()).queryId;
    for (let i = 0; i < 4; i++) await fetch(BASE + `${mp}/diffs/${diffId}/queries/${qid}`, { headers: H });
    const pr = await fetch(BASE + `${mp}/diffs/${diffId}/queries/${qid}/properties`, { headers: H });
    const buf = Buffer.from(await pr.arrayBuffer());
    return zlib.gunzipSync(buf).toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  }
  const changedRows = await diffQuery({ $eq: ['s.changeType', 'OBJECT_CHANGED'] });
  check('diff V2->V3 changed rows = 374', changedRows.length === 374, `rows=${changedRows.length}`);
  const roomRows = await diffQuery({ $eq: ['s.name', "'Main Unit'"] });
  check('diff V2->V3 room rename representative row (Studio Unit -> Main Unit)', roomRows.length === 1 && roomRows[0].svf2Id === 450, `rows=${roomRows.length}`);
  const wallRows = await diffQuery({ $eq: ['s.name', "'標準壁 [748873]'"] });
  check('diff V2->V3 wall move representative row [748873] Position X 500 -> 500.14', wallRows.length === 1 && Math.abs((wallRows[0].props['p3aa77b10'] ?? 0) - 500.14) < 1e-9, `rows=${wallRows.length} posx=${wallRows[0]?.props?.['p3aa77b10']}`);
}

server.kill();
const failed = results.filter(r => !r.ok);
fs.writeFileSync(path.join(here, 'test-results.json'), JSON.stringify({ at: new Date().toISOString(), base: BASE, results }, null, 1));
console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`);
process.exit(failed.length ? 1 : 0);
