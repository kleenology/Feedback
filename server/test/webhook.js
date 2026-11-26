'use strict';
/* تنبيهات «الأستاذ»: التوقيع، الطوابع القديمة، المكرر، وربط الفاتورة بالطلب — بلا شبكة */
const crypto = require('crypto');
process.env.OSTAZ_WEBHOOK_SECRET = 'whsec';

const storePath = require.resolve('../api/_lib/store.js');
const ostazPath = require.resolve('../api/_lib/ostaz.js');
const realOstaz = require('../api/_lib/ostaz.js');

let ORD = {}, HOOKS = {}, INV = {}, PARTNERS = {}, SHARED = 0;
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: {
  async markHook(id) { if (HOOKS[id]) return false; HOOKS[id] = 1; return true; },
  async findOrders(field, v) {
    return Object.keys(ORD).map(k => Object.assign({ _id: k }, ORD[k])).filter(o =>
      field === 'ostaz.id' ? (o.ostaz && o.ostaz.id === v) : o[field] === v);
  },
  async setOstaz(id, x) { ORD[id].ostaz = x; },
  async clearOstaz(id) { delete ORD[id].ostaz; }
} };
require.cache[ostazPath] = { id: ostazPath, filename: ostazPath, loaded: true, exports: {
  phoneKey: realOstaz.phoneKey,
  async call(m, path) {
    let x = /^\/invoices\/(\d+)$/.exec(path); if (x) return { data: INV[x[1]] };
    x = /^\/partners\/(\d+)$/.exec(path); if (x) return { data: PARTNERS[x[1]] };
    throw new Error('unexpected ' + path);
  },
  async shareInvoice(id) { SHARED++; return { status: 'issued', code: INV[id].code, url: 'https://share.test/' + id }; }
} };
const hook = require('../api/ostaz-webhook.js');

const sign = (ts, raw, secret) => crypto.createHmac('sha256', secret || 'whsec').update(ts + '.' + raw).digest('hex');
function send(body, opt = {}) {
  const raw = JSON.stringify(body);
  const ts = String(opt.ts || Math.floor(Date.now() / 1000));
  const req = { method: 'POST', rawBody: raw, headers: {
    'x-webhook-timestamp': ts, 'x-webhook-id': opt.id || String(Math.random()),
    'x-webhook-signature': opt.sig || sign(ts, raw, opt.secret), 'x-webhook-event': body.event } };
  return new Promise(resolve => {
    const res = { statusCode: 200, setHeader() {}, end(s) { resolve({ status: this.statusCode, body: JSON.parse(s) }); } };
    hook(req, res);
  });
}

let pass = 0, fail = 0;
const t = async (n, fn) => { try { await fn(); console.log('✓ ' + n); pass++; } catch (e) { console.log('✗ ' + n + ' — ' + e.message); fail++; } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || '') + ' ' + JSON.stringify(a) + ' ≠ ' + JSON.stringify(b)); };
const reset = () => { ORD = {}; HOOKS = {}; INV = {}; PARTNERS = {}; SHARED = 0; };
const sale = (id, extra) => Object.assign({ id, code: 'INV-' + id, nature: 'sale', type: 'invoice', status: 'issued', partner_id: 9 }, extra);

