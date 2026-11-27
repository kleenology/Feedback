'use strict';
/* الدفع عبر «تاب»: فتح الدفع، التحقق عند الرجوع، والتنبيه — بلا شبكة (تاب وقاعدة البيانات وهميين) */
process.env.TAP_SECRET_KEY = 'sk_test_x';

const storePath = require.resolve('../api/_lib/store.js');
let ORD = {}, TOK = {}, CH = {}, N = 0, GATE = true, SLOTFREED = [];
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: {
  async sweepGate() { return GATE; },
  async staleTapOrders(cut) { return Object.keys(ORD).map(k => Object.assign({ _id: k }, ORD[k]))
    .filter(o => o.pay === 'tap' && o.st === 'new' && !(o.paid > 0) && String(o.at || '') < cut); },
  async cancelUnpaid(id) { const o = ORD[id]; if (o.st !== 'new' || o.paid > 0) return false; o.st = 'cancelled'; SLOTFREED.push(id); return true; },
  async adminUid(t) { return t === 'adm' ? 'a1' : ''; },
  async userUid(t) { if (!TOK[t]) throw new Error('bad token'); return TOK[t]; },
  async getOrder(id) { return ORD[id] ? JSON.parse(JSON.stringify(ORD[id])) : null; },
  async setTapPending(id, tap) { ORD[id].tap = tap; },
  async applyTapPayment(id, ch, m) {
    const o = ORD[id]; if (!o) return { ok: false };
    o.pays = o.pays || [];
    if (o.pays.some(p => p.id === ch.id)) return { ok: true, already: true, paid: o.paid };
    o.paid = (o.paid || 0) + Number(ch.amount); o.pays.push({ id: ch.id, amt: Number(ch.amount), m: 'tap', src: m });
    o.tap = { id: ch.id, st: 'CAPTURED' };
    return { ok: true, paid: o.paid };
  },
  async setTapStatus(id, cid, st) { if (ORD[id] && ORD[id].tap && ORD[id].tap.id === cid) ORD[id].tap.st = st; }
} };

/* تاب الوهمي: ينشئ العملية ويرجّع حالتها المخزّنة — والاختبار يغيّر الحالة كأن العميل دفع */
let LAST = null;
global.fetch = async (url, opt) => {
  const ok = (j) => ({ ok: true, status: 200, text: async () => JSON.stringify(j) });
  if (!/^Bearer sk_test_x$/.test(opt.headers.Authorization)) return { ok: false, status: 401, text: async () => '{}' };
  if (opt.method === 'POST' && url.endsWith('/charges')) {
    const b = JSON.parse(opt.body); LAST = b;
    const id = 'chg_TEST' + (++N) + 'abcdef';
    CH[id] = Object.assign({ id, status: 'INITIATED' }, b);
    return ok({ id, status: 'INITIATED', transaction: { url: 'https://checkout.tap.company/?mode=page&language=en&token=x' } });
  }
  const m = /\/charges\/(chg_\w+)$/.exec(url);
  if (m && CH[m[1]]) return ok(CH[m[1]]);
  return { ok: false, status: 404, text: async () => '{"errors":[{"code":"404"}]}' };
};

const T = require('../api/_lib/tap');
const start = require('../api/pay/start');
const verify = require('../api/pay/verify');
const hook = require('../api/pay/hook');
const ptest = require('../api/pay/test');
const sweep = require('../api/pay/sweep');

function call(fn, body, tok) {
  const req = { method: 'POST', headers: { host: 'srv.test', origin: 'https://app.kleenology.me' }, body, rawBody: JSON.stringify(body) };
  if (tok) req.headers.authorization = 'Bearer ' + tok;
  return new Promise(resolve => {
    const res = { statusCode: 200, setHeader() {}, end(s) { resolve({ status: this.statusCode, body: s ? JSON.parse(s) : {} }); } };
    fn(req, res);
  });
}

