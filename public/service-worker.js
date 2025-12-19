const CACHE_NAME = 'financas-pwa-v1';

const FILES_TO_CACHE = [
  '/index.html',
  '/manifest.json',
  '/src/app.js'
];

// INSTALL
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return Promise.all(
          FILES_TO_CACHE.map(file =>
            fetch(file).then(response => {
              if (!response.ok) {
                throw new Error(`Falha ao cachear ${file}`);
              }
              return cache.put(file, response);
            })
          )
        );
      })
      .catch(err => console.error('❌ Erro no cache:', err))
  );
  self.skipWaiting();
});

// ACTIVATE
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.map(key => key !== CACHE_NAME && caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// FETCH
self.addEventListener('fetch', event => {
  // ❌ Nunca cachear API
  if (event.request.url.includes('/api/')) {
    return;
  }

  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request))
  );
});