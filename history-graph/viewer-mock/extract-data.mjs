// Extract a lightweight bbox dataset for the viewer mock from the measured
// V1->V2 Model Properties diff dump (research/diff-rows/diff-all.ndjson).
//
// Selection:
//   - The 5 target elements of the 4 real changes (identified by Revit
//     element id = hex suffix of externalId, cross-checked against
//     research/diff-reconcile-result.json).
//   - Neighbours: diff rows whose bbox centre lies within RADIUS_FT
//     (horizontal) and DZ_FT (vertical) of a target centre, bbox sane
//     (each axis <= MAX_SIZE_FT, non-degenerate), nearest first, capped
//     per target. Unchanged elements are not in the diff dump, so all
//     context elements come from the 35,618 diff rows (their bbox values
//     are real geometry even when the "change" is locale noise).
//
// Output: data.js  (window.MOCK_DATA = {...}) so index.html works from file://

import fs from 'node:fs';
import readline from 'node:readline';

const SRC = new URL('../research/diff-rows/diff-all.ndjson', import.meta.url);
const OUT = new URL('./data.js', import.meta.url);

const NAME_KEY = 'p153cb174'; // __name__    (diff-fields.ndjson)
const CAT_KEY  = 'p5eddc473'; // __category__

// suffix = Revit element id in hex, zero-padded to 8 (externalId suffix)
const hex = id => id.toString(16).padStart(8, '0');
const TARGETS = [
  { suffix: hex(2482933), role: 'added',   label: 'RPC Shrub "Switchgrass" [2482933]', change: 'shrub' },
  { suffix: hex(1103501), role: 'removed', label: 'Pergola Modern [1103501]',          change: 'pergola' },
  { suffix: hex(2053768), role: 'changed', label: 'Bollard Light [2053768]',           change: 'bollard' },
  { suffix: hex(2053808), role: 'changed', label: 'Bollard Light [2053808]',           change: 'bollard' },
  { suffix: hex(888428),  role: 'changed', label: 'Door-Passage-Single-Flush [888428]', change: 'door' },
];

const RADIUS_FT = 30;   // horizontal neighbour radius around each target centre
const DZ_FT = 6;        // vertical band around target centre height
const MAX_PER_TARGET = 60;
const MAX_SIZE_FT = 150;

const bbox = (mn, mx) => (mn && mx) ? [mn.x, mn.y, mn.z, mx.x, mx.y, mx.z] : null;
const center = b => [(b[0]+b[3])/2, (b[1]+b[4])/2, (b[2]+b[5])/2];
const sane = b => b && b.every(Number.isFinite) &&
  (b[3]-b[0]) <= MAX_SIZE_FT && (b[4]-b[1]) <= MAX_SIZE_FT && (b[5]-b[2]) <= MAX_SIZE_FT &&
  ((b[3]-b[0]) + (b[4]-b[1]) + (b[5]-b[2])) > 0.01;

const rows = [];
const rl = readline.createInterface({ input: fs.createReadStream(SRC), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let r; try { r = JSON.parse(line); } catch { continue; }
  const b2 = bbox(r.bboxMin, r.bboxMax);
  const b1 = r.prev ? bbox(r.prev.bboxMin, r.prev.bboxMax) : null;
  if (!sane(b2) && !sane(b1)) continue;
  const name = r.prev?.props?.[NAME_KEY] ?? r.props?.[NAME_KEY] ?? null;
  const category = r.prev?.props?.[CAT_KEY] ?? r.props?.[CAT_KEY] ?? null;
  rows.push({ key: r.externalId, type: r.type, name, category, b1: sane(b1) ? b1 : null, b2: sane(b2) ? b2 : null });
}
console.log('rows with sane bbox:', rows.length);

const byKey = new Map(rows.map(r => [r.key, r]));
const targets = [];
for (const t of TARGETS) {
  const row = rows.find(r => r.key.toLowerCase().endsWith(t.suffix));
  if (!row) { console.error('TARGET NOT FOUND', t.suffix); process.exit(1); }
  targets.push({ ...t, key: row.key, row });
  console.log('target', t.change, row.key, 'b1=', !!row.b1, 'b2=', !!row.b2);
}

// neighbours per target
const chosen = new Map(); // key -> element record
for (const t of targets) {
  const ref = t.row.b2 ?? t.row.b1;
  const tc = center(ref);
  const cand = [];
  for (const r of rows) {
    if (r.key === t.key) continue;
    const b = r.b2 ?? r.b1; if (!b) continue;
    const c = center(b);
    const dxy = Math.hypot(c[0]-tc[0], c[1]-tc[1]);
    const dz = Math.abs(c[2]-tc[2]);
    if (dxy <= RADIUS_FT && dz <= DZ_FT) cand.push({ r, dxy });
  }
  cand.sort((a, b) => a.dxy - b.dxy);
  for (const { r } of cand.slice(0, MAX_PER_TARGET)) {
    if (!chosen.has(r.key)) chosen.set(r.key, { key: r.key, name: r.name, category: r.category, role: 'context', b1: r.b1, b2: r.b2 });
  }
  console.log('neighbours for', t.change, ':', Math.min(cand.length, MAX_PER_TARGET), '/', cand.length);
}

const elements = [];
for (const t of targets) {
  elements.push({ key: t.key, name: t.row.name ?? t.label, category: t.row.category, role: t.role, change: t.change, label: t.label, b1: t.row.b1, b2: t.row.b2 });
}
for (const el of chosen.values()) if (!elements.some(e => e.key === el.key)) elements.push(el);

// local origin = min corner over all included bboxes (both versions)
const origin = [Infinity, Infinity, Infinity];
for (const e of elements) for (const b of [e.b1, e.b2]) if (b) {
  origin[0] = Math.min(origin[0], b[0]); origin[1] = Math.min(origin[1], b[1]); origin[2] = Math.min(origin[2], b[2]);
}
const rel = b => b ? [b[0]-origin[0], b[1]-origin[1], b[2]-origin[2], b[3]-origin[0], b[4]-origin[1], b[5]-origin[2]] : null;
for (const e of elements) { e.b1 = rel(e.b1); e.b2 = rel(e.b2); }

const data = {
  model: 'Snowdon Towers Sample Architectural',
  versions: ['V1', 'V2'],
  unit: 'feet (model shared coordinates, origin shifted to local min corner)',
  originNote: 'origin = min bbox corner of the extracted set, subtracted for display',
  selection: { radiusFt: RADIUS_FT, dzFt: DZ_FT, maxPerTarget: MAX_PER_TARGET, maxSizeFt: MAX_SIZE_FT, sourceRows: rows.length },
  changes: {
    shrub:   { title: '植栽の追加', added: [targets[0].key] },
    pergola: { title: '藤棚の削除', removed: [targets[1].key] },
    bollard: { title: '外灯の移動 ×2', changed: [targets[2].key, targets[3].key] },
    door:    { title: 'ドアのプロパティ変更（コメント diff-test）', changed: [targets[4].key] },
  },
  elements,
};
fs.writeFileSync(OUT, 'window.MOCK_DATA = ' + JSON.stringify(data) + ';\n');
console.log('elements total:', elements.length, '-> wrote', OUT.pathname);
