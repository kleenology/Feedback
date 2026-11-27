'use strict';
/* POST /api/invoice  {order: "<معرّف الطلب>"}  —  Authorization: Bearer <رمز فايربيس للأدمن>
   يصدر فاتورة في «الأستاذ» من طلب في Firestore ويحفظ رقمها على الطلب.
   - للأدمن فقط (وثيقة في admins)، والطلب يُقرأ من قاعدة البيانات — ما نثق ببيانات من المتصفح.
   - مرة واحدة لكل طلب: لو له فاتورة نرجّعها بدل ما نطلع ثانية. */
const U = require('./_lib/util');
const S = require('./_lib/store');
const O = require('./_lib/ostaz');

module.exports = async function handler(req, res) {
  if (U.cors(req, res)) return;
  if (req.method !== 'POST') return U.json(res, 405, { error: 'method' });

  const auth = String(req.headers.authorization || '');
  const tok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  let id;
  try {
    const body = await U.readBody(req);
    id = String((body && body.order) || '').trim();
  } catch (e) { return U.json(res, 400, { error: 'bad_request' }); }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return U.json(res, 400, { error: 'bad_order' });

  try {
    if (!(await S.adminUid(tok))) return U.json(res, 401, { error: 'not_admin' });
  } catch (e) { return U.json(res, 401, { error: 'not_admin' }); }

  let lock;
  try { lock = await S.lockInvoice(id); }
  catch (e) { console.error('invoice lock:', e && e.message); return U.json(res, 500, { error: 'db' }); }
  if (!lock.ok) {
    if (lock.why === 'done') return U.json(res, 200, { ok: true, already: true, ostaz: lock.ostaz });
    return U.json(res, lock.why === 'busy' ? 409 : 404, { error: lock.why });
  }
  const o = lock.order;
  if (o.st === 'cancelled') { await S.unlockInvoice(id); return U.json(res, 400, { error: 'cancelled' }); }
  /* ما تطلع فاتورة لطلب ما انْدفع كامل — تطلع «غير مدفوعة» في الأستاذ. اللوحة تطلب تسجيل المستلم أول */
  const total = Number(o.price) || Number(o.est) || 0;
  if (!(total > 0) || (Number(o.paid) || 0) < total) { await S.unlockInvoice(id); return U.json(res, 400, { error: 'not_paid', due: Math.max(0, total - (Number(o.paid) || 0)) }); }

  try {
    const r = await O.createInvoice(o);
    const ostaz = { id: r.id, code: r.code, status: r.status, partner: r.partnerId, at: new Date().toISOString() };
    await S.saveInvoice(id, ostaz);
    return U.json(res, 200, { ok: true, ostaz });
  } catch (e) {
    await S.unlockInvoice(id);
    console.error('invoice:', (e && e.message) || e);
    return U.json(res, e && e.code === 'not_configured' ? 503 : 502,
      { error: (e && e.code) || 'ostaz', message: String((e && e.message) || '').slice(0, 400) });
  }
};
