'use strict';
/* عرض الفاتورة عبر خادمنا: صاحب الطلب أو الأدمن بس، ورابط الأستاذ وحده — بلا شبكة */
process.env.OSTAZ_URL = 'https://kleenology.alostaz.io/b/api';
const storePath = require.resolve('../api/_lib/store.js');
let ORD = {}, FETCHED = [];
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: {
  async userUid(t) { if (!{ u1: 1, u2: 1, adm: 1 }[t]) throw new Error('x'); return t; },
  async adminUid(t) { return t === 'adm' ? 'adm' : ''; },
  async getOrder(id) { return ORD[id] || null; }
} };
global.fetch = async (url) => { FETCHED.push(url);
  const pdf = /good/.test(url);
  return { ok: true, status: 200, headers: { get: () => pdf ? 'application/pdf' : 'text/html' },
    arrayBuffer: async () => Buffer.from(pdf ? '%PDF-1.4 test' : '<html>') }; };
const inv = require('../api/inv');
function call(body, tok) {
  const req = { method: 'POST', headers: { origin: 'https://app.kleenology.me' }, body };
  if (tok) req.headers.authorization = 'Bearer ' + tok;
  return new Promise(r => { const H = {}; const res = { statusCode: 200, setHeader(k, v) { H[k] = v; },
    end(b) { r({ status: this.statusCode, type: H['Content-Type'], body: Buffer.isBuffer(b) ? b.toString() : b, H }); } }; inv(req, res); });
}
let pass = 0, fail = 0;
const t = async (n, fn) => { try { await fn(); console.log('✓ ' + n); pass++; } catch (e) { console.log('✗ ' + n + ' — ' + e.message); fail++; } };
const eq = (a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(JSON.stringify(a) + ' ≠ ' + JSON.stringify(b)); };
const U = 'https://kleenology.alostaz.io/b/share/invoice/238/6/good8d37';
(async () => {
  ORD = { o1: { uid: 'u1', no: 1050, ostaz: { url: U, code: 'INV-26-1-000071' } },
          o2: { uid: 'u1', ostaz: { url: 'https://evil.test/b/share/invoice/1/6/good' } },
          o3: { uid: 'u1', ostaz: { url: 'https://kleenology.alostaz.io/b/api/invoices/1?good' } },
          o4: { uid: 'u1', ostaz: { url: 'https://kleenology.alostaz.io/b/share/invoice/9/6/html9' } } };
  await t('صاحب الطلب: يستلم الـPDF من خادمنا', async () => {
    const r = await call({ order: 'o1' }, 'u1');
    eq([r.status, r.type, r.body.slice(0, 5)], [200, 'application/pdf', '%PDF-']);
    if (!/kleenology-INV-26-1-000071\.pdf/.test(r.H['Content-Disposition'])) throw new Error(r.H['Content-Disposition']);
  });
  await t('عميل ثاني: 404', async () => { eq((await call({ order: 'o1' }, 'u2')).status, 404); });
  await t('الأدمن: يقدر يشوفها', async () => { eq((await call({ order: 'o1' }, 'adm')).status, 200); });
  await t('بلا دخول: 401', async () => { eq((await call({ order: 'o1' })).status, 401); });
  await t('رابط خارج الأستاذ أو مو رابط مشاركة: ما ينجاب', async () => {
    FETCHED = [];
    eq((await call({ order: 'o2' }, 'u1')).status, 404); eq((await call({ order: 'o3' }, 'u1')).status, 404); eq(FETCHED, []);
  });
  await t('رد مو PDF: 502', async () => { eq((await call({ order: 'o4' }, 'u1')).status, 502); });
  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})();
