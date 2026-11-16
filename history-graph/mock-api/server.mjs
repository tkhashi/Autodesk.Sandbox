// server.mjs — APS API モックサーバー（公式定義準拠・検証厳しめ）
// 対象: Data Management (storage / versions / OSS signed S3 upload) + Model Properties (index / diff / queries)
// 依存なし (node:http のみ)。状態はインメモリ（再起動でリセット）。
//
// 公式定義の出典は README.md を参照。レスポンス形状は公式チュートリアル/リファレンスと
// 実API実測ログ (research/probe-model-properties-log.json, v2-diff-log.json) に合わせている。
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const PORT = Number(process.env.MOCK_PORT || 4517);
const POLLS_TO_FINISH = Number(process.env.MOCK_JOB_POLLS || 2);
const BUCKET = 'wip.dm.prod';

// ---------- フィールド辞書 (Model Properties) ----------
const F_NAME = 'p153cb174';     // __name__ / name (String)
const F_PARENT = 'p93e93af5';   // __parent__ / parent (DbKey)
const F_COMMENTS = 'p2f4a91c0'; // Identity Data / Comments (String)
const F_POSX = 'p3aa77b10';     // Geometry / Position X (Double)
const FIELDS = [
  { key: F_NAME, category: '__name__', type: 'String', name: 'name', uom: null },
  { key: F_PARENT, category: '__parent__', type: 'DbKey', name: 'parent', uom: null },
  { key: F_COMMENTS, category: 'Identity Data', type: 'String', name: 'Comments', uom: null },
  { key: F_POSX, category: 'Geometry', type: 'Double', name: 'Position X', uom: null },
];

// ---------- データセット ----------
// 建築モデル (lineage suffix VwJ57NkiQ-Gy0nHLR3UmAA) の V1/V2/V3 だけ意図的な差分を持つ。
// それ以外のモデル/バージョンは同一のベースデータ (diff = 0/0/0)。
const ARCH_SUFFIX = 'VwJ57NkiQ-Gy0nHLR3UmAA';
const F_REVMARK = 'p5eed0001'; // 蒸留用マーカー: V3 で一括して値が変わる要素群の再現に使う
function datasetFor(lineageSuffix, version) {
  const objs = new Map();
  const isArch = lineageSuffix === ARCH_SUFFIX;
  const baseCount = isArch ? 500 : 60;
  for (let id = 1; id <= baseCount; id++) {
    objs.set(id, { [F_NAME]: `Element ${id}`, [F_PARENT]: 0 });
  }
  if (isArch) {
    // ドア (id=30): V2 で Comments に "diff-test"
    objs.get(30)[F_COMMENTS] = version >= 2 ? 'diff-test' : '';
    // 外灯 bollard (id=40,41): V2 で Position X が移動
    objs.get(40)[F_POSX] = version >= 2 ? 150 : 100;
    objs.get(41)[F_POSX] = version >= 2 ? 260 : 200;
    if (version === 1) objs.set(600, { [F_NAME]: 'Pergola Modern', [F_PARENT]: 0 }); // V2 で削除 (ベース範囲 1..500 の外)
    if (version >= 2) objs.set(601, { [F_NAME]: 'Switchgrass', [F_PARENT]: 0 });     // V2 で追加
    // ---- V2→V3(実質) の実測差分 (research/v2-diff-measurement.md §7、実測統計 added 51 / removed 33 / modified 374) ----
    // removed 33: V1/V2 にのみ存在するセッション/システム系要素 (実測 removed の大半がこの系統だったことの蒸留)
    if (version <= 2) for (let id = 3001; id <= 3033; id++) objs.set(id, { [F_NAME]: `Session Element ${id}`, [F_PARENT]: 0 });
    // added 51: V3 でのみ現れるビュー/セッション系要素 (実測 added の大半がこの系統だったことの蒸留)
    if (version >= 3) for (let id = 2001; id <= 2051; id++) objs.set(id, { [F_NAME]: `View Element ${id}`, [F_PARENT]: 0 });
    // modified 374 のうち 372 件: V3 で値が変わる要素群 (実測では Revit バージョン差の残差を含む)
    if (version >= 3) for (let id = 1; id <= 372; id++) objs.get(id)[F_REVMARK] = 1;
    // modified 代表行1: 部屋名 Studio Unit -> Main Unit (実測ではプロパティ値が変わった行が 40 件)
    objs.set(450, { [F_NAME]: version >= 3 ? 'Main Unit' : 'Studio Unit', [F_PARENT]: 0 });
    // modified 代表行2: 標準壁 [748873] の移動 (実測 bbox 純平行移動 (+0.14, +0.068, 0) ft ≈ 47mm、X 成分を Position X に反映)
    objs.set(451, { [F_NAME]: '標準壁 [748873]', [F_PARENT]: 0, [F_POSX]: version >= 3 ? 500.14 : 500 });
  }
  return objs;
}
function computeDiff(prev, cur) {
  const added = [], removed = [], changed = [];
  for (const [id, props] of cur) {
    if (!prev.has(id)) added.push(id);
    else if (JSON.stringify(prev.get(id)) !== JSON.stringify(props)) changed.push(id);
  }
  for (const id of prev.keys()) if (!cur.has(id)) removed.push(id);
  return { added, removed, changed };
}
function rowFor(svf2Id, props, changeType) {
  const row = {
    svf2Id, otgId: svf2Id, externalId: `mock-ext-${svf2Id}`, lmvId: svf2Id,
    lineageId: 'mocklineage', databaseId: 'mockdb',
    props, propsHash: crypto.createHash('md5').update(JSON.stringify(props)).digest('hex').slice(0, 7),
    views: [], location: { X: 0, Y: 0, Z: 0 }, scale: { X: 1, Y: 1, Z: 1 }, rotation: { X: 0, Y: 0, Z: 0 },
  };
  if (changeType) row.type = changeType;
  return row;
}

