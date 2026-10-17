// "Aprobar dispositivo" login (Netflix/Smart-TV style): a device types a name and
// asks for access; it shows a 2-digit code; an admin approves it from the panel
// (or the CLI) and the device gets a long-lived session. No passwords at all.
import crypto from 'node:crypto';
import { db, now } from './db.js';
import { config } from './config.js';
import { createSession, sha256 } from './auth.js';
import { createUser, getUser, UserError } from './users.js';

export class AccessError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** Case- and accent-insensitive form used to match typed names to people. */
export function nameKey(s) {
  return String(s || '').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function deviceFromUA(ua = '') {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : 'Dispositivo';
  const br = /EdgA?\//.test(ua) ? 'Edge' : /SamsungBrowser\//.test(ua) ? 'Samsung Internet' : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox'
    : /CriOS\/|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari'
    : /iPhone|iPad/.test(ua) ? 'app de inicio' : '';
  return br ? `${os} · ${br}` : os;
}

function findUserByLooseName(name) {
  const key = nameKey(name);
  return db.prepare('SELECT id, display_name, username FROM users').all()
    .find((u) => nameKey(u.display_name) === key || nameKey(u.username) === key) || null;
}

function expireOld() {
  db.prepare("UPDATE access_requests SET status = 'expired' WHERE status = 'pending' AND expires_at < ?").run(now());
}

function pickCode() {
  const used = new Set(db.prepare("SELECT code FROM access_requests WHERE status = 'pending'").all().map((r) => r.code));
  const free = [];
  for (let c = 10; c <= 99; c++) if (!used.has(c)) free.push(c);
  if (!free.length) throw new AccessError('Hay demasiados pedidos esperando. Probá en un rato.', 429);
  return free[crypto.randomInt(free.length)];
}

/** Admins' names from the database, to say "Avisale a Ana o Luis" (null if none). */
export function adminName() {
  const names = db.prepare('SELECT display_name FROM users WHERE is_admin = 1 ORDER BY created_at LIMIT 3').all().map((r) => r.display_name);
  if (!names.length) return null;
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} o ${names.at(-1)}`;
}

const WINDOW = 10 * 60_000;

/** Creates a pending request. Returns { secret, request }. */
export function createRequest(name, { ip, ua }) {
  expireOld();
  const display = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!nameKey(display)) throw new AccessError('Escribí tu nombre.');
  const since = now() - WINDOW;
  const byIp = db.prepare("SELECT COUNT(*) n FROM access_requests WHERE ip = ? AND created_at > ? AND status = 'pending'").get(ip, since).n;
  if (byIp >= 5) throw new AccessError('Hay demasiados pedidos desde esta red. Esperá unos minutos.', 429);
  const byName = db.prepare("SELECT name FROM access_requests WHERE created_at > ? AND status IN ('pending', 'rejected')").all(since)
    .filter((r) => nameKey(r.name) === nameKey(display)).length;
  if (byName >= 5) throw new AccessError('Ya hay muchos pedidos con ese nombre. Esperá unos minutos.', 429);

  const match = findUserByLooseName(display);
  const secret = crypto.randomBytes(32).toString('base64url');
  const t = now();
  const auto = match && canAutoApprove(match.id, display, ip);
  const row = db.prepare(`INSERT INTO access_requests (secret_hash, name, user_id, code, device, ip, created_at, expires_at,
      status, approved_user_id, auto_approved, decided_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`).get(
    sha256(secret), display, match?.id ?? null, pickCode(), deviceFromUA(ua), ip, t, t + config.accessRequestMinutes * 60_000,
    auto ? 'approved' : 'pending', auto ? match.id : null, auto ? 1 : 0, auto ? t : null);
  return { secret, request: row };
}

/**
 * Same phone, another browser (or the installed app, which has its own storage):
 * an EXISTING person asking from the same IP where they already have a device
 * session used in the last SHAREIT_AUTO_APPROVE_DAYS days gets in right away.
 * Never for new people, never as someone else, and not if a request for that
 * name from that IP was rejected in the last 24 h.
 */
function canAutoApprove(userId, name, ip) {
  const days = config.autoApproveDays;
  if (!(days > 0) || !ip) return false;
  const t = now();
  const rejected = db.prepare("SELECT name FROM access_requests WHERE ip = ? AND status = 'rejected' AND decided_at > ?")
    .all(ip, t - 24 * 3600_000).some((r) => nameKey(r.name) === nameKey(name));
  if (rejected) return false;
  return !!db.prepare(`SELECT 1 FROM sessions WHERE user_id = ? AND auth_method = 'device' AND last_ip = ?
    AND expires_at > ? AND last_used_at > ? LIMIT 1`).get(userId, ip, t, t - days * 86400_000);
}

export function requestBySecret(secret) {
  if (!secret) return null;
  expireOld();
  return db.prepare('SELECT * FROM access_requests WHERE secret_hash = ?').get(sha256(secret)) || null;
}

/**
 * Called by the waiting device. When approved, turns the request into a device
 * session exactly once and returns its token.
 */
export function claimApproved(secret) {
  const r = requestBySecret(secret);
  if (!r || r.status !== 'approved') return null;
  const claimed = db.prepare("UPDATE access_requests SET status = 'consumed' WHERE id = ? AND status = 'approved'").run(r.id);
  if (Number(claimed.changes) !== 1) return null;
  return {
    userId: r.approved_user_id,
    autoApproved: !!r.auto_approved,
    token: createSession(r.approved_user_id, null, { method: 'device', deviceName: r.device, ip: r.ip, autoApproved: !!r.auto_approved }),
  };
}

export function cancelRequest(secret) {
  const r = requestBySecret(secret);
  if (r && r.status === 'pending') db.prepare("UPDATE access_requests SET status = 'cancelled' WHERE id = ?").run(r.id);
}

// ---------------------------------------------------------------- admin side
export function listPending() {
  expireOld();
  return db.prepare(`SELECT r.*, u.display_name AS matched_name FROM access_requests r
    LEFT JOIN users u ON u.id = r.user_id WHERE r.status = 'pending' ORDER BY r.created_at`).all().map((r) => ({
    id: r.id, name: r.name, code: r.code, device: r.device, createdAt: r.created_at, expiresAt: r.expires_at,
    isNew: r.user_id == null, userId: r.user_id, matchedName: r.matched_name || null,
  }));
}

/** `ref` = { id } or { code } (codes are unique among pending requests). */
function pendingBy(ref) {
  expireOld();
  const r = ref.code != null
    ? db.prepare("SELECT * FROM access_requests WHERE status = 'pending' AND code = ?").get(Number(ref.code))
    : db.prepare("SELECT * FROM access_requests WHERE status = 'pending' AND id = ?").get(Number(ref.id));
  if (!r) throw new AccessError('Ese pedido no existe o ya venció.', 404);
  return r;
}

/**
 * Approves a request. `asUserId` approves it as another existing person (typos);
 * otherwise the matched person, or a new person is created with the typed name.
 */
export function approveRequest(ref, { asUserId = null, isAdmin = false, by = null } = {}) {
  const r = pendingBy(ref);
  let userId = asUserId ?? r.user_id;
  let created = false;
  if (userId != null) {
    try { getUser(userId); } catch { throw new AccessError('Esa persona no existe.', 404); }
  } else {
    try {
      userId = createUser(r.name, null, { isAdmin }).id;
      created = true;
    } catch (e) {
      if (e instanceof UserError) throw new AccessError(e.message, e.status);
      throw e;
    }
  }
  const ok = db.prepare(`UPDATE access_requests SET status = 'approved', approved_user_id = ?, decided_by = ?, decided_at = ?
    WHERE id = ? AND status = 'pending'`).run(userId, by, now(), r.id);
  if (Number(ok.changes) !== 1) throw new AccessError('Ese pedido ya se resolvió.', 409);
  return { request: r, userId, created };
}

export function rejectRequest(ref, { by = null } = {}) {
  const r = pendingBy(ref);
  db.prepare("UPDATE access_requests SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
    .run(by, now(), r.id);
  return r;
}

/** Device sessions of a person, for the "Dispositivos" list. */
export function listDevices(userId) {
  return db.prepare(`SELECT rowid AS id, device_name, auth_method, auto_approved, created_at, last_used_at FROM sessions
    WHERE user_id = ? AND expires_at > ? ORDER BY COALESCE(last_used_at, created_at) DESC`).all(userId, now()).map((s) => ({
    id: s.id, name: s.device_name || (s.auth_method === 'passkey' ? 'Passkey' : s.auth_method === 'pin' ? 'Ingreso con PIN' : 'Dispositivo'),
    method: s.auth_method || 'pin', approvedAt: s.created_at, lastUsedAt: s.last_used_at, autoApproved: !!s.auto_approved,
  }));
}

export function disconnectDevice(sessionRowId) {
  const r = db.prepare('DELETE FROM sessions WHERE rowid = ?').run(Number(sessionRowId));
  if (!Number(r.changes)) throw new AccessError('Ese dispositivo ya no está conectado.', 404);
}

/** Auto-approved entries of the last `hours`, so admins notice them (toast + panel list). */
export function recentAutoApprovals(hours = 24) {
  return db.prepare(`SELECT r.id, r.name, r.device, r.decided_at, u.display_name FROM access_requests r
    LEFT JOIN users u ON u.id = r.approved_user_id
    WHERE r.auto_approved = 1 AND r.decided_at > ? ORDER BY r.decided_at DESC LIMIT 20`).all(now() - hours * 3600_000)
    .map((r) => ({ id: r.id, name: r.display_name || r.name, device: r.device, at: r.decided_at }));
}
