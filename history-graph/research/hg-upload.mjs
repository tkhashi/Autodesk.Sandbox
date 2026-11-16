// hg-upload.mjs — HG アイテム用アップロード汎用スクリプト。
// 使い方:
//   新規アイテム作成: node hg-upload.mjs --file <rvt> --name <表示名.rvt> --lineage NEW --label <label>
//   既存アイテムへ版追加: node hg-upload.mjs --file <rvt> --name <表示名.rvt> --lineage <lineageId> --label <label> --expect <既存版数>
// 注意: 並行実行中の測定スクリプトと refresh_token ローテーションが競合しないよう、
// このスクリプトはトークンをリフレッシュしない（既存 access_token を使う。古ければ中止）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const DEMO_DIR = path.join(root, 'demo-issues-3d', 'app');
const BASE = 'https://developer.api.autodesk.com';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const FILE = args.file, ITEM_NAME = args.name, LABEL = args.label ?? 'hg';
const LINEAGE_IN = args.lineage ?? 'NEW';
const EXPECTED = parseInt(args.expect ?? '0', 10);
const PROJECT_ID = 'b.031a6e68-ccdf-4a29-b8a5-50a2a3ecac25';
const PARENT_FOLDER = 'urn:adsk.wipprod:fs.folder:co.dBk0Ywl2VmeUMBxMN-elAA';
if (!FILE || !fs.existsSync(FILE)) { console.error('file not found:', FILE); process.exit(1); }
if (!ITEM_NAME) { console.error('--name required'); process.exit(1); }

const tok = JSON.parse(fs.readFileSync(path.join(DEMO_DIR, '.token.json'), 'utf8'));
const ageMin = (Date.now() - (tok.obtained_at ?? 0)) / 60000;
console.log('token age (min):', ageMin.toFixed(1));
if (ageMin > 50) { console.error('ABORT: token too old; do not refresh while measurement runs'); process.exit(1); }
const T3 = tok.access_token;

const log = [];
function rec(step, method, url, status, note, body) {
  const e = { step, method, url, status, note };
  if (body !== undefined) e.body = body;
  log.push(e);
  console.log(`[${step}] ${method} ${url.replace(BASE, '')} -> ${status}${note ? ' | ' + note : ''}`);
  if (body !== undefined) console.log('   body:', JSON.stringify(body).slice(0, 1000));
}
const trim = (t) => { try { return JSON.parse(t); } catch { return t.slice(0, 500); } };
function saveLog() { fs.writeFileSync(path.join(here, `hg-upload-${LABEL}-log.json`), JSON.stringify(log, null, 1)); }

async function call(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + T3, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, json: trim(text) };
}

const fileSize = fs.statSync(FILE).size;
console.log('local file:', FILE, 'size:', fileSize, '| item name:', ITEM_NAME, '| lineage:', LINEAGE_IN);

// 既存アイテムの場合は版数チェック
if (LINEAGE_IN !== 'NEW') {
  const lineage = `urn:adsk.wipprod:dm.lineage:${LINEAGE_IN}`;
  const { status, json } = await call('GET', `${BASE}/data/v1/projects/${PROJECT_ID}/items/${encodeURIComponent(lineage)}/versions`);
  const vers = json?.data ?? [];
  rec('dm-versions-before', 'GET', '/items/{lineage}/versions', status, `versions=${vers.length}; numbers=${vers.map(v => v.attributes?.versionNumber).join(',')}`);
  if (status !== 200) { saveLog(); throw new Error('versions fetch failed'); }
  if (EXPECTED && vers.length !== EXPECTED) { saveLog(); throw new Error(`ABORT: expected ${EXPECTED} versions, found ${vers.length}`); }
}

// 1) storage 作成
let objectId;
{
  const { status, json } = await call('POST', `${BASE}/data/v1/projects/${PROJECT_ID}/storage`, {
    jsonapi: { version: '1.0' },
    data: {
      type: 'objects',
      attributes: { name: ITEM_NAME },
      relationships: { target: { data: { type: 'folders', id: PARENT_FOLDER } } },
    },
  });
  rec('dm-create-storage', 'POST', '/projects/{pid}/storage', status, json?.data?.id ? `objectId=${json.data.id}` : 'no object id', status >= 300 ? json : undefined);
  if (status !== 201 && status !== 200) { saveLog(); throw new Error('create storage failed'); }
  objectId = json.data.id;
}
const mObj = objectId.match(/^urn:adsk\.objects:os\.object:([^/]+)\/(.+)$/);
const [, bucketKey, objectKey] = mObj;

