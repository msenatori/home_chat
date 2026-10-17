// Passkeys (WebAuthn) with discoverable credentials: login is just
// "Entrar con passkey", no username. New devices are enrolled through
// one-time invite links created by an admin (or the CLI).
import crypto from 'node:crypto';
import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { db, now } from './db.js';
import { config } from './config.js';
import { sha256 } from './auth.js';

export class PasskeyError extends Error {
  /** `reason` = short machine-readable cause for the server log (never secrets). */
  constructor(message, status = 400, reason = null) { super(message); this.status = status; this.reason = reason; }
}

const CHALLENGE_TTL = 5 * 60_000;

// Challenges live in SQLite so a service restart doesn't break a login or
// registration that is in progress on someone's phone.
db.exec(`CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, challenge TEXT NOT NULL, invite_hash TEXT, expires_at INTEGER NOT NULL
)`);

function saveChallenge(kind, challenge, inviteHash = null) {
  const id = crypto.randomBytes(16).toString('base64url');
  db.prepare('INSERT INTO webauthn_challenges (id, kind, challenge, invite_hash, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, kind, challenge, inviteHash, now() + CHALLENGE_TTL);
  return id;
}

/** Single use: the challenge is removed the first time anyone tries to use it. */
function takeChallenge(id, kind) {
  const key = String(id || '');
  const c = db.prepare('SELECT * FROM webauthn_challenges WHERE id = ?').get(key);
  db.prepare('DELETE FROM webauthn_challenges WHERE id = ?').run(key);
  if (!c) throw new PasskeyError('La solicitud no existe o ya se usó. Probá de nuevo.', 400, 'challenge-missing');
  if (c.kind !== kind) throw new PasskeyError('La solicitud no corresponde. Probá de nuevo.', 400, 'challenge-kind');
  if (c.expires_at < now()) throw new PasskeyError('La solicitud venció (más de 5 minutos). Probá de nuevo.', 400, 'challenge-expired');
  return { challenge: c.challenge, inviteHash: c.invite_hash };
}

setInterval(() => {
  db.prepare('DELETE FROM webauthn_challenges WHERE expires_at < ?').run(now());
}, 60_000).unref();

function webauthnId(user) {
  if (user.webauthn_id) return user.webauthn_id;
  const id = crypto.randomBytes(32).toString('base64url');
  db.prepare('UPDATE users SET webauthn_id = ? WHERE id = ? AND webauthn_id IS NULL').run(id, user.id);
  return db.prepare('SELECT webauthn_id FROM users WHERE id = ?').get(user.id).webauthn_id;
}

// ---------------------------------------------------------------- invites
/** Creates a one-time invite (older unused ones for that user are revoked). Returns the raw token. */
export function createInvite(userId, createdBy = null) {
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) throw new PasskeyError('No existe ese usuario.', 404);
  const token = crypto.randomBytes(24).toString('base64url');
  const t = now();
  const expiresAt = t + config.inviteHours * 3600_000;
  db.prepare('DELETE FROM invites WHERE user_id = ? AND used_at IS NULL').run(userId);
  db.prepare('INSERT INTO invites (token_hash, user_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(sha256(token), userId, createdBy, t, expiresAt);
  return { token, expiresAt };
}

export function inviteUrl(token, base) {
  return `${(base || config.publicUrl || config.origins[0]).replace(/\/$/, '')}/invitacion/${token}`;
}

/** Valid (unused, unexpired) invite + its user, or throws. */
function validInvite(token) {
  const row = db.prepare(`SELECT i.*, u.display_name, u.username, u.webauthn_id, u.id AS uid
    FROM invites i JOIN users u ON u.id = i.user_id WHERE i.token_hash = ?`).get(sha256(String(token || '')));
  if (!row) throw new PasskeyError('Esta invitación no existe.', 404);
  if (row.used_at) throw new PasskeyError('Esta invitación ya se usó. Pedile una nueva a quien administra.', 410);
  if (row.expires_at < now()) throw new PasskeyError('Esta invitación venció. Pedile una nueva a quien administra.', 410);
  return row;
}

export function inviteInfo(token) {
  const row = validInvite(token);
  return { name: row.display_name, expiresAt: row.expires_at };
}

export function pendingInvite(userId) {
  const r = db.prepare('SELECT expires_at FROM invites WHERE user_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC')
    .get(userId, now());
  return r ? r.expires_at : null;
}

// ---------------------------------------------------------------- registration
export async function registrationOptions(token) {
  const inv = validInvite(token);
  const user = { id: inv.uid, webauthn_id: inv.webauthn_id };
  const existing = db.prepare('SELECT id, transports FROM passkeys WHERE user_id = ?').all(inv.uid);
  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpId,
    userID: Buffer.from(webauthnId(user), 'base64url'),
    userName: inv.username,
    userDisplayName: inv.display_name,
    attestationType: 'none',
    excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports ? JSON.parse(p.transports) : undefined })),
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
  });
  return { challengeId: saveChallenge('register', options.challenge, inv.token_hash), options };
}

