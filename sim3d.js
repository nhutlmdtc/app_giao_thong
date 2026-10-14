// Mô phỏng 3D bằng Three.js (module ES). Tải không được thì app.js tự dùng bản vẽ 2D.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.min.js';

const LW = 3.75;        // bề rộng làn (m)
const FAR = 170;        // vẽ mặt đường tới (m)
const DASH = 12, DASH_ON = 4;

let renderer, scene, camera, canvas, hemi, sun;
let roadGroup = null, roadKey = '';
let dashLines = [];     // [{x, meshes[]}]
let zones = [];
let ego = null, egoKey = '';
const cars = new Map(); // id -> {group, key}
const tmpV = new THREE.Vector3();
let curRect = null;

// ===== Vật liệu dùng chung =====
const mat = {
  road: new THREE.MeshLambertMaterial({ color: 0x2b3038 }),
  side: new THREE.MeshLambertMaterial({ color: 0x1c2026 }),
  white: new THREE.MeshBasicMaterial({ color: 0xe5e7eb }),
  yellow: new THREE.MeshBasicMaterial({ color: 0xfacc15 }),
  dim: new THREE.MeshBasicMaterial({ color: 0x8b95a5 }),
  glass: new THREE.MeshLambertMaterial({ color: 0x0f172a }),
  tire: new THREE.MeshLambertMaterial({ color: 0x111111 }),
  tail: new THREE.MeshBasicMaterial({ color: 0xef4444 }),
  shadow: new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }),
  cargo: new THREE.MeshLambertMaterial({ color: 0xd1d5db }),
  barrier: new THREE.MeshLambertMaterial({ color: 0x4b5563 }),
};

function init() {
  canvas = document.createElement('canvas');
  canvas.id = 'gl';
  canvas.style.cssText = 'position:fixed;left:0;top:0;width:10px;height:10px;display:block';
  document.body.insertBefore(canvas, document.getElementById('view'));
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0b0f14, 90, FAR);
  camera = new THREE.PerspectiveCamera(40, 1, 0.5, 400);
  camera.position.set(0, 8, 16);
  camera.lookAt(0, 0, -22);
  hemi = new THREE.HemisphereLight(0xffffff, 0x334155, 1.6);
  sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(-6, 12, 8);
  scene.add(hemi, sun);
  for (let i = 0; i < 3; i++) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.3, depthWrite: false }));
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.012;
    scene.add(m);
    zones.push(m);
  }
}

// ===== Mặt đường =====
function buildRoad(c) {
  if (roadGroup) { scene.remove(roadGroup); roadGroup.traverse((o) => o.geometry && o.geometry.dispose()); }
  roadGroup = new THREE.Group();
  dashLines = [];
  const L = -LW / 2 - c.nL * LW, R = LW / 2 + c.nR * LW;
  const plane = (x0, x1, m, y = 0) => {
    const g = new THREE.PlaneGeometry(x1 - x0, FAR + 40);
    const p = new THREE.Mesh(g, m);
    p.rotation.x = -Math.PI / 2;
    p.position.set((x0 + x1) / 2, y, -(FAR + 40) / 2 + 20);
    roadGroup.add(p);
  };
  plane(L - 40, L, mat.side, -0.02);
  plane(R, R + 40, mat.side, -0.02);
  plane(L, R, mat.road);
  // Dải phân cách giữa (gờ bê tông thấp) khi biết mép trái
  if (c.edgeL) {
    const g = new THREE.BoxGeometry(0.4, 0.6, FAR + 40);
    const b = new THREE.Mesh(g, mat.barrier);
    b.position.set(L - 0.9, 0.3, -(FAR + 40) / 2 + 20);
    roadGroup.add(b);
  }
  const solid = (x, m) => plane(x - 0.08, x + 0.08, m, 0.01);
  const dashed = (x, m) => {
    const meshes = [];
    for (let z = 0; z < FAR + DASH * 2; z += DASH) {
      const d = new THREE.Mesh(new THREE.PlaneGeometry(0.15, DASH_ON), m);
      d.rotation.x = -Math.PI / 2;
      d.position.set(x, 0.01, 0);
      roadGroup.add(d);
      meshes.push(d);
    }
    dashLines.push(meshes);
  };
  // Vạch trái/phải làn mình
  c.ls ? solid(-LW / 2, mat.yellow) : dashed(-LW / 2, mat.white);
  c.rs ? solid(LW / 2, mat.white) : dashed(LW / 2, mat.white);
  for (let i = 1; i <= c.nL; i++) {
    const x = -LW / 2 - i * LW;
    i === c.nL && c.edgeL ? solid(x, mat.yellow) : dashed(x, mat.dim);
  }
  for (let i = 1; i <= c.nR; i++) {
    const x = LW / 2 + i * LW;
    i === c.nR && c.edgeR ? solid(x, mat.white) : dashed(x, mat.dim);
  }
  scene.add(roadGroup);
}

