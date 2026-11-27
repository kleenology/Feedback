'use strict';
/* /api/pay/{start|verify|hook|test|sweep} — دالة وحدة لكل عمليات الدفع.
   الخطة المجانية في Vercel تسمح بـ ١٢ دالة بس، فنجمع الدفع هنا ونوزّع حسب آخر جزء من الرابط.
   كل عملية في ملفها داخل api/_pay (الملفات اللي تبدأ بـ _ ما تنحسب دوال). */
const H = {
  start: require('../_pay/start'),
  verify: require('../_pay/verify'),
  hook: require('../_pay/hook'),
  test: require('../_pay/test'),
  sweep: require('../_pay/sweep')
};

module.exports = function handler(req, res) {
  let a = (req.query && req.query.action) || '';
  if (!a) { const m = /\/api\/pay\/([a-z]+)/.exec(String(req.url || '')); a = m ? m[1] : ''; }
  const h = Object.prototype.hasOwnProperty.call(H, a) ? H[a] : null;
  if (!h) { res.statusCode = 404; res.setHeader('Content-Type', 'application/json'); return res.end('{"error":"not_found"}'); }
  return h(req, res);
};