export async function verifyRegistration(token, challengeId, response, deviceName) {
  const c = takeChallenge(challengeId, 'register');
  const inv = validInvite(token);
  if (c.inviteHash !== inv.token_hash) throw new PasskeyError('La solicitud no corresponde a esta invitación.', 400);
  let v;
  try {
    v = await verifyRegistrationResponse({
      response,
      expectedChallenge: c.challenge,
      expectedOrigin: config.origins,
      expectedRPID: config.rpId,
      requireUserVerification: true,
    });
  } catch (e) {
    throw new PasskeyError(`No se pudo verificar la passkey: ${e.message}`, 400, `verify-reg: ${e.message}`);
  }
  if (!v.verified) throw new PasskeyError('No se pudo verificar la passkey.', 400, 'verify-reg: not verified');
  const { credential, credentialDeviceType, credentialBackedUp } = v.registrationInfo;

  // Consume the invite atomically (single use, even with concurrent requests).
  const used = db.prepare('UPDATE invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
    .run(now(), inv.token_hash, now());
  if (Number(used.changes) !== 1) throw new PasskeyError('Esta invitación ya se usó.', 410);
  if (db.prepare('SELECT 1 FROM passkeys WHERE id = ?').get(credential.id)) throw new PasskeyError('Esa passkey ya está registrada.', 409);

  const name = cleanDeviceName(deviceName);
  db.prepare(`INSERT INTO passkeys (id, user_id, public_key, counter, transports, device_type, backed_up, name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    credential.id, inv.uid, Buffer.from(credential.publicKey), credential.counter || 0,
    JSON.stringify(credential.transports || response.response?.transports || []),
    credentialDeviceType, credentialBackedUp ? 1 : 0, name, now());
  return { userId: inv.uid, passkeyId: credential.id };
}

function cleanDeviceName(n) {
  const s = String(n || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return s || 'Dispositivo';
}

// ---------------------------------------------------------------- authentication
export async function authenticationOptions() {
  const options = await generateAuthenticationOptions({ rpID: config.rpId, userVerification: 'required', allowCredentials: [] });
  return { challengeId: saveChallenge('login', options.challenge), options };
}

export async function verifyAuthentication(challengeId, response) {
  const c = takeChallenge(challengeId, 'login');
  const pk = db.prepare(`SELECT p.*, u.webauthn_id FROM passkeys p JOIN users u ON u.id = p.user_id WHERE p.id = ?`)
    .get(String(response?.id || ''));
  if (!pk) throw new PasskeyError('Esta passkey no está registrada (¿la borraron?). Pedí una invitación nueva.', 401, `unknown-credential id=${String(response?.id || '').slice(0, 12)}…`);
  const handle = response?.response?.userHandle;
  if (handle && handle !== pk.webauthn_id) throw new PasskeyError('La passkey no corresponde a esta cuenta.', 401, 'user-handle-mismatch');
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: c.challenge,
      expectedOrigin: config.origins,
      expectedRPID: config.rpId,
      requireUserVerification: true,
      credential: {
        id: pk.id,
        publicKey: new Uint8Array(pk.public_key),
        counter: pk.counter,
        transports: pk.transports ? JSON.parse(pk.transports) : undefined,
      },
    });
  } catch (e) {
    throw new PasskeyError(`No se pudo verificar la passkey: ${e.message}`, 401, `verify-auth: ${e.message}`);
  }
  if (!v.verified) throw new PasskeyError('No se pudo verificar la passkey.', 401, 'verify-auth: not verified');
  db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ?, backed_up = ? WHERE id = ?')
    .run(v.authenticationInfo.newCounter, now(), v.authenticationInfo.credentialBackedUp ? 1 : 0, pk.id);
  return { userId: pk.user_id, passkeyId: pk.id };
}

// ---------------------------------------------------------------- management (admin)
export function listPasskeys(userId) {
  return db.prepare('SELECT id, name, device_type, backed_up, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at')
    .all(userId).map((p) => ({
      id: p.id, name: p.name, synced: p.device_type === 'multiDevice' || !!p.backed_up,
      createdAt: p.created_at, lastUsedAt: p.last_used_at,
    }));
}

export const passkeyCount = (userId) => db.prepare('SELECT COUNT(*) n FROM passkeys WHERE user_id = ?').get(userId).n;

export function renamePasskey(id, name) {
  const r = db.prepare('UPDATE passkeys SET name = ? WHERE id = ?').run(cleanDeviceName(name), String(id));
  if (!Number(r.changes)) throw new PasskeyError('No existe esa passkey.', 404);
}

/** Deletes the passkey and logs out every session it opened. */
export function deletePasskey(id) {
  const pk = db.prepare('SELECT user_id FROM passkeys WHERE id = ?').get(String(id));
  if (!pk) throw new PasskeyError('No existe esa passkey.', 404);
  db.prepare('DELETE FROM sessions WHERE passkey_id = ?').run(String(id));
  db.prepare('DELETE FROM passkeys WHERE id = ?').run(String(id));
  return pk.user_id;
}
