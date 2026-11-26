'use strict';
/* فوترة «الأستاذ»: بناء الفاتورة، البحث عن العميل، وحراسة الواجهة — بلا شبكة ولا فايربيس */
process.env.ALLOWED_ORIGINS = 'https://kleenology.github.io';
process.env.OSTAZ_URL = 'https://acme.alostaz.io/b/api/';
process.env.OSTAZ_TOKEN = 'tok';
delete process.env.OSTAZ_PRODUCTS; delete process.env.OSTAZ_STATUS;

const O = require('../api/_lib/ostaz.js');

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); console.log('✓ ' + name); pass++; }
  catch (e) { console.log('✗ ' + name + ' — ' + e.message); fail++; }
};
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || '') + ' ' + JSON.stringify(a) + ' ≠ ' + JSON.stringify(b)); };

const ORDER = {
  no: 1042, n: 'طلال', ph: '966555555555', st: 'done', date: '2026-12-01',
  items: [{ k: 'maj1', sv: 'sofa', t: 'جلسة عربية', u: 'للمتر', p: 30, q: 9 },
          { k: 'chr1', sv: 'sofa', t: 'كرسي طعام', u: 'للقطعة', p: 15, q: 4 }],
  subt: 330, off: 10, est: 297, dep: 149, paid: 149
};

