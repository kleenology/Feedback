'use strict';
/* اختبار منطق الرموز بلا شبكة ولا فايربيس: نحقن مخزناً في الذاكرة ومزوّداً وهمياً */
process.env.OTP_SECRET = 'test-secret';
process.env.ALLOWED_ORIGINS = 'https://kleenology.github.io';
process.env.OTP_DAILY_CAP = '3';

const path = require('path');
const storePath = require.resolve('../api/_lib/store.js');
const smsPath   = require.resolve('../api/_lib/sms.js');

let DB = {}, DAY = 0, SENT = [], FAIL_SMS = false, CH = 'sms';
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
  channels() { return [CH]; },
  async deliver(p, code, via) {
    if (FAIL_SMS) throw new Error('boom');
    const ch = via || CH; SENT.push({ p, code, via: ch }); return ch;
  }
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
const reset = () => { DB = {}; DAY = 0; SENT = []; FAIL_SMS = false; CH = 'sms'; };

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

  await t('الرقم التجريبي: رمز ثابت بلا رسالة ولا تكلفة', async () => {
    reset(); process.env.OTP_DAILY_CAP = '99';
    process.env.OTP_TEST_NUMBERS = '0500000001:123456';
    const TN = '966500000001';
    eq((await call(send, { phone: TN })).status, 200);
    eq(SENT.length, 0, 'أرسل رسالة لرقم تجريبي');
    eq(DAY, 1, 'ما احتسبه على السقف اليومي');   /* يُحسب: باب مفتوح لو ما انحسب */
    const r = await call(verify, { phone: TN, code: '123456' });
    eq(r.status, 200); eq(r.body.token, 'token-for-' + TN);
  });

  await t('الرقم التجريبي ما يقبل رمزاً غيره', async () => {
    reset(); process.env.OTP_TEST_NUMBERS = '0500000001:123456';
    const TN = '966500000001';
    await call(send, { phone: TN });
    eq((await call(verify, { phone: TN, code: '000000' })).status, 400);
  });

  await t('رمز التجربة ما يفتح رقماً حقيقياً', async () => {
    reset(); process.env.OTP_TEST_NUMBERS = '0500000001:123456';
    await call(send, { phone: PH });
    eq(SENT.length, 1, 'الرقم الحقيقي لازم تُرسل له رسالة');
    eq((await call(verify, { phone: PH, code: '123456' })).status, 400, 'قبل رمز التجربة لرقم حقيقي');
  });

  await t('الحدود تنطبق على الرقم التجريبي كذلك', async () => {
    reset(); process.env.OTP_TEST_NUMBERS = '0500000001:123456';
    const TN = '966500000001';
    await call(send, { phone: TN });
    eq((await call(send, { phone: TN })).status, 429, 'ما طبّق المهلة على التجريبي');
  });

  await t('إعداد خاطئ للأرقام التجريبية يُتجاهل بأمان', async () => {
    process.env.OTP_TEST_NUMBERS = 'خربطة,0500000002:12,:,,0412345678:123456';
    eq(Object.keys(U.testNumbers()).length, 0, JSON.stringify(U.testNumbers()));
    process.env.OTP_TEST_NUMBERS = '';
  });

  /* ================= واتساب و SMS احتياطي ================= */
  await t('الرد يقول وين انرسل الرمز', async () => {
    reset(); process.env.OTP_DAILY_CAP = '99'; CH = 'whatsapp';
    const r = await call(send, { phone: PH });
    eq(r.status, 200); eq(r.body.via, 'whatsapp'); eq(DB[PH].via, 'whatsapp');
  });

  await t('«أرسله SMS» بعد واتساب: مهلة ٢٠ ثانية بدل دقيقة', async () => {
    reset(); process.env.OTP_DAILY_CAP = '99'; CH = 'whatsapp';
    await call(send, { phone: PH });
    eq((await call(send, { phone: PH, via: 'sms' })).status, 429, 'سمح قبل ٢٠ ثانية');
    DB[PH].sentAt = Date.now() - 21000;
    const r = await call(send, { phone: PH, via: 'sms' });
    eq(r.status, 200); eq(r.body.via, 'sms'); eq(SENT[SENT.length - 1].via, 'sms');
    /* الرمز الجديد هو اللي يفتح — القديم ما عاد صالحاً */
    eq((await call(verify, { phone: PH, code: SENT[0].code === SENT[1].code ? 'x' : SENT[0].code })).status, 400);
  });

  await t('بعد SMS المهلة دقيقة كاملة حتى مع via:sms', async () => {
    reset(); process.env.OTP_DAILY_CAP = '99'; CH = 'sms';
    await call(send, { phone: PH });
    DB[PH].sentAt = Date.now() - 21000;
    eq((await call(send, { phone: PH, via: 'sms' })).status, 429);
  });

  await t('via غير معروف يُتجاهل', async () => {
    reset(); CH = 'whatsapp';
    const r = await call(send, { phone: PH, via: 'carrier-pigeon' });
    eq(r.status, 200); eq(r.body.via, 'whatsapp');
  });

  /* اختيار القناة الحقيقي (بدون المزوّد الوهمي) */
  delete require.cache[smsPath];
  const real = require('../api/_lib/sms.js');
  const quiet = console.error; console.error = () => {};
  const L = [];
  real.PROVIDERS.mock = async (to, body) => { L.push(['sms', to, body]); };
  real.WA.mock = async (to, code) => { L.push(['wa', to, code]); };
  real.WA.down = async () => { throw new Error('wa down'); };

  await t('القنوات: الافتراضي SMS وحده', async () => {
    delete process.env.OTP_CHANNELS;
    eq(real.channels().join(), 'sms');
    process.env.OTP_CHANNELS = 'fax, ,';
    eq(real.channels().join(), 'sms', 'قيمة خاطئة');
  });

  await t('واتساب أولاً حين ينجح', async () => {
    L.length = 0; process.env.OTP_CHANNELS = 'whatsapp,sms'; process.env.WA_PROVIDER = 'mock'; process.env.SMS_PROVIDER = 'mock';
    eq(await real.deliver(PH, '111222'), 'whatsapp'); eq(L.length, 1); eq(L[0][0], 'wa');
  });

  await t('واتساب فشل ← SMS تلقائياً', async () => {
    L.length = 0; process.env.WA_PROVIDER = 'down';
    eq(await real.deliver(PH, '111222'), 'sms'); eq(L.length, 1); eq(L[0][0], 'sms');
    if (!L[0][2].includes('111222')) throw new Error('نص SMS بلا الرمز');
  });

  await t('via:sms يتجاوز واتساب', async () => {
    L.length = 0; process.env.WA_PROVIDER = 'mock';
    eq(await real.deliver(PH, '111222', 'sms'), 'sms'); eq(L[0][0], 'sms');
  });

  await t('القناتين فشلتا ← خطأ', async () => {
    process.env.WA_PROVIDER = 'down'; process.env.SMS_PROVIDER = 'nope';
    let threw = false; try { await real.deliver(PH, '111222'); } catch (e) { threw = true; }
    eq(threw, true);
    process.env.SMS_PROVIDER = 'mock';
  });

  await t('شكل طلب Meta: قالب + الرمز في الجسم وزر النسخ', async () => {
    const F = global.fetch; let got = null;
    global.fetch = async (url, o) => { got = { url, o }; return { ok: true, status: 200, text: async () => '{"messages":[{"id":"wamid.x"}]}' }; };
    process.env.WA_PHONE_ID = '1234'; process.env.WA_TOKEN = 'tok';
    try { await real.WA.meta(PH, '654321'); } finally { global.fetch = F; }
    if (!/graph\.facebook\.com\/v\d+\.\d+\/1234\/messages$/.test(got.url)) throw new Error(got.url);
    eq(got.o.headers.Authorization, 'Bearer tok');
    const b = JSON.parse(got.o.body);
    eq(b.to, PH); eq(b.type, 'template'); eq(b.template.name, 'kleenology_otp'); eq(b.template.language.code, 'ar');
    eq(b.template.components[0].parameters[0].text, '654321');
    eq(b.template.components[1].sub_type, 'url'); eq(b.template.components[1].parameters[0].text, '654321');
  });

  await t('Meta ردّت بلا رسالة ← فشل (فيتحول لـ SMS)', async () => {
    const F = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200, text: async () => '{"error":{"message":"x"}}' });
    let threw = false; try { await real.WA.meta(PH, '654321'); } catch (e) { threw = true; } finally { global.fetch = F; }
    eq(threw, true);
  });
  console.error = quiet;

  console.log('\n' + (fail ? 'ERRORS: ' + fail : 'ERRORS: none'));
  process.exit(fail ? 1 : 0);
})();
