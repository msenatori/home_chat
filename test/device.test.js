// "Aprobar dispositivo" login, end to end against the real server on localhost.
// Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 19000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'shareit-device-'));
const ENV = {
  ...process.env,
  SHAREIT_DATA_DIR: DATA, SHAREIT_PORT: String(PORT), SHAREIT_HOST: '127.0.0.1',
  SHAREIT_AUTH: 'device', SHAREIT_LLM_BIN: '/usr/bin/false',
  SHAREIT_APP_NAME: 'Chat "de" Prueba & Co', SHAREIT_APP_SHORT_NAME: 'Prueba',
};
let server;

const cli = (...args) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/admin.js', ...args],
  { cwd: ROOT, env: ENV }).toString();

/** Minimal cookie jar per simulated device. */
class Device {
  constructor(ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1', ip = null) {
    this.jar = new Map();
    this.ua = ua;
    this.ip = ip;
  }

  async call(pathname, { method = 'GET', body } = {}) {
    const headers = { 'User-Agent': this.ua };
    if (this.ip) headers['X-Forwarded-For'] = this.ip; // trusted from loopback (simulates the proxy)
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.jar.size) headers.Cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(BASE + pathname, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    for (const c of res.headers.getSetCookie()) {
      const [kv, ...attrs] = c.split(';');
      const [k, v] = kv.split('=');
      if (attrs.some((a) => /max-age=0/i.test(a)) || v === '') this.jar.delete(k.trim()); else this.jar.set(k.trim(), v);
    }
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data, headers: res.headers };
  }
}

