'use strict';
/* المحفظة: رصيد لكل عميل يتغيّر من الخادم بس (قواعد Firestore تمنع المتصفح من الكتابة).
   wallets/{uid}            {bal, at}
   wallets/{uid}/tx/{id}    {amt (+ إضافة / − خصم), type, ref, note, at}
     type: topup (شحن بالدفع) · code (كود) · admin (من الإدارة) · spend (دفع طلب) · refund (استرجاع)
   codes/{CODE}             {amt, uses, used, exp, on, by:{uid:at}, note, at}

   كل عملية داخل معاملة: الرصيد ما يصير سالب، والكود ما ينصرف مرتين لنفس العميل،
   ونفس الشحنة (رقم عملية تاب) ما تنحسب مرتين. */
const S = require('./store');

const db = () => S.app().firestore();
const r2 = v => Math.round(Number(v) * 100) / 100;
const now = () => new Date().toISOString();
const MAX_PCT = () => { const n = Number(process.env.WALLET_MAX_PCT); return n > 0 && n <= 100 ? n : 50; };

function normCode(c) { return String(c || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24); }

/* إضافة أو خصم مع سجل — txId ثابت = ما تنحسب مرتين */
async function credit(uid, amt, type, ref, note, txId) {
  amt = r2(amt);
  if (!uid || !amt) return { ok: false, why: 'bad' };
  const w = db().collection('wallets').doc(uid);
  const tx = txId ? w.collection('tx').doc(String(txId)) : w.collection('tx').doc();
  return db().runTransaction(async t => {
    const [ws, ts] = await Promise.all([t.get(w), t.get(tx)]);
    if (ts.exists) return { ok: true, already: true, bal: (ws.exists && ws.data().bal) || 0 };
    const bal = r2(((ws.exists && ws.data().bal) || 0) + amt);
    if (bal < 0) return { ok: false, why: 'insufficient' };
    t.set(w, { bal, at: now() }, { merge: true });
    t.set(tx, { amt, type, ref: ref || '', note: String(note || '').slice(0, 120), at: now() });
    return { ok: true, bal, amt };
  });
}

/* حد محاولات القسائم الغلط: ٥ في الساعة لكل عميل — يمنع تجربة أكواد عشوائية لين يصيب وحدة.
   redeem_lim/{uid} {n, since} — ممنوعة على المتصفح (ما لها قاعدة = مرفوضة) */
const LIM_N = 5, LIM_MS = 3600 * 1000;
async function redeemBlocked(uid) {
  const d = await db().collection('redeem_lim').doc(uid).get();
  if (!d.exists) return false;
  const v = d.data();
  return Date.now() - (v.since || 0) < LIM_MS && (v.n || 0) >= LIM_N;
}
async function redeemFail(uid) {
  const ref = db().collection('redeem_lim').doc(uid);
  await db().runTransaction(async t => {
    const d = await t.get(ref);
    const v = d.exists ? d.data() : null;
    if (!v || Date.now() - (v.since || 0) >= LIM_MS) t.set(ref, { n: 1, since: Date.now() });
    else t.update(ref, { n: (v.n || 0) + 1 });
  });
}

async function redeem(uid, code) {
  if (await redeemBlocked(uid)) return { ok: false, why: 'too_many' };
  let r = await redeemTx(uid, code);
  if (!r.ok && r.why === 'not_found') r = await refRedeem(uid, code);
  /* المحاولة الغلط بس تنحسب — الكود المستخدم أو المنتهي مو تخمين */
  if (!r.ok && (r.why === 'not_found' || r.why === 'bad_code')) await redeemFail(uid).catch(() => {});
  return r;
}
async function redeemTx(uid, code) {
  const c = normCode(code);
  if (c.length < 3) return { ok: false, why: 'bad_code' };
  const cr = db().collection('codes').doc(c);
  const w = db().collection('wallets').doc(uid);
  const tx = w.collection('tx').doc('code-' + c);
  return db().runTransaction(async t => {
    const [cs, ws, ts] = await Promise.all([t.get(cr), t.get(w), t.get(tx)]);
    if (!cs.exists) return { ok: false, why: 'not_found' };
    const k = cs.data();
    if (k.on === false) return { ok: false, why: 'off' };
    if (k.exp && String(k.exp) < now().slice(0, 10)) return { ok: false, why: 'expired' };
    if (ts.exists || (k.by && k.by[uid])) return { ok: false, why: 'used' };
    if ((Number(k.used) || 0) >= (Number(k.uses) || 1)) return { ok: false, why: 'finished' };
    const amt = r2(k.amt);
    if (!(amt > 0)) return { ok: false, why: 'bad_code' };
    const bal = r2(((ws.exists && ws.data().bal) || 0) + amt);
    t.update(cr, { used: (Number(k.used) || 0) + 1, ['by.' + uid]: now() });
    t.set(w, { bal, at: now() }, { merge: true });
    t.set(tx, { amt, type: 'code', ref: c, note: String(k.note || '').slice(0, 120), at: now() });
    return { ok: true, amt, bal };
  });
}

