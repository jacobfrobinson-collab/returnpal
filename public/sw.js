/* ReturnPal – minimal service worker for PWA / offline placeholder */
const CACHE = 'returnpal-v1';
self.addEventListener('install', function(e) {
  e.waitUntil(caches.open(CACHE).then(function(cache) {
    return cache.addAll(['/index.html', '/manifest.json']).catch(function() {});
  }));
  self.skipWaiting();
});
self.addEventListener('fetch', function(e) {
  e.respondWith(
    fetch(e.request).catch(function() {
      var url = (e.request.url || '').toLowerCase();
      var isDashboard = url.indexOf('/dashboard/') !== -1 || url.indexOf('/dashboard') === url.length - 10;
      if (isDashboard) return new Response('Not found', { status: 404, statusText: 'Not Found' });
      return caches.match(e.request).then(function(r) { return r || caches.match('/index.html'); });
    })
  );
});