// ---------- 状態 ----------
const tokens = new Map();   // token -> 'user' | 'app'
const items = new Map();    // lineage -> { name, versions: [{urn, versionNumber, objectId, size}] }
const storages = new Map(); // objectId -> { objectKey, name, folderId, completed, size }
const uploads = new Map();  // uploadKey -> { objectKey, partsExpected, parts: Map<num,{size,etag}> }
const indexes = new Map();  // indexId -> job
const diffs = new Map();    // diffId -> job
const queries = new Map();  // queryId -> job

const fileUrnBase = (lineage) => 'urn:adsk.wipprod:fs.file:vf.' + lineage.split(':').pop();
function getItem(lineage) {
  if (!items.has(lineage)) {
    const name = lineage.endsWith(ARCH_SUFFIX) ? 'Snowdon Towers Sample Architectural.rvt' : 'model.rvt';
    items.set(lineage, { name, versions: [{ urn: `${fileUrnBase(lineage)}?version=1`, versionNumber: 1, objectId: null, size: 0 }] });
  }
  return items.get(lineage);
}
function parseVersionUrn(urn) {
  const m = /^urn:adsk\.wipprod:fs\.file:vf\.([^?]+)\?version=(\d+)$/.exec(urn ?? '');
  return m ? { suffix: m[1], version: Number(m[2]) } : null;
}
function versionRegistered(urn) {
  const p = parseVersionUrn(urn);
  if (!p) return false;
  for (const [lineage, item] of items) {
    if (lineage.endsWith(p.suffix)) return item.versions.some(v => v.versionNumber === p.version);
  }
  return p.version === 1; // 未知の lineage は V1 のみ存在する世界として扱う
}
const shortId = (seed) => crypto.createHash('sha256').update(seed).digest('base64url').slice(0, 22);

