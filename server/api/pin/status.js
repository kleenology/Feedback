'use strict';
/* POST /api/pin/status {phone} → {exists} — يحدد شاشة «أنشئ رمزك» أو «أدخل رمزك» */
const U = require('../_lib/util');
const S = require('../_lib/store');

module.exports = async function handler(req, res) {
  if (U.cors(req, res)) return;
  if (req.method !== 'POST') return U.json(res, 405, { error: 'method' });
  let phone;
  try { const b = await U.readBody(req); phone = U.normPhone(b && b.phone); }
  catch (e) { return U.json(res, 400, { error: 'bad_request' }); }
  if (!phone) return U.json(res, 400, { error: 'bad_phone' });
  try { return U.json(res, 200, { exists: !!(await S.getPin(phone)) }); }
  catch (e) { console.error('pin status:', e && e.message); return U.json(res, 500, { error: 'db' }); }
};
