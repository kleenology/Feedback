'use strict';
const U = require('../_lib/util');
const S = require('../_lib/store');
const { deliver, channels, smsReady } = require('../_lib/sms');

const COOLDOWN = 60 * 1000;        /* بين رسالتين لنفس الرقم */
const WINDOW   = 60 * 60 * 1000;   /* نافذة العدّ */
const PER_HOUR = 5;                /* أقصى رسائل للرقم في الساعة */
const TTL      = 5 * 60 * 1000;    /* صلاحية الرمز */
const SWITCH   = 20 * 1000;        /* من واتساب إلى SMS: ما ننتظر الدقيقة كاملة */

module.exports = async function handler(req, res) {
  if (U.cors(req, res)) return;
  if (req.method !== 'POST') return U.json(res, 405, { error: 'method' });

  let phone, via = '';
  try {
    const body = await U.readBody(req);
    phone = U.normPhone(body && body.phone);
    /* via:'sms' = «ما وصلني على واتساب، أرسله برسالة نصية» */
    if (body && body.via === 'sms') via = 'sms';
    if (via === 'sms' && !smsReady() && !U.testNumbers()[U.normPhone(body && body.phone)]) via = 'no_sms';
  } catch (e) { return U.json(res, 400, { error: 'bad_request' }); }
  if (!phone) return U.json(res, 400, { error: 'bad_phone' });
  if (via === 'no_sms') return U.json(res, 400, { error: 'no_sms' });

  try {
    const now = Date.now();
    const cur = await S.getOtp(phone);

    /* حدّان للرقم الواحد: مهلة بين رسالتين، وسقف في الساعة.
       بدونهما يقدر أي أحد يستنزف رصيد الرسائل برقم واحد */
    /* التحويل من واتساب إلى SMS مهلته أقصر — الرسالة الأولى غالباً ما وصلت أصلاً */
    const gap = (via === 'sms' && cur && cur.via === 'whatsapp') ? SWITCH : COOLDOWN;
    if (cur && cur.sentAt && now - cur.sentAt < gap)
      return U.json(res, 429, { error: 'cooldown', wait: Math.ceil((gap - (now - cur.sentAt)) / 1000) });

    let count = (cur && cur.winStart && now - cur.winStart < WINDOW) ? (cur.count || 0) : 0;
    const winStart = (cur && cur.winStart && now - cur.winStart < WINDOW) ? cur.winStart : now;
    if (count >= PER_HOUR) return U.json(res, 429, { error: 'too_many' });

    /* سقف يومي عام يحدّ الفاتورة مهما صار */
    const dayCap = Number(process.env.OTP_DAILY_CAP || 300);
    if (!(await S.bumpDaily(dayCap))) return U.json(res, 503, { error: 'daily_cap' });

    /* الرقم التجريبي يأخذ رمزه الثابت ولا تُرسَل له رسالة — لكن الحدود
       تنطبق عليه كغيره حتى لا يصير باباً مفتوحاً */
    const test = U.testNumbers()[phone];
    const code = test || U.newCode();
    const rec = {
      hash: U.hashCode(code, phone),
      exp: now + TTL,
      tries: 0,
      sentAt: now,
      winStart,
      count: count + 1
    };
    await S.putOtp(phone, rec);

    let used;
    try {
      used = test ? (via || channels()[0]) : await deliver(phone, code, via);
    } catch (e) {
      /* الرسالة ما وصلت: نمسح الرمز حتى لا يبقى صالحاً بلا أحد يعرفه،
         ولا نحبس العميل ٦٠ ثانية على محاولة فاشلة ليست منه */
      await S.dropOtp(phone).catch(() => {});
      throw e;
    }
    /* نحفظ القناة: لو كانت واتساب، طلب SMS بعدها مهلته أقصر */
    await S.putOtp(phone, { ...rec, via: used });
    return U.json(res, 200, { ok: true, via: used, sms: smsReady() });
  } catch (e) {
    console.error('send:', (e && e.message) || e);
    return U.json(res, 500, { error: 'send_failed' });
  }
};
