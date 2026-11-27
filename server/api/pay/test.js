'use strict';
/* POST /api/pay/test — للأدمن فقط: تجربة الدفع بريال واحد بدون طلب.
   {}             → يفتح عملية ١ ر.س ويرجّع رابط صفحة الدفع (الرجوع للوحة)
   {tap_id:"chg_…"} → يرجّع حالة عملية التجربة من تاب (مدفوعة؟ بأي طريقة؟)
   ما يلمس أي طلب — والمبلغ ترجّعه من لوحة تاب (Refund) */
const U = require('../_lib/util');
const S = require('../_lib/store');
const T = require('../_lib/tap');

module.exports = async function handler(req, res) {
  if (U.cors(req, res)) return;
  if (req.method !== 'POST') return U.json(res, 405, { error: 'method' });
  const auth = String(req.headers.authorization || '');
  const tok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  let body = {};
  try { body = (await U.readBody(req)) || {}; } catch (e) { return U.json(res, 400, { error: 'bad_request' }); }
  try { if (!(await S.adminUid(tok))) return U.json(res, 401, { error: 'not_admin' }); }
  catch (e) { return U.json(res, 401, { error: 'not_admin' }); }

  try {
    if (body.tap_id) {
      const ch = await T.getCharge(String(body.tap_id));
      if (!ch.metadata || ch.metadata.test !== 'admin') return U.json(res, 404, { error: 'not_test' });
      return U.json(res, 200, { ok: ch.status === 'CAPTURED', status: ch.status, amount: ch.amount,
        method: T.methodOf(ch), live: !!ch.live_mode, id: ch.id });
    }
    const back = String(process.env.PAY_ADMIN_URL || 'https://app.kleenology.me/').replace(/[?#].*$/, '') + '?admin&paytest=1';
    const j = await T.call('POST', '/charges', {
      amount: 1, currency: 'SAR', customer_initiated: true, threeDSecure: true, save_card: false,
      description: 'تجربة دفع — كلينولوجي', statement_descriptor: 'KLEENOLOGY',
      metadata: { test: 'admin' }, reference: { transaction: 'KLN-TEST-' + Date.now(), order: 'TEST' },
      customer: { first_name: 'Kleenology', email: 'customer@kleenology.me' },
      source: { id: 'src_all' }, redirect: { url: back }
    });
    const url = j.transaction && String(j.transaction.url || '').replace(/([?&]language=)[a-z]{2}\b/, '$1ar');
    if (!url) return U.json(res, 502, { error: 'no_url' });
    return U.json(res, 200, { ok: true, url, live: !!j.live_mode });
  } catch (e) {
    console.error('pay/test:', (e && e.message) || e);
    return U.json(res, e && e.code === 'not_configured' ? 503 : 502, { error: (e && e.code) || 'tap', message: String((e && e.message) || '').slice(0, 200) });
  }
};
