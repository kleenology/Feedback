'use strict';
/* اختبار منطق الرموز بلا شبكة ولا فايربيس: نحقن مخزناً في الذاكرة ومزوّداً وهمياً */
process.env.OTP_SECRET = 'test-secret';
process.env.ALLOWED_ORIGINS = 'https://kleenology.github.io';
process.env.OTP_DAILY_CAP = '3';

const path = require('path');
const storePath = require.resolve('../api/_lib/store.js');
const smsPath   = require.resolve('../api/_lib/sms.js');

let DB = {}, DAY = 0, SENT = [], FAIL_SMS = false;
const store = {
  async getOtp(p) { return DB[p] ? { ...DB[p] } : null; },
  async putOtp(p, d) { DB[p] = { ...d }; },
  async dropOtp(p) { delete DB[p]; },
  async bumpTries(p) { if (DB[p]) DB[p].tries = (DB[p].tries || 0) + 1; },
  async bumpDaily(limit) { if (DAY >= limit) return false; DAY++; return true; },
  async customToken(p) { return 'token-for-' + p; },
  uidFor: p => 'ph_' + p
};
const sms = {
  async sendSms(p, code) { if (FAIL_SMS) throw new Error('boom'); SENT.push({ p, code }); }
};
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: store };
require.cache[smsPath]   = { id: smsPath, filename: smsPath, loaded: true, exports: sms };

const send = require('../api/otp/send.js');
const verify = require('../api/otp/verify.js');
const U = require('../api/_lib/util.js');

function call(fn, body, opts = {}) {
  const req = {
    method: opts.method || 'POST',
    headers: { origin: opts.origin === undefined ? 'https://kleenology.github.io' : opts.origin },
    body
  };
  return new Promise(resolve => {
    const res = {
      statusCode: 200, _h: {}, setHeader(k, v) { this._h[k] = v; },
      end(s) { resolve({ status: this.statusCode, body: s ? JSON.parse(s) : null, headers: this._h }); }
    };
    fn(req, res);
  });
}

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); console.log('✓ ' + name); pass++; }
  catch (e) { console.log('✗ ' + name + ' — ' + e.message); fail++; }
};
const eq = (a, b, m) => { if (a !== b) throw new Error((m || '') + ' ' + JSON.stringify(a) + ' ≠ ' + JSON.stringify(b)); };
const reset = () => { DB = {}; DAY = 0; SENT = []; FAIL_SMS = false; };

