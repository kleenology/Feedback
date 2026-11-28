'use strict';
/* إشعارات الآيفون على محاكي Firestore:
   FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 node test/push.emu.js
   نص الإشعار لكل حالة، توقيع رمز آبل (ES256)، تسجيل الجهاز ونقله بين الحسابات، والإرسال وحذف الرموز الميتة */
const path = require('path');
const crypto = require('crypto');
const admin = require(process.env.ADMIN_PATH || 'firebase-admin');
admin.initializeApp({ projectId: 'kln-test' });
const storePath = require.resolve(path.join(__dirname, '../api/_lib/store.js'));
const orders = {};
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: { app: () => admin, getOrder: async (id) => orders[id] || null } };
const P = require('../api/_lib/push');
const db = admin.firestore();

let pass = 0, fail = 0;
const t = async (n, fn) => { try { await fn(); console.log('✓ ' + n); pass++; } catch (e) { console.log('✗ ' + n + ' — ' + e.message); fail++; } };
const eq = (a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(JSON.stringify(a) + ' ≠ ' + JSON.stringify(b)); };
const tok = (c) => c.repeat(64);
const toks = async (u) => ((await db.doc('push/' + u).get()).data() || {}).tokens || [];

(async () => {
  await t('نص الإشعار: مؤكد فيه الموعد، والحالات بدون إشعار ترجع null', async () => {
    eq(P.statusMsg({ st: 'confirmed', date: '2026-12-03', slot: 'am' }).b, 'موعدك الخميس 3/12 الصباح — نشوفك على خير');
    eq(P.statusMsg({ st: 'on_way' }).t, 'الفريق في الطريق 🚐');
    eq(P.statusMsg({ st: 'new' }), null);
  });
  await t('رمز آبل: ES256 يتحقق بالمفتاح العام، ويتجدد بعد ٥٠ دقيقة', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const c = { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), kid: 'KEY1234567', team: 'TEAM123456' };
    P._reset();
    const j = P.jwt(c, 1e12), [h, p, s] = j.split('.');
    eq(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'KEY1234567' });
    eq(JSON.parse(Buffer.from(p, 'base64url')).iss, 'TEAM123456');
    eq(crypto.verify('sha256', Buffer.from(h + '.' + p), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), true);
    eq(P.jwt(c, 1e12 + 60000), j);
    if (P.jwt(c, 1e12 + 51 * 60000) === j) throw new Error('ما تجدد');
  });
  const A = 'a_' + Date.now(), B = 'b_' + Date.now();
  await t('تسجيل: رمز غلط يُرفض، والصحيح ينحفظ مرة وحدة', async () => {
    eq((await P.register(A, 'xyz')).why, 'bad_token');
    await P.register(A, tok('a')); await P.register(A, tok('A'));
    eq(await toks(A), [tok('a')]);
  });
  await t('نفس الجهاز دخل بحساب ثاني: ينتقل له وينشال من الأول', async () => {
    await P.register(A, tok('b'));
    await P.register(B, tok('b'));
    eq([await toks(A), await toks(B)], [[tok('a')], [tok('b')]]);
  });
  await t('الإرسال لكل أجهزة العميل، والرمز الميت (410) ينحذف', async () => {
    await P.register(A, tok('c'));
    const got = [];
    const send = async (c, token, body) => { got.push([token, body.aps.alert.title, body.oid]); return token === tok('c') ? { ok: false, status: 410, reason: 'Unregistered' } : { ok: true, status: 200 }; };
    orders.o1 = { uid: A, st: 'on_way', no: 12 };
    const r = await P.orderStatus('o1', send);
    eq([r.sent, got.length, got[0][1], got[0][2]], [1, 2, 'الفريق في الطريق 🚐', 'o1']);
    eq(await toks(A), [tok('a')]);
  });
  await t('بدون مفاتيح آبل: ما يرسل ولا يطيح', async () => {
    orders.o2 = { uid: A, st: 'done' };
    eq((await P.orderStatus('o2')).why, 'not_configured');
    eq((await P.orderStatus('nope')).why, 'not_found');
  });
  await t('إلغاء التسجيل عند الخروج', async () => {
    await P.unregister(A, tok('a'));
    eq(await toks(A), []);
  });
  console.log('\n' + pass + ' ناجح، ' + fail + ' فاشل');
  process.exit(fail ? 1 : 0);
})();
