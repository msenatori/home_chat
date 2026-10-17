// End-to-end passkey test with a software authenticator (no browser needed).
// Starts the real server on localhost (a valid WebAuthn secure context) in
// passkey mode, with a throwaway data dir.  Run: node --test test/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 18000 + Math.floor(Math.random() * 1000);
const ORIGIN = `http://localhost:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'shareit-test-'));
const ENV = {
  ...process.env,
  SHAREIT_DATA_DIR: DATA, SHAREIT_PORT: String(PORT), SHAREIT_HOST: '127.0.0.1',
  SHAREIT_AUTH: 'passkey', SHAREIT_RP_ID: 'localhost', SHAREIT_ORIGINS: ORIGIN,
  SHAREIT_LLM_BIN: '/usr/bin/false', // the LLM CLI isn't needed for auth tests
};
let server;

// ---------------------------------------------------------------- tiny CBOR encoder
function head(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}
function cbor(v) {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, b.length), b]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}

const b64u = (b) => Buffer.from(b).toString('base64url');
const sha = (b) => crypto.createHash('sha256').update(b).digest();

/** Software platform authenticator: ES256, discoverable credential, UV always on. */
class SoftAuthenticator {
  constructor(origin = ORIGIN) {
    this.origin = origin;
    this.creds = [];
  }

  register(options) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const credId = crypto.randomBytes(32);
    const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]);
    const flags = 0x01 | 0x04 | 0x40; // UP | UV | AT
    const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
    const authData = Buffer.concat([sha(Buffer.from(options.rp.id)), Buffer.from([flags]), Buffer.alloc(4), Buffer.alloc(16), len, credId, cbor(cose)]);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    const cred = { id: b64u(credId), privateKey, userHandle: options.user.id, rpId: options.rp.id, counter: 0 };
    this.creds.push(cred);
    return {
      id: cred.id, rawId: cred.id, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientData),
        attestationObject: b64u(cbor({ fmt: 'none', attStmt: {}, authData })),
        transports: ['internal'],
      },
    };
  }

  assert(options, cred = this.creds[0]) {
    cred.counter += 1;
    const ctr = Buffer.alloc(4); ctr.writeUInt32BE(cred.counter);
    const authData = Buffer.concat([sha(Buffer.from(options.rpId || cred.rpId)), Buffer.from([0x01 | 0x04]), ctr]);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    const signature = crypto.sign('sha256', Buffer.concat([authData, sha(clientData)]), cred.privateKey); // DER
    return {
      id: cred.id, rawId: cred.id, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientData), authenticatorData: b64u(authData),
        signature: b64u(signature), userHandle: cred.userHandle,
      },
    };
  }
}

// ---------------------------------------------------------------- HTTP helpers
async function call(pathname, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(ORIGIN + pathname, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get('set-cookie');
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data, cookie: setCookie ? setCookie.split(';')[0] : null, setCookie };
}

const tokenFromUrl = (url) => url.split('/invitacion/')[1];

async function enroll(token, auth, deviceName = 'Teléfono de prueba') {
  const opt = await call(`/api/invites/${token}/options`, { method: 'POST', body: {} });
  assert.equal(opt.status, 200, JSON.stringify(opt.data));
  assert.equal(opt.data.options.authenticatorSelection.residentKey, 'required');
  assert.equal(opt.data.options.authenticatorSelection.userVerification, 'required');
  assert.equal(opt.data.options.attestation, 'none');
  const response = auth.register(opt.data.options);
  return call(`/api/invites/${token}/verify`, { method: 'POST', body: { challengeId: opt.data.challengeId, response, deviceName } });
}

async function passkeyLogin(auth, cred) {
  const opt = await call('/api/auth/passkey/options', { method: 'POST', body: {} });
  assert.equal(opt.status, 200);
  assert.deepEqual(opt.data.options.allowCredentials, []); // discoverable: no username needed
  const response = auth.assert(opt.data.options, cred);
  return call('/api/auth/passkey/verify', { method: 'POST', body: { challengeId: opt.data.challengeId, response } });
}

// ---------------------------------------------------------------- setup
const cli = (env, ...args) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/admin.js', ...args],
  { cwd: ROOT, env }).toString();

async function startServer(env = ENV) {
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: ROOT, env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${ORIGIN}/healthz`)).ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

async function stopServer() {
  if (!server) return;
  const s = server;
  server = null;
  await new Promise((r) => { s.once('exit', r); s.kill('SIGTERM'); });
}