// 2) 署名付き S3 URL + チャンク PUT + 完了
const CHUNK = 10 * 1024 * 1024;
const parts = Math.ceil(fileSize / CHUNK);
let uploadKey, urls;
{
  const { status, json } = await call('GET', `${BASE}/oss/v2/buckets/${bucketKey}/objects/${encodeURIComponent(objectKey)}/signeds3upload?parts=${parts}`);
  rec('oss-signeds3upload-get', 'GET', '/signeds3upload', status, json?.uploadKey ? `urls=${json.urls?.length}` : 'no uploadKey', status >= 300 ? json : undefined);
  if (status !== 200) { saveLog(); throw new Error('signeds3upload GET failed'); }
  uploadKey = json.uploadKey; urls = json.urls;
}
{
  const fd = fs.openSync(FILE, 'r');
  const buf = Buffer.alloc(CHUNK);
  for (let i = 0; i < parts; i++) {
    const start = i * CHUNK;
    const len = Math.min(CHUNK, fileSize - start);
    fs.readSync(fd, buf, 0, len, start);
    const r = await fetch(urls[i], { method: 'PUT', body: buf.subarray(0, len) });
    rec('oss-part-put', 'PUT', `part ${i + 1}/${parts}`, r.status, `bytes=${len}`);
    if (r.status !== 200) { fs.closeSync(fd); saveLog(); throw new Error(`part ${i + 1} PUT failed`); }
  }
  fs.closeSync(fd);
}
{
  const { status, json } = await call('POST', `${BASE}/oss/v2/buckets/${bucketKey}/objects/${encodeURIComponent(objectKey)}/signeds3upload`, { uploadKey });
  rec('oss-complete', 'POST', '/signeds3upload', status, json?.objectId ? `size=${json.size}` : '', status >= 300 ? json : undefined);
  if (status !== 200) { saveLog(); throw new Error('complete failed'); }
  if (json?.size !== undefined && json.size !== fileSize) { saveLog(); throw new Error(`size mismatch local=${fileSize} oss=${json.size}`); }
}

// 3) アイテム作成 or 版追加
let result;
if (LINEAGE_IN === 'NEW') {
  const { status, json } = await call('POST', `${BASE}/data/v1/projects/${PROJECT_ID}/items`, {
    jsonapi: { version: '1.0' },
    data: {
      type: 'items',
      attributes: {
        displayName: ITEM_NAME,
        extension: { type: 'items:autodesk.bim360:File', version: '1.0' },
      },
      relationships: {
        tip: { data: { type: 'versions', id: '1' } },
        parent: { data: { type: 'folders', id: PARENT_FOLDER } },
      },
    },
    included: [{
      type: 'versions',
      id: '1',
      attributes: {
        name: ITEM_NAME,
        extension: { type: 'versions:autodesk.bim360:File', version: '1.0' },
      },
      relationships: { storage: { data: { type: 'objects', id: objectId } } },
    }],
  });
  rec('dm-create-item', 'POST', '/projects/{pid}/items', status,
    json?.data?.id ? `lineage=${json.data.id} tip=${json.data.relationships?.tip?.data?.id}` : 'no item id',
    status >= 300 ? json : undefined);
  if (status !== 201 && status !== 200) { saveLog(); throw new Error('create item failed'); }
  result = { label: LABEL, mode: 'create-item', itemName: ITEM_NAME, lineage: json.data.id, lineageId: json.data.id.replace('urn:adsk.wipprod:dm.lineage:', ''), tipVersionUrn: json.data.relationships?.tip?.data?.id, objectId };
} else {
  const lineage = `urn:adsk.wipprod:dm.lineage:${LINEAGE_IN}`;
  const { status, json } = await call('POST', `${BASE}/data/v1/projects/${PROJECT_ID}/versions`, {
    jsonapi: { version: '1.0' },
    data: {
      type: 'versions',
      attributes: {
        name: ITEM_NAME,
        extension: { type: 'versions:autodesk.bim360:File', version: '1.0' },
      },
      relationships: {
        item: { data: { type: 'items', id: lineage } },
        storage: { data: { type: 'objects', id: objectId } },
      },
    },
  });
  rec('dm-create-version', 'POST', '/projects/{pid}/versions', status,
    json?.data?.id ? `versionUrn=${json.data.id} versionNumber=${json.data.attributes?.versionNumber}` : 'no version id',
    status >= 300 ? json : undefined);
  if (status !== 201 && status !== 200) { saveLog(); throw new Error('create version failed'); }
  result = { label: LABEL, mode: 'add-version', itemName: ITEM_NAME, lineage, lineageId: LINEAGE_IN, newUrn: json.data.id, newNumber: json.data.attributes?.versionNumber, objectId };
}

saveLog();
console.log('\nRESULT:', JSON.stringify(result, null, 1));
fs.writeFileSync(path.join(here, `hg-upload-${LABEL}-result.json`), JSON.stringify(result, null, 1));