(async () => {
  const PH = '966537519929';

  await t('يرفض رقماً غير سعودي', async () => {
    reset();
    eq((await call(send, { phone: '0412345678' })).status, 400);
    eq((await call(send, { phone: '' })).status, 400);
    eq(SENT.length, 0, 'أرسل رغم الرفض');
  });

  await t('يقبل الصيغ كلها ويوحّدها', async () => {
    for (const v of ['0537519929', '+966 53 751 9929', '٠٥٣٧٥١٩٩٢٩', '00966537519929'])
      eq(U.normPhone(v), PH, v);
  });

  await t('يرسل الرمز ويخزّنه مجزّأً لا صريحاً', async () => {
    reset();
    const r = await call(send, { phone: '0537519929' });
    eq(r.status, 200); eq(SENT.length, 1);
    const rec = DB[PH];
    if (!rec) throw new Error('ما خزّن');
    if (String(rec.hash).includes(SENT[0].code)) throw new Error('الرمز مخزّن صريحاً');
    eq(rec.hash, U.hashCode(SENT[0].code, PH), 'الجزء لا يطابق');
    if (r.body.code || JSON.stringify(r.body).includes(SENT[0].code)) throw new Error('الرمز رجع في الرد');
  });

  await t('مهلة دقيقة بين رسالتين لنفس الرقم', async () => {
    reset();
    await call(send, { phone: PH });
    const r = await call(send, { phone: PH });
    eq(r.status, 429); eq(r.body.error, 'cooldown'); eq(SENT.length, 1);
  });

  await t('سقف خمس رسائل في الساعة', async () => {
    reset(); process.env.OTP_DAILY_CAP = '99';
    for (let i = 0; i < 5; i++) { await call(send, { phone: PH }); DB[PH].sentAt = 0; }
    const r = await call(send, { phone: PH });
    eq(r.status, 429); eq(r.body.error, 'too_many'); eq(SENT.length, 5);
  });

  await t('سقف يومي يحدّ الفاتورة', async () => {
    reset(); process.env.OTP_DAILY_CAP = '3';
    for (const n of ['966501111111', '966502222222', '966503333333']) await call(send, { phone: n });
    const r = await call(send, { phone: '966504444444' });
    eq(r.status, 503); eq(r.body.error, 'daily_cap'); eq(SENT.length, 3);
  });

  await t('رمز صحيح يعيد رمز دخول ويُستهلك مرة واحدة', async () => {
    reset();
    await call(send, { phone: PH });
    const code = SENT[0].code;
    const r = await call(verify, { phone: PH, code });
    eq(r.status, 200); eq(r.body.token, 'token-for-' + PH);
    eq(DB[PH], undefined, 'الرمز ما انحذف');
    eq((await call(verify, { phone: PH, code })).status, 400, 'قبله مرتين');
  });

  await t('رمز غلط يزيد المحاولات ويُقفل بعد خمس', async () => {
    reset();
    await call(send, { phone: PH });
    for (let i = 0; i < 5; i++) {
      const r = await call(verify, { phone: PH, code: '000000' });
      eq(r.status, 400, 'محاولة ' + (i + 1));
    }
    const r = await call(verify, { phone: PH, code: SENT[0].code });
    eq(r.status, 429, 'ما أقفل بعد خمس محاولات');
    eq(DB[PH], undefined, 'ما مسح الرمز بعد الإقفال');
  });

  await t('رمز منتهي الصلاحية يُرفض ويُمسح', async () => {
    reset();
    await call(send, { phone: PH });
    DB[PH].exp = Date.now() - 1;
    const r = await call(verify, { phone: PH, code: SENT[0].code });
    eq(r.status, 400); eq(r.body.error, 'expired'); eq(DB[PH], undefined);
  });

  await t('رمز رقم آخر ما يفتح هذا الرقم', async () => {
    reset();
    await call(send, { phone: PH });
    await call(send, { phone: '966501111111' });
    const other = SENT[1].code;
    const r = await call(verify, { phone: PH, code: other });
    eq(r.status, 400, 'قبل رمز رقم ثانٍ');
  });

  await t('فشل المزوّد ما يترك رمزاً صالحاً بلا رسالة', async () => {
    reset(); process.env.OTP_DAILY_CAP = '99'; FAIL_SMS = true;
    const r = await call(send, { phone: PH });
    eq(r.status, 500);
    eq(DB[PH], undefined, 'بقي رمز صالح بلا رسالة');
    FAIL_SMS = false;
    eq((await call(send, { phone: PH })).status, 200, 'حبس العميل بعد فشل ليس منه');
  });

  await t('أصل غير مسموح يُرفض، وOPTIONS يمر', async () => {
    reset();
    eq((await call(send, { phone: PH }, { origin: 'https://evil.example' })).status, 403);
    eq(SENT.length, 0);
    const o = await call(send, {}, { method: 'OPTIONS' });
    eq(o.status, 204);
    eq(o.headers['Access-Control-Allow-Origin'], 'https://kleenology.github.io');
  });

  await t('GET مرفوض', async () => {
    eq((await call(send, {}, { method: 'GET' })).status, 405);
    eq((await call(verify, {}, { method: 'GET' })).status, 405);
  });

  console.log('\n' + (fail ? 'ERRORS: ' + fail : 'ERRORS: none'));
  process.exit(fail ? 1 : 0);
})();
