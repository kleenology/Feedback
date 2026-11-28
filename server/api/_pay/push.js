'use strict';
/* POST /api/pay/push  {op, ...}  —  Authorization: Bearer <رمز فايربيس>
   للعميل:  register {token} · unregister {token}   (تطبيق الآيفون يسجّل جهازه بعد الدخول)
   للأدمن:  notify {order}  — اللوحة تناديه بعد ما تغيّر حالة الطلب، فيوصل العميل إشعار */
const U = require('../_lib/util');
const S = require('../_lib/store');
const P = require('../_lib/push');

module.exports = async function handler(req, res) {
  if (U.cors(req, res)) return;
  if (req.method !== 'POST') return U.json(res, 405, { error: 'method' });
  const auth = String(req.headers.authorization || '');
  const tok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  let b = {};
  try { b = (await U.readBody(req)) || {}; } catch (e) { return U.json(res, 400, { error: 'bad_request' }); }
  const op = String(b.op || '');
  try {
    if (op === 'notify') {
      let admin = '';
      try { admin = await S.adminUid(tok); } catch (e) { admin = ''; }
      if (!admin) return U.json(res, 403, { error: 'admin' });
      const id = String(b.order || '');
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return U.json(res, 400, { error: 'bad_order' });
      return U.json(res, 200, Object.assign({ ok: true }, await P.orderStatus(id)));
    }
    let uid = '';
    try { uid = await S.userUid(tok); } catch (e) { uid = ''; }
    if (!uid) return U.json(res, 401, { error: 'auth' });
    if (op === 'register') { const r = await P.register(uid, b.token); return U.json(res, r.ok ? 200 : 400, r.ok ? r : { error: r.why }); }
    if (op === 'unregister') return U.json(res, 200, await P.unregister(uid, b.token));
    return U.json(res, 400, { error: 'op' });
  } catch (e) {
    console.error('push', op, e && e.message);
    return U.json(res, 500, { error: 'server' });
  }
};
