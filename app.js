'use strict';

// ===== Cấu hình =====
const DEFAULTS = { fov: 70, cal: 1.0, hor: 50, hood: 12, beep: true, dbg: false };
const VEHICLE_WIDTH = { car: 1.8, truck: 2.5, bus: 2.5, motorcycle: 0.8 }; // m
const LANE_WIDTH_M = 3.75;      // làn xe cao tốc (TCVN 5729:2012)
const LANE_W = 320;             // độ phân giải khung xử lý vạch kẻ
const DETECT_MIN_SCORE = 0.4;

let cfg = loadCfg();

function loadCfg() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('cfg') || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
function saveCfg() {
  try { localStorage.setItem('cfg', JSON.stringify(cfg)); } catch {}
}

// Khoảng cách an toàn tối thiểu (m) theo tốc độ — Thông tư 38/2024/TT-BGTVT, điều kiện khô ráo.
// Dưới 60 km/h: dùng quy tắc 2 giây.
function safeDistance(kmh) {
  if (kmh == null) return null;
  if (kmh < 60) return Math.max(10, (kmh / 3.6) * 2);
  if (kmh <= 60) return 35;
  if (kmh <= 80) return 55;
  if (kmh <= 100) return 70;
  return 100;
}

// ===== DOM =====
const $ = (id) => document.getElementById(id);
const video = $('cam');
const view = $('view');
const vctx = view.getContext('2d');
const small = document.createElement('canvas');
const sctx = small.getContext('2d', { willReadFrequently: true });

// ===== Trạng thái =====
let model = null;
let detections = [];          // [{cls, x, y, w, h}] toạ độ pixel video
let lanes = { left: null, right: null, lost: 99 }; // line: {a, b, solid, cov} với x = a*y + b (toạ độ khung nhỏ)
let laneIndex = null;         // 1 = làn sát dải phân cách
let prevOffset = null;
let lead = null;              // {D, t, box}
let closingSpeed = 0;         // m/s, > 0 là đang tiến lại gần
let speedKmh = null;
let audioCtx = null;
let lastBeep = 0;
let lastLevel = 'ok';
let debugPts = [];
let wakeLock = null;

// ===== Khởi động =====
$('btnStart').addEventListener('click', start);
$('btnSet').addEventListener('click', () => { bindSettings(); $('settings').hidden = false; });
$('btnClose').addEventListener('click', () => { $('settings').hidden = true; saveCfg(); });
$('btnReset').addEventListener('click', () => { cfg = { ...DEFAULTS }; saveCfg(); bindSettings(); });

async function start() {
  $('intro').hidden = true;
  try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
  try {
    await document.documentElement.requestFullscreen?.();
    await screen.orientation?.lock?.('landscape');
  } catch {}
  requestWakeLock();
  startGps();

  try {
    status('Đang mở camera…');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    video.srcObject = stream;
    await video.play();
  } catch (e) {
    status('Không mở được camera: ' + e.message);
    return;
  }

  requestAnimationFrame(render);

  try {
    status('Đang tải mô hình nhận dạng xe…');
    await tf.setBackend('webgl').catch(() => {});
    model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
    status('Đang chạy · ' + tf.getBackend());
    detectLoop();
  } catch (e) {
    status('Lỗi tải mô hình (cần mạng lần đầu): ' + e.message);
  }
}

function status(t) { $('status').textContent = t; }

async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') requestWakeLock();
});

function startGps() {
  if (!navigator.geolocation) return;
  navigator.geolocation.watchPosition(
    (p) => {
      const s = p.coords.speed;
      speedKmh = s == null || isNaN(s) ? null : s * 3.6;
      $('speedVal').textContent = speedKmh == null ? '--' : Math.round(speedKmh);
    },
    () => { $('speedVal').textContent = '--'; },
    { enableHighAccuracy: true, maximumAge: 1000 }
  );
}

