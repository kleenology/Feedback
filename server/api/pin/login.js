'use strict';
/* POST /api/pin/login {phone, pin, create?} → {token}
   create:true  = أول مرة: ينشئ الرمز (يرفض لو الرقم له رمز، أو الرمز سهل التخمين)
   بدونه        = يتحقق من الرمز. ٥ أخطاء ← قفل ١٥ دقيقة.
   رمز الدخول المخصّص بنفس هوية رموز SMS (ph_الجوال) — لما يتفعّل SMS العميل يبقى نفسه */
const U = require('../_lib/util');
const S = require('../_lib/store');
const P = require('../_lib/pin');

module.exports = async function handler(req, res) {
  if (U.cors(req, res)) return;
  if (req.method !== 'POST') return U.json(res, 405, { error: 'method' });
  let phone, pin, create;
  try {
    const b = await U.readBody(req);
    phone = U.normPhone(b && b.phone);
    pin = String((b && b.pin) || '');
    create = !!(b && b.create);
  } catch (e) { return U.json(res, 400, { error: 'bad_request' }); }
  if (!phone) return U.json(res, 400, { error: 'bad_phone' });
  if (!/^\d{6}$/.test(pin)) return U.json(res, 400, { error: 'bad_pin' });

  try {
    if (create) {
      if (P.weak(pin)) return U.json(res, 400, { error: 'weak' });
      if (!(await S.createPin(phone, P.newRecord(pin)))) return U.json(res, 409, { error: 'exists' });
      return U.json(res, 200, { token: await S.customToken(phone) });
    }
    const rec = await S.getPin(phone);
    if (!rec) return U.json(res, 404, { error: 'no_pin' });
    const now = Date.now();
    if (rec.lockUntil && rec.lockUntil > now)
      return U.json(res, 429, { error: 'locked', wait: Math.ceil((rec.lockUntil - now) / 60000) });
    if (!P.matches(rec, pin)) {
      const fails = (rec.fails || 0) + 1;
      const lock = fails >= P.FAILS;
      await S.updatePin(phone, lock ? { fails: 0, lockUntil: now + P.LOCK_MS } : { fails });
      return U.json(res, lock ? 429 : 401, lock ? { error: 'locked', wait: 15 } : { error: 'wrong', left: P.FAILS - fails });
    }
    if (rec.fails || rec.lockUntil) await S.updatePin(phone, { fails: 0, lockUntil: 0 });
    return U.json(res, 200, { token: await S.customToken(phone) });
  } catch (e) {
    console.error('pin login:', (e && e.message) || e);
    return U.json(res, 500, { error: 'failed' });
  }
};