// ===== Mô hình xe tự dựng =====
// Mặt cắt dọc chuẩn hoá: x 0 (đuôi) → 1 (đầu), y 0 → 1 (cao). belt = đường viền cửa kính; cabin = khoang kính.
const PROFILE = {
  sedan: { belt: 0.6, hoodX: 0.74, cabin: [[0.17, 0.6], [0.32, 1], [0.6, 1], [0.76, 0.6]], nose: 0.45 },
  hatch: { belt: 0.6, hoodX: 0.76, cabin: [[0.02, 0.6], [0.1, 1], [0.6, 1], [0.76, 0.6]], nose: 0.45 },
  suv: { belt: 0.63, hoodX: 0.8, cabin: [[0.01, 0.63], [0.05, 1], [0.66, 1], [0.8, 0.63]], nose: 0.5 },
  mpv: { belt: 0.6, hoodX: 0.88, cabin: [[0.01, 0.6], [0.04, 1], [0.72, 1], [0.88, 0.6]], nose: 0.48 },
  pickup: { belt: 0.62, hoodX: 0.8, cabin: [[0.38, 0.62], [0.42, 1], [0.68, 1], [0.8, 0.62]], nose: 0.52 },
  mini: { belt: 0.6, hoodX: 0.86, cabin: [[0.01, 0.6], [0.04, 1], [0.74, 1], [0.86, 0.6]], nose: 0.5 },
};

// Hình phẳng (dài × cao) đùn theo bề rộng; trả về mesh với đuôi xe ở z=0, đầu xe ở z=-len
function extrude(pts, len, h, width, material) {
  const sh = new THREE.Shape();
  pts.forEach(([x, y], i) => (i ? sh.lineTo(x * len, y * h) : sh.moveTo(x * len, y * h)));
  const g = new THREE.ExtrudeGeometry(sh, { depth: width, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.04, bevelSegments: 2 });
  g.translate(0, 0, -width / 2);
  g.rotateY(Math.PI / 2); // trục dài x → -z
  return new THREE.Mesh(g, material);
}

function wheels(group, len, w, r) {
  const g = new THREE.CylinderGeometry(r, r, 0.26, 16);
  g.rotateZ(Math.PI / 2);
  for (const zf of [0.17, 0.8]) for (const s of [-1, 1]) {
    const m = new THREE.Mesh(g, mat.tire);
    m.position.set(s * (w / 2 - 0.1), r, -zf * len);
    group.add(m);
  }
}

function makeCar(type, dims, color) {
  const [len, w, h] = dims;
  const p = PROFILE[type] || PROFILE.sedan;
  const body = new THREE.MeshLambertMaterial({ color });
  const g = new THREE.Group();
  const clr = 0.13; // gầm xe
  const lower = [[0, clr], [0, p.belt - 0.04], [0.03, p.belt], [p.hoodX, p.belt], [0.97, p.nose + 0.05], [1, p.nose], [1, clr]];
  if (type === 'pickup') lower.splice(2, 0, [0.36, p.belt - 0.04]);
  g.add(extrude(lower, len, h, w - 0.08, body));
  g.add(extrude(p.cabin, len, h, w * 0.86, mat.glass));
  // Nóc xe màu thân
  const [a, b] = [p.cabin[1], p.cabin[2]];
  g.add(extrude([[a[0] + 0.02, 0.95], [a[0] + 0.02, 1.02], [b[0] - 0.02, 1.02], [b[0] - 0.02, 0.95]], len, h, w * 0.82, body));
  wheels(g, len, w, 0.3 * (h / 1.5));
  // Đèn hậu
  const tl = new THREE.BoxGeometry(w * 0.22, h * 0.07, 0.05);
  for (const s of [-1, 1]) {
    const m = new THREE.Mesh(tl, mat.tail);
    m.position.set(s * w * 0.33, h * (p.belt - 0.1), 0.03);
    g.add(m);
  }
  addShadow(g, len, w);
  g.userData.mats = [body];
  return g;
}

