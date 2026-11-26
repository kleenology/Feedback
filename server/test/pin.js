'use strict';
/* رمز الدخول المؤقت: الإنشاء، التحقق، القفل بعد ٥ أخطاء، والرموز السهلة — بلا شبكة */
process.env.ALLOWED_ORIGINS = 'https://kleenology.github.io';
const storePath = require.resolve('../api/_lib/store.js');
let DB = {};
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: {
  async getPin(p) { return DB[p] ? Object.assign({}, DB[p]) : null; },
  async createPin(p, r) { if (DB[p]) return false; DB[p] = r; return true; },
  async updatePin(p, x) { Object.assign(DB[p], x); },
  async customToken(p) { return 'tok-' + p; }
} };
const login = require('../api/pin/login.js');
const status = require('../api/pin/status.js');
const P = require('../api/_lib/pin.js');

const call = (fn, body, origin) => new Promise(resolve => {
  const req = { method: 'POST', headers: { origin: origin === undefined ? 'https://kleenology.github.io' : origin }, body };
  const res = { statusCode: 200, setHeader() {}, end(s) { resolve({ status: this.statusCode, body: s ? JSON.parse(s) : null }); } };
  fn(req, res);
});
let pass = 0, fail = 0;
const t = async (n, fn) => { try { await fn(); console.log('✓ ' + n); pass++; } catch (e) { console.log('✗ ' + n + ' — ' + e.message); fail++; } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || '') + ' ' + JSON.stringify(a) + ' ≠ ' + JSON.stringify(b)); };
const PH = '966555555555';

(async () => {
  await t('رقم جديد: status=false، والإنشاء يعطي رمز دخول بهوية ph_', async () => {
    DB = {};
    eq((await call(status, { phone: '0555555555' })).body, { exists: false });
    const r = await call(login, { phone: '0555555555', pin: '482915', create: true });
    eq([r.status, r.body.token], [200, 'tok-' + PH]);
    eq((await call(status, { phone: '+966555555555' })).body, { exists: true });
  });

  await t('الرمز ينحفظ مجزّأً بملح — مو صريح', async () => {
    const rec = DB[PH];
    if (JSON.stringify(rec).includes('482915')) throw new Error('الرمز صريح');
    eq(rec.hash, P.hashPin('482915', rec.salt));
  });

  await t('إنشاء رمز لرقم عنده رمز: 409 وما يتغير', async () => {
    const h = DB[PH].hash;
    eq((await call(login, { phone: PH, pin: '739204', create: true })).status, 409);
    eq(DB[PH].hash, h);
  });

  await t('الرموز السهلة مرفوضة', async () => {
    for (const p of ['000000', '111111', '123456', '654321', '121212', '123123', '012345'])
      eq((await call(login, { phone: '966500000009', pin: p, create: true })).body.error, 'weak', p);
    eq(DB['966500000009'], undefined);
  });

  await t('الرمز الصحيح يدخل، والغلط يقول كم باقي', async () => {
    eq((await call(login, { phone: PH, pin: '482915' })).body.token, 'tok-' + PH);
    const r = await call(login, { phone: PH, pin: '111222' });
    eq([r.status, r.body.left], [401, 4]);
  });

  await t('٥ أخطاء = قفل ١٥ دقيقة، حتى الرمز الصحيح ما يمشي وقتها', async () => {
    DB[PH].fails = 0;
    for (let i = 0; i < 4; i++) await call(login, { phone: PH, pin: '111222' });
    const r = await call(login, { phone: PH, pin: '111222' });
    eq([r.status, r.body.error], [429, 'locked']);
    eq((await call(login, { phone: PH, pin: '482915' })).status, 429, 'دخل وهو مقفل');
    DB[PH].lockUntil = Date.now() - 1;
    eq((await call(login, { phone: PH, pin: '482915' })).status, 200, 'ما انفك القفل');
    eq([DB[PH].fails, DB[PH].lockUntil], [0, 0]);
  });

  await t('رقم بلا رمز: 404، ومدخلات غلط: 400، وأصل غريب: 403', async () => {
    eq((await call(login, { phone: '966511111111', pin: '482915' })).body.error, 'no_pin');
    eq((await call(login, { phone: '0412345678', pin: '482915' })).status, 400);
    eq((await call(login, { phone: PH, pin: '12a456' })).status, 400);
    eq((await call(login, { phone: PH, pin: '482915' }, 'https://evil.test')).status, 403);
  });

  console.log('\n' + (fail ? 'ERRORS: ' + fail : 'ERRORS: none'));
  process.exit(fail ? 1 : 0);
})();
