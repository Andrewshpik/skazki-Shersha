// Service Worker для «Сказок Шерша»
// Кэширует статические файлы (оболочку сайта) для быстрой загрузки и офлайн-режима.
const CACHE = 'shersha-cache-v2';
const ASSETS = [
  './',
  './index.html',
  './shersh_cursor.png',
  './banner.jpg',
  './tale.js',
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