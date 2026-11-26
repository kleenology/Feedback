'use strict';
/* POST /api/pay/start  {order: "<معرّف الطلب>"}  —  Authorization: Bearer <رمز فايربيس للعميل>
   يفتح عملية دفع للعربون في «تاب» ويرجّع رابط صفحة الدفع (Apple Pay · مدى · بطاقة).
   - الطلب لازم يكون للعميل نفسه، والمبلغ يُحسب من الطلب في قاعدة البيانات (العربون − المستلم). */
const U = require('../_lib/util');
const S = require('../_lib/store');
const T = require('../_lib/tap');

module.exports = async function handler(req, res) {
  if (U.cors(req, res)) return;
  if (req.method !== 'POST') return U.json(res, 405, { error: 'method' });

  const auth = String(req.headers.authorization || '');
  const tok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  let id;
  try { const body = await U.readBody(req); id = String((body && body.order) || '').trim(); }
  catch (e) { return U.json(res, 400, { error: 'bad_request' }); }
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return U.json(res, 400, { error: 'bad_order' });

  let uid = '';
  try { uid = await S.userUid(tok); } catch (e) { uid = ''; }
  if (!uid) return U.json(res, 401, { error: 'auth' });

  let o;
  try { o = await S.getOrder(id); } catch (e) { return U.json(res, 500, { error: 'db' }); }
  if (!o || o.uid !== uid) return U.json(res, 404, { error: 'not_found' });
  if (o.st === 'cancelled' || o.st === 'done') return U.json(res, 400, { error: 'closed' });
  const due = T.dueOf(o);
  if (!due) return U.json(res, 200, { ok: true, paid: true });

  const back = String(process.env.PAY_RETURN_URL || 'https://app.kleenology.me/app/').replace(/[?#].*$/, '') + '?pay=' + encodeURIComponent(id);
  const hook = process.env.PAY_HOOK_URL || ('https://' + String(req.headers.host || '').replace(/[^A-Za-z0-9.:-]/g, '') + '/api/pay/hook');
  try {
    const ch = await T.createCharge(o, id, due, { back, hook });
    await S.setTapPending(id, { id: ch.id, amt: due, st: 'INITIATED', at: new Date().toISOString() });
    return U.json(res, 200, { ok: true, url: ch.url, amount: due });
  } catch (e) {
    console.error('pay/start:', (e && e.message) || e);
    return U.json(res, e && e.code === 'not_configured' ? 503 : 502, { error: (e && e.code) || 'tap' });
  }
};