// ===== Nhận dạng xe (COCO-SSD) =====
let fpsDet = 0;
async function detectLoop() {
  let last = performance.now();
  while (true) {
    if (video.readyState >= 2) {
      try {
        const preds = await model.detect(video, 20, DETECT_MIN_SCORE);
        detections = preds
          .filter((p) => VEHICLE_WIDTH[p.class])
          .map((p) => ({ cls: p.class, score: p.score, x: p.bbox[0], y: p.bbox[1], w: p.bbox[2], h: p.bbox[3] }));
      } catch {}
      updateLead();
    }
    const now = performance.now();
    fpsDet = 0.9 * fpsDet + 0.1 * (1000 / Math.max(1, now - last));
    last = now;
    await new Promise((r) => setTimeout(r, 0));
  }
}

// ===== Dò vạch kẻ đường =====
function laneX(line, y) { return line.a * y + line.b; }

function detectLanes() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw) return;
  const W = LANE_W, H = Math.round((LANE_W * vh) / vw);
  if (small.width !== W) { small.width = W; small.height = H; }
  sctx.drawImage(video, 0, 0, W, H);
  const img = sctx.getImageData(0, 0, W, H).data;

  const y0 = Math.round((cfg.hor / 100) * H) + 2;
  const y1 = Math.round((1 - cfg.hood / 100) * H) - 1;
  if (y1 - y0 < 10) return;

  // Ô che xe (không lấy cạnh xe làm vạch)
  const sx = W / vw;
  const boxes = detections.map((d) => [d.x * sx - 2, d.y * sx - 2, (d.x + d.w) * sx + 2, (d.y + d.h) * sx + 2]);

  // Điểm tụ (vanishing point) từ khung trước, để quét từ "giữa xe" theo phối cảnh
  let vpX = W / 2;
  if (lanes.left && lanes.right && lanes.right.a - lanes.left.a > 0.05) {
    const yv = (lanes.left.b - lanes.right.b) / (lanes.right.a - lanes.left.a);
    vpX = Math.min(W * 0.8, Math.max(W * 0.2, laneX(lanes.left, yv)));
  }

  const g = new Float32Array(W);
  const L = [], R = [];
  let rows = 0;
  for (let y = y0; y <= y1; y += 2) {
    rows++;
    let mean = 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      g[x] = (img[i] + img[i + 1]) * 0.5; // R+G: bắt cả vạch trắng và vàng
      mean += g[x];
    }
    mean /= W;
    const t = (y - y0) / (y1 - y0);
    const k = Math.max(2, Math.round(2 + 7 * t)); // bề rộng vạch tăng dần về phía gần
    const isMark = (x) => {
      if (x - k < 0 || x + k >= W) return false;
      const c = g[x];
      if (c < mean + 18) return false;
      if (c - g[x - k] < 22 || c - g[x + k] < 22) return false;
      for (const b of boxes) if (x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]) return false;
      return true;
    };
    const cx = Math.round(vpX + (W / 2 - vpX) * t);
    for (let x = cx; x > k; x--) if (isMark(x)) { let e = x; while (e > k && isMark(e - 1)) e--; L.push([(x + e) / 2, y]); break; }
    for (let x = cx; x < W - k; x++) if (isMark(x)) { let e = x; while (e < W - k - 1 && isMark(e + 1)) e++; R.push([(x + e) / 2, y]); break; }
  }

  const left = fitLine(L, -1, rows);
  const right = fitLine(R, +1, rows);
  debugPts = cfg.dbg ? L.concat(R) : [];

  let ok = left && right;
  if (ok) {
    const wb = laneX(right, y1) - laneX(left, y1);
    if (wb < W * 0.2 || wb > W * 1.4) ok = false;
  }
  if (ok) {
    lanes.left = smoothLine(lanes.left, left);
    lanes.right = smoothLine(lanes.right, right);
    lanes.lost = 0;
    lanes.H = H; lanes.W = W; lanes.y0 = y0; lanes.y1 = y1;
    trackLaneChange();
  } else if (++lanes.lost > 15) {
    lanes.left = lanes.right = null;
    prevOffset = null;
  }
}

