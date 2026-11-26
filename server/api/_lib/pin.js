'use strict';
/* رمز الدخول المؤقت: ٦ أرقام يختارها العميل أول مرة. يُخزَّن مجزّأً بـ scrypt مع ملح لكل رقم
   (بطيء عمداً — تسريب القاعدة ما يكشف الرموز بسهولة). ٥ محاولات خطأ = قفل ١٥ دقيقة. */
const crypto = require('crypto');

const FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), Buffer.from(salt, 'hex'), 32, { N: 16384, r: 8, p: 1 }).toString('hex');
}
function newRecord(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { hash: hashPin(pin, salt), salt, fails: 0, lockUntil: 0, at: new Date().toISOString() };
}
function matches(rec, pin) {
  const a = Buffer.from(hashPin(pin, rec.salt), 'hex'), b = Buffer.from(String(rec.hash || ''), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/* الرموز اللي يخمّنها أي أحد أول شي */
function weak(pin) {
  const p = String(pin);
  if (/^(\d)\1{5}$/.test(p)) return true;                         /* 000000 · 111111 */
  if ('0123456789'.includes(p) || '9876543210'.includes(p)) return true; /* 123456 · 654321 */
  if (/^(\d\d)\1\1$/.test(p) || /^(\d{3})\1$/.test(p)) return true;   /* 121212 · 123123 */
  return false;
}
module.exports = { FAILS, LOCK_MS, hashPin, newRecord, matches, weak };
