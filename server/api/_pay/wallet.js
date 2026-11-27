'use strict';
/* POST /api/pay/wallet  {op, ...}  —  Authorization: Bearer <رمز فايربيس>
   للعميل:  redeem {code} · apply {order} · topup {amount} · cancel {order}
   للأدمن:  credit {uid, amt, note} · code {code?, amt, uses, exp, note} · codeoff {code} */
const U = require('../_lib/util');
const S = require('../_lib/store');
const T = require('../_lib/tap');
const W = require('../_lib/wallet');
const A = require('../_lib/autoinv');

const WHY = { bad_code: 'الكود غير صحيح', not_found: 'الكود غير صحيح', off: 'الكود موقوف', expired: 'انتهت صلاحية الكود',
  used: 'استخدمت هذا الكود من قبل', finished: 'الكود انتهى عدد استخداماته', too_many: 'محاولات كثيرة — جرّب بعد ساعة' };

module.exports = async function handler(req, res) {
  if (U.cors(req, res)) return;
  if (req.method !== 'POST') return U.json(res, 405, { error: 'method' });
  const auth = String(req.headers.authorization || '');
  const tok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  let b = {};
  try { b = (await U.readBody(req)) || {}; } catch (e) { return U.json(res, 400, { error: 'bad_request' }); }
  const op = String(b.op || '');
  let uid = '';
  try { uid = await S.userUid(tok); } catch (e) { uid = ''; }
  if (!uid) return U.json(res, 401, { error: 'auth' });

  try {
    if (op === 'redeem') {
      const r = await W.redeem(uid, b.code);
      return U.json(res, r.ok ? 200 : (r.why === 'too_many' ? 429 : 400), r.ok ? r : { error: r.why, message: WHY[r.why] || 'تعذّر استخدام الكود' });
    }
    if (op === 'apply') {
      const id = String(b.order || '');
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return U.json(res, 400, { error: 'bad_order' });
      const r = await W.applyToOrder(uid, id);
      if (!r.ok) return U.json(res, 400, { error: r.why });
      if (r.amt > 0 && r.due <= 0) await A.autoInvoice(id).catch(() => {});
      return U.json(res, 200, r);
    }
    if (op === 'cancel') {
      const id = String(b.order || '');
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return U.json(res, 400, { error: 'bad_order' });
      const r = await W.cancelWithRefund(id, 'customer', uid);
      return U.json(res, r.ok ? 200 : 400, r.ok ? r : { error: r.why });
    }
    if (op === 'topup') {
      const amt = Math.round(Number(b.amount) || 0);
      if (amt < 20 || amt > 5000) return U.json(res, 400, { error: 'bad_amount' });
      const back = String(process.env.PAY_RETURN_URL || 'https://app.kleenology.me/app/').replace(/[?#].*$/, '') + '?wallet=1';
      const hook = process.env.PAY_HOOK_URL || ('https://' + String(req.headers.host || '').replace(/[^A-Za-z0-9.:-]/g, '') + '/api/pay/hook');
      const j = await T.call('POST', '/charges', {
        amount: amt, currency: 'SAR', customer_initiated: true, threeDSecure: true, save_card: false,
        description: 'شحن رصيد كلينولوجي', statement_descriptor: 'KLEENOLOGY',
        metadata: { kind: 'topup', wuid: uid }, reference: { transaction: 'KLN-W-' + Date.now(), order: 'WALLET' },
        customer: { first_name: 'عميل كلينولوجي', email: 'customer@kleenology.me' },
        receipt: { email: false, sms: false }, source: { id: 'src_all' }, post: { url: hook }, redirect: { url: back }
      });
      const url = j.transaction && String(j.transaction.url || '').replace(/([?&]language=)[a-z]{2}\b/, '$1ar');
      if (!url) return U.json(res, 502, { error: 'no_url' });
      return U.json(res, 200, { ok: true, url });
    }
    /* ===== الأدمن ===== */
    if (op === 'credit' || op === 'code' || op === 'codeoff') {
      let admin = false;
      try { admin = !!(await S.adminUid(tok)); } catch (e) { admin = false; }
      if (!admin) return U.json(res, 401, { error: 'not_admin' });
      if (op === 'credit') {
        const to = String(b.uid || ''), amt = Number(b.amt);
        if (!/^[A-Za-z0-9_-]{6,128}$/.test(to) || !amt || Math.abs(amt) > 5000) return U.json(res, 400, { error: 'bad_request' });
        const r = await W.credit(to, amt, 'admin', 'admin', b.note || (amt > 0 ? 'رصيد من كلينولوجي' : 'تعديل من الإدارة'));
        return U.json(res, r.ok ? 200 : 400, r.ok ? r : { error: r.why });
      }
      if (op === 'code') {
        const r = await W.createCode(b);
        return U.json(res, r.ok ? 200 : 400, r.ok ? r : { error: r.why });
      }
      const c = W.normCode(b.code);
      if (!c) return U.json(res, 400, { error: 'bad_code' });
      await S.app().firestore().collection('codes').doc(c).update({ on: false });
      return U.json(res, 200, { ok: true });
    }
    return U.json(res, 400, { error: 'op' });
  } catch (e) {
    console.error('wallet:', (e && e.message) || e);
    return U.json(res, e && e.code === 'not_configured' ? 503 : 500, { error: 'wallet' });
  }
};