let pass = 0, fail = 0;
const t = async (n, fn) => { try { await fn(); console.log('✓ ' + n); pass++; } catch (e) { console.log('✗ ' + n + ' — ' + e.message); fail++; } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || '') + ' ' + JSON.stringify(a) + ' ≠ ' + JSON.stringify(b)); };
const reset = () => {
  ORD = { o1: { uid: 'u1', ph: '966501234567', n: 'سالم', no: 1001, est: 400, dep: 200, st: 'new' },
          o2: { uid: 'u2', ph: '966509999999', n: 'نورة', no: 1002, est: 300, dep: 150, st: 'new' } };
  TOK = { tk1: 'u1', tk2: 'u2' }; CH = {}; LAST = null;
};

(async () => {
  await t('بلا تسجيل دخول: 401', async () => { reset(); eq((await call(start, { order: 'o1' })).status, 401); });
  await t('طلب عميل ثاني: 404 وما ينفتح دفع', async () => {
    reset(); eq((await call(start, { order: 'o2' }, 'tk1')).status, 404); eq(LAST, null);
  });
  await t('المبلغ من قاعدة البيانات (العربون) لا من المتصفح', async () => {
    reset(); const r = await call(start, { order: 'o1', amount: 1 }, 'tk1');
    eq([r.status, r.body.amount, LAST.amount, LAST.currency], [200, 200, 200, 'SAR']);
    eq([LAST.metadata.oid, LAST.reference.transaction, LAST.customer.phone], ['o1', 'KLN-o1', { country_code: '966', number: '501234567' }]);
    eq(LAST.redirect.url, 'https://app.kleenology.me/app/?pay=o1');
    eq(LAST.post.url, 'https://srv.test/api/pay/hook');
    if (!/language=ar/.test(r.body.url)) throw new Error('الصفحة مو بالعربي: ' + r.body.url);
    eq(ORD.o1.tap.st, 'INITIATED');
  });
  await t('مدفوع جزئياً: يطلب الباقي من العربون بس', async () => {
    reset(); ORD.o1.paid = 50; await call(start, { order: 'o1' }, 'tk1'); eq(LAST.amount, 150);
  });
  await t('العربون مدفوع كامل: ما يفتح دفع', async () => {
    reset(); ORD.o1.paid = 200; const r = await call(start, { order: 'o1' }, 'tk1'); eq([r.body.paid, LAST], [true, null]);
  });
  await t('طلب ملغي: ما يفتح دفع', async () => {
    reset(); ORD.o1.st = 'cancelled'; eq((await call(start, { order: 'o1' }, 'tk1')).status, 400);
  });

  await t('رجوع العميل قبل ما يدفع: ما يتسجّل شي', async () => {
    reset(); await call(start, { order: 'o1' }, 'tk1'); const id = ORD.o1.tap.id;
    const r = await call(verify, { tap_id: id }, 'tk1');
    eq([r.body.ok, r.body.status, ORD.o1.paid], [false, 'INITIATED', undefined]);
  });
  await t('دفع ناجح: يتسجّل مرة وحدة مهما تكرر التحقق والتنبيه', async () => {
    reset(); await call(start, { order: 'o1' }, 'tk1'); const id = ORD.o1.tap.id;
    CH[id].status = 'CAPTURED';
    const r = await call(verify, { tap_id: id }, 'tk1');
    eq([r.body.ok, r.body.paid, r.body.no], [true, 200, 1001]);
    await call(verify, { tap_id: id }, 'tk1');
    await call(hook, { id, status: 'CAPTURED' });
    await call(hook, { id, status: 'CAPTURED' });
    eq([ORD.o1.paid, ORD.o1.pays.length], [200, 1]);
  });
  await t('عميل ثاني ما يقدر يتحقق من دفعة غيره', async () => {
    reset(); await call(start, { order: 'o1' }, 'tk1'); const id = ORD.o1.tap.id; CH[id].status = 'CAPTURED';
    eq((await call(verify, { tap_id: id }, 'tk2')).status, 404); eq(ORD.o1.paid, undefined);
  });
  await t('تنبيه مزوّر يقول CAPTURED وتاب يقول لا: ما يتسجّل', async () => {
    reset(); await call(start, { order: 'o1' }, 'tk1'); const id = ORD.o1.tap.id;
    await call(hook, { id, status: 'CAPTURED', amount: 200, metadata: { oid: 'o1' } });
    eq(ORD.o1.paid, undefined);
  });
  await t('تنبيه لعملية مو موجودة عند تاب: ما يتسجّل', async () => {
    reset(); const r = await call(hook, { id: 'chg_FAKE123456', status: 'CAPTURED' });
    eq([r.status, r.body.ignored, ORD.o1.paid], [200, 'unknown', undefined]);
  });
  await t('عملة غير الريال ما تنحسب', async () => {
    eq(T.captured({ status: 'CAPTURED', currency: 'USD', amount: 200, metadata: { oid: 'o1' } }, 'o1'), false);
    eq(T.captured({ status: 'CAPTURED', currency: 'SAR', amount: 200, metadata: { oid: 'o2' } }, 'o1'), false);
    eq(T.captured({ status: 'CAPTURED', currency: 'SAR', amount: 200, metadata: { oid: 'o1' } }, 'o1'), true);
  });
  await t('رقم عملية بصيغة غلط يُرفض', async () => {
    reset(); eq((await call(verify, { tap_id: '../charges' }, 'tk1')).status, 400);
  });

  await t('تجربة الريال: للأدمن بس', async () => {
    reset(); eq((await call(ptest, {}, 'tk1')).status, 401); eq(LAST, null);
    const r = await call(ptest, {}, 'adm'); eq([r.status, LAST.amount, LAST.metadata.test], [200, 1, 'admin']);
    if (!/paytest=1/.test(LAST.redirect.url)) throw new Error(LAST.redirect.url);
  });
  await t('تجربة الريال: ما تقرأ عمليات الطلبات الحقيقية', async () => {
    reset(); await call(start, { order: 'o1' }, 'tk1'); const id = ORD.o1.tap.id;
    eq((await call(ptest, { tap_id: id }, 'adm')).status, 404);
  });
  const old = new Date(Date.now() - 2 * 3600e3).toISOString(), fresh = new Date().toISOString();
  await t('إلغاء تلقائي: طلب ما انْدفع من ساعتين يتلغى ويتحرّر موعده', async () => {
    reset(); GATE = true; SLOTFREED = [];
    Object.assign(ORD.o1, { pay: 'tap', at: old });
    Object.assign(ORD.o2, { pay: 'tap', at: fresh });
    const r = await call(sweep, {});
    eq([r.body.cancelled, ORD.o1.st, ORD.o2.st, SLOTFREED], [1, 'cancelled', 'new', ['o1']]);
  });
  await t('إلغاء تلقائي: دفع ووصل التنبيه متأخر — ينحسب مدفوع ما يتلغى', async () => {
    reset(); GATE = true; SLOTFREED = [];
    await call(start, { order: 'o1' }, 'tk1'); const id = ORD.o1.tap.id; CH[id].status = 'CAPTURED';
    Object.assign(ORD.o1, { pay: 'tap', at: old }); ORD.o1.tap.at = old;
    const r = await call(sweep, {});
    eq([r.body.paid, r.body.cancelled, ORD.o1.st, ORD.o1.paid], [1, 0, 'new', 200]);
  });
  await t('إلغاء تلقائي: العميل للحين في صفحة الدفع (بدأ قبل دقائق) — ننتظره', async () => {
    reset(); GATE = true;
    Object.assign(ORD.o1, { pay: 'tap', at: old });
    await call(start, { order: 'o1' }, 'tk1');
    const r = await call(sweep, {});
    eq([r.body.kept, ORD.o1.st], [1, 'new']);
  });
  await t('إلغاء تلقائي: التحويل البنكي والطلبات المدفوعة ما تنلمس', async () => {
    reset(); GATE = true;
    Object.assign(ORD.o1, { pay: 'bank', at: old }); Object.assign(ORD.o2, { pay: 'tap', at: old, paid: 150 });
    const r = await call(sweep, {});
    eq([r.body.cancelled, ORD.o1.st, ORD.o2.st], [0, 'new', 'new']);
  });
  await t('إلغاء تلقائي: يشتغل مرة كل ٥ دقائق بس', async () => {
    reset(); GATE = false; Object.assign(ORD.o1, { pay: 'tap', at: old });
    const r = await call(sweep, {}); eq([r.body.skipped, ORD.o1.st], [true, 'new']);
  });
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
