'use strict';
/* مزوّدو الرسائل السعوديون. كل واحد دالة واحدة ترمي عند الفشل.
   الاختيار من SMS_PROVIDER، والاسم المعتمد من SMS_SENDER.

   ⚠️ شكل الطلب لكل مزوّد مأخوذ من توثيقه المنشور — راجعه مرة واحدة عند
   الربط، فبعض المزوّدين يغيّرون المسارات. نقطة التغيير هنا وحدها. */

async function post(url, opts) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    const text = await r.text();
    if (!r.ok) throw new Error('مزوّد الرسائل ' + r.status + ': ' + text.slice(0, 200));
    return text;
  } finally { clearTimeout(t); }
}

const PROVIDERS = {
  /* https://msegat.docs.apiary.io */
  async msegat(to, body) {
    const out = await post('https://www.msegat.com/gw/sendsms.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userName: process.env.SMS_USER,
        apiKey: process.env.SMS_KEY,
        userSender: process.env.SMS_SENDER,
        numbers: to,
        msg: body
      })
    });
    /* مسجات ترجع 200 مع كود داخل الجسم — النجاح code:1 */
    let j = null; try { j = JSON.parse(out); } catch (e) {}
    if (j && String(j.code) !== '1') throw new Error('مسجات: ' + out.slice(0, 200));
    return out;
  },

  /* https://api.taqnyat.sa — Bearer token */
  async taqnyat(to, body) {
    return post('https://api.taqnyat.sa/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + process.env.SMS_KEY
      },
      body: JSON.stringify({ recipients: [to], body, sender: process.env.SMS_SENDER })
    });
  },

  /* https://api.unifonic.com — AppSid */
  async unifonic(to, body) {
    const form = new URLSearchParams({
      AppSid: process.env.SMS_KEY,
      SenderID: process.env.SMS_SENDER,
      Recipient: to,
      Body: body
    });
    return post('https://el.cloud.unifonic.com/rest/SMS/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });
  },

  /* للتجربة بلا حساب ولا تكلفة: يطبع الرمز في سجل الخادم */
  async mock(to, body) {
    console.log('[mock-sms] →', to, '|', body);
    return 'mock';
  }
};

function smsText(code) {
  const brand = process.env.SMS_BRAND || 'كلينولوجي';
  return 'رمز الدخول إلى ' + brand + ': ' + code + '\nصالح ٥ دقائق. لا تشاركه مع أحد.';
}

async function sendSms(phone, code) {
  const name = (process.env.SMS_PROVIDER || 'mock').toLowerCase();
  const fn = PROVIDERS[name];
  if (!fn) throw new Error('مزوّد غير معروف: ' + name);
  return fn(phone, smsText(code));
}

module.exports = { sendSms, smsText, PROVIDERS };
