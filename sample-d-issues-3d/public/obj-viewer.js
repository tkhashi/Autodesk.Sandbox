// obj-viewer.js — OBJ 表示用ビューア（three.js）。APS Viewer とは独立した軽量表示で、
// サーバーが切り出した「対象要素＋周辺」の OBJ を表示する。対象要素は赤、それ以外はグレー。
let THREE, OBJLoader, OrbitControls;
try {
  THREE = await import('three');
  ({ OBJLoader } = await import('three/addons/loaders/OBJLoader.js'));
  ({ OrbitControls } = await import('three/addons/controls/OrbitControls.js'));
} catch (e) {
  window.__objViewerFailed?.(e); // 読み込み失敗はステータス表示で知らせる（例外は外に出さない）
}

let renderer = null, scene = null, camera = null, controls = null, currentObj = null;

function ensure() {
  if (renderer) return true;
  const container = document.getElementById('objWrap');
  if (!container) return false;
  container.innerHTML = '';
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  container.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xdfe7ee);
  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100000);
  controls = new OrbitControls(camera, renderer.domElement);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a97a5, 1.1));
  const dir = new THREE.DirectionalLight(0xffffff, 1.6);
  dir.position.set(50, 80, 30);
  scene.add(dir);
  const dir2 = new THREE.DirectionalLight(0xdfeaff, 0.5);
  dir2.position.set(-40, -20, -50);
  scene.add(dir2);
  const resize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(container);
  resize();
  const loop = () => {
    requestAnimationFrame(loop);
    if (container.hidden) return;
    controls.update();
    renderer.render(scene, camera);
  };
  loop();
  return true;
}

function show(objText, targetDbId) {
  if (!ensure()) return;
  document.getElementById('objWrap')?.querySelector('.obj-msg')?.remove();
  if (currentObj) { scene.remove(currentObj); currentObj = null; }
  const group = new OBJLoader().parse(objText);
  const matTarget = new THREE.MeshStandardMaterial({ color: 0xe03131, roughness: 0.55, metalness: 0.05 });
  const matOther = new THREE.MeshStandardMaterial({ color: 0xaebfcd, roughness: 0.9, metalness: 0.0 });
  let targetMesh = null;
  group.traverse(o => {
    if (o.isMesh) {
      const isTarget = o.name === 'Obj.' + targetDbId;
      o.material = isTarget ? matTarget : matOther;
      if (isTarget) targetMesh = o;
    }
  });
  group.rotation.x = -Math.PI / 2; // OBJ（Z-up）を three.js（Y-up）に合わせる
  scene.add(group);
  currentObj = group;
  const box = new THREE.Box3().setFromObject(group);
  const center = box.getCenter(new THREE.Vector3());
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const dist = Math.max(sphere.radius * 2.4, 1);
  camera.position.set(center.x + dist * 0.7, center.y + dist * 0.55, center.z + dist * 0.7);
  camera.near = Math.max(dist / 1000, 0.01);
  camera.far = dist * 100;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
  return !!targetMesh;
}

function showMessage(text) {
  const container = document.getElementById('objWrap');
  if (!container) return;
  if (currentObj && scene) { scene.remove(currentObj); currentObj = null; }
  let el = container.querySelector('.obj-msg');
  if (!el) { el = document.createElement('div'); el.className = 'obj-msg'; container.appendChild(el); }
  el.textContent = text;
}

window.ObjView = { show, showMessage };
window.__objViewerReady?.();
