'use strict';
const U = require('../_lib/util');
const S = require('../_lib/store');
const { sendSms } = require('../_lib/sms');

const COOLDOWN = 60 * 1000;        /* بين رسالتين لنفس الرقم */
const WINDOW   = 60 * 60 * 1000;   /* نافذة العدّ */
const PER_HOUR = 5;                /* أقصى رسائل للرقم في الساعة */
const TTL      = 5 * 60 * 1000;    /* صلاحية الرمز */

module.exports = async function handler(req, res) {
  if (U.cors(req, res)) return;
  if (req.method !== 'POST') return U.json(res, 405, { error: 'method' });

  let phone;
  try {
    const body = await U.readBody(req);
    phone = U.normPhone(body && body.phone);
  } catch (e) { return U.json(res, 400, { error: 'bad_request' }); }
  if (!phone) return U.json(res, 400, { error: 'bad_phone' });

  try {
    const now = Date.now();
    const cur = await S.getOtp(phone);

    /* حدّان للرقم الواحد: مهلة بين رسالتين، وسقف في الساعة.
       بدونهما يقدر أي أحد يستنزف رصيد الرسائل برقم واحد */
    if (cur && cur.sentAt && now - cur.sentAt < COOLDOWN)
      return U.json(res, 429, { error: 'cooldown', wait: Math.ceil((COOLDOWN - (now - cur.sentAt)) / 1000) });

    let count = (cur && cur.winStart && now - cur.winStart < WINDOW) ? (cur.count || 0) : 0;
    const winStart = (cur && cur.winStart && now - cur.winStart < WINDOW) ? cur.winStart : now;
    if (count >= PER_HOUR) return U.json(res, 429, { error: 'too_many' });

    /* سقف يومي عام يحدّ الفاتورة مهما صار */
    const dayCap = Number(process.env.OTP_DAILY_CAP || 300);
    if (!(await S.bumpDaily(dayCap))) return U.json(res, 503, { error: 'daily_cap' });

    const code = U.newCode();
    await S.putOtp(phone, {
      hash: U.hashCode(code, phone),
      exp: now + TTL,
      tries: 0,
      sentAt: now,
      winStart,
      count: count + 1
    });

    try {
      await sendSms(phone, code);
    } catch (e) {
      /* الرسالة ما وصلت: نمسح الرمز حتى لا يبقى صالحاً بلا أحد يعرفه،
         ولا نحبس العميل ٦٠ ثانية على محاولة فاشلة ليست منه */
      await S.dropOtp(phone).catch(() => {});
      throw e;
    }
    return U.json(res, 200, { ok: true });
  } catch (e) {
    console.error('send:', (e && e.message) || e);
    return U.json(res, 500, { error: 'send_failed' });
  }
};
