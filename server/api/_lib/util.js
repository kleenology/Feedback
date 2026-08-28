'use strict';
const crypto = require('crypto');

/* نفس قواعد norm() في التطبيق — التحقق يتكرر هنا لأن العميل يقدر يتجاوز الواجهة */
function normPhone(v) {
  let d = String(v == null ? '' : v)
    .replace(/[٠-٩]/g, c => c.charCodeAt(0) - 0x0660)
    .replace(/[۰-۹]/g, c => c.charCodeAt(0) - 0x06F0)
    .replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('966')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  return d.length === 9 && d[0] === '5' ? '966' + d : '';
}

/* الرمز يُخزّن مجزّأً مع سرّ الخادم — تسريب قاعدة البيانات وحده لا يكفي لانتحال أحد */
function hashCode(code, phone) {
  const secret = process.env.OTP_SECRET || '';
  if (!secret) throw new Error('OTP_SECRET غير مضبوط');
  return crypto.createHmac('sha256', secret).update(phone + ':' + code).digest('hex');
}

function sameHash(a, b) {
  const x = Buffer.from(String(a), 'utf8'), y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function newCode() {
  /* randomInt أفضل من Math.random: الأخير متوقّع ويكفي لتخمين الرموز */
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

const ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://kleenology.github.io,http://localhost:8080,http://127.0.0.1:8080')
  .split(',').map(s => s.trim()).filter(Boolean);

function cors(req, res) {
  const o = req.headers.origin || '';
  if (ORIGINS.includes(o)) res.setHeader('Access-Control-Allow-Origin', o);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return true; }
  if (o && !ORIGINS.includes(o)) { json(res, 403, { error: 'origin' }); return true; }
  return false;
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 4096) throw new Error('body too large');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
}

function clientIp(req) {
  const f = req.headers['x-forwarded-for'];
  return (Array.isArray(f) ? f[0] : String(f || '')).split(',')[0].trim() ||
    (req.socket && req.socket.remoteAddress) || 'unknown';
}

module.exports = { normPhone, hashCode, sameHash, newCode, cors, json, readBody, clientIp };
