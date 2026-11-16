// Service Worker РґР»СЏ В«РЎРєР°Р·РѕРє РЁРµСЂС€Р°В»
// РљСЌС€РёСЂСѓРµС‚ СЃС‚Р°С‚РёС‡РµСЃРєРёРµ С„Р°Р№Р»С‹ (РѕР±РѕР»РѕС‡РєСѓ СЃР°Р№С‚Р°) РґР»СЏ Р±С‹СЃС‚СЂРѕР№ Р·Р°РіСЂСѓР·РєРё Рё РѕС„Р»Р°Р№РЅ-СЂРµР¶РёРјР°.
const CACHE = 'shersha-cache-v16';
const ASSETS = [
  './',
  './index.html',
  './shersh_cursor.png',
  './styles.css?v=9',
  './app.js?v=12',
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
  // API-Р·Р°РїСЂРѕСЃС‹ (Netrun) РЅРµ РєСЌС€РёСЂСѓРµРј вЂ” РґР°РЅРЅС‹Рµ Р¶РёРІСѓС‚ РІ localStorage; РїСЂРѕРїСѓСЃРєР°РµРј.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api')) {
    return;
  }

  // РљРѕРґ СЃР°Р№С‚Р° (СЃС‚СЂР°РЅРёС†С‹ Рё СЃРєСЂРёРїС‚С‹) РІСЃРµРіРґР° СЃРЅР°С‡Р°Р»Р° РёР· СЃРµС‚Рё вЂ” РёРЅР°С‡Рµ РєРµС€ РґРµСЂР¶РёС‚
  // СЃС‚Р°СЂС‹Рµ С„Р°Р№Р»С‹ РїРѕСЃР»Рµ РѕР±РЅРѕРІР»РµРЅРёСЏ. РљР°СЂС‚РёРЅРєРё Рё РїСЂРѕС‡РµРµ РїРѕ-РїСЂРµР¶РЅРµРјСѓ РёР· РєРµС€Р°.
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