async function startServer() {
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: ROOT, env: ENV, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

before(async () => {
  cli('add', 'Ana Test', '--admin');
  cli('add', 'Lucía Test');
  await startServer();
});

after(async () => {
  if (server) await new Promise((r) => { server.once('exit', r); server.kill('SIGTERM'); });
  fs.rmSync(DATA, { recursive: true, force: true });
});

const admin = new Device('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36', '10.0.0.10');
const db = () => new DatabaseSync(path.join(DATA, 'shareit.db'));

test('device mode: PIN and passkey endpoints are off', async () => {
  const d = new Device();
  assert.equal((await d.call('/api/auth/config')).data.mode, 'device');
  assert.equal((await d.call('/api/login', { method: 'POST', body: { username: 'ana test', pin: '1234' } })).status, 404);
  assert.equal((await d.call('/api/auth/passkey/options', { method: 'POST', body: {} })).status, 404);
});

test('bootstrap: request → CLI approve by code → device session (1 year, httpOnly)', async () => {
  const r = await admin.call('/api/access/request', { method: 'POST', body: { name: 'ana test' } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.ok(r.data.code >= 10 && r.data.code <= 99);
  assert.equal(r.data.isNew, false);
  assert.equal(r.data.adminName, 'Ana Test');
  assert.match(r.headers.get('set-cookie'), /shareit_req=.*HttpOnly/i);
  assert.equal((await admin.call('/api/access/status')).data.status, 'pending');
  assert.match(cli('requests'), new RegExp(`código ${r.data.code}`));
  assert.match(cli('approve', String(r.data.code)), /Aprobado/);
  const s = await admin.call('/api/access/status');
  assert.equal(s.data.status, 'approved');
  assert.equal(s.data.user.isAdmin, true);
  const cookie = s.headers.getSetCookie().find((c) => c.startsWith('shareit_sid='));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=31536000/);
  assert.equal((await admin.call('/api/me')).status, 200);
  // The approval is claimed once: polling again doesn't mint another session.
  assert.equal((await admin.call('/api/access/status')).data.status, 'none');
});

test('accent/case-insensitive name matching', async () => {
  const d = new Device(undefined, '10.0.0.21');
  const r = await d.call('/api/access/request', { method: 'POST', body: { name: '  LUCIA   test ' } });
  assert.equal(r.data.isNew, false);
  const { data } = await admin.call('/api/admin/requests');
  assert.equal(data.requests.find((x) => x.code === r.data.code).matchedName, 'Lucía Test');
  await d.call('/api/access/cancel', { method: 'POST', body: {} });
});

test('non-admin cannot see or approve requests', async () => {
  const lucia = new Device(undefined, '10.0.0.22');
  const r = await lucia.call('/api/access/request', { method: 'POST', body: { name: 'Lucía Test' } });
  const { data } = await admin.call('/api/admin/requests');
  const id = data.requests.find((x) => x.code === r.data.code).id;
  await admin.call(`/api/admin/requests/${id}/approve`, { method: 'POST', body: {} });
  assert.equal((await lucia.call('/api/access/status')).data.status, 'approved');
  // Lucía (not admin) now has a session; she can't use the admin API.
  const other = new Device(undefined, '10.0.0.23');
  const o = await other.call('/api/access/request', { method: 'POST', body: { name: 'Alguien' } });
  const pending = (await admin.call('/api/admin/requests')).data.requests.find((x) => x.code === o.data.code);
  assert.equal((await lucia.call('/api/admin/requests')).status, 403);
  assert.equal((await lucia.call(`/api/admin/requests/${pending.id}/approve`, { method: 'POST', body: {} })).status, 403);
  assert.equal((await other.call('/api/admin/requests')).status, 401);
  await other.call('/api/access/cancel', { method: 'POST', body: {} });
});

test('reject → device sees "rejected" and gets no session', async () => {
  const d = new Device(undefined, '10.0.0.31');
  const r = await d.call('/api/access/request', { method: 'POST', body: { name: 'Intruso' } });
  const id = (await admin.call('/api/admin/requests')).data.requests.find((x) => x.code === r.data.code).id;
  assert.equal((await admin.call(`/api/admin/requests/${id}/reject`, { method: 'POST', body: {} })).status, 200);
  assert.equal((await d.call('/api/access/status')).data.status, 'rejected');
  assert.equal((await d.call('/api/me')).status, 401);
});

test('expired request (15 min) cannot be approved', async () => {
  const d = new Device(undefined, '10.0.0.41');
  const r = await d.call('/api/access/request', { method: 'POST', body: { name: 'Tarde' } });
  const id = (await admin.call('/api/admin/requests')).data.requests.find((x) => x.code === r.data.code).id;
  const conn = db();
  conn.prepare('UPDATE access_requests SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, id);
  conn.close();
  assert.equal((await d.call('/api/access/status')).data.status, 'expired');
  assert.equal((await admin.call(`/api/admin/requests/${id}/approve`, { method: 'POST', body: {} })).status, 404);
  assert.ok(!(await admin.call('/api/admin/requests')).data.requests.some((x) => x.id === id));
});

test('new person: approval creates the user', async () => {
  const d = new Device('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36', '10.0.0.51');
  const r = await d.call('/api/access/request', { method: 'POST', body: { name: 'Abuela Test' } });
  assert.equal(r.data.isNew, true);
  const req = (await admin.call('/api/admin/requests')).data.requests.find((x) => x.code === r.data.code);
  assert.equal(req.device, 'Android · Chrome');
  const a = await admin.call(`/api/admin/requests/${req.id}/approve`, { method: 'POST', body: {} });
  assert.equal(a.data.created, true);
  const s = await d.call('/api/access/status');
  assert.equal(s.data.user.name, 'Abuela Test');
  assert.ok((await admin.call('/api/admin/users')).data.users.some((u) => u.name === 'Abuela Test'));
});

test('approve as a different existing person (typo)', async () => {
  const d = new Device(undefined, '10.0.0.61');
  const r = await d.call('/api/access/request', { method: 'POST', body: { name: 'Luciaa' } });
  const users = (await admin.call('/api/admin/users')).data.users;
  const lucia = users.find((u) => u.name === 'Lucía Test');
  const req = (await admin.call('/api/admin/requests')).data.requests.find((x) => x.code === r.data.code);
  assert.equal(req.isNew, true);
  await admin.call(`/api/admin/requests/${req.id}/approve`, { method: 'POST', body: { asUserId: lucia.id } });
  assert.equal((await d.call('/api/access/status')).data.user.name, 'Lucía Test');
  assert.equal((await admin.call('/api/admin/users')).data.users.length, users.length, 'no extra user created');
});

test('devices list and "Desconectar" ends that session', async () => {
  const users = (await admin.call('/api/admin/users')).data.users;
  const abuela = users.find((u) => u.name === 'Abuela Test');
  const devs = (await admin.call(`/api/admin/users/${abuela.id}/devices`)).data.devices;
  assert.equal(devs.length, 1);
  assert.equal(devs[0].name, 'Android · Chrome');
  assert.ok(devs[0].approvedAt && devs[0].lastUsedAt);
  // Find abuela's device session and disconnect it.
  assert.equal((await admin.call(`/api/admin/devices/${devs[0].id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await admin.call(`/api/admin/users/${abuela.id}/devices`)).data.devices.length, 0);
});

test('disconnected device gets 401', async () => {
  const d = new Device(undefined, '10.0.0.71');
  const r = await d.call('/api/access/request', { method: 'POST', body: { name: 'Lucía Test' } });
  const req = (await admin.call('/api/admin/requests')).data.requests.find((x) => x.code === r.data.code);
  await admin.call(`/api/admin/requests/${req.id}/approve`, { method: 'POST', body: {} });
  await d.call('/api/access/status');
  assert.equal((await d.call('/api/me')).status, 200);
  const lucia = (await admin.call('/api/admin/users')).data.users.find((u) => u.name === 'Lucía Test');
  const dev = (await admin.call(`/api/admin/users/${lucia.id}/devices`)).data.devices[0]; // most recent first
  await admin.call(`/api/admin/devices/${dev.id}`, { method: 'DELETE' });
  assert.equal((await d.call('/api/me')).status, 401);
});

test('CLI reject by code', async () => {
  const d = new Device(undefined, '10.0.0.81');
  const r = await d.call('/api/access/request', { method: 'POST', body: { name: 'Otro' } });
  assert.match(cli('reject', String(r.data.code)), /Rechazado/);
  assert.equal((await d.call('/api/access/status')).data.status, 'rejected');
});

test('rate limit: max 5 pending requests per IP in 10 minutes', async () => {
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    statuses.push((await new Device(undefined, '10.0.0.99').call('/api/access/request', { method: 'POST', body: { name: `Spam ${i}` } })).status);
  }
  assert.deepEqual(statuses.slice(0, 5), [201, 201, 201, 201, 201]);
  assert.equal(statuses[5], 429);
});

test('rate limit: max 5 requests per name in 10 minutes', async () => {
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    statuses.push((await new Device(undefined, `10.0.1.${i + 1}`).call('/api/access/request', { method: 'POST', body: { name: 'Mismo Nombre' } })).status);
  }
  assert.equal(statuses[5], 429);
});

test('app name comes from SHAREIT_APP_NAME (escaped in HTML and JSON)', async () => {
  const html = await (await fetch(`${BASE}/`)).text();
  assert.match(html, /<title>Chat &quot;de&quot; Prueba &amp; Co<\/title>/);
  assert.ok(!html.includes('{{APP_NAME}}'));
  const manifest = await (await fetch(`${BASE}/manifest.webmanifest`)).json();
  assert.equal(manifest.name, 'Chat "de" Prueba & Co');
  assert.equal(manifest.short_name, 'Prueba');
  assert.equal((await new Device().call('/api/auth/config')).data.appName, 'Chat "de" Prueba & Co');
});

// ---------------------------------------------------------------- same-phone auto-approval
async function approveManually(device, name) {
  const r = await device.call('/api/access/request', { method: 'POST', body: { name } });
  assert.equal(r.data.status, 'pending');
  const req = (await admin.call('/api/admin/requests')).data.requests.find((x) => x.code === r.data.code);
  await admin.call(`/api/admin/requests/${req.id}/approve`, { method: 'POST', body: {} });
  assert.equal((await device.call('/api/access/status')).data.status, 'approved');
}

test('auto-approve: same IP + existing person with a recent device → enters immediately', async () => {
  const safari = new Device(undefined, '10.0.5.1');
  await approveManually(safari, 'Lucía Test');
  const chrome = new Device('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/140.0 Mobile/15E148 Safari/604.1', '10.0.5.1');
  const r = await chrome.call('/api/access/request', { method: 'POST', body: { name: 'lucia test' } });
  assert.equal(r.status, 201);
  assert.equal(r.data.status, 'approved');
  assert.equal(r.data.autoApproved, true);
  assert.equal(r.data.user.name, 'Lucía Test');
  assert.equal((await chrome.call('/api/me')).status, 200, 'session cookie set in the same response');
  const lucia = (await admin.call('/api/admin/users')).data.users.find((u) => u.name === 'Lucía Test');
  const devs = (await admin.call(`/api/admin/users/${lucia.id}/devices`)).data.devices;
  assert.ok(devs.some((d) => d.autoApproved && d.name === 'iPhone · Chrome'));
  const { data } = await admin.call('/api/admin/requests');
  assert.ok(data.recentAuto.some((a) => a.name === 'Lucía Test' && a.device === 'iPhone · Chrome'));
});

test('auto-approve: different IP → pending', async () => {
  const r = await new Device(undefined, '10.0.5.2').call('/api/access/request', { method: 'POST', body: { name: 'Lucía Test' } });
  assert.equal(r.data.status, 'pending');
});

test('auto-approve: new person from the same IP → pending', async () => {
  const r = await new Device(undefined, '10.0.5.1').call('/api/access/request', { method: 'POST', body: { name: 'Beto Test' } });
  assert.equal(r.data.status, 'pending');
  assert.equal(r.data.isNew, true);
});

test('auto-approve: never as someone else (another existing person on the same IP) → pending', async () => {
  const r = await new Device(undefined, '10.0.5.1').call('/api/access/request', { method: 'POST', body: { name: 'Ana Test' } });
  assert.equal(r.data.status, 'pending');
});

test('auto-approve: not after a rejection for that name from that IP in the last 24 h', async () => {
  const d = new Device(undefined, '10.0.6.1');
  await approveManually(d, 'Abuela Test');
  const r1 = await new Device(undefined, '10.0.6.1').call('/api/access/request', { method: 'POST', body: { name: 'Abuela Test' } });
  assert.equal(r1.data.status, 'approved'); // auto (sanity)
  // Someone asks as Abuela from that IP with a name variant that isn't auto (typo → new person), admin rejects a real one:
  const conn = db();
  conn.prepare(`INSERT INTO access_requests (secret_hash, name, code, device, ip, status, created_at, expires_at, decided_at)
    VALUES ('x-test-hash', 'abuela test', 11, 'Dispositivo', '10.0.6.1', 'rejected', ?, ?, ?)`).run(Date.now(), Date.now() + 1000, Date.now());
  conn.close();
  const r2 = await new Device(undefined, '10.0.6.1').call('/api/access/request', { method: 'POST', body: { name: 'Abuela Test' } });
  assert.equal(r2.data.status, 'pending');
});

test('auto-approve: stale session (older than N days) → pending', async () => {
  const lucia = (await admin.call('/api/admin/users')).data.users.find((u) => u.name === 'Lucía Test');
  const conn = db();
  conn.prepare('UPDATE sessions SET last_used_at = ? WHERE user_id = ?').run(Date.now() - 31 * 86400_000, lucia.id);
  conn.close();
  const r = await new Device(undefined, '10.0.5.1').call('/api/access/request', { method: 'POST', body: { name: 'Lucía Test' } });
  assert.equal(r.data.status, 'pending');
});

test('auto-approve: revoked (disconnected) device → pending', async () => {
  const d = new Device(undefined, '10.0.7.1');
  await approveManually(d, 'Ana Test');
  const ana = (await admin.call('/api/admin/users')).data.users.find((u) => u.name === 'Ana Test');
  for (const dev of (await admin.call(`/api/admin/users/${ana.id}/devices`)).data.devices) {
    // disconnect only the one on 10.0.7.1 (the most recent)
    await admin.call(`/api/admin/devices/${dev.id}`, { method: 'DELETE' });
    break;
  }
  const r = await new Device(undefined, '10.0.7.1').call('/api/access/request', { method: 'POST', body: { name: 'Ana Test' } });
  assert.equal(r.data.status, 'pending');
});

test('session IP is tracked on use', async () => {
  const d = new Device(undefined, '10.0.8.1');
  await approveManually(d, 'Beto Test');
  d.ip = '10.0.8.2'; // same phone, now on another network
  assert.equal((await d.call('/api/me')).status, 200);
  const conn = db();
  const beto = conn.prepare("SELECT id FROM users WHERE display_name = 'Beto Test'").get();
  const ips = conn.prepare('SELECT last_ip FROM sessions WHERE user_id = ?').all(beto.id).map((r) => r.last_ip);
  conn.close();
  assert.ok(ips.includes('10.0.8.2'));
  const r = await new Device(undefined, '10.0.8.2').call('/api/access/request', { method: 'POST', body: { name: 'Beto Test' } });
  assert.equal(r.data.status, 'approved');
});
