'use strict';

// ===== Cấu hình =====
const DEFAULTS = {
  fov: 70, cal: 1.0, hor: 50, hood: 12,
  carBrand: 'Khác', carModel: 'Sedan', carColor: '#f1f3f5',
  voice: true, laneWarn: true, speedWarn: true, beep: true, theme: 'auto', dbg: false, autoHor: true,
};
const VEHICLE_WIDTH = { car: 1.8, truck: 2.5, bus: 2.5, motorcycle: 0.8 }; // m
const LANE_WIDTH_M = 3.75;      // làn xe cao tốc (TCVN 5729:2012)
const LANE_W = 320;             // độ phân giải khung xử lý vạch kẻ
const DETECT_MIN_SCORE = 0.4;
const DETECT_INTERVAL_MS = 125; // ~8 lần/giây: đủ cho cao tốc, đỡ nóng máy
const DETECT_INTERVAL_SAVE_MS = 250; // chế độ tiết kiệm pin

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
let tracks = [];              // xe đã ước lượng: {cls, D, lat, box, t}
let lanes = { left: null, right: null, lost: 99 }; // line: {a, b, covS} với x = a*y + b (khung nhỏ)
let laneIndex = null;         // 1 = làn sát dải phân cách
let laneTotal = null;         // tổng số làn (biết khi đã từng thấy cả 2 mép đường)
let prevOffset = null;
let lead = null;              // {D, t, box}
let closingSpeed = 0;         // m/s, > 0 là đang tiến lại gần
let speedKmh = null;
let audioCtx = null;
let lastBeep = 0;
let lastLevel = 'ok';
let debugPts = [];
let showCamera = false;
let brightness = 128;         // độ sáng trung bình khung hình (tự chuyển ngày/đêm)
let departSince = 0;
let frameImg = null;          // khung nhỏ gần nhất (để lấy màu xe)
let trackSeq = 0;
let overSince = 0;
// Chân trời tự động (toạ độ khung nhỏ) + độ cao camera tự suy từ bề rộng làn
const horizon = { y: null, camH: null };
let battery = null;
function powerSave() { return !!(battery && !battery.charging && battery.level < 0.2); }

// ===== Khởi động =====
$('btnStart').addEventListener('click', start);
$('btnSet').addEventListener('click', () => { bindSettings(); $('settings').hidden = false; });
$('btnClose').addEventListener('click', () => { $('settings').hidden = true; saveCfg(); });
$('btnReset').addEventListener('click', () => { cfg = { ...DEFAULTS }; saveCfg(); bindSettings(); });
$('btnTest').addEventListener('click', () => voice.say('test', 'Giữ khoảng cách. Đang ở làn 2.', 0, 3));
$('btnTrip').addEventListener('click', () => { renderTrips(); $('trips').hidden = false; });
$('btnTripClose').addEventListener('click', () => { $('trips').hidden = true; });
$('btnTripClear').addEventListener('click', () => {
  if (!confirm('Xoá toàn bộ nhật ký chuyến đi?')) return;
  try { localStorage.removeItem('trips'); } catch {}
  trip.begin();
  renderTrips();
});
$('btnCam').addEventListener('click', () => {
  showCamera = !showCamera;
  $('btnCam').style.outline = showCamera ? '2px solid var(--accent)' : '';
});

async function start() {
  $('intro').hidden = true;
  try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
  voice.unlock();
  try {
    await document.documentElement.requestFullscreen?.();
    await screen.orientation?.lock?.('landscape');
  } catch {}
  requestWakeLock();
  startGps();
  trip.begin();
  try { battery = await navigator.getBattery?.(); } catch {}

  try {
    status('Đang mở camera…');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      // 640x360 là đủ: mô hình chỉ xử lý ~300x300, dò vạch 320 px
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 30, max: 30 } },
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
    setTimeout(() => status(''), 4000);
    voice.say('start', 'Bắt đầu theo dõi khoảng cách', 0, 1);
    detectLoop();
  } catch (e) {
    status('Lỗi tải mô hình (cần mạng lần đầu): ' + e.message);
  }
}

function status(t) { $('status').textContent = t; }

async function requestWakeLock() {
  try { await navigator.wakeLock?.request('screen'); } catch {}
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
      roadMap.onPosition(p.coords);
    },
    () => { speedKmh = null; },
    { enableHighAccuracy: true, maximumAge: 1000 }
  );
}

// ===== Giọng nói =====
const voice = {
  viVoice: null,
  last: {},
  curPriority: 0,
  init() {
    if (!('speechSynthesis' in window)) return;
    const pick = () => {
      const vs = speechSynthesis.getVoices();
      this.viVoice = vs.find((v) => /^vi/i.test(v.lang)) || null;
    };
    pick();
    speechSynthesis.addEventListener?.('voiceschanged', pick);
  },
  unlock() {
    // Android cần 1 lần phát trong thao tác bấm của người dùng
    try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch {}
  },
  // key: loại cảnh báo; cooldown: giây; priority: cao hơn thì ngắt câu đang đọc
  say(key, text, cooldown, priority) {
    if (!cfg.voice || !('speechSynthesis' in window)) return;
    const now = performance.now() / 1000;
    if (now - (this.last[key] || -1e9) < cooldown) return;
    if (speechSynthesis.speaking) {
      if (priority <= this.curPriority) return;
      speechSynthesis.cancel();
    }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'vi-VN';
    if (this.viVoice) u.voice = this.viVoice;
    u.rate = 1.1;
    u.onend = () => { this.curPriority = 0; };
    this.curPriority = priority;
    this.last[key] = now;
    speechSynthesis.speak(u);
  },
};
voice.init();

// ===== Nhận dạng xe (COCO-SSD) =====
async function detectLoop() {
  while (true) {
    const t0 = performance.now();
    if (video.readyState >= 2) {
      try {
        const preds = await model.detect(video, 20, DETECT_MIN_SCORE);
        detections = preds
          .filter((p) => VEHICLE_WIDTH[p.class])
          .map((p) => ({ cls: p.class, score: p.score, x: p.bbox[0], y: p.bbox[1], w: p.bbox[2], h: p.bbox[3] }));
      } catch {}
      updateTracks();
    }
    const wait = (powerSave() ? DETECT_INTERVAL_SAVE_MS : DETECT_INTERVAL_MS) - (performance.now() - t0);
    await new Promise((r) => setTimeout(r, Math.max(0, wait)));
  }
}