// ---------- HTTP ユーティリティ ----------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}
function sendGzNdjson(res, lines) {
  const text = lines.map(l => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : '');
  const gz = zlib.gzipSync(Buffer.from(text, 'utf8'));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(gz);
}
const dmError = (res, status, msg) => sendJson(res, status, {
  developerMessage: msg,
  moreInfo: 'https://aps.autodesk.com/en/docs/oauth/v2/developers_guide/error_handling/',
  errorCode: '',
});
const notFound = (res) => dmError(res, 404, 'The requested resource does not exist.');
const badRequest = (res, msg) => dmError(res, 400, msg);
const mpBadRequest = (res, msg) => sendJson(res, 400, { detail: msg, title: 'Bad Request', type: 'BadRequest' });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req, res, mp = false) {
  const raw = await readBody(req);
  try { return JSON.parse(raw.toString('utf8')); }
  catch { (mp ? mpBadRequest : badRequest)(res, 'Request body is not valid JSON.'); return undefined; }
}
function auth(req, res, { userContext = false } = {}) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  if (!m || !tokens.has(m[1])) { dmError(res, 401, 'Authentication required: provide a valid Bearer token issued by this mock.'); return false; }
  if (userContext && tokens.get(m[1]) !== 'user') {
    sendJson(res, 403, {
      detail: 'User is not authorized to access this resource with an explicit deny in an identity-based policy',
      title: 'The caller does not have permission to execute the request.',
      type: 'Unauthorized',
    });
    return false;
  }
  return true;
}
const origin = (req) => `http://${req.headers.host}`;

// ---------- 認証 (モックトークン発行) ----------
async function handleToken(req, res) {
  const raw = (await readBody(req)).toString('utf8');
  const params = new URLSearchParams(raw);
  const grant = params.get('grant_type');
  if (!grant) return badRequest(res, 'grant_type is required.');
  if (grant === 'refresh_token') {
    if (!params.get('refresh_token')) return badRequest(res, 'refresh_token is required for grant_type=refresh_token.');
    const t = 'mock-user-' + crypto.randomBytes(12).toString('base64url');
    tokens.set(t, 'user');
    return sendJson(res, 200, { access_token: t, token_type: 'Bearer', expires_in: 3599, refresh_token: 'mock-refresh-' + crypto.randomBytes(8).toString('base64url') });
  }
  if (grant === 'client_credentials') {
    if (!params.get('scope')) return badRequest(res, 'scope is required for grant_type=client_credentials.');
    const t = 'mock-app-' + crypto.randomBytes(12).toString('base64url');
    tokens.set(t, 'app');
    return sendJson(res, 200, { access_token: t, token_type: 'Bearer', expires_in: 3599 });
  }
  return badRequest(res, `Unsupported grant_type: ${grant}`);
}

// ---------- Data Management ----------
function versionJson(item, lineage, v) {
  return {
    type: 'versions', id: v.urn,
    attributes: {
      name: item.name, displayName: item.name, versionNumber: v.versionNumber,
      extension: { type: 'versions:autodesk.core:File', version: '1.0' },
    },
    relationships: {
      item: { data: { type: 'items', id: lineage } },
      ...(v.objectId ? { storage: { data: { type: 'objects', id: v.objectId } } } : {}),
    },
  };
}
function handleGetVersions(req, res, pid, itemId) {
  const item = getItem(itemId);
  const data = [...item.versions].sort((a, b) => b.versionNumber - a.versionNumber).map(v => versionJson(item, itemId, v));
  sendJson(res, 200, { jsonapi: { version: '1.0' }, links: { self: { href: `${origin(req)}/data/v1/projects/${pid}/items/${encodeURIComponent(itemId)}/versions` } }, data });
}
async function handleCreateStorage(req, res, pid) {
  const body = await readJson(req, res); if (body === undefined) return;
  const d = body?.data;
  if (!d || typeof d !== 'object') return badRequest(res, 'Missing "data" object.');
  if (d.type !== 'objects') return badRequest(res, 'data.type must be "objects".');
  const name = d.attributes?.name;
  if (typeof name !== 'string' || !name) return badRequest(res, 'data.attributes.name (string) is required.');
  const target = d.relationships?.target?.data;
  if (!target || target.type !== 'folders' || typeof target.id !== 'string' || !target.id)
    return badRequest(res, 'data.relationships.target.data must be {type:"folders", id:<folder urn>}.');
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  const objectKey = crypto.randomUUID() + ext;
  const objectId = `urn:adsk.objects:os.object:${BUCKET}/${objectKey}`;
  storages.set(objectId, { objectKey, name, folderId: target.id, completed: false, size: 0 });
  sendJson(res, 201, {
    jsonapi: { version: '1.0' },
    data: { type: 'objects', id: objectId, relationships: { target: { data: { type: 'folders', id: target.id } } } },
  });
}
async function handleCreateVersion(req, res, pid) {
  const body = await readJson(req, res); if (body === undefined) return;
  const d = body?.data;
  if (!d || typeof d !== 'object') return badRequest(res, 'Missing "data" object.');
  if (d.type !== 'versions') return badRequest(res, 'data.type must be "versions".');
  const name = d.attributes?.name;
  if (typeof name !== 'string' || !name) return badRequest(res, 'data.attributes.name (string) is required.');
  const ext = d.attributes?.extension;
  if (!ext || !/^versions:autodesk\.(core|bim360):File$/.test(ext.type ?? '') || ext.version !== '1.0')
    return badRequest(res, 'data.attributes.extension must be {type:"versions:autodesk.core:File" (or bim360), version:"1.0"}.');
  const itemRel = d.relationships?.item?.data;
  if (!itemRel || itemRel.type !== 'items' || typeof itemRel.id !== 'string' || !itemRel.id)
    return badRequest(res, 'data.relationships.item.data must be {type:"items", id:<lineage urn>}.');
  const storageRel = d.relationships?.storage?.data;
  if (!storageRel || storageRel.type !== 'objects' || typeof storageRel.id !== 'string' || !storageRel.id)
    return badRequest(res, 'data.relationships.storage.data must be {type:"objects", id:<object urn>}.');
  const st = storages.get(storageRel.id);
  if (!st) return badRequest(res, 'Referenced storage object does not exist.');
  if (!st.completed) return badRequest(res, 'Referenced storage object upload has not been completed.');
  const item = getItem(itemRel.id);
  item.name = name;
  const n = item.versions.length + 1;
  const v = { urn: `${fileUrnBase(itemRel.id)}?version=${n}`, versionNumber: n, objectId: storageRel.id, size: st.size };
  item.versions.push(v);
  sendJson(res, 201, { jsonapi: { version: '1.0' }, data: versionJson(item, itemRel.id, v) });
}

