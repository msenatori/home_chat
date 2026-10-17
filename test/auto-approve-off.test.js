// SHAREIT_AUTO_APPROVE_DAYS=0 disables same-phone auto-approval.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 20000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'shareit-noauto-'));
const ENV = {
  ...process.env, SHAREIT_DATA_DIR: DATA, SHAREIT_PORT: String(PORT), SHAREIT_HOST: '127.0.0.1',
  SHAREIT_AUTH: 'device', SHAREIT_LLM_BIN: '/usr/bin/false', SHAREIT_AUTO_APPROVE_DAYS: '0',
};
let server;
const cli = (...a) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/admin.js', ...a], { cwd: ROOT, env: ENV }).toString();

async function request(name, ip, cookie) {
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': ip };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${BASE}/api/access/request`, { method: 'POST', headers, body: JSON.stringify({ name }) });
  return { data: await res.json(), cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') };
}

before(async () => {
  cli('add', 'Ana Test', '--admin');
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: ROOT, env: ENV, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});

after(async () => {
  if (server) await new Promise((r) => { server.once('exit', r); server.kill('SIGTERM'); });
  fs.rmSync(DATA, { recursive: true, force: true });
});

test('disabled with 0: same IP + existing person with a fresh device → still pending', async () => {
  const first = await request('Ana Test', '10.9.0.1');
  cli('approve', String(first.data.code));
  const st = await fetch(`${BASE}/api/access/status`, { headers: { Cookie: first.cookie, 'X-Forwarded-For': '10.9.0.1' } });
  assert.equal((await st.json()).status, 'approved');
  const second = await request('Ana Test', '10.9.0.1');
  assert.equal(second.data.status, 'pending');
});
