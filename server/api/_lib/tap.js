'use strict';
/* بوابة الدفع «تاب» (tap.company) — عربون الطلب بـ Apple Pay ومدى والبطاقات.
   العميل يدفع في صفحة تاب الجاهزة (src_all)، وتاب يتكفّل بشهادات Apple Pay.

   المتغيرات (Vercel):
     TAP_SECRET_KEY   sk_test_… للتجربة أو sk_live_… للحقيقي — في الخادم فقط، أبداً في الصفحات
     PAY_RETURN_URL   وين يرجع العميل بعد الدفع (افتراضي https://app.kleenology.me/app/)
     PAY_HOOK_URL     رابط التنبيهات (افتراضي https://<هذا الخادم>/api/pay/hook)

   الأمان: ما نثق بأي مبلغ أو حالة من المتصفح. المبلغ يُحسب من الطلب في قاعدة البيانات،
   والحالة تُقرأ من تاب مباشرة بمفتاحنا السري — حتى التنبيه (webhook) نعيد التحقق منه عند تاب. */

const API = 'https://api.tap.company/v2';

function key() { return String(process.env.TAP_SECRET_KEY || '').trim(); }
function mode() { const k = key(); return !k ? '' : k.startsWith('sk_live_') ? 'live' : 'test'; }

async function call(method, path, body) {
  const k = key();
  if (!k) throw Object.assign(new Error('TAP_SECRET_KEY غير مضبوط'), { code: 'not_configured' });
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(API + path, {
      method,
      headers: { Authorization: 'Bearer ' + k, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal
    });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch (e) {}
    if (!r.ok || (j && Array.isArray(j.errors) && j.errors.length)) {
      const m = (j && j.errors && j.errors[0] && (j.errors[0].description || j.errors[0].code)) || text.slice(0, 200);
      throw Object.assign(new Error('تاب ' + r.status + ': ' + m), { code: 'tap_' + r.status });
    }
    return j || {};
  } finally { clearTimeout(t); }
}

/* المبلغ المستحق الحين = العربون ناقص المستلم. ما نقبل أكثر من العربون من التطبيق */
function dueOf(o) {
  const dep = Math.max(0, Math.round(Number(o.dep) || 0));
  const paid = Math.max(0, Number(o.paid) || 0);
  return Math.max(0, dep - paid);
}

/* جسم طلب الدفع — دالة صافية بلا شبكة، تُختبر وحدها */
function chargeBody(o, oid, amount, urls) {
  const ph = String(o.ph || '');
  const name = String(o.n || '').trim() || 'عميل كلينولوجي';
  const cust = { first_name: name.slice(0, 50) };
  if (/^9665\d{8}$/.test(ph)) cust.phone = { country_code: '966', number: ph.slice(3) };
  if (o.em && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.em)) cust.email = String(o.em).slice(0, 120);
  if (!cust.phone && !cust.email) cust.email = 'customer@kleenology.me';   /* تاب يشترط وسيلة تواصل */
  return {
    amount: Number(amount.toFixed(2)),
    currency: 'SAR',
    customer_initiated: true,
    threeDSecure: true,
    save_card: false,
    description: ('طلب كلينولوجي' + (o.no ? ' رقم ' + o.no : '')).slice(0, 120),
    statement_descriptor: 'KLEENOLOGY',
    metadata: { oid: oid },
    reference: { transaction: 'KLN-' + oid, order: o.no ? String(o.no) : oid },
    receipt: { email: !!cust.email && cust.email !== 'customer@kleenology.me', sms: !!cust.phone },
    customer: cust,
    source: { id: 'src_all' },
    post: { url: urls.hook },
    redirect: { url: urls.back }
  };
}

async function createCharge(o, oid, amount, urls) {
  const j = await call('POST', '/charges', chargeBody(o, oid, amount, urls));
  /* صفحة الدفع بالعربي — تاب يرجّع الرابط بـ language=en */
  const url = j.transaction && String(j.transaction.url || '').replace(/([?&]language=)[a-z]{2}\b/, '$1ar');
  if (!j.id || !url) throw new Error('تاب ما رجّع رابط الدفع');
  return { id: j.id, url, status: j.status };
}

async function getCharge(id) {
  if (!/^chg_[A-Za-z0-9]{6,64}$/.test(String(id || ''))) throw Object.assign(new Error('bad charge id'), { code: 'bad_id' });
  return call('GET', '/charges/' + encodeURIComponent(id));
}

/* هل الدفعة مكتملة فعلاً ولطلبنا؟ */
function captured(ch, oid) {
  return !!ch && ch.status === 'CAPTURED' && ch.currency === 'SAR' && Number(ch.amount) > 0 &&
    ((ch.metadata && ch.metadata.oid) === oid || (ch.reference && ch.reference.transaction) === 'KLN-' + oid);
}
function oidOf(ch) {
  const m = ch && ch.metadata && ch.metadata.oid;
  if (m && /^[A-Za-z0-9_-]{1,40}$/.test(m)) return m;
  const t = /^KLN-([A-Za-z0-9_-]{1,40})$/.exec((ch && ch.reference && ch.reference.transaction) || '');
  return t ? t[1] : '';
}
function methodOf(ch) {
  const s = (ch && ch.source) || {};
  return String(s.payment_method || s.payment_type || (ch.card && ch.card.brand) || '').slice(0, 30);
}

module.exports = { call, mode, dueOf, chargeBody, createCharge, getCharge, captured, oidOf, methodOf };
