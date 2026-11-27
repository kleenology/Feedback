'use strict';
/* POST /api/pay/hook — تنبيه «تاب» بعد كل عملية دفع (post.url في طلب الدفع).
   ما نثق بمحتوى التنبيه: ناخذ منه رقم العملية بس، ونسأل تاب بمفتاحنا السري عن حالتها الحقيقية.
   كذا لو أحد أرسل تنبيه مزوّر ما يقدر يسجّل دفعة ما صارت. */
const S = require('../_lib/store');
const T = require('../_lib/tap');
const A = require('../_lib/autoinv');

function reply(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}
async function rawBody(req, limit) {
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);
  if (typeof req.rawBody === 'string') return req.rawBody;
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new Error('too_large'); chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { error: 'method' });
  let body;
  try { body = JSON.parse(await rawBody(req, 512 * 1024) || '{}'); } catch (e) { return reply(res, 400, { error: 'json' }); }
  const cid = String((body && body.id) || '');
  if (!/^chg_[A-Za-z0-9]{6,64}$/.test(cid)) return reply(res, 200, { ok: true, ignored: true });
  try {
    const ch = await T.getCharge(cid);
    const oid = T.oidOf(ch);
    if (!oid) return reply(res, 200, { ok: true, ignored: 'no_order' });
    if (T.captured(ch, oid)) {
      const r = await S.applyTapPayment(oid, ch, T.methodOf(ch));
      /* الفاتورة بعد الدفع — قفل الفوترة يمنع التكرار، ولو فشلت أول مرة تنعاد مع التحقق أو التنبيه الجاي */
      if (r && r.ok) await A.autoInvoice(oid).catch(e => console.error('autoinv:', e && e.message));
      return reply(res, 200, { ok: true, applied: !r.already });
    }
    await S.setTapStatus(oid, ch.id, ch.status || 'UNKNOWN');
    return reply(res, 200, { ok: true, status: ch.status });
  } catch (e) {
    if (e && (e.code === 'tap_404' || e.code === 'bad_id')) return reply(res, 200, { ok: true, ignored: 'unknown' });
    console.error('pay/hook:', (e && e.message) || e);
    /* 500 يخلي تاب يعيد المحاولة لاحقاً */
    return reply(res, 500, { error: 'retry' });
  }
};
