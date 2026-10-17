import crypto from 'node:crypto';
import { db, now } from './db.js';
import { config } from './config.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export function normalizeUsername(name) {
  return String(name || '').trim().toLowerCase().normalize('NFC');
}

export function validPin(pin) {
  return /^[0-9]{4,12}$/.test(String(pin || ''));
}

export function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(pin), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPin(pin, stored) {
  try {
    const [algo, N, r, p, saltB64, keyB64] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(keyB64, 'base64');
    const key = crypto.scryptSync(String(pin), Buffer.from(saltB64, 'base64'), expected.length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

// A fixed dummy hash so unknown users take the same time as wrong PINs.
const DUMMY_HASH = hashPin('000000');

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** New session; `passkeyId` links it so deleting that passkey also logs it out. */
export function createSession(userId, passkeyId = null, { method, deviceName = null } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const t = now();
  db.prepare(`INSERT INTO sessions (token_hash, user_id, passkey_id, auth_method, device_name, created_at, last_used_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(sha256(token), userId, passkeyId, method || (passkeyId ? 'passkey' : 'pin'), deviceName, t, t, t + config.sessionDays * 86400_000);
  return token;
}

/** Device mode: only device-approval sessions are accepted; drop PIN/passkey ones. */
export function purgeNonDeviceSessions() {
  return Number(db.prepare("DELETE FROM sessions WHERE COALESCE(auth_method, 'pin') != 'device'").run().changes);
}

/** In passkey mode, sessions opened with a PIN are no longer accepted: drop them. */
export function purgePinSessions() {
  const r = db.prepare("DELETE FROM sessions WHERE COALESCE(auth_method, 'pin') = 'pin'").run();
  return Number(r.changes);
}

export function login(username, pin) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(normalizeUsername(username));
  const ok = verifyPin(pin, user ? user.pin_hash : DUMMY_HASH);
  if (!user || !ok) return null;
  return { token: createSession(user.id), user };
}

export function userFromToken(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.is_admin, u.last_active_at, s.expires_at, s.last_used_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?`).get(sha256(token));
  if (!row) return null;
  if (row.expires_at < now()) {
    logout(token);
    return null;
  }
  // Track "last activity" for the admin panel and slide the session expiry
  // forward (at most once a minute per session).
  const t = now();
  if (!row.last_active_at || t - row.last_active_at > 60_000) {
    db.prepare('UPDATE users SET last_active_at = ? WHERE id = ?').run(t, row.id);
  }
  if (!row.last_used_at || t - row.last_used_at > 60_000) {
    db.prepare('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE token_hash = ?')
      .run(t, t + config.sessionDays * 86400_000, sha256(token));
  }
  return { id: row.id, username: row.username, displayName: row.display_name, isAdmin: !!row.is_admin, sessionHash: sha256(token) };
}

export function logout(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
}

// --- Login rate limiting (in memory) ---------------------------------------
// Max 5 failed attempts per (ip) and per (username) every 15 minutes.
const WINDOW_MS = 15 * 60_000;
const MAX_FAILS = 5;
const fails = new Map(); // key -> { count, first }

function bucket(key) {
  const b = fails.get(key);
  if (!b || now() - b.first > WINDOW_MS) return null;
  return b;
}

export function loginBlocked(ip, username) {
  for (const key of [`ip:${ip}`, `u:${normalizeUsername(username)}`]) {
    const b = bucket(key);
    if (b && b.count >= MAX_FAILS) return Math.ceil((b.first + WINDOW_MS - now()) / 60_000);
  }
  return 0;
}

export function recordLoginFailure(ip, username) {
  for (const key of [`ip:${ip}`, `u:${normalizeUsername(username)}`]) {
    const b = bucket(key);
    if (b) b.count++;
    else fails.set(key, { count: 1, first: now() });
  }
}

export function clearLoginFailures(ip, username) {
  fails.delete(`ip:${ip}`);
  fails.delete(`u:${normalizeUsername(username)}`);
}

setInterval(() => {
  for (const [k, b] of fails) if (now() - b.first > WINDOW_MS) fails.delete(k);
}, 60_000).unref();

// --- Generic fixed-window rate limiter (in memory) ---------------------------
const buckets = new Map(); // key -> { count, first, windowMs }

/** Returns minutes to wait if `key` exceeded `max` hits in `windowMs`, else 0 (and counts the hit). */
export function rateLimit(key, max, windowMs) {
  const t = now();
  let b = buckets.get(key);
  if (!b || t - b.first > windowMs) { b = { count: 0, first: t, windowMs }; buckets.set(key, b); }
  b.count++;
  return b.count > max ? Math.max(1, Math.ceil((b.first + windowMs - t) / 60_000)) : 0;
}

setInterval(() => {
  const t = now();
  for (const [k, b] of buckets) if (t - b.first > b.windowMs) buckets.delete(k);
}, 60_000).unref();
