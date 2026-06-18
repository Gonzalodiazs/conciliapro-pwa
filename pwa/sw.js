// Service Worker de ConciliaPro Repartidor.
// Código de la app: NETWORK-FIRST (siempre fresco cuando hay señal → los fixes llegan).
// Librerías pesadas e inmutables (opencv/tesseract/zxing…): cache-first (no re-descargar).
const CACHE = 'conciliapro-repartidor-v3';
const ASSETS = ['./index.html', './pwa/manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

function cachePut(req, res) { if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; }

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Las llamadas a la API siempre van a la red (datos frescos)
  if (url.pathname.includes('/api/')) {
    e.respondWith(fetch(e.request).catch(() => new Response(JSON.stringify({ offline: true }), { headers: { 'Content-Type': 'application/json' } })));
    return;
  }
  const p = url.pathname;
  // Código de la app (HTML + store.js + vendor/cp-*.js + manifest): NETWORK-FIRST.
  // Así una versión nueva (APK recompilado / PWA) SIEMPRE se sirve fresca cuando hay señal,
  // y los arreglos llegan al usuario; offline cae a la copia en caché.
  const esCodigoApp = p.endsWith('.html') || p.endsWith('manifest.json') || /\/(store\.js|cp-[\w-]+\.js)$/.test(p);
  if (esCodigoApp) {
    e.respondWith(
      fetch(e.request).then((res) => cachePut(e.request, res)).catch(() => caches.match(e.request))
    );
    return;
  }
  // Librerías pesadas e inmutables y assets: CACHE-FIRST (rápido, sin re-descargar).
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request).then((res) => cachePut(e.request, res)))
  );
});
