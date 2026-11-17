// capture.js — 自動スクショの撮影ページ（サーバのヘッドレス Chrome 専用）
// サーバから渡された撮影仕様（/api/captures/spec/:id）に従い、差分ビューアと同じ
// 見た目（色分け＋見通し確保＋引出線ラベル）でモデルを描き、getScreenShot で撮影して
// サーバへ POST する。結果は window.__capture にも残し、サーバ側ドライバが読む。
'use strict';
window.__capture = { status: 'working' };
const jobId = new URLSearchParams(location.search).get('job');
const statusEl = document.getElementById('capStatus');
const say = (m) => { if (statusEl) statusEl.textContent = m; };
const sleep = ms => new Promise(s => setTimeout(s, ms));

async function fail(msg) {
  window.__capture = { status: 'failed', error: String(msg) };
  say('撮影失敗: ' + msg);
  try {
    await fetch(`/api/captures/${jobId}/fail`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: String(msg) }),
    });
  } catch (e) {}
}
setTimeout(() => { if (window.__capture.status === 'working') fail('撮影がタイムアウトしました（ページ側 150 秒）'); }, 150000);

function pickViewable(doc, spec) {
  const root = doc.getRoot();
  let nodes = [];
  try { nodes = root.search({ type: 'geometry', role: '3d' }, true) ?? []; } catch (e) {}
  if (!nodes.length) { try { nodes = root.search({ type: 'geometry' }, true) ?? []; } catch (e) {} }
  const wantName = spec.viewableName ?? 'New Construction';
  let pick = null;
  if (spec.viewableGuid) pick = nodes.find(n => n.data?.guid === spec.viewableGuid) ?? null;
  if (!pick) pick = nodes.find(n => n.data?.name === wantName) ?? null;
  if (!pick) pick = nodes.find(n => String(n.data?.name ?? '').includes(wantName)) ?? null;
  if (!pick) {
    let bestVol = -1;
    for (const n of nodes) {
      const bb = n.data?.boundingBox;
      if (!bb?.min || !bb?.max) continue;
      const vol = Math.max(0, bb.max.x - bb.min.x) * Math.max(0, bb.max.y - bb.min.y) * Math.max(0, bb.max.z - bb.min.z);
      if (vol > bestVol) { bestVol = vol; pick = n; }
    }
  }
  return pick ?? root.getDefaultGeometry();
}
function nodeWorldBox(dbId, model) {
  try {
    const tree = model.getInstanceTree();
    const a = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    tree.getNodeBox(dbId, a);
    if (a[0] <= a[3] && a[1] <= a[4] && a[2] <= a[5]) return { min: { x: a[0], y: a[1], z: a[2] }, max: { x: a[3], y: a[4], z: a[5] } };
  } catch (e) {}
  return null;
}
const boxCenter = b => ({ x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 });
const boxRadius = b => Math.max(0.5 * Math.hypot(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z), 0.5);
function segmentHitsBox(o, d, tMax, b) {
  let tmin = 0, tmax = tMax;
  for (const ax of ['x', 'y', 'z']) {
    const dd = d[ax], oo = o[ax];
    if (Math.abs(dd) < 1e-9) { if (oo < b.min[ax] || oo > b.max[ax]) return false; }
    else {
      let t1 = (b.min[ax] - oo) / dd, t2 = (b.max[ax] - oo) / dd;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      if (tmin > tmax) return false;
    }
  }
  return true;
}

