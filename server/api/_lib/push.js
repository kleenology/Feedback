'use strict';
/* إشعارات الجوال لتطبيق الآيفون — مباشرة عبر خدمة آبل (APNs) بدون وسيط.

   المتغيرات (Vercel) — تنضاف بعد ما يجهز حساب مطوّر آبل:
     APNS_KEY      محتوى ملف ‎.p8‎ من developer.apple.com → Keys (مع سطوره، أو \n بدلها)
     APNS_KEY_ID   رقم المفتاح (10 خانات)
     APNS_TEAM_ID  رقم الفريق (10 خانات)
     APNS_TOPIC    معرّف التطبيق — افتراضي me.kleenology.app
     APNS_SANDBOX  1 للتجربة من Xcode مباشرة (TestFlight والمتجر = بدونه)

   رموز الأجهزة تنحفظ في push/{uid} — الكتابة من الخادم بس (القواعد ترفض العميل افتراضياً). */
const crypto = require('crypto');
const http2 = require('http2');

const ST_MSG = {
  confirmed: (o) => ({ t: 'تأكّد طلبك ✓', b: 'موعدك ' + when(o) + ' — نشوفك على خير' }),
  on_way: () => ({ t: 'الفريق في الطريق 🚐', b: 'فريق كلينولوجي متجه لك الحين' }),
  done: () => ({ t: 'اكتملت الخدمة ✨', b: 'شكراً لثقتك — قيّم تجربتك من «طلباتي»' }),
  cancelled: (o) => ({ t: 'أُلغي طلبك', b: 'طلب رقم ' + (o.no || '') + ' انلغى — لأي استفسار تواصل معنا' })
};
const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
function when(o) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(o.date || '')) ? new Date(o.date + 'T00:00:00Z') : null;
  const day = d ? DAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + '/' + (d.getUTCMonth() + 1) : '';
  const sl = { am: 'الصباح', pm: 'بعد الظهر', ev: 'المساء' }[o.slot] || '';
  return [day, sl].filter(Boolean).join(' ') || 'المحدد';
}
/* نص الإشعار لحالة الطلب — null لو الحالة ما لها إشعار */
function statusMsg(o) {
  const f = o && ST_MSG[o.st];
  return f ? f(o) : null;
}

function cfg() {
  const key = String(process.env.APNS_KEY || '').replace(/\\n/g, '\n').trim();
  return {
    key, kid: String(process.env.APNS_KEY_ID || '').trim(), team: String(process.env.APNS_TEAM_ID || '').trim(),
    topic: String(process.env.APNS_TOPIC || 'me.kleenology.app').trim(),
    host: process.env.APNS_SANDBOX === '1' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com'
  };
}
function ready() { const c = cfg(); return !!(c.key && c.kid && c.team); }

const b64u = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
/* رمز دخول آبل (JWT بتوقيع ES256) — صالح ساعة، نجدده كل ٥٠ دقيقة */
let JWT = { v: '', at: 0, kid: '' };
function jwt(c, now) {
  now = now || Date.now();
  if (JWT.v && JWT.kid === c.kid && now - JWT.at < 50 * 60 * 1000) return JWT.v;
  const h = b64u(JSON.stringify({ alg: 'ES256', kid: c.kid }));
  const p = b64u(JSON.stringify({ iss: c.team, iat: Math.floor(now / 1000) }));
  const sig = crypto.sign('sha256', Buffer.from(h + '.' + p), { key: c.key, dsaEncoding: 'ieee-p1363' });
  JWT = { v: h + '.' + p + '.' + b64u(sig), at: now, kid: c.kid };
  return JWT.v;
}

function payload(m, data) {
  return Object.assign({ aps: { alert: { title: m.t, body: m.b }, sound: 'default' } }, data || {});
}