/* الدفع من المحفظة لطلب: بحد أقصى نسبة من قيمة الطلب (الشروط: 50%) وبحد المتبقي والرصيد */
async function applyToOrder(uid, oid) {
  const or = db().collection('orders').doc(oid);
  const w = db().collection('wallets').doc(uid);
  return db().runTransaction(async t => {
    const [os, ws] = await Promise.all([t.get(or), t.get(w)]);
    if (!os.exists) return { ok: false, why: 'not_found' };
    const o = os.data();
    if (o.uid !== uid) return { ok: false, why: 'not_found' };
    if (o.st !== 'new') return { ok: false, why: 'closed' };
    const total = Number(o.price) || Number(o.est) || 0;
    const paid = Number(o.paid) || 0;
    const due = Math.max(0, (Number(o.dep) || total) - paid);
    const pays = Array.isArray(o.pays) ? o.pays : [];
    const usedW = pays.filter(p => p && p.m === 'wallet').reduce((s, p) => s + (Number(p.amt) || 0), 0);
    const cap = Math.max(0, Math.floor(total * MAX_PCT() / 100) - usedW);
    const bal = (ws.exists && ws.data().bal) || 0;
    const amt = r2(Math.min(bal, due, cap));
    if (!(amt > 0)) return { ok: true, amt: 0, due, bal };
    const id = 'w-' + oid + '-' + (pays.length + 1);
    t.update(or, { paid: r2(paid + amt), paidAt: now(), pays: pays.concat([{ id, amt, m: 'wallet', at: now() }]) });
    t.set(w, { bal: r2(bal - amt), at: now() }, { merge: true });
    t.set(w.collection('tx').doc(id), { amt: -amt, type: 'spend', ref: oid, note: o.no ? 'طلب رقم ' + o.no : 'طلب', at: now() });
    return { ok: true, amt, due: r2(due - amt), bal: r2(bal - amt), paid: r2(paid + amt) };
  });
}

/* إلغاء طلب ما اكتمل دفعه: اللي انخصم من المحفظة يرجع لها. ما يلغي طلب فيه دفعة بطاقة */
async function cancelWithRefund(oid, by, uid, why) {
  const or = db().collection('orders').doc(oid);
  return db().runTransaction(async t => {
    const os = await t.get(or);
    if (!os.exists) return { ok: false, why: 'not_found' };
    const o = os.data();
    if (uid && o.uid !== uid) return { ok: false, why: 'not_found' };
    if (o.st !== 'new') return { ok: false, why: 'closed' };
    const pays = Array.isArray(o.pays) ? o.pays : [];
    if (pays.some(p => p && p.m !== 'wallet')) return { ok: false, why: 'card_paid' };
    const back = r2(pays.reduce((s, p) => s + (Number(p.amt) || 0), 0));
    let sref = null, cur = 0;
    if (o.date && /^[0-9-]{8,12}$/.test(o.date) && ['am', 'pm', 'ev'].includes(o.slot)) {
      sref = db().collection('slots').doc(o.date);
      const sd = await t.get(sref);
      cur = (sd.exists && Number(sd.data()[o.slot])) || 0;
    }
    const w = db().collection('wallets').doc(o.uid);
    const ws = back > 0 ? await t.get(w) : null;
    const h = { s: 'cancelled', at: now(), by: by || 'customer' };
    if (why) h.why = why;
    const hist = (Array.isArray(o.hist) ? o.hist : []).concat([h]);
    t.update(or, { st: 'cancelled', hist, paid: 0 });
    if (sref && cur > 0) t.update(sref, { [o.slot]: cur - 1 });
    if (back > 0) {
      t.set(w, { bal: r2(((ws && ws.exists && ws.data().bal) || 0) + back), at: now() }, { merge: true });
      t.set(w.collection('tx').doc('refund-' + oid), { amt: back, type: 'refund', ref: oid, note: o.no ? 'إلغاء طلب رقم ' + o.no : 'إلغاء طلب', at: now() });
    }
    return { ok: true, refunded: back };
  });
}

async function createCode(d) {
  const c = normCode(d.code) || ('KLN' + Math.random().toString(36).slice(2, 8).toUpperCase());
  const amt = r2(d.amt);
  if (!(amt > 0 && amt <= 5000)) return { ok: false, why: 'bad_amount' };
  const ref = db().collection('codes').doc(c);
  try {
    await ref.create({ amt, uses: Math.max(1, Math.min(10000, Math.floor(Number(d.uses) || 1))), used: 0,
      exp: /^\d{4}-\d{2}-\d{2}$/.test(String(d.exp || '')) ? d.exp : '', on: true, by: {}, note: String(d.note || '').slice(0, 120), at: now() });
  } catch (e) { if (e && (e.code === 6 || /already exists/i.test(e.message || ''))) return { ok: false, why: 'exists' }; throw e; }
  return { ok: true, code: c, amt };
}