// ===== Dò vạch kẻ đường =====
function laneX(line, y) { return line.a * y + line.b; }
function lanesOk() { return !!(lanes.left && lanes.right); }

function detectLanes() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw) return;
  const W = LANE_W, H = Math.round((LANE_W * vh) / vw);
  if (small.width !== W || small.height !== H) { small.width = W; small.height = H; }
  sctx.drawImage(video, 0, 0, W, H);
  const img = sctx.getImageData(0, 0, W, H).data;
  frameImg = { img, W, H };

  // Độ sáng trung bình (lấy mẫu thưa) để tự chuyển giao diện ngày/đêm
  let sum = 0, cnt = 0;
  for (let i = 0; i < img.length; i += 4 * 97) { sum += img[i] + img[i + 1] + img[i + 2]; cnt += 3; }
  brightness = brightness * 0.98 + (sum / cnt) * 0.02;

  const horY = cfg.autoHor && horizon.y != null ? horizon.y + H * 0.04 : (cfg.hor / 100) * H;
  const y0 = Math.round(horY) + 2;
  const y1 = Math.round((1 - cfg.hood / 100) * H) - 1;
  if (y1 - y0 < 10) return;

  // Ô che xe (không lấy cạnh xe làm vạch)
  const sx = W / vw;
  const boxes = detections.map((d) => [d.x * sx - 2, d.y * sx - 2, (d.x + d.w) * sx + 2, (d.y + d.h) * sx + 2]);

  // Điểm tụ từ khung trước, để quét từ "giữa xe" theo phối cảnh
  let vpX = W / 2;
  if (lanesOk() && lanes.right.a - lanes.left.a > 0.05) {
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
    updateHorizon();
    trackLaneChange();
  } else if (++lanes.lost > 15) {
    lanes.left = lanes.right = null;
    prevOffset = null;
  }
}

// Điểm tụ của 2 vạch = đường chân trời; độ cao camera = bề rộng làn × (y - chân trời) / bề rộng làn (px)
function updateHorizon() {
  const { left, right, H, y1 } = lanes;
  const da = right.a - left.a;
  if (da < 0.05) return;
  const yv = (left.b - right.b) / da;
  if (yv < H * 0.15 || yv > H * 0.75) return;
  horizon.y = horizon.y == null ? yv : horizon.y + (yv - horizon.y) * 0.05;
  const w = laneX(right, y1) - laneX(left, y1);
  if (w > 4 && y1 - horizon.y > 5) {
    const h = Math.min(2.5, Math.max(0.7, (LANE_WIDTH_M * (y1 - horizon.y)) / w));
    horizon.camH = horizon.camH == null ? h : horizon.camH + (h - horizon.camH) * 0.05;
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
  const offset = ((xl + xr) / 2 - W / 2) / (xr - xl); // >0: xe lệch trái trong làn
  const before = laneIndex;
  if (prevOffset != null && laneIndex != null) {
    if (prevOffset > 0.3 && offset < -0.3) laneIndex = Math.max(1, laneIndex - 1); // sang trái
    else if (prevOffset < -0.3 && offset > 0.3) laneIndex += 1;                   // sang phải
  }
  prevOffset = offset;
  lanes.offset = offset;
  const ls = left.covS > 0.62, rs = right.covS > 0.62;
  lanes.leftSolid = ls; lanes.rightSolid = rs;
  const mapTotal = roadMap.road?.lanes || null;
  if (ls) laneIndex = 1;                          // vạch liền bên trái = sát dải phân cách giữa
  else if (rs && mapTotal) laneIndex = mapTotal;  // vạch liền bên phải + biết tổng số làn = làn ngoài cùng
  if (mapTotal) {
    laneTotal = mapTotal;
    if (laneIndex > mapTotal) laneIndex = mapTotal;
  } else {
    if (rs && laneIndex) laneTotal = laneIndex;
    if (laneTotal && laneIndex > laneTotal) laneTotal = null;
  }
  if (before != null && laneIndex !== before) voice.say('lane', `Làn ${laneIndex}`, 3, 1);

  // Lệch làn: lệch > 1/3 làn liên tục 1,2 s
  const now = performance.now();
  if (Math.abs(offset) > 0.33) {
    if (!departSince) departSince = now;
    else if (cfg.laneWarn && now - departSince > 1200) {
      voice.say('depart', offset > 0 ? 'Xe đang lệch trái' : 'Xe đang lệch phải', 10, 2);
    }
  } else departSince = 0;
}

function laneLabel() {
  const r = roadMap.road;
  const mapInfo = r && r.lanes ? `${r.lanes} làn (bản đồ)` : '';
  if (!lanesOk()) return ['--', 'Đang dò vạch kẻ đường' + (mapInfo ? '\n' + mapInfo : '')];
  const { leftSolid: ls, rightSolid: rs } = lanes;
  const tot = laneTotal ? `/${laneTotal}` : '';
  let name;
  if (ls && rs) name = 'Làn duy nhất';
  else if (ls) name = `Làn 1${tot} · trong cùng`;
  else if (rs) name = (laneIndex ? `Làn ${laneIndex}${tot} · ` : '') + 'ngoài cùng';
  else name = laneIndex ? `Làn ${laneIndex}${tot} · giữa` : 'Làn giữa';
  let sub = `Trái ${ls ? 'liền' : 'đứt'} · Phải ${rs ? 'liền' : 'đứt'}`;
  if (Math.abs(lanes.offset) > 0.25) sub += lanes.offset > 0 ? ' · lệch trái' : ' · lệch phải';
  if (mapInfo) sub += '\n' + mapInfo;
  return [name, sub];
}

// ===== Số làn từ bản đồ OpenStreetMap (Overpass API) =====
// Tải các đoạn đường lớn trong bán kính 1,5 km, rồi mỗi lần có GPS thì khớp tại chỗ
// với đoạn gần nhất cùng hướng chạy. Đi xa > 1 km so với điểm tải thì tải lại.
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const roadMap = {
  ways: [], center: null, busy: false, failUntil: 0,
  road: null,                  // {lanes, name, ref, maxspeed}
  prev: null, heading: null,

  onPosition(c) {
    const pos = { lat: c.latitude, lon: c.longitude };
    // Hướng chạy: ưu tiên GPS, nếu không có thì tính từ 2 điểm liên tiếp
    if (c.heading != null && !isNaN(c.heading) && (c.speed || 0) > 2) this.heading = c.heading;
    else if (this.prev && distM(this.prev, pos) > 15) this.heading = bearing(this.prev, pos);
    if (!this.prev || distM(this.prev, pos) > 15) this.prev = pos;

    const now = Date.now();
    if (!this.busy && now > this.failUntil && (!this.center || distM(this.center, pos) > this.radius * 0.6)) this.load(pos);
    this.match(pos);
    area.onPosition(pos);
    trip.onPosition(pos, c.accuracy);
  },

  radius: 1500,
  async load(pos) {
    this.busy = true;
    // Chạy nhanh (cao tốc): tải rộng; chạy chậm (phố): tải hẹp vì đường nhỏ rất dày
    const r = speedKmh != null && speedKmh > 50 ? 1500 : 400;
    const q = `[out:json][timeout:15];way(around:${r},${pos.lat.toFixed(5)},${pos.lon.toFixed(5)})` +
      `[highway~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"];out tags geom;`;
    for (const url of OVERPASS) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 15000);
        const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), signal: ctl.signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        clearTimeout(timer);
        if (!res.ok) throw new Error(res.status);
        const js = await res.json();
        this.ways = js.elements.filter((e) => e.type === 'way' && e.geometry && e.geometry.length > 1);
        this.center = pos;
        this.radius = r;
        this.busy = false;
        this.match(pos);
        return;
      } catch {}
    }
    this.busy = false;
    this.failUntil = Date.now() + 60000; // mất mạng: thử lại sau 1 phút
  },

  match(pos) {
    let best = null;
    for (const w of this.ways) {
      const t = w.tags || {};
      // Tìm đoạn thẳng gần nhất của con đường
      let dmin = Infinity, brg = 0;
      for (let i = 1; i < w.geometry.length; i++) {
        const a = w.geometry[i - 1], b = w.geometry[i];
        const d = segDistM(pos, a, b);
        if (d < dmin) { dmin = d; brg = bearing(a, b); }
      }
      if (dmin > 35) continue;
      const oneway = t.oneway === 'yes' || t.oneway === '1' || t.oneway === '-1' ||
        (t.highway === 'motorway' && t.oneway !== 'no') || t.junction === 'roundabout';
      if (t.oneway === '-1') brg = (brg + 180) % 360;
      let lanes = null, score = dmin;
      const diff = this.heading == null ? 0 : angDiff(this.heading, brg);
      if (oneway) {
        if (this.heading != null && diff > 60) continue; // chiều ngược lại của cao tốc
        lanes = parseInt(t.lanes) || null;
      } else {
        const fwd = diff < 90;
        lanes = parseInt(t[fwd ? 'lanes:forward' : 'lanes:backward']) || (parseInt(t.lanes) ? Math.max(1, Math.floor(parseInt(t.lanes) / 2)) : null);
        score += 5; // ưu tiên đường một chiều (cao tốc tách 2 nhánh)
      }
      if (this.heading != null) score += Math.min(diff, 180 - diff) * 0.2;
      if (!best || score < best.score) {
        best = { score, lanes, name: t.name || '', ref: t.ref || '', maxspeed: parseInt(t.maxspeed) || null, hw: t.highway };
      }
    }
    const before = this.road?.lanes;
    this.road = best;
    if (best?.lanes && best.lanes !== before) {
      laneTotal = best.lanes;
      if (laneIndex > best.lanes) laneIndex = best.lanes;
    }
  },
};