// RANSAC x = a*y + b; sign: -1 vạch trái (a<0), +1 vạch phải (a>0)
function fitLine(pts, sign, rows) {
  if (pts.length < 6) return null;
  let best = null, bestIn = null;
  for (let it = 0; it < 50; it++) {
    const p = pts[(Math.random() * pts.length) | 0], q = pts[(Math.random() * pts.length) | 0];
    if (Math.abs(p[1] - q[1]) < 6) continue;
    const a = (p[0] - q[0]) / (p[1] - q[1]);
    if (a * sign <= 0.15 || a * sign > 6) continue;
    const b = p[0] - a * p[1];
    const inl = pts.filter((r) => Math.abs(a * r[1] + b - r[0]) < 2.5 + 0.02 * r[1]);
    if (!bestIn || inl.length > bestIn.length) { bestIn = inl; best = { a, b }; }
  }
  if (!bestIn || bestIn.length < 6) return null;
  // Bình phương tối thiểu trên inlier
  let sy = 0, sx = 0, syy = 0, sxy = 0;
  for (const [x, y] of bestIn) { sy += y; sx += x; syy += y * y; sxy += x * y; }
  const n = bestIn.length, den = n * syy - sy * sy;
  if (Math.abs(den) > 1e-6) { best.a = (n * sxy - sx * sy) / den; best.b = (sx - best.a * sy) / n; }
  if (best.a * sign <= 0.1) return null;
  best.cov = n / rows;           // tỉ lệ phủ: liền > ~0.65, đứt < ~0.5
  return best;
}

function smoothLine(prev, cur) {
  if (!prev) return { ...cur, covS: cur.cov };
  const k = 0.35;
  return {
    a: prev.a + (cur.a - prev.a) * k,
    b: prev.b + (cur.b - prev.b) * k,
    cov: cur.cov,
    covS: prev.covS + (cur.cov - prev.covS) * 0.1, // làm mượt chậm để phân biệt liền/đứt
  };
}

function trackLaneChange() {
  const { left, right, W, y1 } = lanes;
  const xl = laneX(left, y1), xr = laneX(right, y1);
  const offset = ((xl + xr) / 2 - W / 2) / (xr - xl); // >0: tâm làn lệch phải so với xe
  if (prevOffset != null && laneIndex != null) {
    if (prevOffset > 0.3 && offset < -0.3) laneIndex = Math.max(1, laneIndex - 1); // sang trái
    else if (prevOffset < -0.3 && offset > 0.3) laneIndex += 1;                   // sang phải
  }
  prevOffset = offset;
  lanes.offset = offset;
  const ls = left.covS > 0.62, rs = right.covS > 0.62;
  lanes.leftSolid = ls; lanes.rightSolid = rs;
  if (ls) laneIndex = 1; // vạch liền bên trái = sát dải phân cách giữa
}

function laneLabel() {
  if (!lanes.left || !lanes.right) return ['--', 'Đang dò vạch kẻ đường'];
  const { leftSolid: ls, rightSolid: rs } = lanes;
  let name, sub;
  if (ls && rs) name = 'Làn duy nhất';
  else if (ls) name = 'Làn 1 · trong cùng';
  else if (rs) name = (laneIndex ? `Làn ${laneIndex} · ` : '') + 'ngoài cùng';
  else name = laneIndex ? `Làn ${laneIndex} · giữa` : 'Làn giữa';
  sub = `Trái: ${ls ? 'liền' : 'đứt'} · Phải: ${rs ? 'liền' : 'đứt'}`;
  const off = lanes.offset;
  if (Math.abs(off) > 0.25) sub += off > 0 ? ' · lệch trái' : ' · lệch phải';
  return [name, sub];
}

// ===== Xe phía trước & khoảng cách =====
function focalPx(imgW) { return imgW / 2 / Math.tan((cfg.fov * Math.PI) / 360); }