function makeTruck(color) {
  const g = new THREE.Group();
  const cab = new THREE.MeshLambertMaterial({ color });
  const box = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.9, 6.6), mat.cargo);
  box.position.set(0, 0.55 + 1.45, -3.3);
  const c = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.4, 2.0), cab);
  c.position.set(0, 0.55 + 1.2, -7.7);
  const glass = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.9, 0.05), mat.glass);
  glass.position.set(0, 0.55 + 1.9, -8.71);
  g.add(box, c, glass);
  wheels(g, 8.7, 2.4, 0.5);
  for (const s of [-1, 1]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.15, 0.05), mat.tail);
    m.position.set(s * 0.95, 0.75, 0.03);
    g.add(m);
  }
  addShadow(g, 8.7, 2.5);
  g.userData.mats = [cab];
  return g;
}

function makeBus(color) {
  const g = new THREE.Group();
  const body = new THREE.MeshLambertMaterial({ color });
  const b = new THREE.Mesh(new THREE.BoxGeometry(2.5, 3.0, 11), body);
  b.position.set(0, 0.4 + 1.5, -5.5);
  const win = new THREE.Mesh(new THREE.BoxGeometry(2.54, 0.9, 10.4), mat.glass);
  win.position.set(0, 0.4 + 2.15, -5.5);
  const rear = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.8, 0.05), mat.glass);
  rear.position.set(0, 0.4 + 2.2, 0.01);
  g.add(b, win, rear);
  wheels(g, 11, 2.4, 0.5);
  for (const s of [-1, 1]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.2, 0.05), mat.tail);
    m.position.set(s * 1.0, 0.9, 0.03);
    g.add(m);
  }
  addShadow(g, 11, 2.5);
  g.userData.mats = [body];
  return g;
}

function makeMoto(color) {
  const g = new THREE.Group();
  const body = new THREE.MeshLambertMaterial({ color });
  const b = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.6, 1.8), body);
  b.position.set(0, 0.6, -0.9);
  const rider = new THREE.Mesh(new THREE.CapsuleGeometry(0.25, 0.6, 4, 8), mat.glass);
  rider.position.set(0, 1.3, -0.8);
  const t = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.1, 0.05), mat.tail);
  t.position.set(0, 0.8, 0.02);
  g.add(b, rider, t);
  addShadow(g, 1.9, 0.8);
  g.userData.mats = [body];
  return g;
}

function addShadow(g, len, w) {
  const s = new THREE.Mesh(new THREE.PlaneGeometry(w + 0.3, len + 0.3), mat.shadow);
  s.rotation.x = -Math.PI / 2;
  s.position.set(0, 0.015, -len / 2);
  g.add(s);
}

function disposeGroup(g) {
  scene.remove(g);
  g.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  for (const m of g.userData.mats || []) m.dispose();
}

function vehicleFor(t) {
  const col = t.color || '#9ca3af';
  if (t.cls === 'truck') return { key: 'truck', make: () => makeTruck(col) };
  if (t.cls === 'bus') return { key: 'bus', make: () => makeBus(col) };
  if (t.cls === 'motorcycle') return { key: 'moto', make: () => makeMoto(col) };
  const type = t.tall ? 'suv' : 'sedan';
  return { key: type, make: () => makeCar(type, type === 'suv' ? [4.55, 1.83, 1.68] : [4.5, 1.75, 1.45], col) };
}

