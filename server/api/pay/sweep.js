'use strict';
/* POST /api/pay/sweep — يلغي طلبات الدفع الإلكتروني اللي ما انْدفعت خلال المهلة (افتراضي ساعة)
   ويحرّر مواعيدها لغيرهم. يشغّله التطبيق لما أحد يفتح الحجز، واللوحة لما تنفتح —
   مرة كل ٥ دقائق بالكثير مهما تكرر الطلب. ما يحتاج تسجيل دخول: ما يلغي إلا طلب متأكدين إنه ما انْدفع.

   قبل الإلغاء نسأل تاب عن آخر عملية للطلب: لو اكتملت (والتنبيه تأخر) نسجّل الدفعة بدل الإلغاء.
   المتغيرات: PAY_HOLD_MIN = المهلة بالدقائق (افتراضي 60) */
const U = require('../_lib/util');
const S = require('../_lib/store');
const T = require('../_lib/tap');

const GAP = 5 * 60 * 1000;

module.exports = async function handler(req, res) {
  if (U.cors(req, res)) return;
  if (req.method !== 'POST' && req.method !== 'GET') return U.json(res, 405, { error: 'method' });
  const hold = Math.max(15, Number(process.env.PAY_HOLD_MIN) || 60);
  try {
    if (!(await S.sweepGate(GAP))) return U.json(res, 200, { ok: true, skipped: true });
    const cutoff = new Date(Date.now() - hold * 60000).toISOString();
    const list = await S.staleTapOrders(cutoff);
    let cancelled = 0, paid = 0, kept = 0;
    for (const o of list) {
      const cid = o.tap && o.tap.id;
      if (cid) {
        let ch = null;
        try { ch = await T.getCharge(cid); } catch (e) { ch = null; }
        if (!ch && T.mode()) { kept++; continue; }               /* ما قدرنا نسأل تاب — نخليه للمرة الجاية */
        if (ch && T.captured(ch, o._id)) { await S.applyTapPayment(o._id, ch, T.methodOf(ch)); paid++; continue; }
        /* العميل للحين في صفحة الدفع؟ (عملية بدأت خلال المهلة) — ننتظره */
        if (ch && ch.status === 'INITIATED' && o.tap.at && o.tap.at > cutoff) { kept++; continue; }
      }
      if (await S.cancelUnpaid(o._id)) cancelled++;
    }
    return U.json(res, 200, { ok: true, checked: list.length, cancelled, paid, kept });
  } catch (e) {
    console.error('pay/sweep:', (e && e.message) || e);
    return U.json(res, 500, { error: 'sweep' });
  }
};
