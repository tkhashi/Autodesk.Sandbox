// build-diff-cache.mjs — 実測済み diff 全行ダンプ（research/diff-rows/*.ndjson）を
// アプリ用の正規化キャッシュ（seed/diff-<from>-<to>.json）に変換する。
// 正規化: 統計（result JSON の diffStats を正とする）＋ bbox を持つ行のみ
// { type, externalId, name, category, bboxMin/Max, prevBboxMin/Max, geomChanged, changedProps } を残す。
// 使い方: node tools/build-diff-cache.mjs [researchDir]
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const research = process.argv[2] ?? path.join(appRoot, '..', 'research');
const rowsDir = path.join(research, 'diff-rows');
const seedDir = path.join(appRoot, 'seed');
fs.mkdirSync(seedDir, { recursive: true });

const PAIRS = [
  { from: 1, to: 2, dump: 'diff-all.ndjson', fields: 'diff-fields.ndjson', result: 'v2-diff-result.json' },
  { from: 2, to: 4, dump: 'diff-v2v4.ndjson', fields: 'diff-v2v4-fields.ndjson', result: 'diff-v2v4-result.json' },
  { from: 1, to: 4, dump: 'diff-v1v4.ndjson', fields: 'diff-v1v4-fields.ndjson', result: 'diff-v1v4-result.json' },
];
const TYPE_MAP = { OBJECT_ADDED: 'added', OBJECT_REMOVED: 'removed', OBJECT_CHANGED: 'modified' };

function loadFields(file) {
  const map = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const d = JSON.parse(line);
    map.set(d.key, d);
  }
  let nameKey = null, catKey = null;
  for (const [k, v] of map) {
    if (v.category === '__name__') nameKey = k;
    if (v.category === '__category__' && v.name === 'Category') catKey = k;
  }
  return { map, nameKey, catKey };
}

async function buildPair(p) {
  const { map, nameKey, catKey } = loadFields(path.join(rowsDir, p.fields));
  const result = JSON.parse(fs.readFileSync(path.join(research, p.result), 'utf8'));
  const stats = result.diffStats;
  const bboxRows = [];
  const byCategory = {};
  let total = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(rowsDir, p.dump)), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    total++;
    const type = TYPE_MAP[r.type] ?? r.type;
    const cur = r.props ?? {};
    const prev = r.prev?.props ?? {};
    const name = cur[nameKey] ?? prev[nameKey] ?? null;
    const category = cur[catKey] ?? prev[catKey] ?? null;
    if (category) {
      byCategory[category] ??= { added: 0, removed: 0, modified: 0 };
      if (byCategory[category][type] !== undefined) byCategory[category][type]++;
    }
    const hasBbox = r.bboxMin || r.prev?.bboxMin;
    if (!hasBbox) continue;
    let changedProps = [];
    if (type === 'modified') {
      const keys = new Set([...Object.keys(cur), ...Object.keys(prev)]);
      for (const k of keys) {
        if (k.startsWith('p') && JSON.stringify(cur[k]) !== JSON.stringify(prev[k])) {
          const f = map.get(k);
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
  const out = {
    from: p.from, to: p.to, source: 'measured-dump', dumpFile: p.dump,
    stats, objects: { prev: result.idxPrev?.objects ?? null, cur: result.idxCur?.objects ?? null },
    totalRows: total, bboxRowCount: bboxRows.length, byCategory, bboxRows,
  };
  const file = path.join(seedDir, `diff-${p.from}-${p.to}.json`);
  fs.writeFileSync(file, JSON.stringify(out));
  console.log(`${file}: stats=${JSON.stringify(stats)} rows=${total} bboxRows=${bboxRows.length} bytes=${fs.statSync(file).size}`);
}

for (const p of PAIRS) await buildPair(p);
console.log('done');
