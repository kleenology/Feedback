'use strict';
/* POST /api/inv  {order}  —  Authorization: Bearer <رمز فايربيس للعميل أو الأدمن>
   يرجّع ملف الفاتورة (PDF) من «الأستاذ» عبر خادمنا — العميل يشوف فاتورته داخل التطبيق
   بدون ما يطلع له رابط الأستاذ أو اسمه.

   الأمان: صاحب الطلب أو الأدمن بس، والرابط لازم يكون رابط مشاركة فاتورة على حسابك في الأستاذ
   (نفس دومين OSTAZ_URL) — ما نجيب أي رابط ثاني حتى لو انكتب في الطلب. */
const U = require('./_lib/util');
const S = require('./_lib/store');

const MAX = 4 * 1024 * 1024;

function allowed(url) {
  let u, base;
  try { u = new URL(String(url || '')); base = new URL(String(process.env.OSTAZ_URL || '')); } catch (e) { return false; }
  return u.protocol === 'https:' && u.host === base.host && /^\/b\/share\/invoice\/\d+\/\d+\/[A-Za-z0-9]+$/.test(u.pathname);
}

module.exports = async function handler(req, res) {
  if (U.cors(req, res)) return;
  if (req.method !== 'POST') return U.json(res, 405, { error: 'method' });
  const auth = String(req.headers.authorization || '');
  const tok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  let id;
  try { const b = await U.readBody(req); id = String((b && b.order) || '').trim(); }
  catch (e) { return U.json(res, 400, { error: 'bad_request' }); }
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return U.json(res, 400, { error: 'bad_order' });

  let uid = '', admin = false;
  try { uid = await S.userUid(tok); } catch (e) { uid = ''; }
  if (!uid) return U.json(res, 401, { error: 'auth' });

  let o;
  try { o = await S.getOrder(id); } catch (e) { return U.json(res, 500, { error: 'db' }); }
  if (o && o.uid !== uid) { try { admin = !!(await S.adminUid(tok)); } catch (e) { admin = false; } }
  if (!o || (o.uid !== uid && !admin)) return U.json(res, 404, { error: 'not_found' });
  const url = o.ostaz && o.ostaz.url;
  if (!allowed(url)) return U.json(res, 404, { error: 'no_invoice' });

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { headers: { Accept: 'application/pdf' }, signal: ctl.signal });
    const type = String(r.headers.get('content-type') || '');
    if (!r.ok || !/application\/pdf/i.test(type)) return U.json(res, 502, { error: 'upstream', status: r.status });
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX || buf.slice(0, 5).toString() !== '%PDF-') return U.json(res, 502, { error: 'bad_pdf' });
    const name = 'kleenology-' + String((o.ostaz && o.ostaz.code) || o.no || 'invoice').replace(/[^A-Za-z0-9-]/g, '') + '.pdf';
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="' + name + '"');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(buf);
  } catch (e) {
    console.error('inv:', (e && e.message) || e);
    return U.json(res, 502, { error: 'upstream' });
  } finally { clearTimeout(t); }
};
