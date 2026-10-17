// User management shared by the admin CLI (scripts/admin.js) and the admin API.
// Every function throws UserError with a Spanish, user-facing message.
import fs from 'node:fs';
import path from 'node:path';
import { db, now } from './db.js';
import crypto from 'node:crypto';
import { hashPin, normalizeUsername, validPin } from './auth.js';
import { config } from './config.js';

export class UserError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const PIN_RULE = 'El PIN tiene que ser numérico, de 4 a 12 dígitos.';

function cleanName(name) {
  const display = String(name || '').replace(/\s+/g, ' ').trim();
  const username = normalizeUsername(display);
  if (!username || username.length > 40) throw new UserError('Nombre inválido (1 a 40 caracteres).');
  return { display, username };
}

export function getUser(id) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) throw new UserError('No existe ese usuario.', 404);
  return u;
}

export function findUserByName(name) {
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(normalizeUsername(name));
  if (!u) throw new UserError(`No existe el usuario "${name}".`, 404);
  return u;
}

export const adminCount = () => db.prepare('SELECT COUNT(*) n FROM users WHERE is_admin = 1').get().n;

/** In passkey mode the PIN is optional (people enroll with an invite link). */
export function createUser(name, pin, { isAdmin = false } = {}) {
  const { display, username } = cleanName(name);
  if (pin == null || pin === '') {
    if (config.authMode === 'pin') throw new UserError(PIN_RULE);
    pin = crypto.randomBytes(16).toString('hex'); // unusable random secret
  } else if (!validPin(pin)) throw new UserError(PIN_RULE);
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new UserError(`Ya existe "${display}".`, 409);
  return db.prepare(`INSERT INTO users (username, display_name, pin_hash, is_admin, created_at)
    VALUES (?, ?, ?, ?, ?) RETURNING *`).get(username, display, hashPin(pin), isAdmin ? 1 : 0, now());
}

export function renameUser(id, name) {
  const u = getUser(id);
  const { display, username } = cleanName(name);
  const other = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (other && other.id !== u.id) throw new UserError(`Ya existe "${display}".`, 409);
  db.prepare('UPDATE users SET username = ?, display_name = ? WHERE id = ?').run(username, display, u.id);
  return getUser(u.id);
}

/** Changes the PIN and closes all of that user's sessions. */
export function setPin(id, pin) {
  const u = getUser(id);
  if (!validPin(pin)) throw new UserError(PIN_RULE);
  db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(hashPin(pin), u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  return u;
}

// `force` (CLI only, run on the server) may leave the app without admins.
export function setAdmin(id, isAdmin, { force = false } = {}) {
  const u = getUser(id);
  if (!force && !isAdmin && u.is_admin && adminCount() <= 1) {
    throw new UserError('Tiene que quedar al menos un administrador.', 409);
  }
  db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, u.id);
  return getUser(u.id);
}

const PICKER = { inherit: null, allow: 1, hide: 0 };
/** Per-user model picker override: 'inherit' | 'allow' | 'hide'. */
export function setModelPicker(id, mode) {
  const u = getUser(id);
  if (!(mode in PICKER)) throw new UserError('Valor inválido para "elegir modelo".');
  db.prepare('UPDATE users SET model_picker = ? WHERE id = ?').run(PICKER[mode], u.id);
  return getUser(u.id);
}

/** Closes sessions; `keepSessionHash` keeps the caller's own session alive. */
export function revokeSessions(id, keepSessionHash = null) {
  const u = getUser(id);
  const r = keepSessionHash
    ? db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(u.id, keepSessionHash)
    : db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  return Number(r.changes);
}

/** Deletes the user, their chats, messages, sessions and attachment files. */
export function deleteUser(id, { force = false } = {}) {
  const u = getUser(id);
  if (!force && u.is_admin && adminCount() <= 1) throw new UserError('No se puede borrar al único administrador.', 409);
  const chats = db.prepare('SELECT id, thread_id FROM chats WHERE user_id = ?').all(u.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id); // cascades (turn stats are kept, user_id -> NULL)
  for (const c of chats) {
    fs.rmSync(path.join(config.attachmentsDir, c.id), { recursive: true, force: true });
    if (c.thread_id && /^[\w-]+$/.test(c.thread_id)) {
      fs.rmSync(path.join(config.llmHome, 'generated_images', c.thread_id), { recursive: true, force: true });
    }
  }
  return { user: u, chats: chats.length };
}

/** Rows for the admin user list (metadata only — never chat contents). */
export function listUsers() {
  const t = now();
  return db.prepare(`
    SELECT u.id, u.display_name, u.username, u.is_admin, u.model_picker, u.created_at, u.last_active_at,
      (SELECT COUNT(*) FROM chats c WHERE c.user_id = u.id) AS chats,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS sessions,
      (SELECT COALESCE(SUM(a.size), 0) FROM attachments a JOIN chats c ON c.id = a.chat_id WHERE c.user_id = u.id) AS storage,
      (SELECT MAX(t.created_at) FROM turns t WHERE t.user_id = u.id) AS last_turn_at,
      (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS passkeys,
      (SELECT MAX(i.expires_at) FROM invites i WHERE i.user_id = u.id AND i.used_at IS NULL AND i.expires_at > ?) AS invite_until
    FROM users u ORDER BY u.display_name COLLATE NOCASE`).all(t, t).map((r) => ({
    id: r.id,
    name: r.display_name,
    login: r.username,
    isAdmin: !!r.is_admin,
    modelPicker: r.model_picker == null ? 'inherit' : r.model_picker ? 'allow' : 'hide',
    createdAt: r.created_at,
    lastActiveAt: Math.max(r.last_active_at || 0, r.last_turn_at || 0) || null,
    chats: r.chats,
    sessions: r.sessions,
    storageBytes: r.storage,
    passkeys: r.passkeys,
    inviteUntil: r.invite_until || null,
  }));
}
