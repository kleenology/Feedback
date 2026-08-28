'use strict';
const U = require('../_lib/util');
const S = require('../_lib/store');

const MAX_TRIES = 5;

module.exports = async function handler(req, res) {
  if (U.cors(req, res)) return;
  if (req.method !== 'POST') return U.json(res, 405, { error: 'method' });

  let phone, code;
  try {
    const body = await U.readBody(req);
    phone = U.normPhone(body && body.phone);
    code = String((body && body.code) || '').replace(/\D/g, '');
  } catch (e) { return U.json(res, 400, { error: 'bad_request' }); }
  if (!phone || code.length !== 6) return U.json(res, 400, { error: 'bad_request' });

  try {
    const rec = await S.getOtp(phone);
    /* رسالة واحدة لكل حالات الفشل حتى لا نكشف إن كان للرقم رمز قائم */
    if (!rec) return U.json(res, 400, { error: 'bad_code' });
    if (Date.now() > rec.exp) { await S.dropOtp(phone); return U.json(res, 400, { error: 'expired' }); }
    if ((rec.tries || 0) >= MAX_TRIES) { await S.dropOtp(phone); return U.json(res, 429, { error: 'too_many' }); }

    if (!U.sameHash(rec.hash, U.hashCode(code, phone))) {
      await S.bumpTries(phone);
      return U.json(res, 400, { error: 'bad_code' });
    }

    /* الرمز يُستهلك مرة واحدة */
    await S.dropOtp(phone);
    const token = await S.customToken(phone);
    return U.json(res, 200, { token });
  } catch (e) {
    console.error('verify:', (e && e.message) || e);
    return U.json(res, 500, { error: 'verify_failed' });
  }
};
