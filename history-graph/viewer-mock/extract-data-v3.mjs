// Extract the wall-move dataset (V2->V3 in substance) for the viewer mock
// from the measured V2->V4 Model Properties diff dump
// (research/diff-rows/diff-v2v4.ndjson; on ACC the proper V3 is registered
// as V4, so this diff IS the V2->V3 diff — see research/v2-diff-measurement.md §7).
//
// Selection (same criteria as extract-data.mjs):
//   - Target: the standard wall [748873] whose bbox shows a pure translation
//     (+0.14, +0.068, 0) ft ≈ 47mm (identified by Revit element id = hex
//     suffix of externalId).
//   - Neighbours: diff rows whose bbox centre lies within RADIUS_FT
//     (horizontal) and DZ_FT (vertical) of the target centre, bbox sane,
//     nearest first, capped per target. Only 158 of the 458 diff rows carry
//     a bbox, so context comes from that subset.
//
// Output: data-v3.js (window.MOCK_DATA_V3 = {...}) in the SAME shape as
// data.js: element.b1 = old (V2) bbox, element.b2 = new (V3) bbox,
// coordinates relativized to the extracted set's min corner.

import fs from 'node:fs';
import readline from 'node:readline';

const SRC = new URL('../research/diff-rows/diff-v2v4.ndjson', import.meta.url);
const OUT = new URL('./data-v3.js', import.meta.url);

const NAME_KEY = 'p153cb174'; // __name__
const CAT_KEY  = 'p5eddc473'; // __category__

const hex = id => id.toString(16).padStart(8, '0');
const TARGET = { suffix: hex(748873), role: 'changed', label: '標準壁 [748873]', change: 'wall' };

const RADIUS_FT = 30;
const DZ_FT = 6;
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

const trow = rows.find(r => r.key.toLowerCase().endsWith(TARGET.suffix));
if (!trow) { console.error('TARGET NOT FOUND', TARGET.suffix); process.exit(1); }
console.log('target wall:', trow.key, 'b1=', !!trow.b1, 'b2=', !!trow.b2);
if (trow.b1 && trow.b2) {
  const d = [0, 1, 2].map(i => (trow.b2[i] - trow.b1[i]).toFixed(3));
  console.log('wall bbox translation (ft):', d.join(', '));
}

const tc = center(trow.b2 ?? trow.b1);
const cand = [];
for (const r of rows) {
  if (r.key === trow.key) continue;
  const b = r.b2 ?? r.b1; if (!b) continue;
  const c = center(b);
  const dxy = Math.hypot(c[0]-tc[0], c[1]-tc[1]);
  const dz = Math.abs(c[2]-tc[2]);
  if (dxy <= RADIUS_FT && dz <= DZ_FT) cand.push({ r, dxy });
}
cand.sort((a, b) => a.dxy - b.dxy);
console.log('neighbours:', Math.min(cand.length, MAX_PER_TARGET), '/', cand.length);

const elements = [{ key: trow.key, name: trow.name ?? TARGET.label, category: trow.category, role: TARGET.role, change: TARGET.change, label: TARGET.label, b1: trow.b1, b2: trow.b2 }];
for (const { r } of cand.slice(0, MAX_PER_TARGET)) {
  elements.push({ key: r.key, name: r.name, category: r.category, role: 'context', b1: r.b1, b2: r.b2 });
}

const origin = [Infinity, Infinity, Infinity];
for (const e of elements) for (const b of [e.b1, e.b2]) if (b) {
  origin[0] = Math.min(origin[0], b[0]); origin[1] = Math.min(origin[1], b[1]); origin[2] = Math.min(origin[2], b[2]);
}
const rel = b => b ? [b[0]-origin[0], b[1]-origin[1], b[2]-origin[2], b[3]-origin[0], b[4]-origin[1], b[5]-origin[2]] : null;
for (const e of elements) { e.b1 = rel(e.b1); e.b2 = rel(e.b2); }

const data = {
  model: 'Snowdon Towers Sample Architectural',
  versions: ['V2', 'V3'],
  unit: 'feet (model shared coordinates, origin shifted to local min corner)',
  originNote: 'origin = min bbox corner of the extracted set, subtracted for display',
  selection: { radiusFt: RADIUS_FT, dzFt: DZ_FT, maxPerTarget: MAX_PER_TARGET, maxSizeFt: MAX_SIZE_FT, sourceRows: rows.length, source: 'diff-v2v4.ndjson (V2->V4 on ACC = V2->V3 in substance)' },
  changes: {
    wall: { title: '壁の移動（標準壁 [748873]、bbox 平行移動 ≈47mm）', changed: [trow.key] },
  },
  elements,
};
fs.writeFileSync(OUT, 'window.MOCK_DATA_V3 = ' + JSON.stringify(data) + ';\n');
console.log('elements total:', elements.length, '-> wrote', OUT.pathname);
