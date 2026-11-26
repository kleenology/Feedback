'use strict';
/* POST /api/invoice-share  {order}  —  Authorization: Bearer <رمز فايربيس للأدمن>
   يرجّع رابط الفاتورة من «الأستاذ» عشان اللوحة ترسله للعميل على واتساب.
   الفاتورة المسودة ترجع draft — لازم تُعتمد أول. */
const U = require('./_lib/util');
const S = require('./_lib/store');
const O = require('./_lib/ostaz');

module.exports = async function handler(req, res) {
  if (U.cors(req, res)) return;
  if (req.method !== 'POST') return U.json(res, 405, { error: 'method' });
  const auth = String(req.headers.authorization || '');
  const tok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  let id;
  try { const b = await U.readBody(req); id = String((b && b.order) || '').trim(); }
  catch (e) { return U.json(res, 400, { error: 'bad_request' }); }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return U.json(res, 400, { error: 'bad_order' });
  try { if (!(await S.adminUid(tok))) return U.json(res, 401, { error: 'not_admin' }); }
  catch (e) { return U.json(res, 401, { error: 'not_admin' }); }

  try {
    const o = await S.getOrder(id);
    if (!o) return U.json(res, 404, { error: 'not_found' });
    if (!o.ostaz || !o.ostaz.id) return U.json(res, 400, { error: 'no_invoice' });
    const r = await O.shareInvoice(o.ostaz.id);
    if (r.status !== (o.ostaz.status || '')) await S.setInvoiceStatus(id, r.status).catch(() => {});
    if (r.status === 'draft') return U.json(res, 409, { error: 'draft', code: r.code });
    return U.json(res, 200, { ok: true, url: r.url, code: r.code, status: r.status });
  } catch (e) {
    console.error('share:', (e && e.message) || e);
    return U.json(res, 502, { error: (e && e.code) || 'ostaz', message: String((e && e.message) || '').slice(0, 300) });
  }
};