let viewer = null;
async function main() {
  if (!jobId) return fail('job パラメータがありません');
  const specRes = await fetch(`/api/captures/spec/${jobId}`);
  if (!specRes.ok) return fail('撮影仕様を取得できませんでした（HTTP ' + specRes.status + '）');
  const spec = await specRes.json();
  if (!window.Autodesk?.Viewing) return fail('Viewer の CDN に到達できません（撮影ホストから Autodesk の CDN へ到達できる必要があります）');
  say(`V${spec.job.from} → V${spec.job.to} を撮影中…`);

  await new Promise((resolve, reject) => {
    Autodesk.Viewing.Initializer({
      env: 'AutodeskProduction', api: 'derivativeV2',
      getAccessToken: async (cb) => {
        const t = await (await fetch('/api/token')).json();
        cb(t.access_token, t.expires_in);
      },
    }, resolve);
  });
  viewer = new Autodesk.Viewing.GuiViewer3D(document.getElementById('viewerEl'));
  viewer.start();
  try { viewer.setGhosting(true); } catch (e) {}

  const loadModel = (vnum) => new Promise((resolve, reject) => {
    const ver = spec.versions.find(v => v.versionNumber === vnum);
    if (!ver) return reject(new Error('版 V' + vnum + ' が仕様にありません'));
    Autodesk.Viewing.Document.load('urn:' + ver.derivativeUrn, (doc) => {
      viewer.loadDocumentNode(doc, pickViewable(doc, spec), { keepCurrentModels: true }).then(resolve).catch(reject);
    }, (code) => reject(new Error(`V${vnum} のドキュメント読み込みに失敗（${code}）`)));
  });
  const waitGeometry = (model) => new Promise(resolve => {
    let tree = null;
    try { tree = model.getInstanceTree(); } catch (e) {}
    if (tree) return resolve();
    const onGeo = (e) => { if (e.model === model) { viewer.removeEventListener(Autodesk.Viewing.GEOMETRY_LOADED_EVENT, onGeo); resolve(); } };
    viewer.addEventListener(Autodesk.Viewing.GEOMETRY_LOADED_EVENT, onGeo);
    setTimeout(() => { viewer.removeEventListener(Autodesk.Viewing.GEOMETRY_LOADED_EVENT, onGeo); resolve(); }, 90000);
  });
  const toM = await loadModel(spec.job.to);
  await waitGeometry(toM);
  const fromM = await loadModel(spec.job.from);
  await waitGeometry(fromM);
  const extMap = (model) => new Promise(res => { try { model.getExternalIdMapping(m => res(m)); } catch (e) { res({}); } });
  const [mapFrom, mapTo] = await Promise.all([extMap(fromM), extMap(toM)]);
  const T = window.THREE;
  const V4 = (r, g, b, a) => new T.Vector4(r, g, b, a);
  const els = spec.elements;
  const addedDb = els.added.map(e => mapTo[e.externalId]).filter(x => x != null);
  const changedToDb = els.changed.map(e => mapTo[e.externalId]).filter(x => x != null);
  const changedFromDb = els.changed.map(e => mapFrom[e.externalId]).filter(x => x != null);
  const removedDb = els.removed.map(e => mapFrom[e.externalId]).filter(x => x != null);
  for (const db of addedDb) viewer.setThemingColor(db, V4(0.1, 0.65, 0.3, 1), toM);
  for (const db of changedToDb) viewer.setThemingColor(db, V4(0.95, 0.72, 0.08, 1), toM);
  for (const db of removedDb) viewer.setThemingColor(db, V4(0.85, 0.16, 0.1, 0.45), fromM);
  for (const db of changedFromDb) viewer.setThemingColor(db, V4(0.9, 0.7, 0.15, 0.35), fromM);
  // Before モデルの変更なし要素は重ねない（差分ビューアの重ね表示と同じ）
  {
    const keep = new Set([...removedDb, ...changedFromDb]);
    const all = [];
    const tree = fromM.getInstanceTree();
    if (tree) {
      const walk = (id) => { all.push(id); tree.enumNodeChildren(id, c => walk(c)); };
      walk(tree.getRootId());
    }
    const hideIds = all.filter(id => !keep.has(id));
    if (hideIds.length) { try { viewer.hide(hideIds, fromM); } catch (e) {} }
  }

  // 対象ボックス（カメラと見通しの基準）
  let targetBox = spec.target.box;
  if (!targetBox && spec.target.anchorExternalId) {
    const db = mapTo[spec.target.anchorExternalId] ?? mapFrom[spec.target.anchorExternalId];
    const model = mapTo[spec.target.anchorExternalId] != null ? toM : fromM;
    if (db != null) targetBox = nodeWorldBox(db, model);
  }
  // 見通し確保: カメラは後で決まるため、先にカメラを決めてから遮蔽物を計算する

  // ---- カメラ ----
  const cam = spec.camera;
  if (cam.type === 'pin' && cam.viewerState?.viewport?.eye) {
    // ピンカメラ再現: ピンが保持する視点・注視点・上方向をそのまま使う
    const vp = cam.viewerState.viewport;
    const eye = new T.Vector3(vp.eye[0], vp.eye[1], vp.eye[2]);
    const tgt = new T.Vector3(vp.target[0], vp.target[1], vp.target[2]);
    const up = new T.Vector3(vp.up?.[0] ?? 0, vp.up?.[1] ?? 0, vp.up?.[2] ?? 1);
    try { viewer.navigation.setPivotPoint(tgt); } catch (e) {}
    viewer.navigation.setView(eye, tgt, up);
    if (vp.isOrthographic) { try { viewer.navigation.setRequestOrthographicProjection(true); } catch (e) {} }
  } else if (cam.type === 'fallback' && cam.pinPosition) {
    // 代替カメラ: ピン位置を注視点に、方位 45°・仰角 28°・距離 60（定義済みの固定値）
    const p = cam.pinPosition;
    const el = 28 * Math.PI / 180, az = Math.PI / 4, dist = 60;
    const eye = new T.Vector3(p.x + Math.cos(az) * Math.cos(el) * dist, p.y + Math.sin(az) * Math.cos(el) * dist, p.z + Math.sin(el) * dist);
    const tgt = new T.Vector3(p.x, p.y, p.z);
    try { viewer.navigation.setPivotPoint(tgt); } catch (e) {}
    viewer.navigation.setView(eye, tgt, new T.Vector3(0, 0, 1));
  } else {
    // 計算カメラ（sample-d 方式）: ピボット＝対象の中心、方位は現在を維持、仰角 28°
    const box = targetBox;
    if (!box) return fail('対象のボックスが取得できませんでした');
    const c = boxCenter(box);
    const radius = boxRadius(box);
    const fov = ((viewer.impl?.camera?.fov ?? 45) * Math.PI) / 180;
    const dist = (radius / Math.tan(fov / 2)) * 1.9;
    const camPos = viewer.navigation.getPosition();
    let az = Math.atan2(camPos.y - c.y, camPos.x - c.x);
    if (!isFinite(az)) az = Math.PI / 4;
    const el = 28 * Math.PI / 180;
    const eye = new T.Vector3(c.x + Math.cos(az) * Math.cos(el) * dist, c.y + Math.sin(az) * Math.cos(el) * dist, c.z + Math.sin(el) * dist);
    const tgt = new T.Vector3(c.x, c.y, c.z);
    try { viewer.navigation.setPivotPoint(tgt); } catch (e) {}
    viewer.navigation.setView(eye, tgt, new T.Vector3(0, 0, 1));
  }

  // ---- 見通し確保（occluder removal、範囲 50% 固定） ----
  if (targetBox) {
    try {
      const camPos = viewer.navigation.getPosition();
      const o = { x: camPos.x, y: camPos.y, z: camPos.z };
      const c = boxCenter(targetBox);
      const f = 2; // 1 + (50/100)*2
      const ex = {
        min: { x: c.x + (targetBox.min.x - c.x) * f, y: c.y + (targetBox.min.y - c.y) * f, z: c.z + (targetBox.min.z - c.z) * f },
        max: { x: c.x + (targetBox.max.x - c.x) * f, y: c.y + (targetBox.max.y - c.y) * f, z: c.z + (targetBox.max.z - c.z) * f },
      };
      const pts = [c];
      for (const x of [ex.min.x, ex.max.x]) for (const y of [ex.min.y, ex.max.y]) for (const z of [ex.min.z, ex.max.z]) pts.push({ x, y, z });
      const segs = pts.map(p => ({ x: p.x - o.x, y: p.y - o.y, z: p.z - o.z }));
      const distC = Math.hypot(c.x - o.x, c.y - o.y, c.z - o.z);
      for (const [model, classified] of [[toM, new Set([...addedDb, ...changedToDb])], [fromM, new Set([...removedDb, ...changedFromDb])]]) {
        const tree = model.getInstanceTree();
        if (!tree) continue;
        const excl = new Set(classified);
        for (const id of classified) {
          let p = id, guard = 0;
          while (p != null && guard++ < 100) {
            let parent = null;
            try { parent = tree.getNodeParentId(p); } catch (e) { break; }
            if (parent == null || parent === p) break;
            excl.add(parent);
            p = parent;
          }
        }
        const hits = [];
        const walk = (id) => {
          tree.enumNodeChildren(id, ch => walk(ch));
          let hasFrag = false;
          tree.enumNodeFragments(id, () => { hasFrag = true; }, false);
          if (!hasFrag || id === tree.getRootId() || excl.has(id)) return;
          const box = nodeWorldBox(id, model);
          if (!box) return;
          const cc = boxCenter(box);
          if (Math.hypot(cc.x - o.x, cc.y - o.y, cc.z - o.z) - boxRadius(box) >= distC) return;
          if (segs.some(d => segmentHitsBox(o, d, 1, box))) hits.push(id);
        };
        walk(tree.getRootId());
        if (hits.length) { try { viewer.hide(hits, model); } catch (e) {} }
      }
    } catch (e) { /* 見通し確保の失敗は撮影自体を止めない */ }
  }

  // ---- 引出線ラベル（対象の構成要素のみ・最大12件） ----
  const KIND = { added: ['追加', '#1e9e57'], removed: ['削除', '#d43a2f'], changed: ['変更', '#b8860b'], modified: ['変更', '#b8860b'] };
  const labelItems = [];
  {
    const markersEl = document.getElementById('capMarkers');
    const leadersEl = document.getElementById('capLeaders');
    const SVGNS = 'http://www.w3.org/2000/svg';
    for (const m of (spec.target.members ?? []).slice(0, 12)) {
      const inTo = m.kind === 'added' || m.kind === 'modified' || m.kind === 'changed';
      const model = inTo ? toM : fromM;
      const db = (inTo ? mapTo : mapFrom)[m.externalId] ?? (inTo ? mapFrom : mapTo)[m.externalId];
      if (db == null) continue;
      const box = nodeWorldBox(db, model);
      if (!box) continue;
      const [kindLabel, color] = KIND[m.kind] ?? KIND.modified;
      const el = document.createElement('div');
      el.className = 'diff-label k-' + (m.kind === 'modified' ? 'changed' : m.kind);
      el.innerHTML = `<span class="dl-kind">${kindLabel}</span>${String(m.name ?? '').slice(0, 42)}`;
      markersEl.appendChild(el);
      const line = document.createElementNS(SVGNS, 'polyline');
      line.setAttribute('class', 'leader-line');
      leadersEl.appendChild(line);
      const dot = document.createElementNS(SVGNS, 'circle');
      dot.setAttribute('class', 'leader-dot');
      dot.setAttribute('r', '3.5');
      dot.setAttribute('fill', color);
      leadersEl.appendChild(dot);
      labelItems.push({ el, line, dot, pos: boxCenter(box), w: el.offsetWidth, h: el.offsetHeight });
    }
  }
  const placeLabels = () => {
    if (!labelItems.length) return;
    const W = innerWidth, H = innerHeight;
    const camPos = viewer.navigation.getPosition();
    // カメラ方向は Navigation の公式 API には無い（getWorldDirection は存在しない）。
    // app.js の updateLabels と同じく impl.camera から取る。
    const camDir = new T.Vector3();
    const cam = viewer.impl?.camera;
    if (cam?.getWorldDirection) cam.getWorldDirection(camDir);
    else {
      const tgt = viewer.navigation.getTarget();
      camDir.set(tgt.x - camPos.x, tgt.y - camPos.y, tgt.z - camPos.z).normalize();
    }
    const B = { l: W * 0.125, r: W * 0.875, t: H * 0.18, b: H * 0.74 };
    const vis = [];
    for (const it of labelItems) {
      const v = new T.Vector3(it.pos.x, it.pos.y, it.pos.z);
      const toP = v.clone().sub(camPos);
      if (toP.lengthSq() < 1e-9 || camDir.dot(toP.normalize()) <= 0.02) { it.el.style.display = 'none'; it.line.style.display = 'none'; it.dot.style.display = 'none'; continue; }
      const c = viewer.worldToClient(v);
      if (!c || c.x < -20 || c.x > W + 20 || c.y < -20 || c.y > H + 20) { it.el.style.display = 'none'; it.line.style.display = 'none'; it.dot.style.display = 'none'; continue; }
      vis.push({ it, anchor: { x: c.x, y: c.y } });
    }
    const C = { x: W / 2, y: vis.length ? vis.reduce((s, v) => s + v.anchor.y, 0) / vis.length : H / 2 };
    const rayExitRect = (cx, cy, px, py, r) => {
      const dx = px - cx, dy = py - cy;
      if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return { x: r.r, y: cy };
      let t = Infinity;
      if (dx > 0) t = Math.min(t, (r.r - cx) / dx); else if (dx < 0) t = Math.min(t, (r.l - cx) / dx);
      if (dy > 0) t = Math.min(t, (r.b - cy) / dy); else if (dy < 0) t = Math.min(t, (r.t - cy) / dy);
      return { x: cx + dx * (isFinite(t) ? t : 0), y: cy + dy * (isFinite(t) ? t : 0) };
    };
    for (const v of vis) {
      const e = rayExitRect(C.x, C.y, v.anchor.x, v.anchor.y, B);
      let side;
      if (Math.abs(e.x - B.l) < 0.6) side = 'l'; else if (Math.abs(e.x - B.r) < 0.6) side = 'r';
      else if (Math.abs(e.y - B.t) < 0.6) side = 't'; else side = 'b';
      if (side === 'l') { v.lx = e.x - v.it.w - 4; v.ly = e.y - v.it.h / 2; }
      else if (side === 'r') { v.lx = e.x + 4; v.ly = e.y - v.it.h / 2; }
      else if (side === 't') { v.lx = e.x - v.it.w / 2; v.ly = e.y - v.it.h - 4; }
      else { v.lx = e.x - v.it.w / 2; v.ly = e.y + 4; }
      v.side = side;
    }
    for (const side of ['l', 'r', 't', 'b']) {
      const grp = vis.filter(v => v.side === side);
      const vert = side === 'l' || side === 'r';
      grp.sort((a, b) => (vert ? a.ly - b.ly : a.lx - b.lx));
      for (let k = 1; k < grp.length; k++) {
        const prev = grp[k - 1], cur = grp[k];
        const minPos = (vert ? prev.ly + prev.it.h : prev.lx + prev.it.w) + 6;
        if (vert ? cur.ly < minPos : cur.lx < minPos) { if (vert) cur.ly = minPos; else cur.lx = minPos; }
      }
    }
    for (const v of vis) {
      const { it, anchor } = v;
      it.el.style.display = '';
      it.el.style.transform = `translate(${Math.round(v.lx)}px, ${Math.round(v.ly)}px)`;
      const ex = v.lx > anchor.x ? v.lx : v.lx + it.w;
      const ey = Math.min(Math.max(anchor.y, v.ly + 2), v.ly + it.h - 2);
      it.line.setAttribute('points', `${anchor.x},${anchor.y} ${ex},${ey}`);
      it.line.style.display = '';
      it.dot.setAttribute('cx', anchor.x);
      it.dot.setAttribute('cy', anchor.y);
      it.dot.style.display = '';
    }
  };

  // 描画の安定を待ってから撮影する
  say('描画の安定を待っています…');
  await sleep(1800);
  placeLabels();
  await sleep(300);
  say('撮影中…');
  const dataUrl = await new Promise((resolve, reject) => {
    try {
      viewer.getScreenShot(960, 720, (url) => {
        if (!url) return reject(new Error('getScreenShot が画像を返しませんでした'));
        if (url.startsWith('data:')) return resolve(url);
        fetch(url).then(r => r.blob()).then(blob => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result);
          fr.onerror = () => reject(new Error('画像の読み取りに失敗しました'));
          fr.readAsDataURL(blob);
        }).catch(reject);
      });
    } catch (e) { reject(e); }
  });
  const png = String(dataUrl).split(',')[1];
  if (!png) return fail('撮影画像の形式が不正でした');
  const post = await fetch(`/api/captures/${jobId}/image`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ png }),
  });
  if (!post.ok) return fail('画像の保存に失敗しました（HTTP ' + post.status + '）');
  window.__capture = { status: 'done' };
  say('撮影完了');
}
main().catch(e => fail(e.message ?? String(e)));
