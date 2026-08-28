/* كاش الأصول الثابتة فقط — بيانات Firestore تُجلب دائماً من الشبكة */
var CACHE = 'kln-v28';
var ASSETS = ['./index.html', './reviews.html', './app/index.html', './app/manifest.json', './logo.png', './icon.png', './icon-192.png', './icon-512.png', './manifest.json'];

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
  /* ملف الإصدار هو أداة كشف القديم — لو انكيّش صار هو نفسه قديماً */
  if (/version\.json$/.test(url.pathname)) return;

  var isDoc = req.mode === 'navigate' || /\.html?$/.test(url.pathname) || url.pathname.endsWith('/');

  e.respondWith(
    caches.open(CACHE).then(function (c) {
      return c.match(req).then(function (hit) {
        var net = fetch(req).then(function (res) {
          if (res && res.status === 200) c.put(req, res.clone());
          return res;
        }).catch(function () { return hit || c.match('./index.html'); });

        /* الصفحات: الشبكة أولاً بمهلة ثانيتين ونصف — نسخة قديمة من التطبيق تعني
           أخطاءً وهمية يطاردها المستخدم، والكاش يبقى شبكة أمان عند ضعف الشبكة */
        if (isDoc && hit) {
          return Promise.race([
            net,
            new Promise(function (r) { setTimeout(function () { r(hit); }, 2500); })
          ]);
        }
        /* بقية الأصول (شعار، manifest): الكاش أولاً وتحديث بالخلفية */
        return hit || net;
      });
    })
  );
});
