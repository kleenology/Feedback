/* كاش الأصول الثابتة فقط — بيانات Firestore تُجلب دائماً من الشبكة */
var CACHE = 'kln-v58';
/* مكتبات خارجية روابطها فيها رقم إصدار ثابت (فايربيس 10.12.0، ملفات الخط) — محتواها ما يتغير،
   فتنحفظ مرة وتُخدم من الجهاز. كاش منفصل يعيش بين إصدارات التطبيق */
var LIB = 'kln-lib-1';
function isLib(u) {
  return (u.hostname === 'www.gstatic.com' && u.pathname.indexOf('/firebasejs/') === 0) ||
         u.hostname === 'fonts.gstatic.com' || u.hostname === 'fonts.googleapis.com';
}
var ASSETS = ['./index.html', './reviews.html', './app/index.html', './app/manifest.json', './app/img/splash.png', './logo.png', './icon.png', './icon-192.png', './icon-512.png', './manifest.json'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE && k !== LIB; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    if (!isLib(url)) return; /* بيانات فايربيس وغيرها: شبكة مباشرة دائماً */
    e.respondWith(caches.open(LIB).then(function (c) {
      return c.match(req).then(function (hit) {
        if (hit) return hit;
        /* نطلبها cors عشان نعرف إنها نجحت فعلاً — استجابة «مبهمة» ممكن تكون خطأ ينحفظ للأبد */
        return fetch(new Request(req.url, { mode: 'cors', credentials: 'omit' })).then(function (res) {
          if (res && res.ok) c.put(req, res.clone());
          return res;
        }).catch(function () { return fetch(req); });
      });
    }));
    return;
  }
  /* ملف الإصدار هو أداة كشف القديم — لو انكيّش صار هو نفسه قديماً */
  if (/version\.json$/.test(url.pathname)) return;

  var isDoc = req.mode === 'navigate' || /\.html?$/.test(url.pathname) || url.pathname.endsWith('/');

  e.respondWith(
    caches.open(CACHE).then(function (c) {
      return c.match(req).then(function (hit) {
        var net = fetch(req).then(function (res) {
          if (res && res.status === 200) c.put(req, res.clone());
          return res;
        }).catch(function () {
          if (hit) return hit;
          /* بدون شبكة: تطبيق العميل يرجع لصفحته، مو لصفحة التقييم */
          if (isDoc) return c.match(/\/app(\/|$)/.test(url.pathname) ? './app/index.html' : './index.html');
          return Promise.reject(new Error('offline'));
        });

        /* الصفحات: الشبكة أولاً بمهلة أقل من ثانية (كانت ثانيتين ونص) — نسخة قديمة من التطبيق تعني
           أخطاءً وهمية يطاردها المستخدم، والكاش يبقى شبكة أمان عند ضعف الشبكة */
        if (isDoc && hit) {
          return Promise.race([
            net,
            new Promise(function (r) { setTimeout(function () { r(hit); }, 800); })
          ]);
        }
        /* بقية الأصول (شعار، manifest): الكاش أولاً وتحديث بالخلفية */
        return hit || net;
      });
    })
  );
});