let pinCookie;
before(async () => {
  // 1) Legacy PIN mode: a person logs in with a PIN (that session must not survive the switch).
  const PIN_ENV = { ...ENV, SHAREIT_AUTH: 'pin' };
  cli(PIN_ENV, 'add', 'Pin Test', '2468');
  await startServer(PIN_ENV);
  const r = await call('/api/login', { method: 'POST', body: { username: 'pin test', pin: '2468' } });
  assert.equal(r.status, 200, 'PIN login works in pin mode');
  pinCookie = r.cookie;
  assert.equal((await call('/api/me', { cookie: pinCookie })).status, 200);
  await stopServer();

  // 2) Switch to passkey mode.
  ENV.ADMIN_INVITE = cli(ENV, 'add', 'Admin Test', '--admin').match(/http\S+\/invitacion\/\S+/)[0];
  await startServer(ENV);
});

after(async () => {
  await stopServer();
  fs.rmSync(DATA, { recursive: true, force: true });
});

// ---------------------------------------------------------------- tests
const admin = new SoftAuthenticator();
const nene = new SoftAuthenticator();
let adminCookie, neneCookie, neneId;

test('auth config says passkey mode and PIN login is disabled', async () => {
  const cfg = (await call('/api/auth/config')).data;
  assert.equal(cfg.mode, 'passkey');
  assert.equal(cfg.rpId, 'localhost');
  assert.ok(cfg.appName);
  const r = await call('/api/login', { method: 'POST', body: { username: 'admin test', pin: '1234' } });
  assert.equal(r.status, 404);
});

test('PIN sessions are closed when the server starts in passkey mode', async () => {
  assert.equal((await call('/api/me', { cookie: pinCookie })).status, 401);
});

test('CLI invite → register → session (admin)', async () => {
  const token = tokenFromUrl(ENV.ADMIN_INVITE);
  assert.ok(ENV.ADMIN_INVITE.startsWith(`${ORIGIN}/invitacion/`));
  assert.equal((await call(`/api/invites/${token}`)).data.name, 'Admin Test');
  const r = await enroll(token, admin, 'Mac de prueba');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.cookie?.startsWith('shareit_sid='));
  assert.ok(!/;\s*Secure/i.test(r.setCookie), 'no Secure flag over plain http');
  adminCookie = r.cookie;
  const me = await call('/api/me', { cookie: adminCookie });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.isAdmin, true);
});

test('invite reuse is rejected', async () => {
  const token = tokenFromUrl(ENV.ADMIN_INVITE);
  assert.equal((await call(`/api/invites/${token}`)).status, 410);
  assert.equal((await call(`/api/invites/${token}/options`, { method: 'POST', body: {} })).status, 410);
});

test('login with passkey (no username) → session', async () => {
  await call('/api/logout', { method: 'POST', body: {}, cookie: adminCookie });
  assert.equal((await call('/api/me', { cookie: adminCookie })).status, 401);
  const r = await passkeyLogin(admin);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.user.name, 'Admin Test');
  adminCookie = r.cookie;
  assert.equal((await call('/api/me', { cookie: adminCookie })).status, 200);
});

test('a login challenge is single use', async () => {
  const opt = await call('/api/auth/passkey/options', { method: 'POST', body: {} });
  const body = { challengeId: opt.data.challengeId, response: admin.assert(opt.data.options) };
  assert.equal((await call('/api/auth/passkey/verify', { method: 'POST', body })).status, 200);
  const again = await call('/api/auth/passkey/verify', { method: 'POST', body: { ...body, response: admin.assert(opt.data.options) } });
  assert.equal(again.status, 400);
});

test('wrong origin is rejected', async () => {
  const evil = new SoftAuthenticator('http://evil.localhost:9999');
  evil.creds = admin.creds;
  const opt = await call('/api/auth/passkey/options', { method: 'POST', body: {} });
  const r = await call('/api/auth/passkey/verify', { method: 'POST', body: { challengeId: opt.data.challengeId, response: evil.assert(opt.data.options) } });
  assert.equal(r.status, 401);
});

test('admin creates a person with an invite; they enroll and log in', async () => {
  const r = await call('/api/admin/users', { method: 'POST', body: { name: 'Nene Test' }, cookie: adminCookie });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.ok(r.data.invite.url.startsWith(`${ORIGIN}/invitacion/`));
  assert.ok(r.data.invite.qr.startsWith('data:image/svg+xml;base64,'));
  neneId = r.data.user.id;
  const e = await enroll(tokenFromUrl(r.data.invite.url), nene);
  assert.equal(e.status, 200, JSON.stringify(e.data));
  neneCookie = e.cookie;
  const list = await call(`/api/admin/users/${neneId}/passkeys`, { cookie: adminCookie });
  assert.equal(list.data.passkeys.length, 1);
  assert.equal(list.data.passkeys[0].name, 'Teléfono de prueba');
});