(async () => {
  await t('توقيع غلط أو سر غلط يُرفض', async () => {
    reset();
    eq((await send({ event: 'webhook.test' }, { sig: 'abc' })).status, 401);
    eq((await send({ event: 'webhook.test' }, { secret: 'other' })).status, 401);
  });

  await t('طابع زمني قديم (إعادة إرسال مسروق) يُرفض', async () => {
    eq((await send({ event: 'webhook.test' }, { ts: Math.floor(Date.now() / 1000) - 3600 })).status, 401);
  });

  await t('تنبيه التجربة من الأستاذ يرجع 200', async () => {
    const r = await send({ event: 'webhook.test', data: {} });
    eq([r.status, r.body.test], [200, true]);
  });

  await t('بلا سر في الإعدادات: 503 وما يقبل شي', async () => {
    const s = process.env.OSTAZ_WEBHOOK_SECRET; process.env.OSTAZ_WEBHOOK_SECRET = '';
    eq((await send({ event: 'webhook.test' })).status, 503);
    process.env.OSTAZ_WEBHOOK_SECRET = s;
  });

  await t('اعتماد فاتورة طلعت من اللوحة ← تظهر للعميل برابطها', async () => {
    reset();
    ORD.a = { no: 1033, ph: '966555555555', st: 'done', ostaz: { id: 67, code: 'INV-67', status: 'draft' } };
    INV[67] = sale(67);
    const r = await send({ event: 'invoice.updated', data: { id: 67 } });
    eq([r.status, r.body.order, r.body.url], [200, 'a', true]);
    eq(ORD.a.ostaz.status, 'issued'); eq(ORD.a.ostaz.url, 'https://share.test/67');
  });

  await t('فاتورة يدوية بمرجع APP-رقم الطلب تنربط بطلبه', async () => {
    reset();
    ORD.b = { no: 1040, ph: '966511111111', st: 'done' };
    INV[70] = sale(70, { partner_reference_code: 'app-1040', partner_id: null });
    const r = await send({ event: 'invoice.created', data: { id: 70 } });
    eq(r.body.order, 'b'); eq(ORD.b.ostaz.url, 'https://share.test/70');
  });

  await t('فاتورة يدوية لعميل التطبيق ← آخر طلب مكتمل له بلا فاتورة', async () => {
    reset();
    ORD.old = { no: 1, ph: '966522222222', st: 'done', at: '2026-10-01' };
    ORD.new = { no: 2, ph: '966522222222', st: 'done', at: '2026-11-20' };
    ORD.live = { no: 3, ph: '966522222222', st: 'confirmed', at: '2026-11-25' };
    PARTNERS[9] = { id: 9, name: 'سارة', code: 'APP-966522222222', contacts: [] };
    INV[71] = sale(71);
    eq((await send({ event: 'invoice.created', data: { id: 71 } })).body.order, 'new');
    eq(ORD.live.ostaz, undefined, 'ربطها بطلب ما اكتمل');
  });

  await t('عميل قديم بلا جوال ولا مرجع: يتجاهل بدون ما يخرّب شي', async () => {
    reset();
    ORD.x = { no: 5, ph: '966533333333', st: 'done' };
    PARTNERS[9] = { id: 9, name: 'شركة النخبة', code: '1-000004', contacts: [] };
    INV[72] = sale(72);
    const r = await send({ event: 'invoice.created', data: { id: 72 } });
    eq([r.status, r.body.ignored], [200, 'no_order']); eq(ORD.x.ostaz, undefined);
  });

  await t('المسودة تنربط بدون رابط، والاعتماد بعدها يضيف الرابط', async () => {
    reset();
    ORD.d = { no: 1050, ph: '966544444444', st: 'done' };
    INV[73] = sale(73, { status: 'draft', partner_reference_code: 'APP-1050' });
    await send({ event: 'invoice.created', data: { id: 73 } });
    eq([ORD.d.ostaz.status, ORD.d.ostaz.url, SHARED], ['draft', undefined, 0]);
    INV[73].status = 'issued';
    await send({ event: 'invoice.updated', data: { id: 73 } });
    eq([ORD.d.ostaz.status, ORD.d.ostaz.url], ['issued', 'https://share.test/73']);
  });

  await t('تعديل فاتورة معتمدة ما يطلب رابط جديد كل مرة', async () => {
    INV[73].status = 'issued';
    await send({ event: 'invoice.updated', data: { id: 73 } });
    eq(SHARED, 1);
  });

  await t('التنبيه المكرر (نفس المعرّف) يُتجاهل', async () => {
    reset();
    ORD.a = { no: 1, ph: '966555555555', st: 'done', ostaz: { id: 80, status: 'draft' } };
    INV[80] = sale(80);
    await send({ event: 'invoice.updated', data: { id: 80 } }, { id: 'h1' });
    const r = await send({ event: 'invoice.updated', data: { id: 80 } }, { id: 'h1' });
    eq(r.body.duplicate, true); eq(SHARED, 1);
  });

  await t('فاتورة مشتريات أو إشعار دائن ما تنربط', async () => {
    reset();
    ORD.a = { no: 1, ph: '966555555555', st: 'done', ostaz: { id: 81, status: 'draft' } };
    INV[81] = sale(81, { nature: 'purchase' });
    eq((await send({ event: 'invoice.updated', data: { id: 81 } })).body.ignored, 'not_sale_invoice');
    eq(ORD.a.ostaz.status, 'draft');
  });

  await t('حذف الفاتورة في الأستاذ يشيلها من طلب العميل', async () => {
    reset();
    ORD.a = { no: 1, ph: '966555555555', st: 'done', ostaz: { id: 90, status: 'issued', url: 'https://share.test/90' } };
    const r = await send({ event: 'invoice.deleted', data: { id: 90 } });
    eq(r.body.cleared, true); eq(ORD.a.ostaz, undefined);
  });

  console.log('\n' + (fail ? 'ERRORS: ' + fail : 'ERRORS: none'));
  process.exit(fail ? 1 : 0);
})();
