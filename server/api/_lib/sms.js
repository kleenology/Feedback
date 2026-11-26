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

/* ================= واتساب ================= */
/* WhatsApp Cloud API من Meta: قالب من فئة «Authentication» فيه زر «نسخ الرمز».
   القالب يُنشأ ويُعتمد من WhatsApp Manager باسم WA_TEMPLATE (افتراضي kleenology_otp)
   ولغة WA_LANG (افتراضي ar). جسم القالب فيه {{1}} = الرمز، والزر copy-code يأخذ نفس الرمز.

   ⚠️ Meta ترد 200 حتى لو الرقم ما عليه واتساب — الفشل يوصل لاحقاً عبر webhook.
   لهذا التطبيق يعرض زر «أرسله برسالة نصية» بعد ثوانٍ، ويطلب via:'sms'. */
const WA = {
  async meta(to, code) {
    const ver = process.env.WA_API_VERSION || 'v21.0';
    const out = await post('https://graph.facebook.com/' + ver + '/' + process.env.WA_PHONE_ID + '/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.WA_TOKEN },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: process.env.WA_TEMPLATE || 'kleenology_otp',
          language: { code: process.env.WA_LANG || 'ar' },
          components: [
            { type: 'body', parameters: [{ type: 'text', text: code }] },
            { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] }
          ]
        }
      })
    });
    let j = null; try { j = JSON.parse(out); } catch (e) {}
    if (!j || !j.messages || !j.messages.length) throw new Error('واتساب: ' + out.slice(0, 200));
    return out;
  },

  /* للتجربة: يطبع الرمز في سجل الخادم بدل ما يرسله */
  async mock(to, code) {
    console.log('[mock-whatsapp] →', to, '|', code);
    return 'mock';
  }
};

async function sendWhatsApp(phone, code) {
  const name = (process.env.WA_PROVIDER || 'mock').toLowerCase();
  const fn = WA[name];
  if (!fn) throw new Error('مزوّد واتساب غير معروف: ' + name);
  return fn(phone, code);
}

/* ================= اختيار القناة ================= */
/* OTP_CHANNELS بالترتيب، مثال: "whatsapp,sms" = واتساب أولاً، وإذا فشل الإرسال فوراً SMS.
   الافتراضي "sms" وحده — نفس سلوك الخادم قبل إضافة واتساب. */
const SENDERS = { whatsapp: sendWhatsApp, sms: sendSms };
function channels() {
  const list = String(process.env.OTP_CHANNELS || 'sms').toLowerCase().split(',')
    .map(x => x.trim()).filter(x => SENDERS[x]);
  return list.length ? list : ['sms'];
}

/* يرسل عبر أول قناة تنجح ويرجّع اسمها. via يفرض قناة واحدة (زر «أرسله برسالة نصية») */
async function deliver(phone, code, via) {
  const order = via && SENDERS[via] ? [via] : channels();
  let last = null;
  for (const ch of order) {
    try { await SENDERS[ch](phone, code); return ch; }
    catch (e) { last = e; console.error('قناة ' + ch + ' فشلت:', (e && e.message) || e); }
  }
  throw last || new Error('لا توجد قناة إرسال');
}

/* فيه SMS حقيقي؟ (قناة sms في OTP_CHANNELS ومزوّد مو mock). بدونه التطبيق يخفي زر «أرسله برسالة نصية» */
function smsReady() {
  const p = String(process.env.SMS_PROVIDER || '').toLowerCase();
  return channels().includes('sms') && !!p && p !== 'mock' && !!PROVIDERS[p];
}

module.exports = { smsReady, deliver, channels, sendSms, sendWhatsApp, smsText, PROVIDERS, WA, SENDERS };