// ===== Vẽ 1 khung =====
// s: {rect, bg, ok, warn, bad, accent, lane:{nL,nR,edgeL,edgeR,ls,rs}, egoX, speedMs, dt, safe, level,
//     tracks:[{id, cls, D, x, color, tall}], leadId, ego:{type, dims, color}}
let phase = 0;
function render(s) {
  const { rect } = s;
  if (!curRect || curRect.x !== rect.x || curRect.y !== rect.y || curRect.w !== rect.w || curRect.h !== rect.h) {
    curRect = { ...rect };
    canvas.style.left = rect.x + 'px'; canvas.style.top = rect.y + 'px';
    canvas.style.width = rect.w + 'px'; canvas.style.height = rect.h + 'px';
    renderer.setSize(rect.w, rect.h, false);
    camera.aspect = rect.w / rect.h;
    // Màn dọc hẹp: lùi camera để thấy đủ làn
    camera.fov = rect.w / rect.h < 1 ? 52 : 40;
    camera.updateProjectionMatrix();
  }
  const bg = new THREE.Color(s.bg);
  scene.background = bg;
  scene.fog.color.copy(bg);
  const night = s.night;
  hemi.intensity = night ? 0.7 : 1.6;
  sun.intensity = night ? 0.5 : 1.6;

  const key = JSON.stringify(s.lane);
  if (key !== roadKey) { roadKey = key; buildRoad(s.lane); }

  // Vạch đứt chạy theo tốc độ
  phase = (phase + s.speedMs * s.dt) % DASH;
  for (const meshes of dashLines) {
    meshes.forEach((m, i) => { m.position.z = -(i * DASH - phase) + 6 - DASH_ON / 2; });
  }

  // Vùng màu khoảng cách trên làn mình
  const zs = s.safe ? [[0, s.safe * 0.6, s.bad], [s.safe * 0.6, s.safe, s.warn], [s.safe, FAR, s.ok]] : [];
  zones.forEach((m, i) => {
    const z = zs[i];
    m.visible = !!z;
    if (!z) return;
    m.material.color.set(z[2]);
    m.scale.set(LW - 0.3, z[1] - z[0], 1);
    m.position.set(0, 0.012, -(z[0] + z[1]) / 2);
  });

  // Xe mình
  const ek = JSON.stringify(s.ego);
  if (ek !== egoKey) {
    egoKey = ek;
    if (ego) disposeGroup(ego);
    ego = makeCar(s.ego.type, s.ego.dims, s.ego.color);
    scene.add(ego);
  }
  ego.position.set(s.egoX, 0, s.ego.dims[0]); // cản trước tại z=0

  // Xe khác
  const seen = new Set();
  let leadScreen = null;
  for (const t of s.tracks) {
    seen.add(t.id);
    const v = vehicleFor(t);
    let c = cars.get(t.id);
    if (!c || c.key !== v.key) {
      if (c) disposeGroup(c.group);
      c = { group: v.make(), key: v.key, color: t.color };
      scene.add(c.group);
      cars.set(t.id, c);
    }
    if (t.color && t.color !== c.color) { c.color = t.color; c.group.userData.mats[0].color.set(t.color); }
    c.group.position.set(t.x, 0, -t.D);
    if (t.id === s.leadId) {
      tmpV.set(t.x + 1.3, 1.0, -t.D).project(camera);
      leadScreen = [rect.x + ((tmpV.x + 1) / 2) * rect.w, rect.y + ((1 - tmpV.y) / 2) * rect.h];
    }
  }
  for (const [id, c] of cars) if (!seen.has(id)) { disposeGroup(c.group); cars.delete(id); }

  renderer.render(scene, camera);

  // Toạ độ màn hình các mốc khoảng cách (để app.js vẽ chữ)
  const ticks = [];
  for (let m = 20; m <= 100; m += 20) {
    tmpV.set(-LW / 2 - s.lane.nL * LW - 0.6, 0, -m).project(camera);
    ticks.push([m, rect.x + ((tmpV.x + 1) / 2) * rect.w, rect.y + ((1 - tmpV.y) / 2) * rect.h]);
  }
  return { leadScreen, ticks };
}

function setVisible(v) { if (canvas) canvas.style.display = v ? 'block' : 'none'; }

try {
  init();
  window.Sim3D = { ready: true, render, setVisible };
} catch (e) {
  console.warn('Không khởi tạo được 3D:', e);
}
