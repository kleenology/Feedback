'use strict';
/* الفاتورة التلقائية بعد الدفع: مرة وحدة، معتمدة، فيها الدفعة، ورابطها ينحفظ للعميل — بلا شبكة */
process.env.OSTAZ_URL = 'https://x.alostaz.io/b/api'; process.env.OSTAZ_TOKEN = 't';
const storePath = require.resolve('../api/_lib/store.js');
const ostazPath = require.resolve('../api/_lib/ostaz.js');
const realO = require('../api/_lib/ostaz.js');
let ORD = {}, CREATED = [], SHARE_FAIL = false, CREATE_FAIL = false;
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: {
  async lockInvoice(id) {
    const o = ORD[id]; if (!o) return { ok: false, why: 'not_found' };
    if (o.ostaz && o.ostaz.id) return { ok: false, why: 'done' };
    if (o.ostazLock) return { ok: false, why: 'busy' };
    o.ostazLock = 1; return { ok: true, order: JSON.parse(JSON.stringify(o)) };
  },
  async unlockInvoice(id) { delete ORD[id].ostazLock; },
  async saveInvoice(id, x) { ORD[id].ostaz = x; delete ORD[id].ostazLock; },
  async setInvoiceStatus(id, st, url) { ORD[id].ostaz.status = st; if (url) ORD[id].ostaz.url = url; }
} };
require.cache[ostazPath] = { id: ostazPath, filename: ostazPath, loaded: true, exports: {
  cfg: realO.cfg,
  async createInvoice(o, c) {
    if (CREATE_FAIL) throw Object.assign(new Error('down'), { code: 'ostaz_500' });
    const body = realO.buildInvoice(o, 7, c, '2026-11-27');
    CREATED.push(body); return { id: 900 + CREATED.length, code: 'INV-' + CREATED.length, status: c.status, partnerId: 7 };
  },
  async shareInvoice(id) { if (SHARE_FAIL) throw new Error('x'); return { status: 'issued', url: 'https://share.test/' + id }; }
} };
const A = require('../api/_lib/autoinv');

let pass = 0, fail = 0;
const t = async (n, fn) => { try { await fn(); console.log('✓ ' + n); pass++; } catch (e) { console.log('✗ ' + n + ' — ' + e.message); fail++; } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || '') + ' ' + JSON.stringify(a) + ' ≠ ' + JSON.stringify(b)); };
const reset = () => { CREATED = []; SHARE_FAIL = CREATE_FAIL = false; delete process.env.OSTAZ_AUTO;
  ORD = { o1: { st: 'new', no: 1050, ph: '966501234567', n: 'سالم', est: 400, dep: 400, paid: 400, items: [{ sv: 'sofa', t: 'كنب', u: 'مقعد', p: 50, q: 8 }] } }; };

(async () => {
  await t('دفع كامل: فاتورة معتمدة فيها الدفعة، والرابط ينحفظ للعميل', async () => {
    reset(); const r = await A.autoInvoice('o1');
    eq([r.ok, CREATED.length, CREATED[0].status, CREATED[0].payments[0].amount], [true, 1, 'issued', 40000]);
    eq([ORD.o1.ostaz.auto, ORD.o1.ostaz.url], [true, 'https://share.test/901']);
  });
  await t('ما تطلع فاتورتين لو التحقق والتنبيه وصلوا مع بعض', async () => {
    reset(); await Promise.all([A.autoInvoice('o1'), A.autoInvoice('o1'), A.autoInvoice('o1')]);
    await A.autoInvoice('o1'); eq(CREATED.length, 1);
  });
  await t('مدفوع جزئياً: ما تطلع فاتورة', async () => {
    reset(); ORD.o1.paid = 200; const r = await A.autoInvoice('o1');
    eq([r.skipped, CREATED.length, !!ORD.o1.ostazLock], ['not_fully_paid', 0, false]);
  });
  await t('السعر النهائي أعلى من المدفوع: ما تطلع (تصدرها يدوياً بعد الاستلام)', async () => {
    reset(); ORD.o1.price = 500; eq((await A.autoInvoice('o1')).skipped, 'not_fully_paid');
  });
  await t('الأستاذ معطّل: الطلب يبقى مدفوع وينفك القفل وتنعاد المرة الجاية', async () => {
    reset(); CREATE_FAIL = true; const r = await A.autoInvoice('o1');
    eq([r.error, !!ORD.o1.ostazLock, !!ORD.o1.ostaz], ['ostaz_500', false, false]);
    CREATE_FAIL = false; eq((await A.autoInvoice('o1')).ok, true);
  });
  await t('فشل رابط المشاركة ما يلغي الفاتورة', async () => {
    reset(); SHARE_FAIL = true; const r = await A.autoInvoice('o1');
    eq([r.ok, !!ORD.o1.ostaz.id, ORD.o1.ostaz.url], [true, true, undefined]);
  });
  await t('OSTAZ_AUTO=0 يوقفها', async () => {
    reset(); process.env.OSTAZ_AUTO = '0'; eq([(await A.autoInvoice('o1')).skipped, CREATED.length], ['off', 0]);
  });
  await t('طلب ملغي: ما تطلع', async () => {
    reset(); ORD.o1.st = 'cancelled'; eq((await A.autoInvoice('o1')).skipped, 'not_fully_paid');
  });
  await t('زيارة المعاينة المدفوعة: ما تطلع فاتورة تلقائية (تنخصم من فاتورة الخدمة)', async () => {
    reset(); Object.assign(ORD.o1, { quote: true, est: 29, dep: 29, paid: 29, items: [] });
    eq([(await A.autoInvoice('o1')).skipped, CREATED.length, !!ORD.o1.ostazLock], ['quote', 0, false]);
  });
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