function updateLead() {
  const vw = video.videoWidth;
  if (!vw) return;
  const sx = LANE_W / vw;
  let cand = null;
  for (const d of detections) {
    if (d.x < 2 || d.x + d.w > vw - 2) continue; // bị cắt ở mép khung -> bỏ
    const bx = (d.x + d.w / 2) * sx, by = (d.y + d.h) * sx;
    let inLane;
    if (lanes.left && lanes.right) {
      const xl = laneX(lanes.left, by), xr = laneX(lanes.right, by);
      const m = (xr - xl) * 0.1;
      inLane = bx > xl - m && bx < xr + m;
    } else {
      inLane = Math.abs(bx - LANE_W / 2) < LANE_W * 0.12 + d.w * sx * 0.3;
    }
    if (inLane && (!cand || d.y + d.h > cand.y + cand.h)) cand = d;
  }

  const now = performance.now() / 1000;
  if (!cand) { if (lead && now - lead.t > 1) lead = null; return; }

  // (1) Theo bề rộng xe
  const Dw = (focalPx(vw) * VEHICLE_WIDTH[cand.cls]) / cand.w;
  // (2) Theo bề rộng làn tại hàng chân xe (không phụ thuộc loại xe)
  let Dl = null;
  if (lanes.left && lanes.right) {
    const by = (cand.y + cand.h) * sx;
    const wl = laneX(lanes.right, by) - laneX(lanes.left, by);
    if (by > lanes.y0 - 10 && wl > 4) Dl = (focalPx(LANE_W) * LANE_WIDTH_M) / wl;
  }
  let D = Dl && Dl / Dw > 0.6 && Dl / Dw < 1.6 ? 0.6 * Dl + 0.4 * Dw : Dw;
  D *= cfg.cal;

  if (lead && Math.abs(D - lead.D) / lead.D < 0.35) {
    const dt = Math.max(0.03, now - lead.t);
    const Ds = lead.D + (D - lead.D) * 0.3;
    closingSpeed = closingSpeed * 0.85 + ((lead.D - Ds) / dt) * 0.15;
    lead = { D: Ds, t: now, box: cand };
  } else {
    lead = { D, t: now, box: cand };
    closingSpeed = 0;
  }
}

// ===== Cảnh báo âm thanh =====
function beep(freq, ms) {
  if (!audioCtx || !cfg.beep) return;
  const o = audioCtx.createOscillator(), gn = audioCtx.createGain();
  o.frequency.value = freq; o.type = 'square';
  gn.gain.value = 0.15;
  o.connect(gn); gn.connect(audioCtx.destination);
  o.start(); o.stop(audioCtx.currentTime + ms / 1000);
}

function alertLevel() {
  if (!lead) return 'ok';
  const safe = safeDistance(speedKmh);
  const ttc = closingSpeed > 0.5 ? lead.D / closingSpeed : Infinity;
  if (ttc < 2.5 || (safe && lead.D < safe * 0.6)) return 'bad';
  if (ttc < 4 || (safe && lead.D < safe)) return 'warn';
  return 'ok';
}

