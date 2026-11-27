'use strict';
/* GET /api/health — فحص الإعداد بعد النشر: يقول لك أي جزء ناقص بدون ما يكشف أي مفتاح.
   firebase: يتصل بقاعدة البيانات بحساب الخدمة. ostaz: يسأل «الأستاذ» عن هوية الرمز (قراءة بس). */
const S = require('./_lib/store');
const O = require('./_lib/ostaz');
const T = require('./_lib/tap');

const has = k => !!String(process.env[k] || '').trim();

module.exports = async function handler(req, res) {
  const out = {
    env: {
      ALLOWED_ORIGINS: has('ALLOWED_ORIGINS'), FB_PROJECT_ID: has('FB_PROJECT_ID'),
      FB_CLIENT_EMAIL: has('FB_CLIENT_EMAIL'), FB_PRIVATE_KEY: has('FB_PRIVATE_KEY'),
      OSTAZ_URL: has('OSTAZ_URL'), OSTAZ_TOKEN: has('OSTAZ_TOKEN'),
      OTP_SECRET: has('OTP_SECRET'),
      OSTAZ_WEBHOOK_SECRET: has('OSTAZ_WEBHOOK_SECRET'),
      NODEJS_HELPERS_off: process.env.NODEJS_HELPERS === '0', SMS_PROVIDER: process.env.SMS_PROVIDER || '(none)'
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
    out.ostaz = me && me.id ? 'ok' : 'رد غير متوقع';
  } catch (e) {
    const c = (e && e.code) || '';
    out.ostaz = c === 'not_configured' ? 'OSTAZ_URL أو OSTAZ_TOKEN ناقص'
      : c === 'ostaz_401' ? 'OSTAZ_TOKEN غير صحيح أو محذوف' : 'خطأ: ' + String((e && e.message) || e).slice(0, 160);
  }
  /* واتساب (رموز الدخول): نتأكد إن الرمز ورقم الهاتف صحيحين بقراءة بيانات الرقم من Meta — ما يرسل شي */
  out.otp = { channels: process.env.OTP_CHANNELS || 'sms', OTP_SECRET: has('OTP_SECRET'), wa_provider: process.env.WA_PROVIDER || '(none)',
    WA_PHONE_ID: has('WA_PHONE_ID'), WA_TOKEN: has('WA_TOKEN'), template: process.env.WA_TEMPLATE || 'kleenology_otp' };
  if (process.env.WA_PROVIDER === 'meta' && has('WA_PHONE_ID') && has('WA_TOKEN')) {
    try {
      const ver = process.env.WA_API_VERSION || 'v21.0';
      const r = await fetch('https://graph.facebook.com/' + ver + '/' + process.env.WA_PHONE_ID +
        '?fields=display_phone_number,verified_name,quality_rating', { headers: { Authorization: 'Bearer ' + process.env.WA_TOKEN } });
      const j = await r.json().catch(() => ({}));
      out.otp.whatsapp = r.ok ? ('ok — ' + (j.verified_name || '') + ' ' + (j.display_phone_number || '')).trim()
        : 'خطأ ' + r.status + ': ' + String((j.error && j.error.message) || '').slice(0, 140);
    } catch (e) { out.otp.whatsapp = 'خطأ: ' + String((e && e.message) || e).slice(0, 120); }
  }
  /* تاب: نتأكد إن المفتاح شغّال بقراءة قائمة فاضية — ما ينشئ أي عملية */
  out.tap = { mode: T.mode() || '(no key)' };
  if (T.mode()) {
    try { await T.call('POST', '/charges/list', { period: { date: { from: Date.now() - 86400000, to: Date.now() } }, limit: 1 }); out.tap.status = 'ok'; }
    catch (e) { out.tap.status = /not found/i.test(String(e && e.message)) ? 'ok (ما فيه عمليات بعد)'
      : /401|403/.test(String(e && e.message)) ? 'TAP_SECRET_KEY غير صحيح' : 'خطأ: ' + String((e && e.message) || e).slice(0, 140); }
  }
  out.ok = out.firebase === 'ok' && String(out.ostaz).startsWith('ok');
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(out, null, 2));
};