test('non-admin cannot create invites or manage passkeys', async () => {
  assert.equal((await call(`/api/admin/users/${neneId}/invite`, { method: 'POST', body: {}, cookie: neneCookie })).status, 403);
  assert.equal((await call('/api/admin/users', { method: 'POST', body: { name: 'X' }, cookie: neneCookie })).status, 403);
  assert.equal((await call(`/api/admin/users/${neneId}/passkeys`, { cookie: neneCookie })).status, 403);
  assert.equal((await call(`/api/admin/users/${neneId}/invite`, { method: 'POST', body: {} })).status, 401);
});

test('expired invite is rejected', async () => {
  const r = await call(`/api/admin/users/${neneId}/invite`, { method: 'POST', body: {}, cookie: adminCookie });
  assert.equal(r.status, 201);
  const token = tokenFromUrl(r.data.invite.url);
  const opt = await call(`/api/invites/${token}/options`, { method: 'POST', body: {} }); // challenge issued before expiry
  const db = new DatabaseSync(path.join(DATA, 'shareit.db'));
  db.prepare('UPDATE invites SET expires_at = ? WHERE user_id = ? AND used_at IS NULL').run(Date.now() - 1000, neneId);
  db.close();
  assert.equal((await call(`/api/invites/${token}`)).status, 410);
  const late = await call(`/api/invites/${token}/verify`, {
    method: 'POST', body: { challengeId: opt.data.challengeId, response: new SoftAuthenticator().register(opt.data.options) },
  });
  assert.equal(late.status, 410);
});

test('a new invite replaces the previous unused one', async () => {
  const a = await call(`/api/admin/users/${neneId}/invite`, { method: 'POST', body: {}, cookie: adminCookie });
  const b = await call(`/api/admin/users/${neneId}/invite`, { method: 'POST', body: {}, cookie: adminCookie });
  assert.equal((await call(`/api/invites/${tokenFromUrl(a.data.invite.url)}`)).status, 404);
  assert.equal((await call(`/api/invites/${tokenFromUrl(b.data.invite.url)}`)).status, 200);
});

test('rename, then delete a passkey: its sessions end and it cannot log in', async () => {
  const { data } = await call(`/api/admin/users/${neneId}/passkeys`, { cookie: adminCookie });
  const pk = data.passkeys[0];
  assert.equal((await call(`/api/admin/passkeys/${pk.id}`, { method: 'PATCH', body: { name: 'Celu viejo' }, cookie: adminCookie })).status, 200);
  assert.equal((await call(`/api/admin/users/${neneId}/passkeys`, { cookie: adminCookie })).data.passkeys[0].name, 'Celu viejo');
  assert.equal((await passkeyLogin(nene)).status, 200); // still works before deleting
  assert.equal((await call(`/api/admin/passkeys/${pk.id}`, { method: 'DELETE', cookie: adminCookie })).status, 200);
  assert.equal((await call('/api/me', { cookie: neneCookie })).status, 401, 'session opened by that passkey is gone');
  const r = await passkeyLogin(nene);
  assert.equal(r.status, 401);
  assert.match(r.data.error, /no está registrada/);
});

test('Secure cookie when the proxy says the request is HTTPS', async () => {
  const opt = await call('/api/auth/passkey/options', { method: 'POST', body: {} });
  const res = await fetch(`${ORIGIN}/api/auth/passkey/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
    body: JSON.stringify({ challengeId: opt.data.challengeId, response: admin.assert(opt.data.options) }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie'), /;\s*Secure/i);
});

test('verify endpoint is rate limited', async () => {
  let last;
  for (let i = 0; i < 25; i++) last = await call('/api/auth/passkey/verify', { method: 'POST', body: { challengeId: 'x', response: {} } });
  assert.equal(last.status, 429);
});

test('passkey sessions survive a restart in passkey mode', async () => {
  assert.equal((await call('/api/me', { cookie: adminCookie })).status, 200);
  await stopServer();
  await startServer(ENV);
  assert.equal((await call('/api/me', { cookie: adminCookie })).status, 200);
});

test('an in-flight login survives a server restart (challenges are in SQLite)', async () => {
  const opt = await call('/api/auth/passkey/options', { method: 'POST', body: {} });
  await stopServer();
  await startServer(ENV);
  const r = await call('/api/auth/passkey/verify', { method: 'POST', body: { challengeId: opt.data.challengeId, response: admin.assert(opt.data.options) } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
});