/* ===== ادعُ صديق =====
   refs/{CODE} {uid}  ·  wallets/{uid}.ref = كوده  ·  wallets/{uid}.refBy = اللي دعاه  ·  refPaid = انصرفت مكافأة الداعي
   refPhones/{ph} = الجوال استفاد من دعوة قبل — مكافأة الصديق مرة وحدة لكل رقم حتى لو سوّى أكثر من حساب */
const REF_FRIEND = () => { const n = Number(process.env.REF_FRIEND); return n >= 0 && n <= 500 ? n : 25; };
const REF_REWARD = () => { const n = Number(process.env.REF_REWARD); return n >= 0 && n <= 500 ? n : 25; };

async function refCode(uid, name) {
  const w = db().collection('wallets').doc(uid);
  const ws = await w.get();
  if (ws.exists && ws.data().ref) return ws.data().ref;
  const base = String(name || '').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 5);
  for (let i = 0; i < 6; i++) {
    const c = (base.length >= 3 ? base : 'KLN') + Math.random().toString(36).slice(2, 6).toUpperCase().replace(/[^A-Z0-9]/g, '7');
    try {
      await db().runTransaction(async t => {
        const r = db().collection('refs').doc(c);
        const [rs, w2] = await Promise.all([t.get(r), t.get(w)]);
        if (w2.exists && w2.data().ref) throw Object.assign(new Error('has'), { has: w2.data().ref });
        if (rs.exists) throw new Error('taken');
        t.create(r, { uid, at: now() });
        t.set(w, { ref: c, at: now() }, { merge: true });
      });
      return c;
    } catch (e) { if (e.has) return e.has; if (e.message !== 'taken') throw e; }
  }
  throw new Error('ref_code');
}

/* الصديق يستخدم كود الدعوة: رصيد له، وتسجيل الداعي عشان يكافأ بعد أول دفع */
async function refRedeem(uid, code) {
  const c = normCode(code);
  const rr = db().collection('refs').doc(c);
  const w = db().collection('wallets').doc(uid);
  const cu = db().collection('customers').doc(uid);
  /* طلبات العميل بفلتر واحد (ما يحتاج فهرس مركّب)، والمدفوع نفحصه هنا */
  const paidQ = db().collection('orders').where('uid', '==', uid).limit(50);
  return db().runTransaction(async t => {
    const [rs, ws, cs, ps] = await Promise.all([t.get(rr), t.get(w), t.get(cu), t.get(paidQ)]);
    if (!rs.exists) return { ok: false, why: 'not_found' };
    const owner = rs.data().uid;
    if (owner === uid) return { ok: false, why: 'own_ref' };
    const wv = ws.exists ? ws.data() : {};
    if (wv.refBy) return { ok: false, why: 'ref_used' };
    if (ps.docs.some(d => Number(d.data().paid) > 0)) return { ok: false, why: 'not_new' };
    const ph = cs.exists ? String(cs.data().ph || '') : '';
    if (!/^9665\d{8}$/.test(ph)) return { ok: false, why: 'need_phone' };
    const pr = db().collection('refPhones').doc(ph);
    const prs = await t.get(pr);
    if (prs.exists) return { ok: false, why: 'ref_used' };
    const amt = r2(REF_FRIEND());
    const bal = r2((Number(wv.bal) || 0) + amt);
    t.set(pr, { uid, by: owner, at: now() });
    t.set(w, { bal, refBy: owner, at: now() }, { merge: true });
    if (amt > 0) t.set(w.collection('tx').doc('ref-in'), { amt, type: 'ref', ref: c, note: 'هدية دعوة صديق', at: now() });
    return { ok: true, amt, bal, ref: true };
  });
}

/* بعد أول طلب مدفوع للصديق: مكافأة الداعي مرة وحدة */
async function refReward(friendUid) {
  const fw = db().collection('wallets').doc(friendUid);
  return db().runTransaction(async t => {
    const fs = await t.get(fw);
    if (!fs.exists) return { ok: false };
    const f = fs.data();
    if (!f.refBy || f.refPaid) return { ok: false };
    const ow = db().collection('wallets').doc(f.refBy);
    const os = await t.get(ow);
    const amt = r2(REF_REWARD());
    t.set(fw, { refPaid: now() }, { merge: true });
    if (amt > 0) {
      t.set(ow, { bal: r2(((os.exists && os.data().bal) || 0) + amt), at: now() }, { merge: true });
      t.set(ow.collection('tx').doc('ref-' + friendUid), { amt, type: 'ref', ref: '', note: 'مكافأة دعوة صديق — أول طلب له', at: now() });
    }
    return { ok: true, amt, to: f.refBy };
  });
}

module.exports = { refCode, refRedeem, refReward, REF_FRIEND, REF_REWARD, credit, redeem, applyToOrder, cancelWithRefund, createCode, normCode, MAX_PCT, r2 };