// ===== Xã/phường, tỉnh theo vị trí (Nominatim — tra địa chỉ của OpenStreetMap) =====
// Tra lại khi đi > 2 km; Nominatim giới hạn 1 lượt/giây nên tần suất này rất thấp.
const area = {
  at: null, text: '', road: '', busy: false, failUntil: 0,
  onPosition(pos) {
    if (this.busy || Date.now() < this.failUntil || (this.at && distM(this.at, pos) < 2000)) return;
    this.load(pos);
  },
  async load(pos) {
    this.busy = true;
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&addressdetails=1&accept-language=vi` +
        `&lat=${pos.lat.toFixed(5)}&lon=${pos.lon.toFixed(5)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.status);
      const a = (await res.json()).address || {};
      const low = a.quarter || a.suburb || a.village || a.town || a.city_district || a.municipality || a.county || '';
      const prov = a.state || a.city || a.province || '';
      this.text = [low, prov].filter((x, i, arr) => x && arr.indexOf(x) === i).join(' · ');
      this.road = a.road || '';
      this.at = pos;
    } catch { this.failUntil = Date.now() + 60000; }
    this.busy = false;
  },
};

// Tên đường hiển thị: số hiệu + tên (ưu tiên đoạn khớp theo hướng chạy, nếu không có thì lấy từ Nominatim)
function roadTitle() {
  const r = roadMap.road;
  if (r && (r.ref || r.name)) return [r.ref, r.name].filter(Boolean).join(' · ');
  return area.road;
}

