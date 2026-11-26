'use strict';
/* GET /api/health — فحص الإعداد بعد النشر: يقول لك أي جزء ناقص بدون ما يكشف أي مفتاح.
   firebase: يتصل بقاعدة البيانات بحساب الخدمة. ostaz: يسأل «الأستاذ» عن هوية الرمز (قراءة بس). */
const S = require('./_lib/store');
const O = require('./_lib/ostaz');

const has = k => !!String(process.env[k] || '').trim();

module.exports = async function handler(req, res) {
  const out = {
    env: {
      ALLOWED_ORIGINS: has('ALLOWED_ORIGINS'), FB_PROJECT_ID: has('FB_PROJECT_ID'),
      FB_CLIENT_EMAIL: has('FB_CLIENT_EMAIL'), FB_PRIVATE_KEY: has('FB_PRIVATE_KEY'),
      OSTAZ_URL: has('OSTAZ_URL'), OSTAZ_TOKEN: has('OSTAZ_TOKEN'),
      OTP_SECRET: has('OTP_SECRET'), SMS_PROVIDER: process.env.SMS_PROVIDER || '(none)'
    }
  };
  try {
    await S.app().firestore().collection('otp_meta').doc('health').get();
    out.firebase = 'ok';
  } catch (e) {
    const m = String((e && e.message) || e);
    out.firebase = /PEM|private key|DECODER|asn1/i.test(m) ? 'FB_PRIVATE_KEY غير صحيح — انسخه كاملاً من -----BEGIN إلى END PRIVATE KEY-----\\n'
      : /client_email|invalid_grant|account/i.test(m) ? 'FB_CLIENT_EMAIL أو المفتاح غير مطابقين'
      : 'خطأ: ' + m.slice(0, 160);
  }
  try {
    const me = await O.call('GET', '/me');
    out.ostaz = me && me.id ? 'ok (' + (me.name || 'api') + ')' : 'رد غير متوقع';
  } catch (e) {
    const c = (e && e.code) || '';
    out.ostaz = c === 'not_configured' ? 'OSTAZ_URL أو OSTAZ_TOKEN ناقص'
      : c === 'ostaz_401' ? 'OSTAZ_TOKEN غير صحيح أو محذوف' : 'خطأ: ' + String((e && e.message) || e).slice(0, 160);
  }
  out.ok = out.firebase === 'ok' && String(out.ostaz).startsWith('ok');
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(out, null, 2));
};