// ---------- OSS signed S3 upload ----------
function handleSignedGet(req, res, bucketKey, objectKey, query) {
  if (bucketKey !== BUCKET) return notFound(res);
  let session;
  const existingKey = query.get('uploadKey');
  if (existingKey) {
    session = uploads.get(existingKey);
    if (!session) return notFound(res);
  }
  let parts = 1;
  if (query.get('parts') !== null) {
    parts = Number(query.get('parts'));
    if (!Number.isInteger(parts) || parts < 1 || parts > 100) return badRequest(res, 'parts must be an integer between 1 and 100.');
  }
  if (!session) {
    const uploadKey = crypto.randomUUID();
    session = { objectKey, partsExpected: parts, parts: new Map() };
    uploads.set(uploadKey, session);
    session.uploadKey = uploadKey;
  }
  const urls = [];
  for (let i = 1; i <= session.partsExpected; i++) urls.push(`${origin(req)}/mock-s3/${session.uploadKey}/${i}`);
  sendJson(res, 200, {
    uploadKey: session.uploadKey,
    uploadExpiration: new Date(Date.now() + 24 * 3600e3).toISOString(),
    urlExpiration: new Date(Date.now() + 2 * 60e3).toISOString(),
    urls,
  });
}
function handlePartPut(req, res, uploadKey, partNum) {
  const session = uploads.get(uploadKey);
  if (!session) return notFound(res);
  const n = Number(partNum);
  if (!Number.isInteger(n) || n < 1 || n > session.partsExpected) return badRequest(res, 'Invalid part number for this upload session.');
  readBody(req).then(buf => {
    const etag = '"' + crypto.createHash('md5').update(buf).digest('hex') + '"';
    session.parts.set(n, { size: buf.length, etag });
    res.writeHead(200, { ETag: etag });
    res.end();
  });
}
async function handleSignedComplete(req, res, bucketKey, objectKey) {
  if (bucketKey !== BUCKET) return notFound(res);
  const body = await readJson(req, res); if (body === undefined) return;
  if (typeof body?.uploadKey !== 'string' || !body.uploadKey) return badRequest(res, 'uploadKey (string) is required.');
  const session = uploads.get(body.uploadKey);
  if (!session || session.objectKey !== objectKey) return notFound(res);
  for (let i = 1; i <= session.partsExpected; i++) {
    if (!session.parts.has(i)) return badRequest(res, `Upload is incomplete: part ${i} has not been uploaded.`);
  }
  const total = [...session.parts.values()].reduce((a, p) => a + p.size, 0);
  if (body.size !== undefined && body.size !== total)
    return badRequest(res, `size mismatch: expected ${body.size}, actual ${total}.`);
  if (Array.isArray(body.eTags)) {
    for (let i = 1; i <= session.partsExpected; i++) {
      if (body.eTags[i - 1] !== undefined && body.eTags[i - 1] !== session.parts.get(i).etag)
        return badRequest(res, `eTags mismatch at part ${i}.`);
    }
  }
  const objectId = `urn:adsk.objects:os.object:${BUCKET}/${objectKey}`;
  const st = storages.get(objectId);
  if (st) { st.completed = true; st.size = total; }
  sendJson(res, 200, {
    bucketKey, objectId, objectKey, size: total, contentType: 'application/octet-stream',
    location: `${origin(req)}/oss/v2/buckets/${bucketKey}/objects/${encodeURIComponent(objectKey)}`,
  });
}