// ===== Vẽ =====
let frame = 0;
function render() {
  requestAnimationFrame(render);
  if (video.readyState < 2) return;
  if (frame++ % 2 === 0) detectLanes();

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = Math.round(innerWidth * dpr), ch = Math.round(innerHeight * dpr);
  if (view.width !== cw || view.height !== ch) { view.width = cw; view.height = ch; }

  // object-fit: cover
  const vw = video.videoWidth, vh = video.videoHeight;
  const s = Math.max(cw / vw, ch / vh);
  const ox = (cw - vw * s) / 2, oy = (ch - vh * s) / 2;
  vctx.drawImage(video, ox, oy, vw * s, vh * s);

  const k = vw / LANE_W; // khung nhỏ -> pixel video
  const P = (x, y) => [ox + x * k * s, oy + y * k * s];

  // Làn đường
  if (lanes.left && lanes.right) {
    const yt = lanes.y0, yb = lanes.H;
    const pts = [P(laneX(lanes.left, yt), yt), P(laneX(lanes.right, yt), yt), P(laneX(lanes.right, yb), yb), P(laneX(lanes.left, yb), yb)];
    vctx.fillStyle = 'rgba(34,197,94,0.22)';
    vctx.beginPath(); pts.forEach((p, i) => (i ? vctx.lineTo(...p) : vctx.moveTo(...p))); vctx.closePath(); vctx.fill();
    for (const [line, solid] of [[lanes.left, lanes.leftSolid], [lanes.right, lanes.rightSolid]]) {
      vctx.strokeStyle = solid ? '#facc15' : '#ffffff';
      vctx.lineWidth = 5 * dpr;
      vctx.setLineDash(solid ? [] : [18 * dpr, 14 * dpr]);
      vctx.beginPath(); vctx.moveTo(...P(laneX(line, yt), yt)); vctx.lineTo(...P(laneX(line, yb), yb)); vctx.stroke();
    }
    vctx.setLineDash([]);
  }
  if (cfg.dbg) {
    vctx.fillStyle = '#0ff';
    for (const [x, y] of debugPts) { const [px, py] = P(x, y); vctx.fillRect(px - 2, py - 2, 4, 4); }
    const [hx, hy] = P(0, (cfg.hor / 100) * (lanes.H || 180)), [hx2] = P(LANE_W, 0);
    vctx.strokeStyle = '#0ff'; vctx.beginPath(); vctx.moveTo(hx, hy); vctx.lineTo(hx2, hy); vctx.stroke();
  }

  // Xe
  const level = alertLevel();
  const col = { ok: '#22c55e', warn: '#f59e0b', bad: '#ef4444' };
  for (const d of detections) {
    const isLead = lead && d === lead.box;
    vctx.strokeStyle = isLead ? col[level] : 'rgba(255,255,255,0.5)';
    vctx.lineWidth = (isLead ? 4 : 2) * dpr;
    vctx.strokeRect(ox + d.x * s, oy + d.y * s, d.w * s, d.h * s);
    if (isLead) {
      vctx.font = `bold ${22 * dpr}px system-ui`;
      vctx.fillStyle = col[level];
      vctx.fillText(lead.D.toFixed(0) + ' m', ox + d.x * s, oy + d.y * s - 8 * dpr);
    }
  }

  updateHud(level);
}

function updateHud(level) {
  const dv = $('distVal'), ds = $('distSub'), box = $('dist');
  if (lead) {
    dv.textContent = lead.D.toFixed(0) + ' m';
    dv.style.color = level === 'bad' ? '#ef4444' : level === 'warn' ? '#f59e0b' : '#22c55e';
    const safe = safeDistance(speedKmh);
    const parts = [];
    if (safe) parts.push(`An toàn ≥ ${Math.round(safe)} m`);
    if (speedKmh > 5) parts.push(`${(lead.D / (speedKmh / 3.6)).toFixed(1)} s`);
    if (closingSpeed > 0.5) parts.push(`đang gần lại ${(closingSpeed * 3.6).toFixed(0)} km/h`);
    ds.textContent = parts.join(' · ') || 'Xe phía trước';
  } else {
    dv.textContent = '--'; dv.style.color = '#fff';
    ds.textContent = 'Chưa thấy xe phía trước';
  }
  box.classList.toggle('flash', level === 'bad');

  const now = performance.now();
  if (level === 'bad' && now - lastBeep > 500) { beep(1200, 150); lastBeep = now; }
  else if (level === 'warn' && lastLevel === 'ok') { beep(800, 200); lastBeep = now; }
  lastLevel = level;

  const [n, sub] = laneLabel();
  $('laneName').textContent = n;
  $('laneSub').textContent = sub;
}

// ===== Cài đặt =====
function bindSettings() {
  for (const id of ['fov', 'cal', 'hor', 'hood']) {
    const el = $(id), out = $(id + 'V');
    el.value = cfg[id]; out.textContent = cfg[id];
    el.oninput = () => { cfg[id] = parseFloat(el.value); out.textContent = el.value; };
  }
  for (const id of ['beep', 'dbg']) {
    const el = $(id);
    el.checked = cfg[id];
    el.onchange = () => { cfg[id] = el.checked; };
  }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
