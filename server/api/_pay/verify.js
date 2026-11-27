'use strict';
/* POST /api/pay/verify  {tap_id: "chg_…"}  —  Authorization: Bearer <رمز فايربيس للعميل>
   لما يرجع العميل من صفحة الدفع: نسأل تاب عن الحالة الحقيقية ونسجّل الدفعة على طلبه.
   نفس العمل يسويه التنبيه (hook) — أيهم وصل أول يسجّل، والثاني يلقاها مسجّلة. */
const U = require('../_lib/util');
const S = require('../_lib/store');
const T = require('../_lib/tap');
const A = require('../_lib/autoinv');

module.exports = async function handler(req, res) {
  if (U.cors(req, res)) return;
  if (req.method !== 'POST') return U.json(res, 405, { error: 'method' });
  const auth = String(req.headers.authorization || '');
  const tok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  let cid;
  try { const body = await U.readBody(req); cid = String((body && body.tap_id) || '').trim(); }
  catch (e) { return U.json(res, 400, { error: 'bad_request' }); }
  if (!/^chg_[A-Za-z0-9]{6,64}$/.test(cid)) return U.json(res, 400, { error: 'bad_id' });

  let uid = '';
  try { uid = await S.userUid(tok); } catch (e) { uid = ''; }
  if (!uid) return U.json(res, 401, { error: 'auth' });

  try {
    const ch = await T.getCharge(cid);
    const oid = T.oidOf(ch);
    const o = oid ? await S.getOrder(oid) : null;
    if (!o || o.uid !== uid) return U.json(res, 404, { error: 'not_found' });
    if (T.captured(ch, oid)) {
      const r = await S.applyTapPayment(oid, ch, T.methodOf(ch));
      /* الفاتورة بعد الدفع — قفل الفوترة يمنع التكرار، ولو فشلت أول مرة تنعاد مع التحقق أو التنبيه الجاي */
      if (r && r.ok) await A.autoInvoice(oid).catch(e => console.error('autoinv:', e && e.message));
      return U.json(res, 200, { ok: true, status: 'CAPTURED', order: oid, no: o.no || null, paid: r.paid });
    }
    await S.setTapStatus(oid, ch.id, ch.status || 'UNKNOWN');
    return U.json(res, 200, { ok: false, status: ch.status || 'UNKNOWN', order: oid, no: o.no || null });
  } catch (e) {
    console.error('pay/verify:', (e && e.message) || e);
    return U.json(res, e && e.code === 'not_configured' ? 503 : 502, { error: (e && e.code) || 'tap' });
  }
};
