// Service Worker для «Сказок Шерша»
// Кэширует статические файлы (оболочку сайта) для быстрой загрузки и офлайн-режима.
const CACHE = 'shersha-cache-v39';
const OFFLINE_CACHE = 'shersh-offline-v1';
const ASSETS = [
  './',
  './index.html',
  './privacy.html',
  './shersh_cursor.png',
  './styles.css?v=15',
  './src/app/main.js?v=1',
  './src/features/tale-generator/index.js?v=1',
  './src/features/audio-player/index.js?v=1',
  './src/shared/state.js',
  './src/shared/lib/urls.js',
  './src/features/offline-save/index.js',
  './src/features/page-view/index.js',
  './src/features/search/index.js',
  './src/features/tag-filter/index.js',
  './src/features/like/index.js',
  './src/features/share/index.js',
  './src/features/report/index.js',
  './src/widgets/tale-of-day/index.js',
  './src/widgets/notifications/index.js',
  './src/widgets/feed/index.js',
  './admin.css',
  './admin.js?v=3',
  './manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== OFFLINE_CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
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
      caches.open(OFFLINE_CACHE)
        .then((saved) => saved.match(e.request))
        .then((savedCopy) => {
          // Сохранённое вручную читается без интернета в первую очередь
          if (savedCopy) return savedCopy;
          return fetch(e.request, { cache: 'no-store' })
            .then((res) => {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
              return res;
            })
            .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html')));
        })
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