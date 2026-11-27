'use strict';
/* فاتورة «الأستاذ» تلقائياً بعد الدفع الإلكتروني:
   العميل يدفع ← نتأكد من تاب ← تطلع فاتورة معتمدة فيها الدفعة ← رابطها يظهر للعميل في طلبه.

   - مرة وحدة لكل طلب (نفس قفل الفوترة اليدوية من اللوحة) — لو التحقق والتنبيه وصلوا مع بعض ما تطلع فاتورتين.
   - بس لما يكون الطلب مدفوع كامل (الدفع الإلكتروني = قيمة الطلب كاملة).
   - معتمدة (issued) لأن المبلغ مستلم فعلاً — الأستاذ يرفض الدفعات على المسودة.
   - أي خطأ ما يوقف الدفع: الطلب يبقى مدفوع، وتقدر تصدر الفاتورة يدوياً من اللوحة.

   المتغيرات: OSTAZ_AUTO=0 يوقفها. OSTAZ_TAP_TREASURY_ID = حساب الأستاذ اللي تنحسب فيه مبالغ تاب
   (افتراضي نفس OSTAZ_TREASURY_ID = الحساب البنكي الرئيسي). */
const S = require('./store');
const O = require('./ostaz');

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

async function autoInvoice(oid) {
  if (process.env.OSTAZ_AUTO === '0') return { skipped: 'off' };
  const c = O.cfg();
  if (!c.url || !c.token) return { skipped: 'not_configured' };
  c.status = 'issued';
  c.treasury = num(process.env.OSTAZ_TAP_TREASURY_ID, c.treasury);

  let lock;
  try { lock = await S.lockInvoice(oid); } catch (e) { console.error('autoinv lock:', e && e.message); return { error: 'db' }; }
  if (!lock.ok) return { skipped: lock.why };
  const o = lock.order;
  const total = Number(o.price) || Number(o.est) || 0;
  if (o.st === 'cancelled' || !(total > 0) || !(Number(o.paid) >= total)) {
    await S.unlockInvoice(oid);
    return { skipped: 'not_fully_paid' };
  }
  let r;
  try {
    r = await O.createInvoice(o, c);
  } catch (e) {
    await S.unlockInvoice(oid);
    console.error('autoinv create:', (e && e.message) || e);
    return { error: (e && e.code) || 'ostaz' };
  }
  const ostaz = { id: r.id, code: r.code, status: r.status, partner: r.partnerId, at: new Date().toISOString(), auto: true };
  await S.saveInvoice(oid, ostaz);
  /* رابط الفاتورة للعميل — لو تأخر، تنبيه الأستاذ (ostaz-webhook) يضيفه لاحقاً */
  try {
    const sh = await O.shareInvoice(r.id, c);
    if (sh && sh.url) await S.setInvoiceStatus(oid, sh.status || 'issued', sh.url);
  } catch (e) { console.error('autoinv share:', (e && e.message) || e); }
  return { ok: true, id: r.id, code: r.code };
}

module.exports = { autoInvoice };
