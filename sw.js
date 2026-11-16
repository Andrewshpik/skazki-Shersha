// Service Worker для «Сказок Шерша»
// Кэширует статические файлы (оболочку сайта) для быстрой загрузки и офлайн-режима.
const CACHE = 'shersha-cache-v15';
const ASSETS = [
  './',
  './index.html',
  './shersh_cursor.png',
  './styles.css?v=8',
  './app.js?v=11',
  './tale.js?v=4',
  './player.js?v=1',
  './admin.css',
  './admin.js?v=1',
  './manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // API-запросы (Netrun) не кэшируем — данные живут в localStorage; пропускаем.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api')) {
    return;
  }

  // Код сайта (страницы и скрипты) всегда сначала из сети — иначе кеш держит
  // старые файлы после обновления. Картинки и прочее по-прежнему из кеша.
  const isCode = e.request.destination === 'document'
    || e.request.destination === 'script'
    || e.request.destination === 'style'
    || /\.(html|js|css)$/i.test(url.pathname);

  if (isCode) {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});