/* إرسال لجهاز واحد — يرجّع {ok, status, reason} */
function sendOne(c, token, body) {
  return new Promise((resolve) => {
    let cl;
    try { cl = http2.connect(c.host); } catch (e) { return resolve({ ok: false, status: 0, reason: 'connect' }); }
    cl.on('error', () => resolve({ ok: false, status: 0, reason: 'connect' }));
    const req = cl.request({
      ':method': 'POST', ':path': '/3/device/' + token,
      authorization: 'bearer ' + jwt(c), 'apns-topic': c.topic, 'apns-push-type': 'alert', 'apns-priority': '10',
      'content-type': 'application/json'
    });
    let status = 0, txt = '';
    req.setTimeout(10000, () => { req.close(); });
    req.on('response', (h) => { status = h[':status']; });
    req.on('data', (d) => { txt += d; });
    req.on('end', () => {
      cl.close();
      let reason = ''; try { reason = (JSON.parse(txt || '{}').reason) || ''; } catch (e) {}
      resolve({ ok: status === 200, status, reason });
    });
    req.on('error', () => { cl.close(); resolve({ ok: false, status: 0, reason: 'request' }); });
    req.end(JSON.stringify(body));
  });
}
/* رمز انتهى (حذف التطبيق مثلاً) — نشيله من القائمة */
function dead(r) { return r.status === 410 || r.reason === 'BadDeviceToken' || r.reason === 'Unregistered' || r.reason === 'DeviceTokenNotForTopic'; }

const okToken = (t) => /^[0-9a-f]{64,200}$/i.test(String(t || ''));

function db() { return require('./store').app().firestore(); }

async function register(uid, token) {
  if (!okToken(token)) return { ok: false, why: 'bad_token' };
  const t = String(token).toLowerCase();
  /* نفس الجهاز لو كان مسجّلاً لحساب ثاني (خرج ودخل بحساب ثاني) نشيله من هناك — الإشعار يروح لصاحب الجلسة بس */
  const others = await db().collection('push').where('tokens', 'array-contains', t).get();
  for (const d of others.docs) if (d.id !== uid) await unregister(d.id, t);
  const ref = db().collection('push').doc(uid);
  await db().runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const list = ((s.exists && s.data().tokens) || []).filter((x) => x !== t).slice(-4); /* آخر ٥ أجهزة */
    list.push(t);
    tx.set(ref, { tokens: list, at: new Date().toISOString() }, { merge: true });
  });
  return { ok: true };
}

async function unregister(uid, token) {
  const t = String(token || '').toLowerCase();
  const ref = db().collection('push').doc(uid);
  await db().runTransaction(async (tx) => {
    const s = await tx.get(ref); if (!s.exists) return;
    tx.set(ref, { tokens: (s.data().tokens || []).filter((x) => x !== t) }, { merge: true });
  });
  return { ok: true };
}

/* إشعار لكل أجهزة العميل — send قابل للتبديل في الاختبار */
async function toUser(uid, m, data, send) {
  if (!uid || !m) return { sent: 0 };
  const c = cfg();
  if (!send && !ready()) return { sent: 0, why: 'not_configured' };
  const s = await db().collection('push').doc(uid).get();
  const list = (s.exists && s.data().tokens) || [];
  let sent = 0;
  for (const t of list) {
    const r = await (send || sendOne)(c, t, payload(m, data));
    if (r.ok) sent++;
    else if (dead(r)) await unregister(uid, t).catch(() => {});
  }
  return { sent, devices: list.length };
}

/* إشعار حالة طلب — يُستدعى من اللوحة بعد تغيير الحالة */
async function orderStatus(oid, send) {
  const o = await require('./store').getOrder(oid);
  if (!o) return { sent: 0, why: 'not_found' };
  const m = statusMsg(o);
  if (!m) return { sent: 0, why: 'no_msg' };
  return toUser(o.uid, m, { oid }, send);
}

module.exports = { statusMsg, when, payload, jwt, cfg, ready, dead, okToken, register, unregister, toUser, orderStatus, _reset: () => { JWT = { v: '', at: 0, kid: '' }; } };
