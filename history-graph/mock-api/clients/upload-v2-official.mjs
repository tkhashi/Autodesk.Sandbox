// upload-v2-official.mjs — [MOCK TEST COPY] 元: research/upload-v2-official.mjs
// モック用改変点 (詳細は ../README.md):
//  (a) BASE / .env / .token.json / アップロード対象ファイルを環境変数で差し替え可能にした
//      (APS_BASE_URL, APS_ENV_FILE, APS_TOKEN_FILE, APS_TOKEN_FILE2, APS_UPLOAD_FILE)。
//      実環境の .env / .token.json には一切触らない。
//  (b) バージョン作成ルートを公式定義どおり POST /data/v1/projects/{pid}/versions に修正した
//      (元は POST /items/{lineage}/versions — 公式チュートリアル Step 8 の定義と異なる)。
//      APS_VERSION_ROUTE=items を指定すると元のルートで実行し、不整合を再現できる。
// フロー: versions確認 → storage作成(projects) → OSS signed S3 upload → 完了 → バージョン作成
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const DEMO_DIR = path.join(root, 'demo-issues-3d', 'app');
const SAMPLE_A_DIR = path.join(root, 'sample-a-http-client');
const BASE = process.env.APS_BASE_URL || 'https://developer.api.autodesk.com';
const TOKEN_FILE = process.env.APS_TOKEN_FILE || path.join(DEMO_DIR, '.token.json');
const TOKEN_FILE2 = process.env.APS_TOKEN_FILE2 || path.join(SAMPLE_A_DIR, '.token.json');

const FILE = process.env.APS_UPLOAD_FILE || path.join(root, 'test-models', 'user-v2', 'src', 'Snowdon Towers Sample Architectural_v2.rvt');
const ITEM_NAME = 'Snowdon Towers Sample Architectural.rvt';
const PROJECT_ID = 'b.031a6e68-ccdf-4a29-b8a5-50a2a3ecac25';
const LINEAGE = 'urn:adsk.wipprod:dm.lineage:VwJ57NkiQ-Gy0nHLR3UmAA';
const PARENT_FOLDER = 'urn:adsk.wipprod:fs.folder:co.dBk0Ywl2VmeUMBxMN-elAA';

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
  if (body !== undefined) console.log('   body:', JSON.stringify(body).slice(0, 1000));
}
const trim = (t) => { try { return JSON.parse(t); } catch { return t.slice(0, 500); } };
function saveLog() { fs.writeFileSync(path.join(here, 'upload-v2-official-log.json'), JSON.stringify(log, null, 1)); }

// ---------- トークン ----------
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
if (Date.now() - (tok3.obtained_at ?? 0) > 45 * 60000) await refresh3();
else rec('token-refresh', '-', '-', 0, 'existing token still fresh');
const T3 = tok3.access_token;

async function call(method, url, body, extraHeaders = {}) {
  const r = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + T3, ...(body ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, json: trim(text), raw: text, headers: r.headers };
}

// ---------- 0) 現在のバージョン確認（V1 のみであること） ----------
const fileSize = fs.statSync(FILE).size;
console.log('local file size:', fileSize);
let v1Urn;
{
  const url = `${BASE}/data/v1/projects/${PROJECT_ID}/items/${encodeURIComponent(LINEAGE)}/versions`;
  const { status, json } = await call('GET', url);
  const vers = json?.data ?? [];
  rec('dm-versions-before', 'GET', '/data/v1/projects/{pid}/items/{arch lineage}/versions', status,
    `versions=${vers.length}; numbers=${vers.map(v => v.attributes?.versionNumber).join(',')}; tipName=${vers[0]?.attributes?.name ?? ''}`);
  if (status !== 200) { saveLog(); throw new Error('versions fetch failed'); }
  if (vers.length !== 1) { saveLog(); throw new Error(`ABORT: expected exactly 1 existing version, found ${vers.length}`); }
  v1Urn = vers[0].id;
}
console.log('V1 urn:', v1Urn);

// ---------- 1) storage 作成（正規ルート: POST /projects/{pid}/storage, target=フォルダ） ----------
let objectId;
{
  const url = `${BASE}/data/v1/projects/${PROJECT_ID}/storage`;
  const body = {
    jsonapi: { version: '1.0' },
    data: {
      type: 'objects',
      attributes: { name: ITEM_NAME },
      relationships: { target: { data: { type: 'folders', id: PARENT_FOLDER } } },
    },
  };
  const { status, json } = await call('POST', url, body);
  rec('dm-create-storage-official', 'POST', '/data/v1/projects/{pid}/storage', status,
    json?.data?.id ? `objectId=${json.data.id}` : 'no object id', status >= 300 ? json : undefined);
  if (status !== 201 && status !== 200) { saveLog(); throw new Error('create storage (official route) failed'); }
  objectId = json.data.id;
}
const mObj = objectId.match(/^urn:adsk\.objects:os\.object:([^/]+)\/(.+)$/);
if (!mObj) { saveLog(); throw new Error('unexpected objectId format: ' + objectId); }
const [, bucketKey, objectKey] = mObj;
console.log('bucketKey:', bucketKey, 'objectKey:', objectKey);

