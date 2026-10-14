// Cache app + thư viện + mô hình để dùng được khi sóng yếu trên cao tốc
const CACHE = 'caotoc-v2';
const SHELL = ['./', 'index.html', 'app.js', 'manifest.json', 'icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isLib = /cdn\.jsdelivr\.net|storage\.googleapis\.com|tfhub\.dev|kaggle/.test(url.host);
  if (isLib) {
    // Thư viện & trọng số mô hình: cache-first
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }))
    );
  } else if (url.origin === location.origin) {
    // File của app: network-first để luôn lấy bản mới
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req))
    );
  }
});
