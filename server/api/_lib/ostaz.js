'use strict';
/* ربط برنامج «الأستاذ» (alostaz.io) — إصدار فاتورة من طلب مكتمل.
   التوثيق: https://api.developers.alostaz.io
   المبالغ عندهم بالهللة (×100) والكميات بالألف (×1000).

   المتغيرات:
     OSTAZ_URL          https://<حسابك>.alostaz.io/b/api
     OSTAZ_TOKEN        رمز API Clients — في إعدادات الخادم فقط، أبداً في الصفحات
     OSTAZ_BRANCH_ID    الفرع (افتراضي 1 = الفرع الرئيسي)
     OSTAZ_STOREHOUSE_ID المستودع للأسطر (افتراضي 1)
     OSTAZ_TAX_ID       الضريبة (افتراضي 1 = القيمة المضافة 15% شاملة — أسعار التطبيق شاملة الضريبة)
     OSTAZ_TREASURY_ID  وين ينحسب المبلغ المستلم (افتراضي 2 = الحساب البنكي الرئيسي)
     OSTAZ_STATUS       draft (افتراضي: تراجعها وتعتمدها من الأستاذ) أو issued
     OSTAZ_PRODUCTS     JSON يربط خدمات التطبيق بمنتجات الأستاذ، مثل {"post":5,"sofa":11}
     OSTAZ_PRODUCT_ID   المنتج الافتراضي لأي خدمة ما لها ربط (افتراضي 18 = تنظيف عام) */

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

function cfg() {
  let map = {};
  try { map = JSON.parse(process.env.OSTAZ_PRODUCTS || '{}') || {}; } catch (e) { map = {}; }
  return {
    url: String(process.env.OSTAZ_URL || '').replace(/\/+$/, ''),
    token: process.env.OSTAZ_TOKEN || '',
    branch: num(process.env.OSTAZ_BRANCH_ID, 1),
    store: num(process.env.OSTAZ_STOREHOUSE_ID, 1),
    tax: num(process.env.OSTAZ_TAX_ID, 1),
    treasury: num(process.env.OSTAZ_TREASURY_ID, 2),
    status: process.env.OSTAZ_STATUS === 'issued' ? 'issued' : 'draft',
    products: Object.assign({ post: 5, sofa: 11, pkg: 31 }, map),
    product: num(process.env.OSTAZ_PRODUCT_ID, 18),
    design: num(process.env.OSTAZ_DESIGN_ID, 6)       /* قالب الطباعة: 6 = القالب «t» */
  };
}

/* الجوال بصيغة واحدة 9665XXXXXXXX — العملاء عندك مسجّلين بأسماء مثل 0556462002 */
function phoneKey(v) {
  let d = String(v == null ? '' : v).replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('966')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  return d.length === 9 && d[0] === '5' ? '966' + d : '';
}

const SAR = v => Math.round(Number(v || 0) * 100);           /* ريال ← هللة */

/* بناء الفاتورة من الطلب — دالة صافية بلا شبكة، تُختبر وحدها.
   الإجمالي النهائي = السعر النهائي إن حدّده الفريق، وإلا التقديري بعد الخصم. */
function buildInvoice(order, partnerId, c, now) {
  c = c || cfg();
  const items = Array.isArray(order.items) ? order.items : [];
  const prodFor = sv => num(c.products[sv], c.product);
  const svOf = it => (order.pkg ? 'pkg' : (it.sv || String(it.k || '').replace(/\d+$/, '') || ''));

  const lines = items.filter(it => Number(it.q) > 0).map(it => ({
    product_id: prodFor(svOf(it)),
    storehouse_id: c.store,
    description: [it.t, it.u].filter(Boolean).join(' — ').slice(0, 250),
    unit_quantity: Math.round(Number(it.q) * 1000),
    unit_price: SAR(it.p),
    unit_content: 1,
    taxes: [{ id: c.tax }]
  }));
  /* زيارة معاينة أو طلب بلا أصناف: سطر واحد بالمبلغ */
  if (!lines.length) lines.push({
    product_id: c.product, storehouse_id: c.store,
    description: String(order.svc || 'خدمة تنظيف').slice(0, 250),
    unit_quantity: 1000, unit_price: SAR(order.price || order.est), unit_content: 1,
    taxes: [{ id: c.tax }]
  });

  const linesTotal = lines.reduce((s, l) => s + l.unit_price * l.unit_quantity / 1000, 0);
  const target = SAR(Number(order.price) || order.est || linesTotal / 100);
  const inv = {
    variant: 'standard', nature: 'sale', type: 'invoice', status: c.status,
    partner_id: partnerId,
    issue_date: now, due_date: now,
    partner_reference_code: order.no ? 'APP-' + order.no : undefined,
    notes: ['طلب من تطبيق كلينولوجي' + (order.no ? ' رقم ' + order.no : ''),
            order.date ? 'الموعد: ' + order.date : ''].filter(Boolean).join('\n'),
    line_items: lines
  };
  /* الفرق بين مجموع الأسطر والإجمالي: خصم (سلّم الخصم) أو سعر نهائي أقل بعد المعاينة.
     لو السعر النهائي أعلى نضيف سطر «فرق السعر بعد المعاينة» */
  const diff = Math.round(linesTotal - target);
  if (diff > 0) inv.discount_amount = diff;
  else if (diff < 0) lines.push({
    product_id: c.product, storehouse_id: c.store, description: 'فرق السعر بعد المعاينة',
    unit_quantity: 1000, unit_price: -diff, unit_content: 1, taxes: [{ id: c.tax }]
  });

  const paid = Math.min(SAR(order.paid), target);
  if (paid > 0) inv.payments = [{ amount: paid, treasury_id: c.treasury, description: 'تحويل بنكي — عربون/دفعات الطلب' }];
  if (!inv.partner_reference_code) delete inv.partner_reference_code;
  return inv;
}

