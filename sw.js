/* كاش الأصول الثابتة فقط — بيانات Firestore تُجلب دائماً من الشبكة */
var CACHE = 'kln-v3';
var ASSETS = ['./index.html', './reviews.html', './logo.png', './manifest.json'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; /* Firebase وغيره: شبكة مباشرة */

  /* الكاش أولاً ثم تحديث بالخلفية: الصفحة تفتح فوراً بدل ما تنتظر 180KB على شبكة الجوال،
     والنسخة الجديدة تُنزّل بهدوء وتظهر في الفتحة التالية */
  e.respondWith(
    caches.open(CACHE).then(function (c) {
      return c.match(req).then(function (hit) {
        var net = fetch(req).then(function (res) {
          if (res && res.status === 200) c.put(req, res.clone());
          return res;
        }).catch(function () {
          return hit || c.match('./index.html');
        });
        return hit || net;
      });
    })
  );
});
