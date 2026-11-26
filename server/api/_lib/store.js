'use strict';
/* فايربيس أدمن: يخزّن الرموز وحدود المحاولات، ويصكّ رمز الدخول.
   الأدمن يتجاوز قواعد Firestore، فمجموعة otp ممنوعة تماماً على العملاء. */
let admin = null;

function app() {
  if (admin) return admin;
  admin = require('firebase-admin');
  if (!admin.apps.length) {
    const key = (process.env.FB_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    if (!key || !process.env.FB_CLIENT_EMAIL || !process.env.FB_PROJECT_ID)
      throw new Error('بيانات حساب الخدمة ناقصة (FB_PROJECT_ID / FB_CLIENT_EMAIL / FB_PRIVATE_KEY)');
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FB_PROJECT_ID,
        clientEmail: process.env.FB_CLIENT_EMAIL,
        privateKey: key
      })
    });
  }
  return admin;
}

const db = () => app().firestore();
const OTP = 'otp', META = 'otp_meta';

async function getOtp(phone) {
  const s = await db().collection(OTP).doc(phone).get();
  return s.exists ? s.data() : null;
}
async function putOtp(phone, data) {
  await db().collection(OTP).doc(phone).set(data);
}
async function dropOtp(phone) {
  await db().collection(OTP).doc(phone).delete();
}
async function bumpTries(phone) {
  const inc = app().firestore.FieldValue.increment(1);
  await db().collection(OTP).doc(phone).update({ tries: inc });
}

/* عدّاد يومي يحدّ التكلفة: مهما صار، لا تتجاوز الرسائل هذا السقف في اليوم */
async function bumpDaily(limit) {
  const id = 'day_' + new Date().toISOString().slice(0, 10);
  const ref = db().collection(META).doc(id);
  return db().runTransaction(async tx => {
    const s = await tx.get(ref);
    const n = (s.exists ? s.data().n : 0) || 0;
    if (n >= limit) return false;
    tx.set(ref, { n: n + 1, at: Date.now() }, { merge: true });
    return true;
  });
}

/* معرّف ثابت مشتق من الرقم — العميل يبقى نفسه ولو بدّل جهازه */
function uidFor(phone) { return 'ph_' + phone; }

async function customToken(phone) {
  return app().auth().createCustomToken(uidFor(phone), { ph: phone });
}

/* ===== الفواتير (لوحة التحكم) ===== */
/* هوية الطالب من رمز فايربيس، والأدمن = له وثيقة في admins — نفس قاعدة firestore.rules */
async function adminUid(idToken) {
  if (!idToken) return '';
  const t = await app().auth().verifyIdToken(idToken);
  const a = await db().collection('admins').doc(t.uid).get();
  return a.exists ? t.uid : '';
}
async function getOrder(id) {
  const s = await db().collection('orders').doc(id).get();
  return s.exists ? s.data() : null;
}
/* قفل بسيط ضد الضغط المزدوج: نحجز الطلب للفوترة داخل معاملة قبل ما نكلّم الأستاذ */
async function lockInvoice(id) {
  const ref = db().collection('orders').doc(id);
  return db().runTransaction(async tx => {
    const s = await tx.get(ref);
    if (!s.exists) return { ok: false, why: 'not_found' };
    const o = s.data();
    if (o.ostaz && o.ostaz.id) return { ok: false, why: 'done', ostaz: o.ostaz, order: o };
    if (o.ostazLock && Date.now() - o.ostazLock < 60000) return { ok: false, why: 'busy' };
    tx.update(ref, { ostazLock: Date.now() });
    return { ok: true, order: o };
  });
}
async function saveInvoice(id, ostaz) {
  const F = app().firestore.FieldValue;
  await db().collection('orders').doc(id).update({ ostaz, ostazLock: F.delete() });
}
async function unlockInvoice(id) {
  const F = app().firestore.FieldValue;
  await db().collection('orders').doc(id).update({ ostazLock: F.delete() }).catch(() => {});
}

module.exports = { getOtp, putOtp, dropOtp, bumpTries, bumpDaily, customToken, uidFor, app,
  adminUid, getOrder, lockInvoice, saveInvoice, unlockInvoice };