function distM(a, b) {
  const k = Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot((b.lon - a.lon) * k * 111320, (b.lat - a.lat) * 110540);
}
function bearing(a, b) {
  const k = Math.cos((a.lat * Math.PI) / 180);
  const dx = (b.lon - a.lon) * k, dy = b.lat - a.lat;
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}
function angDiff(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
// Khoảng cách (m) từ p đến đoạn thẳng ab
function segDistM(p, a, b) {
  const k = Math.cos((p.lat * Math.PI) / 180);
  const ax = (a.lon - p.lon) * k * 111320, ay = (a.lat - p.lat) * 110540;
  const bx = (b.lon - p.lon) * k * 111320, by = (b.lat - p.lat) * 110540;
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

// ===== Ước lượng vị trí các xe =====
function focalPx(imgW) { return imgW / 2 / Math.tan((cfg.fov * Math.PI) / 360); }

// Trả về {D: m phía trước, lat: lệch ngang theo đơn vị làn (0 = tâm làn mình, -1 = làn trái)}
function estimate(d, vw) {
  const sx = LANE_W / vw;
  const bx = (d.x + d.w / 2) * sx, by = (d.y + d.h) * sx;
  const cut = d.x < 2 || d.x + d.w > vw - 2; // bị cắt ở mép khung -> bề rộng sai
  const Dw = cut ? null : (focalPx(vw) * VEHICLE_WIDTH[d.cls]) / d.w;
  let Dl = null, lat = null;
  if (lanesOk()) {
    const xl = laneX(lanes.left, by), xr = laneX(lanes.right, by);
    const wl = xr - xl;
    if (by > lanes.y0 - 10 && wl > 4) Dl = (focalPx(LANE_W) * LANE_WIDTH_M) / wl;
    if (wl > 4) lat = (bx - (xl + xr) / 2) / wl;
  }
  // Khoảng cách theo mặt đường (chân trời + độ cao camera): dùng được cả cho xe làn bên, xe ở xa
  let Dg = null;
  if (horizon.y != null && horizon.camH && by - horizon.y > 2) Dg = (focalPx(LANE_W) * horizon.camH) / (by - horizon.y);
  const Dground = Dl || Dg;
  let D;
  if (Dground && Dw) D = Dground / Dw > 0.6 && Dground / Dw < 1.6 ? 0.6 * Dground + 0.4 * Dw : Dw;
  else D = Dw || Dground;
  if (!D) return null;
  // Camera ở kính lái: trừ đoạn kính lái → cản trước để ra khoảng cách cản trước → đuôi xe trước
  D = Math.max(0.5, D * cfg.cal - myCar().hood);
  if (lat == null) lat = (((bx - LANE_W / 2) / focalPx(LANE_W)) * D) / LANE_WIDTH_M;
  return { D, lat };
}

function updateTracks() {
  const vw = video.videoWidth;
  if (!vw) return;
  const now = performance.now() / 1000;
  const next = [];
  for (const d of detections) {
    const e = estimate(d, vw);
    if (!e) continue;
    // Ghép với xe đã theo dõi để làm mượt
    let m = null, best = Infinity;
    for (const t of tracks) {
      const cost = Math.abs(t.D - e.D) / Math.max(5, t.D) + Math.abs(t.lat - e.lat);
      if (t.cls === d.cls && cost < 0.6 && cost < best) { best = cost; m = t; }
    }
    const rgb = sampleColor(d, vw);
    const tall = d.h / d.w > 0.9;
    if (m) {
      tracks.splice(tracks.indexOf(m), 1);
      const col = rgb && m.rgb ? m.rgb.map((c, i) => c + (rgb[i] - c) * 0.2) : rgb || m.rgb;
      next.push({ id: m.id, cls: d.cls, box: d, t: now, tall, rgb: col, D: m.D + (e.D - m.D) * 0.35, lat: m.lat + (e.lat - m.lat) * 0.35 });
    } else next.push({ id: ++trackSeq, cls: d.cls, box: d, t: now, tall, rgb, ...e });
  }
  // Giữ xe vừa mất dấu tối đa 0,7 s
  for (const t of tracks) if (now - t.t < 0.7) next.push(t);
  tracks = next;

  const cand = tracks.filter((t) => Math.abs(t.lat) < 0.55 && now - t.t < 0.7).sort((a, b) => a.D - b.D)[0];
  if (!cand) { if (lead && now - lead.t > 1) { lead = null; closingSpeed = 0; kf.reset(); } return; }

  // Xe trước đổi sang xe khác (nhảy > 35%) thì khởi tạo lại bộ lọc
  if (!lead || Math.abs(cand.D - lead.D) / lead.D > 0.35) kf.reset();
  const D = kf.update(cand.D, now);
  closingSpeed = -kf.v;
  lead = { D, t: now, box: cand.box, track: cand };
}

// Bộ lọc Kalman 1 chiều (khoảng cách + tốc độ tương đối), mô hình vận tốc không đổi
const kf = {
  D: null, v: 0, t: 0, P: [[1, 0], [0, 1]],
  reset() { this.D = null; this.v = 0; },
  update(z, t) {
    const r = (0.07 * z) ** 2 + 0.25;         // nhiễu đo tăng theo khoảng cách
    if (this.D == null) { this.D = z; this.v = 0; this.t = t; this.P = [[r, 0], [0, 25]]; return z; }
    const dt = Math.min(1, Math.max(0.02, t - this.t));
    this.t = t;
    // Dự đoán
    this.D += this.v * dt;
    const q = 9; // (3 m/s²)²: xe trước có thể phanh/tăng tốc
    const [[a, b], [c, d]] = this.P;
    const p00 = a + dt * (b + c) + dt * dt * d + (q * dt ** 4) / 4;
    const p01 = b + dt * d + (q * dt ** 3) / 2;
    const p10 = c + dt * d + (q * dt ** 3) / 2;
    const p11 = d + q * dt * dt;
    // Cập nhật
    const s = p00 + r, k0 = p00 / s, k1 = p10 / s, y = z - this.D;
    this.D += k0 * y;
    this.v += k1 * y;
    this.P = [[(1 - k0) * p00, (1 - k0) * p01], [p10 - k1 * p00, p11 - k1 * p01]];
    return this.D;
  },
};

// Màu trung bình phần thân sau xe (nắp cốp/cản); trời tối thì bỏ qua
function sampleColor(d, vw) {
  if (!frameImg || brightness < 55) return null;
  const { img, W, H } = frameImg, k = W / vw;
  const x0 = Math.max(0, Math.round((d.x + d.w * 0.3) * k)), x1 = Math.min(W - 1, Math.round((d.x + d.w * 0.7) * k));
  const y0 = Math.max(0, Math.round((d.y + d.h * 0.45) * k)), y1 = Math.min(H - 1, Math.round((d.y + d.h * 0.7) * k));
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = (y * W + x) * 4;
    r += img[i]; g += img[i + 1]; b += img[i + 2]; n++;
  }
  return n ? [r / n, g / n, b / n] : null;
}
const hex = (rgb) => '#' + rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('');

let myCarCache = null;
function myCar() {
  const k = cfg.carBrand + '|' + cfg.carModel;
  if (!myCarCache || myCarCache.k !== k) myCarCache = { k, ...carSpec(cfg.carBrand, cfg.carModel) };
  return myCarCache;
}

// ===== Mức cảnh báo =====
function alertLevel() {
  if (!lead) return 'ok';
  const safe = safeDistance(speedKmh);
  const ttc = closingSpeed > 0.5 ? lead.D / closingSpeed : Infinity;
  if (ttc < 2.5 || (safe && lead.D < safe * 0.6)) return 'bad';
  if (ttc < 4 || (safe && lead.D < safe)) return 'warn';
  return 'ok';
}

function beep(freq, ms) {
  if (!audioCtx || !cfg.beep) return;
  const o = audioCtx.createOscillator(), gn = audioCtx.createGain();
  o.frequency.value = freq; o.type = 'square';
  gn.gain.value = 0.12;
  o.connect(gn); gn.connect(audioCtx.destination);
  o.start(); o.stop(audioCtx.currentTime + ms / 1000);
}

function handleAlerts(level) {
  const now = performance.now();
  if (level === 'bad') {
    if (now - lastBeep > 600) { beep(1200, 120); lastBeep = now; }
    voice.say('bad', 'Nguy hiểm, giảm tốc', 4, 3);
  } else if (level === 'warn' && lastLevel === 'ok') {
    voice.say('warn', 'Giữ khoảng cách', 8, 2);
  }
  // Xe trước phanh gấp: đang tiến lại > 15 km/h trong tầm gần
  const safe = safeDistance(speedKmh) || 50;
  if (lead && closingSpeed > 4 && lead.D < safe * 1.5) voice.say('brake', 'Xe phía trước giảm tốc', 8, 2);
  // Vượt tốc độ (theo giới hạn trên bản đồ) liên tục 3 s
  const lim = roadMap.road?.maxspeed;
  if (lim && speedKmh != null && speedKmh > lim + 5) {
    if (!overSince) overSince = now;
    else if (cfg.speedWarn && now - overSince > 3000) voice.say('speed', `Vượt tốc độ, giới hạn ${lim}`, 30, 1);
  } else overSince = 0;
  if (level === 'bad' && lastLevel !== 'bad' && trip.data) trip.data.badCount++;
  lastLevel = level;
}

// ===== Giao diện ngày/đêm =====
function applyTheme() {
  let t = cfg.theme;
  if (t === 'auto') {
    const cur = document.body.dataset.theme;
    t = cur === 'night' ? (brightness > 75 ? 'day' : 'night') : (brightness < 55 ? 'night' : 'day');
  }
  if (document.body.dataset.theme !== t || !palette) {
    document.body.dataset.theme = t;
    const cs = getComputedStyle(document.body), v = (n) => cs.getPropertyValue(n).trim();
    palette = { bg: v('--bg'), fg: v('--fg'), dim: v('--dim'), accent: v('--accent'), ok: v('--ok'), warn: v('--warn'), bad: v('--bad') };
  }
}
let palette = null;

// ===== Vẽ =====
let frame = 0, lastT = performance.now(), dashPhase = 0;
function render() {
  requestAnimationFrame(render);
  const now = performance.now(), dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  if (video.readyState < 2) return;
  if (frame++ % (powerSave() ? 5 : 3) === 0) detectLanes();
  if (frame % 30 === 0) {
    applyTheme();
    if (powerSave()) status('🔋 Pin yếu · đang chạy chế độ tiết kiệm');
  }

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = Math.round(innerWidth * dpr), ch = Math.round(innerHeight * dpr);
  if (view.width !== cw || view.height !== ch) { view.width = cw; view.height = ch; }

  const level = alertLevel();
  const C = palette;
  const use3D = !showCamera && window.Sim3D?.ready;
  window.Sim3D?.setVisible(use3D);
  if (showCamera) drawCamera(cw, ch, dpr, level, C);
  else if (use3D) draw3D(cw, ch, dpr, level, C, dt);
  else drawSim(cw, ch, dpr, level, C, dt);

  // Viền cả màn hình theo mức cảnh báo
  if (level !== 'ok') {
    const on = level === 'warn' || Math.floor(now / 250) % 2 === 0;
    if (on) {
      vctx.strokeStyle = C[level];
      vctx.lineWidth = 14 * dpr;
      vctx.strokeRect(0, 0, cw, ch);
    }
  }

  handleAlerts(level);
  trip.tick(dt, level);
  updateHud(level, C);
}

// Cấu hình làn cho mô phỏng: số làn hai bên, biết mép đường hay chưa
function laneConf() {
  const hasL = lanesOk();
  const ls = hasL && !!lanes.leftSolid, rs = hasL && !!lanes.rightSolid;
  const known = !!(hasL && laneIndex && laneTotal);
  return {
    nL: known ? laneIndex - 1 : ls ? 0 : 1, nR: known ? laneTotal - laneIndex : rs ? 0 : 1,
    edgeL: ls || known, edgeR: rs || known, ls, rs,
  };
}

// Mô phỏng 3D (Three.js, sim3d.js) + chữ vẽ đè trên canvas 2D
function draw3D(cw, ch, dpr, level, C, dt) {
  vctx.clearRect(0, 0, cw, ch);
  const portrait = ch > cw, W = innerWidth, H = innerHeight;
  const rect = portrait
    ? { x: 0, y: Math.round(H * 0.23), w: W, h: Math.round(H * 0.5) }
    : { x: Math.round(W * 0.285), y: 0, w: Math.round(W * 0.43), h: H };
  const now = performance.now() / 1000;
  const car = myCar();
  const res = window.Sim3D.render({
    rect, bg: C.bg, ok: C.ok, warn: C.warn, bad: C.bad, night: document.body.dataset.theme === 'night',
    lane: laneConf(), egoX: -(lanesOk() ? lanes.offset : 0) * LANE_WIDTH_M,
    speedMs: (speedKmh || 0) / 3.6, dt, safe: safeDistance(speedKmh), level,
    tracks: tracks.filter((t) => now - t.t <= 0.7 && t.D < 170 && Math.abs(t.lat) < 4)
      .map((t) => ({ id: t.id, cls: t.cls, D: t.D, x: t.lat * LANE_WIDTH_M, tall: t.tall,
        color: lead && t === lead.track && level !== 'ok' ? C[level] : t.rgb ? hex(t.rgb) : null })),
    leadId: lead?.track?.id,
    ego: { type: car.type, dims: car.dims, color: cfg.carColor },
  });
  // Mốc khoảng cách
  vctx.fillStyle = C.dim;
  vctx.textAlign = 'right';
  vctx.font = `${12 * dpr}px system-ui`;
  let lastY = Infinity;
  for (const [m, x, y] of res.ticks) {
    if (lastY - y < 14 || x < rect.x + 4) continue;
    lastY = y;
    vctx.fillText(m + ' m', x * dpr, y * dpr + 4 * dpr);
  }
  vctx.textAlign = 'left';
  if (res.leadScreen && lead) {
    vctx.fillStyle = C[level];
    vctx.font = `bold ${20 * dpr}px system-ui`;
    vctx.fillText(lead.D.toFixed(0) + ' m', res.leadScreen[0] * dpr, res.leadScreen[1] * dpr);
  }
}

// Mô phỏng phối cảnh 3D (camera ảo phía sau, trên cao — kiểu màn hình Tesla)
const CAM_H = 9;       // m: độ cao camera ảo
const CAM_BACK = 25;   // m: camera ảo lùi sau đầu xe mình
const EGO_LEN = 4.5;
const FAR_Z = 160;

function drawSim(cw, ch, dpr, level, C, dt) {
  const portrait = ch > cw;
  vctx.fillStyle = C.bg;
  vctx.fillRect(0, 0, cw, ch);

  const rx0 = portrait ? 0 : cw * 0.29, rx1 = portrait ? cw : cw * 0.71;
  const ry0 = portrait ? ch * 0.26 : 0, ry1 = portrait ? ch * 0.82 : ch;
  const cx = (rx0 + rx1) / 2;
  const hy = ry0 + (ry1 - ry0) * 0.16;                        // đường chân trời
  const f = (ry1 - hy) * (CAM_BACK - EGO_LEN - 6) / CAM_H;    // tiêu cự ảo: đáy khung = 6 m sau đuôi xe mình
  // (X ngang m, Z phía trước m, Y cao m) -> pixel
  const P = (X, Z, Y = 0) => { const d = Math.max(0.5, Z + CAM_BACK); return [cx + (f * X) / d, hy + (f * (CAM_H - Y)) / d]; };
  const quad = (pts, fill) => {
    vctx.fillStyle = fill;
    vctx.beginPath();
    pts.forEach((p, i) => (i ? vctx.lineTo(p[0], p[1]) : vctx.moveTo(p[0], p[1])));
    vctx.closePath(); vctx.fill();
  };
  const groundQuad = (xa, xb, za, zb, fill) => quad([P(xa, za), P(xb, za), P(xb, zb), P(xa, zb)], fill);

  vctx.save();
  vctx.beginPath(); vctx.rect(rx0, ry0, rx1 - rx0, ry1 - ry0); vctx.clip();

  // Nền trời mờ phía chân trời
  const sky = vctx.createLinearGradient(0, ry0, 0, hy + 20 * dpr);
  sky.addColorStop(0, 'rgba(56,189,248,0)'); sky.addColorStop(1, 'rgba(56,189,248,.08)');
  vctx.fillStyle = sky; vctx.fillRect(rx0, ry0, rx1 - rx0, hy - ry0 + 20 * dpr);

  const LW = LANE_WIDTH_M;
  const hasL = lanesOk();
  const ls = hasL && lanes.leftSolid, rs = hasL && lanes.rightSolid;
  // Số làn hai bên: biết vị trí + tổng số làn thì vẽ đủ, không thì vẽ 1 làn mỗi bên
  const known = hasL && laneIndex && laneTotal;
  const nL = known ? laneIndex - 1 : ls ? 0 : 1, nR = known ? laneTotal - laneIndex : rs ? 0 : 1;
  const edgeL = ls || !!known, edgeR = rs || !!known; // biết chắc mép đường
  const roadL = -LW / 2 - nL * LW, roadR = LW / 2 + nR * LW;
  const zNear = -EGO_LEN - 8;

  // Dải phân cách / lề, mặt đường
  if (edgeL) groundQuad(roadL - 3, roadL, zNear, FAR_Z, 'rgba(148,163,184,.10)');
  if (edgeR) groundQuad(roadR, roadR + 3, zNear, FAR_Z, 'rgba(148,163,184,.06)');
  groundQuad(roadL, roadR, zNear, FAR_Z, 'rgba(148,163,184,.16)');

  // Vùng màu khoảng cách trên làn mình
  const safe = safeDistance(speedKmh);
  if (safe) {
    vctx.globalAlpha = 0.28;
    for (const [a, b, col] of [[0, safe * 0.6, C.bad], [safe * 0.6, safe, C.warn], [safe, FAR_Z, C.ok]]) {
      groundQuad(-LW / 2, LW / 2, a, b, col);
    }
    vctx.globalAlpha = 1;
  }

  // Vạch kẻ (dải mỏng trên mặt đất, chạy theo tốc độ)
  dashPhase = (dashPhase + ((speedKmh || 0) / 3.6) * dt) % 12;
  const line = (X, solid, col) => {
    const w = 0.18;
    if (solid) { groundQuad(X - w, X + w, zNear, FAR_Z, col); return; }
    for (let z = zNear - dashPhase; z < FAR_Z; z += 12) groundQuad(X - w, X + w, z, z + 4, col);
  };
  line(-LW / 2, ls, ls ? '#facc15' : C.fg);
  line(LW / 2, rs, C.fg);
  for (let i = 1; i <= nL; i++) {
    const outer = i === nL;
    line(-LW / 2 - i * LW, outer && edgeL, outer && edgeL ? '#facc15' : C.dim);
  }
  for (let i = 1; i <= nR; i++) {
    const outer = i === nR;
    line(LW / 2 + i * LW, outer && edgeR, C.dim);
  }

  // Mốc khoảng cách
  vctx.fillStyle = C.dim;
  vctx.textAlign = 'right';
  let lastY = Infinity;
  for (let m = 20; m <= 100; m += 20) {
    const [x, y] = P(roadL - 0.6, m);
    if (lastY - y < 14 * dpr) continue; // quá sát chân trời thì bỏ
    lastY = y;
    vctx.font = `${Math.max(9, Math.min(14, 400 / (m + CAM_BACK))) * dpr}px system-ui`;
    vctx.fillText(m + ' m', x, y + 4 * dpr);
  }
  vctx.textAlign = 'left';

  // Xe: vẽ xa trước, gần sau
  const now = performance.now() / 1000;
  const cars = tracks
    .filter((t) => now - t.t <= 0.7 && t.D < FAR_Z && Math.abs(t.lat) < 4)
    .sort((a, b) => b.D - a.D);
  for (const t of cars) {
    const isLead = lead && t === lead.track;
    const big = t.cls === 'truck' || t.cls === 'bus';
    const dim = big ? [2.5, 3.2, 10] : t.cls === 'motorcycle' ? [0.8, 1.4, 2] : [1.8, 1.45, 4.5];
    box3d(P, quad, t.lat * LW, t.D, dim, isLead ? C[level] : C.dim);
    if (isLead) {
      const [x, y] = P(t.lat * LW + dim[0] / 2 + 0.4, t.D, dim[1] / 2);
      vctx.fillStyle = C[level];
      vctx.font = `bold ${20 * dpr}px system-ui`;
      vctx.fillText(t.D.toFixed(0) + ' m', x, y + 7 * dpr);
    }
  }

  // Xe mình (lệch trong làn theo offset)
  box3d(P, quad, -(hasL ? lanes.offset : 0) * LW, -EGO_LEN, [1.8, 1.45, EGO_LEN], C.accent);

  if (!hasL) {
    vctx.fillStyle = C.dim;
    vctx.font = `${14 * dpr}px system-ui`;
    vctx.textAlign = 'center';
    vctx.fillText('Chưa thấy vạch kẻ đường', cx, hy - 8 * dpr);
    vctx.textAlign = 'left';
  }
  vctx.restore();
}

// Hộp 3D: X tâm ngang, Z đuôi xe (m phía trước), dim = [rộng, cao, dài]
function box3d(P, quad, X, Z, [w, h, len], col) {
  const xl = X - w / 2, xr = X + w / 2, z0 = Z, z1 = Z + len;
  quad([P(xl, z0), P(xr, z0), P(xr, z1), P(xl, z1)], 'rgba(0,0,0,.35)'); // bóng
  // Mặt bên hướng về tâm (thấy được khi xe ở làn bên)
  if (xl > 0.05) quad([P(xl, z0), P(xl, z0, h), P(xl, z1, h), P(xl, z1)], col);
  if (xr < -0.05) quad([P(xr, z0), P(xr, z0, h), P(xr, z1, h), P(xr, z1)], col);
  if (xl > 0.05 || xr < -0.05) {
    const s = xl > 0.05 ? xl : xr;
    quad([P(s, z0), P(s, z0, h), P(s, z1, h), P(s, z1)], 'rgba(0,0,0,.35)');
  }
  // Nóc
  quad([P(xl, z0, h), P(xr, z0, h), P(xr, z1, h), P(xl, z1, h)], col);
  quad([P(xl, z0, h), P(xr, z0, h), P(xr, z1, h), P(xl, z1, h)], 'rgba(255,255,255,.22)');
  // Mặt sau (đuôi xe)
  quad([P(xl, z0), P(xr, z0), P(xr, z0, h), P(xl, z0, h)], col);
  // Kính sau + đèn hậu
  const g = (a, b, c, d) => [P(xl + w * a, z0, h * c), P(xl + w * b, z0, h * c), P(xl + w * b, z0, h * d), P(xl + w * a, z0, h * d)];
  quad(g(0.12, 0.88, 0.62, 0.92), 'rgba(0,0,0,.4)');
  quad(g(0.04, 0.22, 0.35, 0.5), 'rgba(239,68,68,.9)');
  quad(g(0.78, 0.96, 0.35, 0.5), 'rgba(239,68,68,.9)');
}

// Chế độ xem camera thật (để hiệu chỉnh)
function drawCamera(cw, ch, dpr, level, C) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const s = Math.max(cw / vw, ch / vh);
  const ox = (cw - vw * s) / 2, oy = (ch - vh * s) / 2;
  vctx.drawImage(video, ox, oy, vw * s, vh * s);
  const k = vw / LANE_W;
  const P = (x, y) => [ox + x * k * s, oy + y * k * s];

  if (lanesOk()) {
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
  // Đường chân trời + vùng capo để dễ chỉnh
  const H = lanes.H || Math.round((LANE_W * vh) / vw);
  vctx.strokeStyle = '#0ff'; vctx.lineWidth = 2 * dpr;
  vctx.setLineDash([8 * dpr, 8 * dpr]);
  const hy = cfg.autoHor && horizon.y != null ? horizon.y : (cfg.hor / 100) * H;
  for (const yy of [hy, (1 - cfg.hood / 100) * H]) {
    const [, py] = P(0, yy);
    vctx.beginPath(); vctx.moveTo(0, py); vctx.lineTo(cw, py); vctx.stroke();
  }
  vctx.setLineDash([]);
  if (cfg.dbg) {
    vctx.fillStyle = '#0ff';
    for (const [x, y] of debugPts) { const [px, py] = P(x, y); vctx.fillRect(px - 2, py - 2, 4, 4); }
  }
  for (const d of detections) {
    const isLead = lead && d === lead.box;
    vctx.strokeStyle = isLead ? C[level] : 'rgba(255,255,255,0.5)';
    vctx.lineWidth = (isLead ? 4 : 2) * dpr;
    vctx.strokeRect(ox + d.x * s, oy + d.y * s, d.w * s, d.h * s);
    if (isLead) {
      vctx.font = `bold ${22 * dpr}px system-ui`;
      vctx.fillStyle = C[level];
      vctx.fillText(lead.D.toFixed(0) + ' m', ox + d.x * s, oy + d.y * s - 8 * dpr);
    }
  }
}

// ===== Nhật ký chuyến đi (lưu trong máy) =====
const trip = {
  data: null, last: null, saveT: 0,
  begin() {
    this.data = { id: Date.now(), start: Date.now(), end: Date.now(), km: 0, maxSpeed: 0,
      closeSec: 0, warnSec: 0, badCount: 0, overSec: 0, driveSec: 0 };
  },
  onPosition(pos, acc) {
    if (!this.data) return;
    if (this.last && (acc == null || acc < 30)) {
      const d = distM(this.last, pos);
      if (d > 3 && d < 500) this.data.km += d / 1000;
    }
    this.last = pos;
  },
  tick(dt, level) {
    const t = this.data;
    if (!t) return;
    const moving = speedKmh != null && speedKmh > 10;
    if (moving) {
      t.driveSec += dt;
      t.maxSpeed = Math.max(t.maxSpeed, speedKmh);
      if (lead && lead.D / (speedKmh / 3.6) < 1) t.closeSec += dt;   // bám dưới 1 giây
      if (level !== 'ok') t.warnSec += dt;
      const lim = roadMap.road?.maxspeed;
      if (lim && speedKmh > lim + 5) t.overSec += dt;
    }
    t.end = Date.now();
    if (t.end - this.saveT > 15000) this.save();
  },
  save() {
    this.saveT = Date.now();
    if (!this.data || this.data.driveSec < 30) return; // chuyến quá ngắn thì không lưu
    try {
      const all = JSON.parse(localStorage.getItem('trips') || '[]').filter((x) => x.id !== this.data.id);
      all.unshift(this.data);
      localStorage.setItem('trips', JSON.stringify(all.slice(0, 30)));
    } catch {}
  },
  list() { try { return JSON.parse(localStorage.getItem('trips') || '[]'); } catch { return []; } },
};
addEventListener('pagehide', () => trip.save());

function fmtDur(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s2 = sec % 60;
  return h ? `${h} giờ ${m} phút` : m ? `${m} phút ${s2} giây` : `${s2} giây`;
}
function renderTrips() {
  trip.save();
  const rows = trip.list();
  if (trip.data && !rows.some((x) => x.id === trip.data.id)) rows.unshift(trip.data);
  const el = $('tripList');
  el.textContent = '';
  if (!rows.length) { el.textContent = 'Chưa có chuyến nào.'; return; }
  for (const t of rows) {
    const d = document.createElement('div');
    d.className = 'trip';
    const pct = t.driveSec ? Math.round((t.closeSec / t.driveSec) * 100) : 0;
    const when = new Date(t.start).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
    d.innerHTML = `<b></b><div></div>`;
    d.querySelector('b').textContent = `${when}${trip.data && t.id === trip.data.id ? ' · đang chạy' : ''}`;
    d.querySelector('div').textContent =
      `${t.km.toFixed(1)} km · ${fmtDur(t.driveSec)} · tối đa ${Math.round(t.maxSpeed)} km/h\n` +
      `Bám xe < 1 giây: ${fmtDur(t.closeSec)} (${pct}%) · Cảnh báo nguy hiểm: ${t.badCount} lần` +
      (t.overSec ? `\nVượt tốc độ: ${fmtDur(t.overSec)}` : '');
    el.appendChild(d);
  }
}

// ===== HUD =====
let hudCache = {};
function setText(id, v) { if (hudCache[id] !== v) { hudCache[id] = v; $(id).textContent = v; } }

function updateHud(level, C) {
  const safe = safeDistance(speedKmh);
  const moving = speedKmh != null && speedKmh > 5;
  if (lead) {
    if (moving) {
      // Số chính là số giây cách xe trước
      setText('mainVal', (lead.D / (speedKmh / 3.6)).toFixed(1) + ' s');
      setText('mainUnit', 'cách xe phía trước');
      setText('subVal', `${lead.D.toFixed(0)} m${safe ? ` · an toàn ≥ ${Math.round(safe)} m` : ''}`);
    } else {
      setText('mainVal', lead.D.toFixed(0) + ' m');
      setText('mainUnit', 'cách xe phía trước');
      setText('subVal', closingSpeed > 0.5 ? `đang gần lại ${(closingSpeed * 3.6).toFixed(0)} km/h` : '');
    }
  } else {
    setText('mainVal', '--');
    setText('mainUnit', 'Chưa thấy xe phía trước');
    setText('subVal', '');
  }
  $('mainVal').style.color = lead ? C[level] : C.fg;
  setText('alertTxt', level === 'bad' ? 'GIẢM TỐC!' : level === 'warn' ? 'GIỮ KHOẢNG CÁCH' : '');
  $('alertTxt').style.color = C[level];

  setText('speedVal', speedKmh == null ? '--' : String(Math.round(speedKmh)));
  const lim = roadMap.road?.maxspeed;
  setText('speedUnit', 'km/h · GPS' + (lim ? ` · giới hạn ${lim}` : ''));
  $('speedVal').style.color = lim && speedKmh > lim + 2 ? palette.bad : '';

  setText('road', roadTitle() || '');
  setText('area', area.text || '');
  const [n, sub] = laneLabel();
  setText('laneName', n);
  setText('laneSub', sub);

  // Dải làn kiểu bản đồ
  const key = `${lanesOk()}|${laneIndex}|${laneTotal}|${lanes.leftSolid}|${lanes.rightSolid}`;
  if (hudCache.strip !== key) {
    hudCache.strip = key;
    let html = '';
    if (lanesOk()) {
      if (laneIndex) {
        const total = laneTotal || laneIndex;
        html += '<div class="bar"></div>';
        for (let i = 1; i <= total; i++) html += `<div class="ln${i === laneIndex ? ' me' : ''}"></div>`;
        html += laneTotal ? '' : '<div class="more">…</div>';
      } else if (laneTotal) {
        html += '<div class="bar"></div>';
        for (let i = 1; i <= laneTotal; i++) html += '<div class="ln"></div>';
      } else {
        html += '<div class="more">…</div><div class="ln me"></div>' + (lanes.rightSolid ? '' : '<div class="more">…</div>');
      }
    }
    $('strip').innerHTML = html;
  }
}

// ===== Cài đặt =====
function bindSettings() {
  for (const id of ['fov', 'cal', 'hor', 'hood']) {
    const el = $(id), out = $(id + 'V');
    el.value = cfg[id]; out.textContent = cfg[id];
    el.oninput = () => { cfg[id] = parseFloat(el.value); out.textContent = el.value; };
  }
  for (const id of ['voice', 'laneWarn', 'speedWarn', 'beep', 'dbg', 'autoHor']) {
    const el = $(id);
    el.checked = cfg[id];
    el.onchange = () => { cfg[id] = el.checked; };
  }
  // Xe của bạn
  const bSel = $('carBrand'), mSel = $('carModel'), cIn = $('carColor'), sw = $('carSwatches');
  const fillModels = () => {
    mSel.textContent = '';
    for (const [name] of CAR_BRANDS[bSel.value] || []) mSel.add(new Option(name, name));
    if ([...mSel.options].some((o) => o.value === cfg.carModel)) mSel.value = cfg.carModel;
    cfg.carModel = mSel.value;
  };
  if (!bSel.options.length) for (const b of Object.keys(CAR_BRANDS)) bSel.add(new Option(b, b));
  bSel.value = CAR_BRANDS[cfg.carBrand] ? cfg.carBrand : 'Khác';
  fillModels();
  bSel.onchange = () => { cfg.carBrand = bSel.value; fillModels(); };
  mSel.onchange = () => { cfg.carModel = mSel.value; };
  cIn.value = cfg.carColor;
  cIn.oninput = () => { cfg.carColor = cIn.value; markSwatch(); };
  const markSwatch = () => sw.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.c === cfg.carColor));
  if (!sw.children.length) {
    for (const [name, c] of CAR_COLORS) {
      const b = document.createElement('button');
      b.type = 'button'; b.title = name; b.dataset.c = c; b.style.background = c;
      b.onclick = () => { cfg.carColor = c; cIn.value = c; markSwatch(); };
      sw.appendChild(b);
    }
  }
  markSwatch();

  const th = $('theme');
  th.value = cfg.theme;
  th.onchange = () => { cfg.theme = th.value; applyTheme(); };
}

applyTheme();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
