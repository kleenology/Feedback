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

async function setInvoiceStatus(id, status, url) {
  const patch = { 'ostaz.status': status };
  if (url) patch['ostaz.url'] = url;          /* رابط الفاتورة — العميل يشوفه في طلبه بالتطبيق */
  await db().collection('orders').doc(id).update(patch);
}

/* ===== تنبيهات «الأستاذ» (webhook) ===== */
/* كل تنبيه له معرّف ثابت حتى لو أعيد إرساله — نسجّله أول مرة ونتجاهل المكرر */
async function markHook(hookId) {
  try { await db().collection('ostaz_hooks').doc(String(hookId)).create({ at: Date.now() }); return true; }
  catch (e) { if (e && (e.code === 6 || /already exists/i.test(e.message || ''))) return false; throw e; }
}
async function findOrders(field, value) {
  const s = await db().collection('orders').where(field, '==', value).limit(20).get();
  return s.docs.map(d => Object.assign({ _id: d.id }, d.data()));
}
async function setOstaz(id, ostaz) {
  await db().collection('orders').doc(id).update({ ostaz });
}
async function clearOstaz(id) {
  await db().collection('orders').doc(id).update({ ostaz: app().firestore.FieldValue.delete() });
}

/* ===== رمز الدخول المؤقت (PIN) — قبل تفعيل SMS/واتساب ===== */
/* pins/{الجوال}: {hash, salt, fails, lockUntil, at}. ممنوعة على المتصفح بقاعدة «أي مجموعة أخرى» */
async function getPin(phone) {
  const s = await db().collection('pins').doc(phone).get();
  return s.exists ? s.data() : null;
}
async function createPin(phone, rec) {
  try { await db().collection('pins').doc(phone).create(rec); return true; }
  catch (e) { if (e && (e.code === 6 || /already exists/i.test(e.message || ''))) return false; throw e; }
}
async function updatePin(phone, patch) {
  await db().collection('pins').doc(phone).update(patch);
}

/* ===== الدفع عبر «تاب» ===== */
/* هوية العميل من رمز فايربيس — ما نثق بمعرّف يرسله المتصفح */
async function userUid(idToken) {
  if (!idToken) return '';
  const t = await app().auth().verifyIdToken(idToken);
  return t.uid || '';
}
async function setTapPending(id, tap) {
  await db().collection('orders').doc(id).update({ tap });
}
/* تسجيل الدفعة مرة وحدة مهما تكرر التحقق (رجوع العميل + التنبيه): داخل معاملة، والمعرّف في pays يمنع التكرار.
   paid = كل المستلم — نفس الحقل اللي يكتبه الفريق من اللوحة للتحويل البنكي */
async function applyTapPayment(id, ch, method) {
  const ref = db().collection('orders').doc(id);
  return db().runTransaction(async tx => {
    const s = await tx.get(ref);
    if (!s.exists) return { ok: false, why: 'not_found' };
    const o = s.data();
    const pays = Array.isArray(o.pays) ? o.pays : [];
    if (pays.some(p => p && p.id === ch.id)) return { ok: true, already: true, paid: Number(o.paid) || 0 };
    const amt = Math.round(Number(ch.amount) * 100) / 100;
    const now = new Date().toISOString();
    const paid = Math.round(((Number(o.paid) || 0) + amt) * 100) / 100;
    tx.update(ref, {
      paid, paidAt: now,
      pays: pays.concat([{ id: ch.id, amt, m: 'tap', src: method || '', at: now }]),
      tap: { id: ch.id, amt, st: 'CAPTURED', at: now }
    });
    return { ok: true, paid, amt };
  });
}
async function setTapStatus(id, chId, st) {
  const ref = db().collection('orders').doc(id);
  await db().runTransaction(async tx => {
    const s = await tx.get(ref);
    if (!s.exists) return;
    const t = s.data().tap;
    if (t && t.id === chId && t.st !== 'CAPTURED') tx.update(ref, { 'tap.st': String(st).slice(0, 20) });
  });
}

/* ===== الإلغاء التلقائي للطلبات اللي ما انْدفعت ===== */
/* بوابة: التنظيف يشتغل مرة كل كم دقيقة مهما كثرت الطلبات عليه */
async function sweepGate(minMs) {
  const ref = db().collection('pay_meta').doc('sweep');
  return db().runTransaction(async tx => {
    const s = await tx.get(ref);
    const last = (s.exists && s.data().at) || 0;
    if (Date.now() - last < minMs) return false;
    tx.set(ref, { at: Date.now() });
    return true;
  });
}
/* طلبات الدفع الإلكتروني اللي للحين «جديدة» وما انْدفع منها شي وأقدم من المهلة */
async function staleTapOrders(cutoffIso) {
  const s = await db().collection('orders').where('pay', '==', 'tap').where('st', '==', 'new').limit(100).get();
  return s.docs.map(d => Object.assign({ _id: d.id }, d.data()))
    .filter(o => !(Number(o.paid) > 0) && String(o.at || '') < cutoffIso);
}
/* الإلغاء والموعد يتحرّر في معاملة وحدة — ولو انْدفع في آخر لحظة ما نلغيه */
async function cancelUnpaid(id) {
  const ref = db().collection('orders').doc(id);
  return db().runTransaction(async tx => {
    const s = await tx.get(ref);
    if (!s.exists) return false;
    const o = s.data();
    if (o.st !== 'new' || Number(o.paid) > 0) return false;
    let sref = null, cur = 0;
    if (o.date && /^[0-9-]{8,12}$/.test(o.date) && ['am', 'pm', 'ev'].includes(o.slot)) {
      sref = db().collection('slots').doc(o.date);
      const sd = await tx.get(sref);
      cur = (sd.exists && Number(sd.data()[o.slot])) || 0;
    }
    const now = new Date().toISOString();
    const hist = (Array.isArray(o.hist) ? o.hist : []).concat([{ s: 'cancelled', at: now, by: 'auto', why: 'unpaid' }]);
    tx.update(ref, { st: 'cancelled', hist });
    if (sref && cur > 0) tx.update(sref, { [o.slot]: cur - 1 });
    return true;
  });
}

module.exports = { sweepGate, staleTapOrders, cancelUnpaid, userUid, setTapPending, applyTapPayment, setTapStatus, getPin, createPin, updatePin, markHook, findOrders, setOstaz, clearOstaz, setInvoiceStatus, getOtp, putOtp, dropOtp, bumpTries, bumpDaily, customToken, uidFor, app,
  adminUid, getOrder, lockInvoice, saveInvoice, unlockInvoice };