async function call(method, path, body, c) {
  c = c || cfg();
  if (!c.url || !c.token) throw Object.assign(new Error('OSTAZ_URL / OSTAZ_TOKEN غير مضبوطة'), { code: 'not_configured' });
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(c.url + path, {
      method,
      headers: {
        Accept: 'application/json', 'Content-Type': 'application/json',
        Authorization: 'Bearer ' + c.token,
        'X-API-Version': '1', 'X-Branch-Id': String(c.branch), 'X-Locale': 'ar'
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal
    });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch (e) {}
    if (!r.ok) {
      const msg = (j && (j.message || JSON.stringify(j.errors || j))) || text.slice(0, 300);
      throw Object.assign(new Error('الأستاذ ' + r.status + ': ' + msg), { code: 'ostaz_' + r.status, detail: j && j.errors });
    }
    return j;
  } finally { clearTimeout(t); }
}

/* العميل: نبحث بالجوال في اسمه أو جهات اتصاله أو الكود (اللي ننشئهم نعطيهم كود APP-جواله).
   ما في بحث بالجوال في الواجهة، فنمرّ على قائمة العملاء. أغلب عملائك القدامى ما عندهم
   جوال محفوظ، فاللي ما ينلقى ينشأ جديد بكود APP-جواله، والمرة الجاية ينلقى بالكود مباشرة */
async function findOrCreatePartner(order, c) {
  c = c || cfg();
  const key = phoneKey(order.ph);
  const code = key ? 'APP-' + key : '';
  if (code) {
    const byCode = await call('GET', '/partners?type=client&code=' + encodeURIComponent(code), null, c);
    if (byCode && byCode.data && byCode.data[0]) return byCode.data[0].id;
  }
  if (key) {
    for (let page = 1; page <= 20; page++) {
      const j = await call('GET', '/partners?type=client&per_page=100&page=' + page, null, c);
      const list = (j && j.data) || [];
      const hit = list.find(p => phoneKey(p.name) === key || phoneKey(p.code) === key ||
        (p.contacts || []).some(x => phoneKey(x.phone) === key));
      if (hit) return hit.id;
      /* الواجهة حالياً ترجّع كل العملاء بصفحة وحدة بلا last_page — فنوقف أول ما يغيب الترقيم */
      if (!j.last_page || page >= j.last_page || list.length < 100) break;
    }
  }
  const name = String(order.n || '').trim() || (key ? '0' + key.slice(3) : 'عميل التطبيق');
  const created = await call('POST', '/partners', {
    type: 'client', nature: 'individual', name: name.slice(0, 255),
    code: code || undefined,
    contacts: key ? [{ phone: '+' + key, city: (order.adr && order.adr.c) || '', district: (order.adr && order.adr.d) || '', country: 'SA' }] : []
  }, c);
  const p = (created && (created.data || created)) || {};
  if (!p.id) throw new Error('الأستاذ ما رجّع رقم العميل');
  return p.id;
}

async function createInvoice(order, c) {
  c = c || cfg();
  const partnerId = await findOrCreatePartner(order, c);
  const body = buildInvoice(order, partnerId, c, new Date().toISOString());
  const j = await call('POST', '/invoices', body, c);
  const inv = (j && (j.data || j)) || {};
  return { id: inv.id, code: inv.code || '', status: inv.status || c.status, partnerId };
}

/* أول رابط http في الرد — شكل رد المشاركة غير موثّق، فنبحث عنه في أي حقل */
function firstUrl(x) {
  if (typeof x === 'string') return /^https?:\/\//.test(x) ? x : '';
  if (x && typeof x === 'object') for (const k of Object.keys(x)) { const u = firstUrl(x[k]); if (u) return u; }
  return '';
}

/* رابط مشاركة الفاتورة للعميل. المسودة ما تُرسل — لازم تُعتمد في الأستاذ أول (الاعتماد يرسلها للهيئة) */
async function shareInvoice(invoiceId, c) {
  c = c || cfg();
  const v = await call('GET', '/invoices/' + encodeURIComponent(invoiceId), null, c);
  const inv = (v && (v.data || v)) || {};
  if (inv.status === 'draft') return { status: 'draft', code: inv.code || '' };
  const j = await call('POST', '/helpers/share/invoice',
    { invoice_id: Number(invoiceId), document_template_design_id: c.design, method: 'link' }, c);
  const url = firstUrl(j);
  if (!url) throw new Error('الأستاذ ما رجّع رابطاً للفاتورة');
  return { status: inv.status || 'issued', code: inv.code || '', url };
}

module.exports = { cfg, phoneKey, buildInvoice, findOrCreatePartner, createInvoice, shareInvoice, firstUrl, call };