(async () => {
  await t('الأسطر بالهللة والكمية بالألف، والضريبة الشاملة', async () => {
    const inv = O.buildInvoice(ORDER, 77, O.cfg(), '2026-12-01T10:00:00Z');
    eq(inv.variant, 'standard'); eq(inv.nature, 'sale'); eq(inv.type, 'invoice');
    eq(inv.status, 'draft', 'الافتراضي مسودة');
    eq(inv.partner_id, 77);
    eq(inv.line_items.length, 2);
    eq(inv.line_items[0].unit_price, 3000); eq(inv.line_items[0].unit_quantity, 9000);
    eq(inv.line_items[0].product_id, 11, 'الأثاث ← تنظيف كنب وسجاد');
    eq(inv.line_items[0].taxes, [{ id: 1 }]); eq(inv.line_items[0].storehouse_id, 1);
    eq(inv.partner_reference_code, 'APP-1042');
  });

  await t('الخصم = مجموع الأسطر − التقديري', async () => {
    const inv = O.buildInvoice(ORDER, 1, O.cfg(), 'x');
    eq(inv.discount_amount, 3300, '330 − 297 = 33 ر.س');
  });

  await t('السعر النهائي الأقل يصير خصماً', async () => {
    const inv = O.buildInvoice(Object.assign({}, ORDER, { price: '250' }), 1, O.cfg(), 'x');
    eq(inv.discount_amount, 8000);
  });

  await t('السعر النهائي الأعلى يضيف سطر «فرق السعر»', async () => {
    const inv = O.buildInvoice(Object.assign({}, ORDER, { price: '400' }), 1, O.cfg(), 'x');
    eq(inv.discount_amount, undefined);
    const last = inv.line_items[inv.line_items.length - 1];
    eq(last.description, 'فرق السعر بعد المعاينة'); eq(last.unit_price, 7000);
  });

  await t('المسودة: بلا دفعات (الأستاذ يرفضها)، والملاحظات فاضية دائماً', async () => {
    const inv = O.buildInvoice(ORDER, 1, O.cfg(), 'x');
    eq(inv.payments, undefined);
    eq('notes' in inv, false, 'فيه ملاحظات');
    process.env.OSTAZ_STATUS = 'issued';
    eq('notes' in O.buildInvoice(ORDER, 1, O.cfg(), 'x'), false, 'ملاحظات في المعتمدة');
    delete process.env.OSTAZ_STATUS;
  });

  await t('المعتمدة: المستلم دفعة في الحساب البنكي، وما يتجاوز الإجمالي', async () => {
    process.env.OSTAZ_STATUS = 'issued';
    let inv = O.buildInvoice(ORDER, 1, O.cfg(), 'x');
    eq(inv.payments, [{ amount: 14900, treasury_id: 2, description: 'تحويل بنكي — عربون/دفعات الطلب' }]);
    inv = O.buildInvoice(Object.assign({}, ORDER, { paid: 9999 }), 1, O.cfg(), 'x');
    eq(inv.payments[0].amount, 29700);
    inv = O.buildInvoice(Object.assign({}, ORDER, { paid: 0 }), 1, O.cfg(), 'x');
    eq(inv.payments, undefined);
    delete process.env.OSTAZ_STATUS;
  });

  await t('طلب بلا أصناف (معاينة) = سطر واحد بالمبلغ', async () => {
    const inv = O.buildInvoice({ svc: 'زيارة تسعير — مكاتب', est: 29, items: [] }, 1, O.cfg(), 'x');
    eq(inv.line_items.length, 1); eq(inv.line_items[0].unit_price, 2900); eq(inv.line_items[0].product_id, 18);
  });

  await t('ربط المنتجات من OSTAZ_PRODUCTS، والحالة issued عند الطلب', async () => {
    process.env.OSTAZ_PRODUCTS = '{"sofa":4}'; process.env.OSTAZ_STATUS = 'issued';
    const inv = O.buildInvoice(ORDER, 1, O.cfg(), 'x');
    eq(inv.line_items[0].product_id, 4); eq(inv.status, 'issued');
    process.env.OSTAZ_PRODUCTS = 'خربطة'; delete process.env.OSTAZ_STATUS;
    eq(O.buildInvoice(ORDER, 1, O.cfg(), 'x').line_items[0].product_id, 11, 'JSON خاطئ يُتجاهل');
    delete process.env.OSTAZ_PRODUCTS;
  });

  await t('صيغ الجوال كلها توحّد', async () => {
    for (const v of ['0556462002', '+966556462002', '966556462002', '00966556462002', '556462002'])
      eq(O.phoneKey(v), '966556462002', v);
    eq(O.phoneKey('ساكو'), '');
  });

  /* البحث عن العميل: fetch وهمي */
  const F = global.fetch;
  const calls = [];
  const fake = routes => async (url, o) => {
    calls.push({ url, method: o.method, body: o.body && JSON.parse(o.body), h: o.headers });
    for (const [re, resp] of routes) if (re.test(url) && (!resp.m || resp.m === o.method))
      return { ok: (resp.s || 200) < 300, status: resp.s || 200, text: async () => JSON.stringify(resp.j) };
    return { ok: false, status: 404, text: async () => '{"message":"nf"}' };
  };

  await t('يلقى العميل الموجود باسمه (رقم جواله) بدون ما ينشئ', async () => {
    calls.length = 0;
    global.fetch = fake([
      [/code=APP/, { j: { data: [] } }],
      [/per_page=100&page=1/, { j: { data: [{ id: 3, name: 'ساكو', code: '1-1' }, { id: 159, name: '0555555555', code: '1-000135' }] } }]
    ]);
    eq(await O.findOrCreatePartner(ORDER), 159);
    eq(calls.some(c => c.method === 'POST'), false, 'أنشأ عميلاً مكرراً');
    const h = calls[0].h;
    eq([h.Authorization, h['X-API-Version'], h['X-Branch-Id']], ['Bearer tok', '1', '1']);
    if (!calls[0].url.startsWith('https://acme.alostaz.io/b/api/partners')) throw new Error(calls[0].url);
  });

  await t('قائمة بلا ترقيم: طلب واحد بس، مو عشرين', async () => {
    calls.length = 0;
    const many = Array.from({ length: 136 }, (_, i) => ({ id: i + 1, name: 'عميل ' + i }));
    global.fetch = fake([
      [/code=APP/, { j: { data: [] } }],
      [/per_page=100/, { j: { data: many } }],
      [/\/partners$/, { m: 'POST', j: { data: { id: 901 } } }]
    ]);
    eq(await O.findOrCreatePartner(ORDER), 901);
    eq(calls.filter(c => /per_page/.test(c.url)).length, 1);
  });

  await t('عميل جديد ينشأ باسمه وجواله وكود APP-جواله', async () => {
    calls.length = 0;
    global.fetch = fake([
      [/code=APP/, { j: { data: [] } }],
      [/per_page=100/, { j: { data: [] } }],
      [/\/partners$/, { m: 'POST', j: { data: { id: 900 } } }]
    ]);
    eq(await O.findOrCreatePartner(ORDER), 900);
    const b = calls.find(c => c.method === 'POST').body;
    eq([b.type, b.nature, b.name, b.code, b.contacts[0].phone], ['client', 'individual', 'طلال', 'APP-966555555555', '+966555555555']);
  });

  await t('إصدار الفاتورة يرجّع رقمها وكودها', async () => {
    global.fetch = fake([
      [/code=APP/, { j: { data: [{ id: 900 }] } }],
      [/\/invoices$/, { m: 'POST', j: { data: { id: 555, code: 'S-1-007900', status: 'draft' } } }]
    ]);
    eq(await O.createInvoice(ORDER), { id: 555, code: 'S-1-007900', status: 'draft', partnerId: 900 });
  });

  await t('رفض الأستاذ يطلع برسالته', async () => {
    global.fetch = fake([[/code=APP/, { s: 422, j: { message: 'The given data was invalid.' } }]]);
    let msg = '';
    try { await O.createInvoice(ORDER); } catch (e) { msg = e.message; }
    if (!msg.includes('422') || !msg.includes('invalid')) throw new Error(msg);
  });

  await t('بلا رابط أو رمز: خطأ واضح بدون أي طلب', async () => {
    calls.length = 0; const u = process.env.OSTAZ_TOKEN; process.env.OSTAZ_TOKEN = '';
    let code = ''; try { await O.createInvoice(ORDER); } catch (e) { code = e.code; }
    process.env.OSTAZ_TOKEN = u;
    eq(code, 'not_configured'); eq(calls.length, 0);
  });
  await t('مشاركة: المسودة ما تنرسل، ولا يُطلب رابط', async () => {
    calls.length = 0;
    global.fetch = fake([[/\/invoices\/555$/, { j: { data: { id: 555, code: 'S-1-9', status: 'draft' } } }]]);
    eq(await O.shareInvoice(555), { status: 'draft', code: 'S-1-9' });
    eq(calls.some(c => /share/.test(c.url)), false);
  });

  await t('مشاركة: المعتمدة ترجع رابطها بالقالب t (6)', async () => {
    calls.length = 0;
    global.fetch = fake([
      [/\/invoices\/555$/, { j: { data: { id: 555, code: 'S-1-9', status: 'issued' } } }],
      [/share\/invoice$/, { m: 'POST', j: { data: { link: 'https://kleenology.alostaz.io/s/abc' } } }]
    ]);
    const r = await O.shareInvoice(555);
    eq(r.url, 'https://kleenology.alostaz.io/s/abc');
    eq(calls.find(c => /share/.test(c.url)).body, { invoice_id: 555, document_template_design_id: 6, method: 'link' });
  });

  await t('firstUrl يلقى الرابط وين ما كان في الرد', async () => {
    eq(O.firstUrl({ a: 1, b: { c: ['x', 'https://u.test/1'] } }), 'https://u.test/1');
    eq(O.firstUrl({ a: 'ftp://x' }), '');
  });
  global.fetch = F;

  /* الواجهة: أدمن فقط، مرة وحدة لكل طلب */
  const storePath = require.resolve('../api/_lib/store.js');
  const ostazPath = require.resolve('../api/_lib/ostaz.js');
  let ADMIN = true, ORD = {}, MADE = 0, FAILS = false;
  require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: {
    async adminUid(tok) { return ADMIN && tok === 'good' ? 'u1' : ''; },
    async lockInvoice(id) {
      const o = ORD[id]; if (!o) return { ok: false, why: 'not_found' };
      if (o.ostaz) return { ok: false, why: 'done', ostaz: o.ostaz };
      return { ok: true, order: o };
    },
    async saveInvoice(id, x) { ORD[id].ostaz = x; },
    async getOrder(id) { return ORD[id] || null; },
    async setInvoiceStatus(id, st, url) { ORD[id].ostaz.status = st; if (url) ORD[id].ostaz.url = url; },
    async unlockInvoice() {}
  } };
  require.cache[ostazPath] = { id: ostazPath, filename: ostazPath, loaded: true, exports: {
    async shareInvoice(iid) { return iid === 7 ? { status: 'draft', code: 'S-7' } : { status: 'issued', code: 'S-8', url: 'https://x.test/inv' }; },
    async createInvoice() { if (FAILS) throw Object.assign(new Error('الأستاذ 422: x'), { code: 'ostaz_422' }); MADE++; return { id: 1, code: 'S-1', status: 'draft', partnerId: 2 }; }
  } };
  const handler = require('../api/invoice.js');
  const call = (body, tok, method) => new Promise(resolve => {
    const req = { method: method || 'POST', headers: { origin: 'https://kleenology.github.io', authorization: tok ? 'Bearer ' + tok : '' }, body };
    const res = { statusCode: 200, _h: {}, setHeader(k, v) { this._h[k] = v; },
      end(s) { resolve({ status: this.statusCode, body: s ? JSON.parse(s) : null, h: this._h }); } };
    handler(req, res);
  });

  await t('بدون رمز أدمن: 401 وما ينطلب الأستاذ', async () => {
    ORD = { a1: { st: 'done' } }; MADE = 0;
    eq((await call({ order: 'a1' })).status, 401);
    eq((await call({ order: 'a1' }, 'bad')).status, 401);
    eq(MADE, 0);
  });

  await t('أدمن: تطلع الفاتورة وتنحفظ على الطلب', async () => {
    ORD = { a1: { st: 'done' } }; MADE = 0;
    const r = await call({ order: 'a1' }, 'good');
    eq(r.status, 200); eq(r.body.ostaz.code, 'S-1'); eq(ORD.a1.ostaz.code, 'S-1'); eq(MADE, 1);
  });

  await t('الضغط مرتين ما يطلع فاتورتين', async () => {
    const r = await call({ order: 'a1' }, 'good');
    eq(r.status, 200); eq(r.body.already, true); eq(MADE, 1);
  });

  await t('طلب ملغي أو غير موجود أو معرّف غريب يُرفض', async () => {
    ORD = { c1: { st: 'cancelled' } };
    eq((await call({ order: 'c1' }, 'good')).status, 400);
    eq((await call({ order: 'zz' }, 'good')).status, 404);
    eq((await call({ order: '../x' }, 'good')).status, 400);
  });

  await t('فشل الأستاذ يرجع برسالته وما يحفظ شي', async () => {
    ORD = { a2: { st: 'done' } }; FAILS = true;
    const r = await call({ order: 'a2' }, 'good');
    eq(r.status, 502); if (!String(r.body.message).includes('422')) throw new Error(JSON.stringify(r.body));
    eq(ORD.a2.ostaz, undefined); FAILS = false;
  });

  await t('CORS يسمح بترويسة Authorization', async () => {
    const r = await call({}, '', 'OPTIONS');
    eq(r.status, 204); if (!/Authorization/.test(r.h['Access-Control-Allow-Headers'])) throw new Error(r.h['Access-Control-Allow-Headers']);
  });

  const share = require('../api/invoice-share.js');
  const call2 = (body, tok) => new Promise(resolve => {
    const req = { method: 'POST', headers: { origin: 'https://kleenology.github.io', authorization: tok ? 'Bearer ' + tok : '' }, body };
    const res = { statusCode: 200, setHeader() {}, end(s) { resolve({ status: this.statusCode, body: s ? JSON.parse(s) : null }); } };
    share(req, res);
  });

  await t('مشاركة الفاتورة: أدمن فقط، والمسودة 409، والمعتمدة رابط', async () => {
    ORD = { d: { ostaz: { id: 7, status: 'draft' } }, i: { ostaz: { id: 8, status: 'draft' } }, n: {} };
    eq((await call2({ order: 'i' })).status, 401);
    eq((await call2({ order: 'd' }, 'good')).status, 409);
    const r = await call2({ order: 'i' }, 'good');
    eq([r.status, r.body.url], [200, 'https://x.test/inv']);
    eq(ORD.i.ostaz.status, 'issued', 'ما حدّث حالة الفاتورة على الطلب');
    eq(ORD.i.ostaz.url, 'https://x.test/inv', 'ما حفظ الرابط للعميل');
    eq((await call2({ order: 'n' }, 'good')).body.error, 'no_invoice');
  });

  console.log('\n' + (fail ? 'ERRORS: ' + fail : 'ERRORS: none'));
  process.exit(fail ? 1 : 0);
})();