// ---------- Model Properties: クエリ評価 ----------
function fieldValue(row, field) {
  if (/^s\.svf2id$/i.test(field)) return row.svf2Id;
  if (/^s\.changetype$/i.test(field)) return row.type;
  if (/^s\.name$/i.test(field)) return row.props[F_NAME];
  return row.props[field];
}
function normVal(v) {
  if (typeof v === 'string' && v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  return v;
}
function evalQuery(q, row) {
  if (!q || typeof q !== 'object' || Array.isArray(q)) throw new Error('query must be an object');
  const ops = Object.keys(q);
  if (ops.length !== 1) throw new Error('query must contain exactly one operator');
  const op = ops[0], arg = q[op];
  switch (op) {
    case '$eq': case '$ne': case '$gt': case '$gte': case '$lt': case '$lte': {
      if (!Array.isArray(arg) || arg.length !== 2 || typeof arg[0] !== 'string') throw new Error(`${op} expects [field, value]`);
      const v = fieldValue(row, arg[0]), w = normVal(arg[1]);
      return op === '$eq' ? v === w : op === '$ne' ? v !== w :
        op === '$gt' ? v > w : op === '$gte' ? v >= w : op === '$lt' ? v < w : v <= w;
    }
    case '$between': {
      if (!Array.isArray(arg) || arg.length !== 3 || typeof arg[0] !== 'string') throw new Error('$between expects [field, min, max]');
      const v = fieldValue(row, arg[0]);
      return v >= arg[1] && v <= arg[2];
    }
    case '$in': {
      if (!Array.isArray(arg) || arg.length !== 2 || typeof arg[0] !== 'string' || !Array.isArray(arg[1])) throw new Error('$in expects [field, [values]]');
      return arg[1].map(normVal).includes(fieldValue(row, arg[0]));
    }
    case '$and': if (!Array.isArray(arg)) throw new Error('$and expects an array'); return arg.every(s => evalQuery(s, row));
    case '$or': if (!Array.isArray(arg)) throw new Error('$or expects an array'); return arg.some(s => evalQuery(s, row));
    case '$not': return !evalQuery(arg, row);
    default: throw new Error(`Unsupported operator: ${op}`);
  }
}
function validateQuery(q) { // 構造だけ先に検証する（ダミー行で評価）
  evalQuery(q, { svf2Id: 0, type: 'OBJECT_CHANGED', props: {} });
}

// ---------- Model Properties: ジョブ ----------
function jobState(job) {
  if (job.fail) return job.polls >= POLLS_TO_FINISH ? 'FAILED' : 'PROCESSING';
  return job.polls >= POLLS_TO_FINISH ? 'FINISHED' : 'PROCESSING';
}
async function handleIndexBatch(req, res, pid) {
  const body = await readJson(req, res, true); if (body === undefined) return;
  if (!Array.isArray(body?.versions) || body.versions.length === 0)
    return mpBadRequest(res, 'versions (non-empty array) is required.');
  for (const v of body.versions)
    if (!v || typeof v.versionUrn !== 'string' || !v.versionUrn) return mpBadRequest(res, 'each entry of versions must have versionUrn (string).');
  const urns = body.versions.map(v => v.versionUrn);
  const indexId = shortId('idx:' + urns.join('|'));
  if (!indexes.has(indexId)) {
    indexes.set(indexId, {
      kind: 'index', projectId: pid, versionUrns: urns, polls: 0, queries: new Map(),
      fail: !urns.every(versionRegistered),
    });
  }
  const job = indexes.get(indexId);
  sendJson(res, 200, {
    indexes: [{
      projectId: pid, indexId, type: 'INDEX', state: jobState(job),
      selfUrl: `${origin(req)}/construction/index/v2/projects/${pid}/indexes/${indexId}`,
      versionUrns: urns, updatedAt: new Date().toISOString(),
    }],
  });
}
function indexRows(job) {
  const p = parseVersionUrn(job.versionUrns[0]);
  const ds = datasetFor(p.suffix, p.version);
  return [...ds.entries()].map(([id, props]) => rowFor(id, props));
}
function handleIndexGet(req, res, pid, indexId) {
  const job = indexes.get(indexId);
  if (!job) return notFound(res);
  job.polls++;
  const state = jobState(job);
  const out = {
    projectId: pid, indexId, type: 'INDEX', state,
    selfUrl: `${origin(req)}/construction/index/v2/projects/${pid}/indexes/${indexId}`,
    versionUrns: job.versionUrns, updatedAt: new Date().toISOString(),
  };
  if (state === 'PROCESSING') out.retryAt = new Date(Date.now() + 5000).toISOString();
  if (state === 'FINISHED') out.stats = { objects: indexRows(job).length };
  if (state === 'FAILED') out.errors = [{ code: 'TranslationFailed', title: 'The OTG manifest could not be retrieved' }];
  sendJson(res, 200, out);
}
async function handleDiffBatch(req, res, pid) {
  const body = await readJson(req, res, true); if (body === undefined) return;
  if (!Array.isArray(body?.diffs) || body.diffs.length === 0)
    return mpBadRequest(res, 'diffs (non-empty array) is required.');
  for (const d of body.diffs)
    if (!d || typeof d.prevVersionUrn !== 'string' || !d.prevVersionUrn || typeof d.curVersionUrn !== 'string' || !d.curVersionUrn)
      return mpBadRequest(res, 'each entry of diffs must have prevVersionUrn and curVersionUrn (strings).');
  const d0 = body.diffs[0];
  const diffId = shortId(`diff:${d0.prevVersionUrn}|${d0.curVersionUrn}`);
  if (!diffs.has(diffId)) {
    const prev = parseVersionUrn(d0.prevVersionUrn), cur = parseVersionUrn(d0.curVersionUrn);
    const result = computeDiff(datasetFor(prev.suffix, prev.version), datasetFor(cur.suffix, cur.version));
    diffs.set(diffId, {
      kind: 'diff', projectId: pid, prevVersionUrn: d0.prevVersionUrn, curVersionUrn: d0.curVersionUrn,
      polls: 0, queries: new Map(), result,
      fail: !(versionRegistered(d0.prevVersionUrn) && versionRegistered(d0.curVersionUrn)),
    });
  }
  const job = diffs.get(diffId);
  sendJson(res, 200, {
    diffs: [{
      projectId: pid, diffId, type: 'DIFF', state: jobState(job),
      selfUrl: `${origin(req)}/construction/index/v2/projects/${pid}/diffs/${diffId}`,
      prevVersionUrns: [d0.prevVersionUrn], curVersionUrns: [d0.curVersionUrn], updatedAt: new Date().toISOString(),
    }],
  });
}
function diffRows(job) {
  const prev = parseVersionUrn(job.prevVersionUrn), cur = parseVersionUrn(job.curVersionUrn);
  const prevDs = datasetFor(prev.suffix, prev.version), curDs = datasetFor(cur.suffix, cur.version);
  const rows = [];
  for (const id of job.result.added) rows.push(rowFor(id, curDs.get(id), 'OBJECT_ADDED'));
  for (const id of job.result.removed) rows.push(rowFor(id, prevDs.get(id), 'OBJECT_REMOVED'));
  for (const id of job.result.changed) rows.push(rowFor(id, curDs.get(id), 'OBJECT_CHANGED'));
  return rows;
}
function handleDiffGet(req, res, pid, diffId) {
  const job = diffs.get(diffId);
  if (!job) return notFound(res);
  job.polls++;
  const state = jobState(job);
  const out = {
    projectId: pid, diffId, type: 'DIFF', state,
    selfUrl: `${origin(req)}/construction/index/v2/projects/${pid}/diffs/${diffId}`,
    prevVersionUrns: [job.prevVersionUrn], curVersionUrns: [job.curVersionUrn], updatedAt: new Date().toISOString(),
  };
  if (state === 'PROCESSING') { out.retryAt = new Date(Date.now() + 5000).toISOString(); out.stats = null; out.errors = null; }
  if (state === 'FINISHED') out.stats = { added: job.result.added.length, removed: job.result.removed.length, modified: job.result.changed.length };
  if (state === 'FAILED') out.errors = [{ code: 'TranslationFailed', title: 'The OTG manifest could not be retrieved' }];
  sendJson(res, 200, out);
}
function handleManifest(req, res, job, kind) {
  if (!job) return notFound(res);
  const state = jobState(job);
  const out = { schema: '2.0.0', status: state === 'FINISHED' ? 'Succeeded' : state === 'FAILED' ? 'Failed' : 'Running' };
  if (kind === 'index') out.seedFiles = [{ name: 'mock-seed', urn: job.versionUrns[0] }];
  if (kind === 'diff' && state === 'FINISHED') {
    out.addedObjects = job.result.added.length;
    out.removedObjects = job.result.removed.length;
    out.modifiedObjects = job.result.changed.length;
  }
  sendJson(res, 200, out);
}
async function handleQueryCreate(req, res, pid, parentJob, parentId) {
  const body = await readJson(req, res, true); if (body === undefined) return;
  if (!body || typeof body.query !== 'object' || body.query === null || Array.isArray(body.query))
    return mpBadRequest(res, 'query (object) is required.');
  try { validateQuery(body.query); } catch (e) { return mpBadRequest(res, `Invalid query: ${e.message}`); }
  const queryId = shortId(`q:${parentId}:${JSON.stringify(body.query)}:${queries.size}`);
  const job = { queryId, parentKind: parentJob.kind, parentId, query: body.query, polls: 0 };
  queries.set(queryId, job);
  parentJob.queries.set(queryId, job);
  const type = parentJob.kind === 'diff' ? 'DIFF' : 'INDEX';
  const seg = parentJob.kind === 'diff' ? 'diffs' : 'indexes';
  sendJson(res, 200, {
    projectId: pid, ...(parentJob.kind === 'diff' ? { diffId: parentId } : { indexId: parentId }),
    queryId, type, state: 'PROCESSING',
    selfUrl: `${origin(req)}/construction/index/v2/projects/${pid}/${seg}/${parentId}/queries/${queryId}`,
  });
}
function handleQueryGet(req, res, pid, parentJob, parentId, queryId) {
  const job = queries.get(queryId);
  if (!job || job.parentId !== parentId) return notFound(res);
  job.polls++;
  const state = job.polls >= POLLS_TO_FINISH ? 'FINISHED' : 'PROCESSING';
  const seg = parentJob.kind === 'diff' ? 'diffs' : 'indexes';
  const out = {
    projectId: pid, ...(parentJob.kind === 'diff' ? { diffId: parentId } : { indexId: parentId }),
    queryId, type: parentJob.kind === 'diff' ? 'DIFF' : 'INDEX', state,
    selfUrl: `${origin(req)}/construction/index/v2/projects/${pid}/${seg}/${parentId}/queries/${queryId}`,
  };
  if (state === 'PROCESSING') out.retryAt = new Date(Date.now() + 5000).toISOString();
  if (state === 'FINISHED') {
    out.propertiesUrl = out.selfUrl + '/properties';
    out.queryResultsUrl = out.selfUrl + '/properties';
  }
  sendJson(res, 200, out);
}
function handleQueryProperties(req, res, parentJob, queryId) {
  const job = queries.get(queryId);
  if (!job || job.parentId !== (parentJob.kind === 'diff' ? parentJob.diffId : parentJob.indexId)) return notFound(res);
  if (job.polls < POLLS_TO_FINISH) return notFound(res); // 未完了の間は結果なし
  const all = parentJob.kind === 'diff' ? diffRows(parentJob) : indexRows(parentJob);
  sendGzNdjson(res, all.filter(r => evalQuery(job.query, r)));
}

// ---------- ルーター ----------
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const seg = u.pathname.split('/').filter(Boolean).map(s => decodeURIComponent(s));
    const M = req.method;

    if (M === 'GET' && u.pathname === '/health') return sendJson(res, 200, { ok: true });
    if (M === 'POST' && u.pathname === '/authentication/v2/token') return await handleToken(req, res);
    if (M === 'PUT' && seg[0] === 'mock-s3' && seg.length === 3) return handlePartPut(req, res, seg[1], seg[2]);

    // Data Management
    if (seg[0] === 'data' && seg[1] === 'v1' && seg[2] === 'projects' && seg.length >= 4) {
      if (!auth(req, res)) return;
      const pid = seg[3];
      if (M === 'POST' && seg.length === 5 && seg[4] === 'storage') return await handleCreateStorage(req, res, pid);
      if (M === 'POST' && seg.length === 5 && seg[4] === 'versions') return await handleCreateVersion(req, res, pid);
      if (M === 'GET' && seg.length === 7 && seg[4] === 'items' && seg[6] === 'versions') return handleGetVersions(req, res, pid, seg[5]);
      return notFound(res);
    }
    // OSS
    if (seg[0] === 'oss' && seg[1] === 'v2' && seg[2] === 'buckets' && seg[4] === 'objects' && seg[6] === 'signeds3upload') {
      if (!auth(req, res)) return;
      if (M === 'GET') return handleSignedGet(req, res, seg[3], seg[5], u.searchParams);
      if (M === 'POST') return await handleSignedComplete(req, res, seg[3], seg[5]);
      return notFound(res);
    }
    // Model Properties (user context 必須)
    if (seg[0] === 'construction' && seg[1] === 'index' && seg[2] === 'v2' && seg[3] === 'projects' && seg.length >= 5) {
      if (!auth(req, res, { userContext: true })) return;
      const pid = seg[4];
      if (M === 'POST' && seg[5] === 'indexes:batch-status' && seg.length === 6) return await handleIndexBatch(req, res, pid);
      if (M === 'POST' && seg[5] === 'diffs:batch-status' && seg.length === 6) return await handleDiffBatch(req, res, pid);
      const isDiff = seg[5] === 'diffs';
      if ((seg[5] === 'indexes' || isDiff) && seg.length >= 7) {
        const parentId = seg[6];
        const job = isDiff ? diffs.get(parentId) : indexes.get(parentId);
        if (M === 'GET' && seg.length === 7) return isDiff ? handleDiffGet(req, res, pid, parentId) : handleIndexGet(req, res, pid, parentId);
        if (!job) return notFound(res);
        if (M === 'GET' && seg.length === 8 && seg[7] === 'manifest') return handleManifest(req, res, job, isDiff ? 'diff' : 'index');
        if (M === 'GET' && seg.length === 8 && seg[7] === 'fields') return sendGzNdjson(res, FIELDS);
        if (M === 'POST' && seg.length === 8 && seg[7] === 'queries') return await handleQueryCreate(req, res, pid, { ...job, kind: isDiff ? 'diff' : 'index', ...(isDiff ? { diffId: parentId } : { indexId: parentId }) }, parentId);
        if (seg.length >= 9 && seg[7] === 'queries') {
          const parentJob = { ...job, kind: isDiff ? 'diff' : 'index', ...(isDiff ? { diffId: parentId } : { indexId: parentId }) };
          if (M === 'GET' && seg.length === 9) return handleQueryGet(req, res, pid, parentJob, parentId, seg[8]);
          if (M === 'GET' && seg.length === 10 && seg[9] === 'properties') return handleQueryProperties(req, res, parentJob, seg[8]);
        }
      }
      return notFound(res);
    }
    return notFound(res);
  } catch (e) {
    console.error('mock server error:', e);
    if (!res.headersSent) dmError(res, 500, 'Mock server internal error: ' + e.message);
  }
});
server.listen(PORT, () => console.log(`APS mock server listening on http://localhost:${PORT} (job polls to finish: ${POLLS_TO_FINISH})`));
