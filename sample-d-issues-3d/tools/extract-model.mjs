// extract-model.mjs — 新規モデル1件分の索引（props-index / ext2dbid / bbox-index）を app/data/{key}/ に生成する
// usage: node extract-model.mjs <derivativeUrn> <key> [viewName]
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createFetchReader, getToken } from './fetch-reader.mjs';

const [urn, key, viewNameArg] = process.argv.slice(2);
const APP = path.resolve(import.meta.dirname, '..');
const env = {};
for (const line of fs.readFileSync(path.join(APP, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim();
}
const BASE = 'https://developer.api.autodesk.com';
const token = await getToken(env);
const H = { Authorization: 'Bearer ' + token };
async function getPoll(url, label) {
  for (let i = 0; i < 120; i++) {
    const r = await fetch(url, { headers: H });
    if (r.status === 200) return r.json();
    if (r.status !== 202) throw new Error(label + ' status ' + r.status + ' ' + (await r.text()).slice(0, 150));
    await new Promise(s => setTimeout(s, 3000));
  }
  throw new Error(label + ' timeout');
}

// manifest → geometry ノード一覧
const man = await (await fetch(`${BASE}/modelderivative/v2/designdata/${urn}/manifest`, { headers: H })).json();
console.log(key, 'manifest status:', man.status);
const geoNodes = [];
(function walk(d) { if (d.type === 'geometry') geoNodes.push(d); for (const c of d.children ?? []) walk(c); })({ children: man.derivatives });
console.log(key, 'geometry nodes:', geoNodes.map(g => g.name).join(' | '));

// metadata → 3D ビュー選択
const meta = await getPoll(`${BASE}/modelderivative/v2/designdata/${urn}/metadata`, 'metadata');
const views = meta.data.metadata;
console.log(key, 'views:', views.map(v => `${v.name} [role=${v.role}]`).join(' | '));
const cands = views.filter(v => v.role === '3d');
const view = (viewNameArg && views.find(v => v.name === viewNameArg))
  ?? cands.find(v => /^\{?3D/.test(v.name)) ?? cands.find(v => v.name.includes('Coord')) ?? cands[0] ?? views[0];
console.log(key, 'chosen view:', view.name, view.guid);

// properties → props-index
const props = await getPoll(`${BASE}/modelderivative/v2/designdata/${urn}/metadata/${view.guid}/properties?forceget=true`, 'properties');
const collection = props.data?.collection ?? [];
const propsIndex = {};
for (const o of collection) {
  if (!o.externalId) continue;
  const entry = { name: o.name, revitId: o.name?.match(/\[(\d+)\]\s*$/)?.[1] ?? null, objectid: o.objectid };
  for (const g of Object.values(o.properties ?? {})) for (const [k, v] of Object.entries(g)) {
    if (!k.startsWith('_') && entry[k] === undefined) entry[k] = v;
  }
  propsIndex[o.externalId] = entry;
}
console.log(key, 'props objects:', collection.length, 'indexed:', Object.keys(propsIndex).length);

// model.sdb → ext2dbid
const sdbUrn = `urn:adsk.viewing:fs.file:${urn}/output/Resource/model.sdb`;
const sr = await fetch(`${BASE}/modelderivative/v2/designdata/${urn}/manifest/${encodeURIComponent(sdbUrn)}`, { headers: H });
if (!sr.ok) throw new Error('sdb status ' + sr.status);
const sdbPath = `/tmp/${key}-model.sdb`;
fs.writeFileSync(sdbPath, Buffer.from(await sr.arrayBuffer()));
const db = new DatabaseSync(sdbPath);
const ext2dbid = {};
for (const row of db.prepare('SELECT id, external_id FROM _objects_id').all()) ext2dbid[row.external_id] = row.id;
db.close();
console.log(key, 'ext2dbid entries:', Object.keys(ext2dbid).length);

// SVF フラグメント → bbox-index（SVF リソース GUID は geometry ノード配下から）
const geo = geoNodes.find(g => g.name === view.name) ?? geoNodes[0];
let svfGuid = view.guid;
(function findSv(c) { if (c.mime === 'application/autodesk-svf') { svfGuid = c.guid; return true; } for (const ch of c.children ?? []) if (findSv(ch)) return true; return false; })(geo ?? {});
console.log(key, 'svf guid:', svfGuid);
const reader = await createFetchReader({ urn, guid: svfGuid, token });
const bbox = new Map();
let frags = 0;
for await (const frag of reader.enumerateFragments()) {
  frags++;
  if (!frag.bbox) continue;
  const cur = bbox.get(frag.dbID);
  if (!cur) bbox.set(frag.dbID, [...frag.bbox]);
  else for (let i = 0; i < 3; i++) { cur[i] = Math.min(cur[i], frag.bbox[i]); cur[i + 3] = Math.max(cur[i + 3], frag.bbox[i + 3]); }
}
console.log(key, 'fragments:', frags, 'dbIds with bbox:', bbox.size);

const outDir = path.join(APP, 'data', key);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'props-index.json'), JSON.stringify(propsIndex));
fs.writeFileSync(path.join(outDir, 'ext2dbid.json'), JSON.stringify(ext2dbid));
fs.writeFileSync(path.join(outDir, 'bbox-index.json'), JSON.stringify(Object.fromEntries(bbox)));
console.log(key, 'DONE →', outDir, '| viewableGuid:', view.guid, '| viewName:', view.name);
