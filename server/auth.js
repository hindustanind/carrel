// Passwords (scrypt), session tokens (HMAC-signed), and desk QR signatures. Node built-ins only.
import crypto from 'node:crypto';

const scrypt = (pw, salt) => new Promise((res, rej) =>
  crypto.scrypt(pw, salt, 32, { N: 16384, r: 8, p: 1 }, (e, k) => e ? rej(e) : res(k)));

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64url')}$${(await scrypt(pw, salt)).toString('base64url')}`;
}
export async function verifyPassword(pw, stored) {
  const [alg, s, h] = String(stored).split('$');
  if (alg !== 'scrypt' || !s || !h) return false;
  const k = await scrypt(pw, Buffer.from(s, 'base64url'));
  const want = Buffer.from(h, 'base64url');
  return want.length === k.length && crypto.timingSafeEqual(want, k);
}

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const mac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

export function signSession(secret, user, ttlSec = 60 * 60 * 12) {
  const body = b64({ uid: user.id, role: user.role, exp: Math.floor(Date.now() / 1000) + ttlSec });
  return `${body}.${mac(secret, body)}`;
}
export function readSession(secret, token) {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const want = mac(secret, body);
  if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  try {
    const s = JSON.parse(Buffer.from(body, 'base64url').toString());
    return s.exp > Date.now() / 1000 ? s : null;
  } catch { return null; }
}

// Desk QR: the printed code carries the seat id plus a truncated HMAC, so codes cannot be forged or edited.
export const qrSig = (secret, seatId) => mac(secret, `seat:${seatId}`).slice(0, 16);
export function verifyQr(secret, seatId, sig) {
  if (!seatId || !sig || typeof sig !== 'string') return false;
  const want = qrSig(secret, seatId);
  return want.length === sig.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig));
}
export const qrUrl = (origin, secret, seatId) => `${origin.replace(/\/$/, '')}/s/${encodeURIComponent(seatId)}?k=${qrSig(secret, seatId)}`;
