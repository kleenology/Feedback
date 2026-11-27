'use strict';
/* المحفظة على محاكي Firestore (يحتاج firebase-admin والمحاكي):
   FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 node test/wallet.emu.js
   شحن، كود (مرة لكل عميل، وحد الاستخدامات، والانتهاء)، الدفع من المحفظة بحد 50%، الإلغاء والاسترجاع، وما يصير الرصيد سالب */
const path = require('path');
const admin = require(process.env.ADMIN_PATH || 'firebase-admin');
admin.initializeApp({ projectId: 'kln-test' });
const storePath = require.resolve(path.join(__dirname, '../api/_lib/store.js'));
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: { app: () => admin } };
const W = require('../api/_lib/wallet');
const db = admin.firestore();

let pass = 0, fail = 0;
const t = async (n, fn) => { try { await fn(); console.log('✓ ' + n); pass++; } catch (e) { console.log('✗ ' + n + ' — ' + e.message); fail++; } };
const eq = (a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(JSON.stringify(a) + ' ≠ ' + JSON.stringify(b)); };
const bal = async u => ((await db.doc('wallets/' + u).get()).data() || {}).bal || 0;

(async () => {
  const U1 = 'u1_' + Date.now(), U2 = 'u2_' + Date.now();
  await t('شحن: ينضاف الرصيد، ونفس العملية ما تنحسب مرتين', async () => {
    await W.credit(U1, 200, 'topup', 'chg_1', 'شحن', 'tap-chg_1');
    const r = await W.credit(U1, 200, 'topup', 'chg_1', 'شحن', 'tap-chg_1');
    eq([r.already, await bal(U1)], [true, 200]);
  });
  await t('الرصيد ما يصير سالب', async () => {
    const r = await W.credit(U1, -500, 'admin', 'x', 'خصم');
    eq([r.ok, r.why, await bal(U1)], [false, 'insufficient', 200]);
  });
  await t('كود: يضيف قيمته مرة وحدة لكل عميل، ويوقف عند انتهاء الاستخدامات', async () => {
    const c = await W.createCode({ code: 'GIFT' + Date.now() % 100000, amt: 50, uses: 1 });
    eq(c.ok, true);
    eq((await W.redeem(U1, c.code.toLowerCase())).amt, 50);
    eq((await W.redeem(U1, c.code)).why, 'used');
    eq((await W.redeem(U2, c.code)).why, 'finished');
    eq(await bal(U1), 250);
  });
  await t('كود منتهي أو موقوف أو غلط يُرفض', async () => {
    const c = await W.createCode({ amt: 30, uses: 5, exp: '2020-01-01' });
    eq((await W.redeem(U2, c.code)).why, 'expired');
    const d = await W.createCode({ amt: 30, uses: 5 }); await db.doc('codes/' + d.code).update({ on: false });
    eq((await W.redeem(U2, d.code)).why, 'off');
    eq((await W.redeem(U2, 'NOPE-123')).why, 'not_found');
  });
  await t('الدفع من المحفظة: بحد 50% من الطلب', async () => {
    const oid = 'o' + Date.now();
    await db.doc('orders/' + oid).set({ uid: U1, st: 'new', est: 400, dep: 400, no: 1200 });
    const r = await W.applyToOrder(U1, oid);
    eq([r.amt, r.due, await bal(U1)], [200, 200, 50]);
    const o = (await db.doc('orders/' + oid).get()).data();
    eq([o.paid, o.pays.length, o.pays[0].m], [200, 1, 'wallet']);
    eq((await W.applyToOrder(U1, oid)).amt, 0);   /* وصل الحد */
  });
  await t('عميل ثاني ما يقدر يدفع من محفظته لطلب غيره', async () => {
    const oid = 'x' + Date.now();
    await db.doc('orders/' + oid).set({ uid: U1, st: 'new', est: 400, dep: 400 });
    eq((await W.applyToOrder(U2, oid)).why, 'not_found');
  });
  await t('إلغاء طلب ما اكتمل دفعه: الرصيد يرجع والموعد يتحرر', async () => {
    const oid = 'c' + Date.now();
    await db.doc('slots/2030-01-01').set({ am: 1 });
    await db.doc('orders/' + oid).set({ uid: U1, st: 'new', est: 100, dep: 100, date: '2030-01-01', slot: 'am' });
    await W.credit(U1, 50, 'admin', 'x', 'هدية');
    const b0 = await bal(U1);
    eq((await W.applyToOrder(U1, oid)).amt, 50);
    const r = await W.cancelWithRefund(oid, 'auto', null, 'unpaid');
    eq([r.ok, r.refunded, await bal(U1), ((await db.doc('slots/2030-01-01').get()).data()).am], [true, 50, b0, 0]);
    const o = (await db.doc('orders/' + oid).get()).data();
    eq([o.st, o.paid, o.hist.at(-1).why], ['cancelled', 0, 'unpaid']);
  });
  await t('طلب فيه دفعة بطاقة ما ينلغى بالاسترجاع', async () => {
    const oid = 'k' + Date.now();
    await db.doc('orders/' + oid).set({ uid: U1, st: 'new', est: 100, dep: 100, paid: 100, pays: [{ m: 'tap', amt: 100 }] });
    eq((await W.cancelWithRefund(oid, 'customer', U1)).why, 'card_paid');
  });
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
