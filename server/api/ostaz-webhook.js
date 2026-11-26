'use strict';
/* POST /api/ostaz-webhook — تنبيهات «الأستاذ»: فاتورة انشأت أو تعدّلت أو انحذفت.
   الفاتورة المعتمدة تنربط بطلب العميل ويطلع له «فاتورتك جاهزة» في التطبيق تلقائياً.

   الإعداد:  الأستاذ ← الإعدادات ← API Integration ← Webhooks
     الرابط: https://<خادمك>.vercel.app/api/ostaz-webhook
     الأحداث: invoice.created, invoice.updated, invoice.deleted
   وفي Vercel:  OSTAZ_WEBHOOK_SECRET = الرمز السري اللي يعطيك إياه الأستاذ مرة وحدة
                NODEJS_HELPERS = 0   (نحتاج جسم الطلب الخام للتحقق من التوقيع)

   الأمان: توقيع HMAC-SHA256 على «{timestamp}.{الجسم الخام}» بمقارنة ثابتة الزمن،
   ونرفض الطوابع الأقدم من ١٠ دقائق، ونتجاهل التنبيه المكرر بمعرّفه. */
const crypto = require('crypto');
const S = require('./_lib/store');
const O = require('./_lib/ostaz');

const MAX_AGE = 600;

function reply(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function rawBody(req, limit) {
  if (typeof req.rawBody === 'string') return req.rawBody;       /* للاختبار */
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new Error('too_large'); chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}

function validSig(secret, ts, raw, sig) {
  const want = crypto.createHmac('sha256', secret).update(ts + '.' + raw).digest('hex');
  const a = Buffer.from(want), b = Buffer.from(String(sig || '').toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* أي طلب تخصه الفاتورة؟ بالترتيب: طلب مربوط بها أصلاً ← «مرجع العميل» APP-رقم الطلب ←
   جوال العميل (آخر طلب مكتمل له بلا فاتورة) */
async function orderFor(inv) {
  let hit = (await S.findOrders('ostaz.id', inv.id))[0];
  if (hit) return hit;
  const m = /APP-(\d+)/i.exec(String(inv.partner_reference_code || ''));
  if (m) { hit = (await S.findOrders('no', Number(m[1])))[0]; if (hit) return hit; }
  if (!inv.partner_id) return null;
  let p = null;
  try { const j = await O.call('GET', '/partners/' + inv.partner_id); p = (j && (j.data || j)) || null; } catch (e) { p = null; }
  if (!p) return null;
  const key = [p.code, p.name].concat((p.contacts || []).map(c => c.phone)).map(O.phoneKey).find(Boolean);
  if (!key) return null;
  const list = (await S.findOrders('ph', key))
    .filter(o => o.st === 'done' && !(o.ostaz && o.ostaz.id))
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return list[0] || null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { error: 'method' });
  const secret = process.env.OSTAZ_WEBHOOK_SECRET || '';
  if (!secret) return reply(res, 503, { error: 'not_configured' });

  let raw;
  try { raw = await rawBody(req, 2 * 1024 * 1024); } catch (e) { return reply(res, 413, { error: 'too_large' }); }
  const h = req.headers || {};
  const ts = String(h['x-webhook-timestamp'] || '');
  if (!/^\d{9,11}$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > MAX_AGE) return reply(res, 401, { error: 'stale' });
  if (!validSig(secret, ts, raw, h['x-webhook-signature'])) return reply(res, 401, { error: 'signature' });

  let body;
  try { body = JSON.parse(raw); } catch (e) { return reply(res, 400, { error: 'json' }); }
  const event = String(body.event || h['x-webhook-event'] || '');
  if (event === 'webhook.test') return reply(res, 200, { ok: true, test: true });

  try {
    const hookId = h['x-webhook-id'] || body.id;
    if (hookId && !(await S.markHook(hookId))) return reply(res, 200, { ok: true, duplicate: true });

    const data = body.data || {};
    if (!/^invoice\.(created|updated|deleted)$/.test(event) || !data.id) return reply(res, 200, { ok: true, ignored: event });

    if (event === 'invoice.deleted') {
      const o = (await S.findOrders('ostaz.id', data.id))[0];
      if (o) await S.clearOstaz(o._id);
      return reply(res, 200, { ok: true, cleared: !!o });
    }

    /* data يعكس السجل وقت الإرسال — نجيب الفاتورة كاملة من الأستاذ */
    const j = await O.call('GET', '/invoices/' + data.id);
    const inv = (j && (j.data || j)) || data;
    if (inv.nature !== 'sale' || inv.type !== 'invoice') return reply(res, 200, { ok: true, ignored: 'not_sale_invoice' });

    const o = await orderFor(inv);
    if (!o) return reply(res, 200, { ok: true, ignored: 'no_order' });

    const prev = o.ostaz || {};
    const ostaz = { id: inv.id, code: inv.code || prev.code || '', status: inv.status, partner: inv.partner_id || prev.partner || null,
      at: prev.at || new Date().toISOString() };
    if (inv.status === 'issued') {
      if (prev.url && prev.id === inv.id && prev.status === 'issued') ostaz.url = prev.url;
      else { const r = await O.shareInvoice(inv.id); if (r.url) ostaz.url = r.url; }
    }
    await S.setOstaz(o._id, ostaz);
    return reply(res, 200, { ok: true, order: o._id, status: ostaz.status, url: !!ostaz.url });
  } catch (e) {
    console.error('ostaz-webhook:', (e && e.message) || e);
    /* 5xx = الأستاذ يعيد المحاولة بعد دقيقة، ٥ دقائق، … */
    return reply(res, 500, { error: 'failed' });
  }
};
module.exports.orderFor = orderFor;
module.exports.validSig = validSig;