// ---------- 2) 署名付き S3 アップロード URL 取得 ----------
const CHUNK = 10 * 1024 * 1024;
const parts = Math.ceil(fileSize / CHUNK);
let uploadKey, urls;
{
  const url = `${BASE}/oss/v2/buckets/${bucketKey}/objects/${encodeURIComponent(objectKey)}/signeds3upload?parts=${parts}`;
  const { status, json } = await call('GET', url);
  rec('oss-signeds3upload-get', 'GET', `/oss/v2/buckets/{bucket}/objects/{key}/signeds3upload?parts=${parts}`, status,
    json?.uploadKey ? `urls=${json.urls?.length}` : 'no uploadKey', status >= 300 ? json : undefined);
  if (status !== 200) { saveLog(); throw new Error('signeds3upload GET failed'); }
  uploadKey = json.uploadKey; urls = json.urls;
}

// ---------- 3) チャンク PUT ----------
{
  const fd = fs.openSync(FILE, 'r');
  const buf = Buffer.alloc(CHUNK);
  for (let i = 0; i < parts; i++) {
    const start = i * CHUNK;
    const len = Math.min(CHUNK, fileSize - start);
    fs.readSync(fd, buf, 0, len, start);
    const r = await fetch(urls[i], { method: 'PUT', body: buf.subarray(0, len) });
    rec('oss-part-put', 'PUT', `signed-url part ${i + 1}/${parts}`, r.status, `bytes=${len} etag=${r.headers.get('etag') ?? ''}`);
    if (r.status !== 200) { fs.closeSync(fd); saveLog(); throw new Error(`part ${i + 1} PUT failed`); }
  }
  fs.closeSync(fd);
}

// ---------- 4) アップロード完了 ----------
{
  const url = `${BASE}/oss/v2/buckets/${bucketKey}/objects/${encodeURIComponent(objectKey)}/signeds3upload`;
  const { status, json } = await call('POST', url, { uploadKey });
  rec('oss-signeds3upload-complete', 'POST', `/oss/v2/buckets/{bucket}/objects/{key}/signeds3upload`, status,
    json?.objectId ? `objectId=${json.objectId} size=${json.size}` : '', status >= 300 ? json : undefined);
  if (status !== 200) { saveLog(); throw new Error('complete upload failed'); }
}

// ---------- 5) バージョン作成 ----------
// 公式定義 (Upload a File チュートリアル Step 8): POST /data/v1/projects/{pid}/versions
//   body は relationships.item (対象アイテム) + relationships.storage (アップロード済み storage) を持つ。
// 元スクリプトは POST /items/{lineage}/versions を使っていた（定義に無いルート）。
// APS_VERSION_ROUTE=items で元のルートを再現できる（モックは定義どおり 404 を返す）。
let v2Urn;
{
  const route = process.env.APS_VERSION_ROUTE || 'projects';
  const isItems = route === 'items';
  const url = isItems
    ? `${BASE}/data/v1/projects/${PROJECT_ID}/items/${encodeURIComponent(LINEAGE)}/versions`
    : `${BASE}/data/v1/projects/${PROJECT_ID}/versions`;
  const body = {
    jsonapi: { version: '1.0' },
    data: {
      type: 'versions',
      attributes: {
        name: ITEM_NAME,
        extension: { type: 'versions:autodesk.core:File', version: '1.0' },
      },
      relationships: isItems
        ? { storage: { data: { type: 'objects', id: objectId } } }
        : {
            item: { data: { type: 'items', id: LINEAGE } },
            storage: { data: { type: 'objects', id: objectId } },
          },
    },
  };
  const { status, json } = await call('POST', url, body);
  rec('dm-create-version', 'POST', isItems ? '/data/v1/projects/{pid}/items/{arch lineage}/versions' : '/data/v1/projects/{pid}/versions', status,
    json?.data?.id ? `versionUrn=${json.data.id} versionNumber=${json.data.attributes?.versionNumber} status=${json.data.attributes?.status}` : 'no version id',
    status >= 300 ? json : undefined);
  if (status !== 201 && status !== 200) { saveLog(); throw new Error('create version failed'); }
  v2Urn = json.data.id;
}

saveLog();
console.log('\nRESULT:', JSON.stringify({ v1Urn, v2Urn, objectId }, null, 1));
fs.writeFileSync(path.join(here, 'upload-v2-official-result.json'), JSON.stringify({ v1Urn, v2Urn, objectId }, null, 1));
