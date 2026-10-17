import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { db, now } from './db.js';
import {
  login, logout, userFromToken, loginBlocked, recordLoginFailure,
  clearLoginFailures, purgeExpiredSessions, createSession, rateLimit, purgePinSessions, purgeNonDeviceSessions,
} from './auth.js';
import { llm } from './llm.js';
import { classify, extractText, IMAGE_MIME } from './extract.js';
import { isLanAddress } from './lan.js';
import { handleAdmin } from './admin.js';
import {
  AccessError, adminName, cancelRequest, claimApproved, createRequest, requestBySecret,
} from './access.js';
import { canPickModel, choiceFor } from './settings.js';
import {
  PasskeyError, authenticationOptions, inviteInfo, registrationOptions,
  verifyAuthentication, verifyRegistration,
} from './passkeys.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const COOKIE = 'shareit_sid';
const DEFAULT_TITLE = 'Nueva conversación';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

// ---------------------------------------------------------------- helpers
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sendJson(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(data);
}

async function readJson(req) {
  const ct = req.headers['content-type'] || '';
  if (!ct.startsWith('application/json')) throw new HttpError(415, 'Se esperaba JSON');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new HttpError(413, 'Mensaje demasiado largo');
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'JSON inválido'); }
}

// Same-origin check for state-changing requests (cookies are SameSite=Lax too).
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let host;
  try { host = new URL(origin).host; } catch { throw new HttpError(403, 'Origen inválido'); }
  if (host !== req.headers.host) throw new HttpError(403, 'Origen inválido');
}

// HTTPS directly, or via the local reverse proxy (only trusted from loopback).
function isHttps(req) {
  if (req.socket.encrypted) return true;
  return LOOPBACK.has(req.socket.remoteAddress) && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function sessionCookie(req, token, maxAgeSec) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`;
}

function requestOrigin(req) {
  return `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
}

/** Base URL for invite links: this origin if it's an allowed passkey origin, else the configured one. */
function inviteBase(req) {
  const o = requestOrigin(req);
  return config.origins.includes(o) ? o : (config.publicUrl || config.origins[0]);
}

function limitOrThrow(key, max, windowMs) {
  const wait = rateLimit(key, max, windowMs);
  if (wait) {
    console.warn(`[ratelimit] ${key} blocked for ${wait} min`);
    throw new HttpError(429, `Demasiados intentos. Probá de nuevo en ${wait} min.`);
  }
}

// Every passkey failure is logged with its reason (no tokens, keys or challenges).
async function passkeyCall(req, step, fn) {
  try {
    return await fn();
  } catch (e) {
    const origin = req.headers.origin || '-';
    const ua = String(req.headers['user-agent'] || '-').slice(0, 120);
    console.warn(`[passkey] ${step} failed ip=${clientIp(req)} origin=${origin} reason=${e.reason || e.message} ua="${ua}"`);
    if (e instanceof PasskeyError) throw new HttpError(e.status, e.message);
    throw e;
  }
}

const chatDto = (c) => ({
  id: c.id, title: c.title, model: c.model || null, effort: c.effort || null,
  createdAt: c.created_at, updatedAt: c.updated_at,
});
const attDto = (a) => ({ id: a.id, kind: a.kind, name: a.name, mime: a.mime, size: a.size, note: a.note || null });
const msgDto = (m, atts = []) => ({
  id: m.id, role: m.role, content: m.content, status: m.status, model: m.model || null,
  createdAt: m.created_at, attachments: atts.map(attDto),
});

// ---------------------------------------------------------------- models

async function validateChoice(body) {
  const models = await llm.listModels();
  const m = models.find((x) => x.id === body.model);
  if (!m) throw new HttpError(400, 'Ese modelo no está disponible');
  const effort = body.effort == null || body.effort === '' ? null : String(body.effort);
  if (effort && !m.efforts.some((e) => e.value === effort)) throw new HttpError(400, 'Nivel de razonamiento inválido');
  return { model: m.id, effort };
}

// ---------------------------------------------------------------- attachments
const chatAttDir = (chatId) => path.join(config.attachmentsDir, chatId);

function removeChatFiles(chatId) {
  fs.rm(chatAttDir(chatId), { recursive: true, force: true }, () => {});
}

function safeName(name) {
  const n = String(name || 'archivo').normalize('NFC').replace(/[\\/\x00-\x1f]/g, '_').replace(/^\.+/, '').trim();
  return (n || 'archivo').slice(0, 120);
}

async function handleUpload(req, res, user, chatId) {
  const chat = getChat(user.id, chatId);
  // A custom header can't be sent cross-site without a CORS preflight (which we never allow).
  if (!req.headers['x-file-name']) throw new HttpError(400, 'Falta el nombre del archivo');
  let name;
  try { name = safeName(decodeURIComponent(req.headers['x-file-name'] || '')); } catch { name = 'archivo'; }
  const mime = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > config.maxUploadBytes) throw new HttpError(413, `El archivo supera ${config.maxUploadBytes / 1048576} MB`);
  const pending = db.prepare('SELECT COUNT(*) n FROM attachments WHERE chat_id = ? AND message_id IS NULL').get(chat.id).n;
  if (pending >= 20) throw new HttpError(429, 'Demasiados adjuntos sin enviar');

  const kindRaw = classify(name, mime);
  if (mime.startsWith('image/') && kindRaw !== 'image') {
    throw new HttpError(415, 'Formato de imagen no soportado. Usá JPG, PNG, WEBP o GIF.');
  }
  const id = crypto.randomUUID();
  const dir = chatAttDir(chat.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ext = path.extname(name).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
  const file = path.join(dir, id + ext);
  const tmp = file + '.part';

  let size = 0;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp, { mode: 0o600 });
    let failed = false;
    const fail = (err) => { if (failed) return; failed = true; out.destroy(); fs.rm(tmp, { force: true }, () => {}); reject(err); };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > config.maxUploadBytes) { fail(new HttpError(413, `El archivo supera ${config.maxUploadBytes / 1048576} MB`)); req.resume(); return; }
      if (!out.write(chunk)) { req.pause(); out.once('drain', () => req.resume()); }
    });
    req.on('end', () => { if (!failed) out.end(resolve); });
    req.on('error', fail);
    out.on('error', fail);
  });
  if (!size) { fs.rmSync(tmp, { force: true }); throw new HttpError(400, 'El archivo está vacío'); }
  fs.renameSync(tmp, file);

  let extracted = null, note = null;
  const kind = kindRaw === 'image' ? 'image' : 'file';
  if (kind === 'file') ({ text: extracted, note } = await extractText(file, name, mime));
  const row = db.prepare(`INSERT INTO attachments (id, chat_id, kind, name, mime, size, path, extracted, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
    .get(id, chat.id, kind, name, mime, size, file, extracted || null, note, now());
  return sendJson(res, 201, { attachment: attDto(row) });
}

function serveAttachment(req, res, user, id) {
  const a = db.prepare(`SELECT a.* FROM attachments a JOIN chats c ON c.id = a.chat_id
    WHERE a.id = ? AND c.user_id = ?`).get(id, user.id);
  if (!a) throw new HttpError(404, 'Adjunto no encontrado');
  const inline = a.kind === 'image' && IMAGE_MIME.has(a.mime);
  fs.stat(a.path, (err, st) => {
    if (err) return sendJson(res, 404, { error: 'Adjunto no encontrado' });
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Type': inline ? a.mime : 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'private, max-age=86400',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.name)}`,
    });
    fs.createReadStream(a.path).pipe(res);
  });
}

function cleanupOrphanAttachments() {
  const old = db.prepare('SELECT id, path FROM attachments WHERE message_id IS NULL AND created_at < ?').all(now() - 24 * 3600_000);
  for (const a of old) {
    fs.rm(a.path, { force: true }, () => {});
    db.prepare('DELETE FROM attachments WHERE id = ?').run(a.id);
  }
}

const MAX_TOTAL_FILE_CHARS = 150_000;

function buildInput(text, atts) {
  const files = atts.filter((a) => a.kind === 'file');
  const images = atts.filter((a) => a.kind === 'image');
  let prompt = text || (images.length && !files.length ? 'Te mando esta imagen.' : 'Te mando estos archivos.');
  if (files.length) {
    let budget = MAX_TOTAL_FILE_CHARS;
    const blocks = files.map((f) => {
      let body = f.extracted || '';
      let note = f.note || '';
      if (body.length > budget) { body = body.slice(0, Math.max(0, budget)); note = 'Se recortó por ser muy largo.'; }
      budget -= body.length;
      const attrs = `nombre="${f.name.replace(/"/g, "'")}" tipo="${f.mime}"${note ? ` nota="${note}"` : ''}`;
      return body ? `<archivo ${attrs}>\n${body}\n</archivo>` : `<archivo ${attrs}>(sin contenido legible)</archivo>`;
    });
    prompt += `\n\n[El usuario adjuntó ${files.length === 1 ? 'un archivo' : `${files.length} archivos`}. ` +
      'Abajo va el texto extraído de cada uno; usalo para responder.]\n\n' + blocks.join('\n\n');
  }
  return [
    { type: 'text', text: prompt, text_elements: [] },
    ...images.map((a) => ({ type: 'localImage', path: a.path })),
  ];
}

function getChat(userId, chatId) {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ? AND user_id = ?').get(chatId, userId);
  if (!chat) throw new HttpError(404, 'Conversación no encontrada');
  return chat;
}

function cleanTitle(t) {
  return String(t || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function autoTitle(text) {
  const t = cleanTitle(text);
  return t.length > 48 ? t.slice(0, 47).trimEnd() + '…' : t || DEFAULT_TITLE;
}

// ---------------------------------------------------------------- chat turn (SSE)
const busyChats = new Set();

async function handleSend(req, res, user, chatId) {
  const chat = getChat(user.id, chatId);
  const body = await readJson(req);
  const text = String(body.text || '').trim();
  const ids = Array.isArray(body.attachmentIds) ? [...new Set(body.attachmentIds.map(String))] : [];
  if (!text && !ids.length) throw new HttpError(400, 'Escribí un mensaje');
  if (text.length > config.maxMessageChars) throw new HttpError(413, 'El mensaje es demasiado largo');
  if (ids.length > config.maxAttachmentsPerMessage) throw new HttpError(400, `Máximo ${config.maxAttachmentsPerMessage} adjuntos por mensaje`);
  const atts = ids.map((id) => db.prepare('SELECT * FROM attachments WHERE id = ? AND chat_id = ? AND message_id IS NULL').get(id, chat.id));
  if (atts.some((a) => !a)) throw new HttpError(400, 'Algún adjunto ya no está disponible. Volvé a subirlo.');
  const choice = await choiceFor(user.id, chat.model, chat.effort);
  if (atts.some((a) => a.kind === 'image') && choice.info && !choice.info.images) {
    throw new HttpError(400, 'El modelo elegido no acepta imágenes. Cambiá de modelo.');
  }
  if (busyChats.has(chat.id)) throw new HttpError(409, 'Esperá a que termine la respuesta anterior');
  busyChats.add(chat.id);

  try {
    const t = now();
    const userMsg = db.prepare('INSERT INTO messages (chat_id, role, content, created_at) VALUES (?, ?, ?, ?) RETURNING *')
      .get(chat.id, 'user', text, t);
    for (const a of atts) db.prepare('UPDATE attachments SET message_id = ? WHERE id = ?').run(userMsg.id, a.id);
    let title = chat.title;
    if (title === DEFAULT_TITLE) title = autoTitle(text || atts[0]?.name);
    db.prepare('UPDATE chats SET title = ?, updated_at = ? WHERE id = ?').run(title, t, chat.id);

    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let open = true;
    res.on('close', () => { open = false; });
    const emit = (event, data) => { if (open) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    const ping = setInterval(() => { if (open) res.write(': ping\n\n'); }, 15_000);

    emit('start', { userMessage: msgDto(userMsg, atts), title, model: choice.model, effort: choice.effort });

    let result;
    try {
      const threadId = await llm.ensureThread(chat.thread_id);
      if (threadId !== chat.thread_id) {
        db.prepare('UPDATE chats SET thread_id = ? WHERE id = ?').run(threadId, chat.id);
      }
      activeThreads.set(chat.id, threadId);
      result = await llm.runTurn(threadId, buildInput(text, atts), {
        model: choice.model, effort: choice.effort,
        onImage: (ev) => emit('drawing', ev),
      }, (d) => emit('delta', { t: d }));
    } catch (e) {
      result = { text: '', status: 'error', error: e.message };
    } finally {
      activeThreads.delete(chat.id);
      clearInterval(ping);
    }

    let content = result.text;
    if (result.status === 'error') {
      console.error(`[chat ${chat.id}] turn error: ${result.error}`);
      if (!content) content = 'No pude responder en este momento. Probá de nuevo en un ratito.';
    }
    const images = result.images || [];
    if (!content && result.imageFailures?.length) content = 'No pude dibujar la imagen: se alcanzó el límite de imágenes del plan. Probá más tarde.';
    const asst = db.prepare('INSERT INTO messages (chat_id, role, content, status, model, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *')
      .get(chat.id, 'assistant', content || (images.length ? '' : '…'), result.status, result.model || choice.model, now());
    const drawn = saveGeneratedImages(chat, asst.id, images);
    result.imagesSaved = drawn.length;
    db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(now(), chat.id);
    recordTurn(user, chat, choice, result, atts);

    if (result.status === 'error') emit('error', { message: content, assistantMessage: msgDto(asst, drawn) });
    else emit('done', { assistantMessage: msgDto(asst, drawn) });
    if (open) res.end();
  } finally {
    busyChats.delete(chat.id);
  }
}

const activeThreads = new Map(); // chatId -> threadId while a turn runs

// Images drawn by the assistant become attachments of the assistant message (same
// per-chat folder as uploads, so they are deleted with the chat).
function sniffImage(buf) {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ['image/png', '.png'];
  if (buf[0] === 0xff && buf[1] === 0xd8) return ['image/jpeg', '.jpg'];
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return ['image/webp', '.webp'];
  return null;
}

function saveGeneratedImages(chat, messageId, images) {
  const saved = [];
  for (const [i, img] of images.entries()) {
    try {
      let buf = null;
      if (img.result) buf = Buffer.from(String(img.result).replace(/^data:[^,]*,/, ''), 'base64');
      if ((!buf || !buf.length) && img.savedPath && img.savedPath.startsWith(path.join(config.llmHome, 'generated_images') + path.sep)) {
        buf = fs.readFileSync(img.savedPath);
      }
      const kind = buf && sniffImage(buf);
      if (!kind) { console.warn(`[images] chat ${chat.id}: unrecognized image data`); continue; }
      const id = crypto.randomUUID();
      const dir = chatAttDir(chat.id);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, id + kind[1]);
      fs.writeFileSync(file, buf, { mode: 0o600 });
      saved.push(db.prepare(`INSERT INTO attachments (id, chat_id, message_id, kind, name, mime, size, path, generated, created_at)
        VALUES (?, ?, ?, 'image', ?, ?, ?, ?, 1, ?) RETURNING *`)
        .get(id, chat.id, messageId, `dibujo-${i + 1}${kind[1]}`, kind[0], buf.length, file, now()));
    } catch (e) {
      console.error(`[images] chat ${chat.id}: could not save image: ${e.message}`);
    }
  }
  return saved;
}

/** The CLI keeps its own copy of drawn images per thread; drop it with the chat. */
function removeCliImages(threadId) {
  if (!threadId || !/^[\w-]+$/.test(threadId)) return;
  fs.rm(path.join(config.llmHome, 'generated_images', threadId), { recursive: true, force: true }, () => {});
}

// Usage metadata for the admin reports (no message text).
function recordTurn(user, chat, choice, result, atts) {
  const u = result.usage;
  try {
    db.prepare(`INSERT INTO turns (user_id, user_name, chat_id, model, effort, status, input_tokens, cached_input_tokens,
      output_tokens, reasoning_tokens, total_tokens, attachments, attachment_bytes, images, duration_ms, images_generated, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      user.id, user.displayName, chat.id, result.model || choice.model, choice.effort, result.status,
      u?.input ?? null, u?.cached ?? null, u?.output ?? null, u?.reasoning ?? null, u?.total ?? null,
      atts.length, atts.reduce((n, a) => n + a.size, 0), atts.filter((a) => a.kind === 'image').length,
      result.durationMs ?? null, result.imagesSaved || 0, now());
  } catch (e) {
    console.error('[stats] could not record turn:', e.message);
  }
}

// Behind a local reverse proxy every request comes from loopback,
// so trust X-Forwarded-For only then; otherwise the login rate limit would be shared.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function clientIp(req) {
  const peer = req.socket.remoteAddress || '?';
  const fwd = req.headers['x-forwarded-for'];
  if (LOOPBACK.has(peer) && typeof fwd === 'string' && fwd) return fwd.split(',').pop().trim();
  return peer;
}

// ---------------------------------------------------------------- API router
async function handleApi(req, res, url) {
  const method = req.method;
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
  if (method !== 'GET' && method !== 'HEAD') checkOrigin(req);

  const ip = clientIp(req);
  const token = parseCookies(req)[COOKIE];

  // ---- auth (public)
  if (parts[0] === 'auth' && parts[1] === 'config' && method === 'GET') {
    return sendJson(res, 200, { mode: config.authMode, rpId: config.rpId, appName: config.appName, appShortName: config.appShortName });
  }

  const startSession = (userId, passkeyId) => sendJson(res, 200, {
    user: (() => {
      const u = db.prepare('SELECT display_name, is_admin FROM users WHERE id = ?').get(userId);
      return { name: u.display_name, isAdmin: !!u.is_admin, modelPicker: canPickModel(userId) };
    })(),
  }, { 'Set-Cookie': sessionCookie(req, createSession(userId, passkeyId), config.sessionDays * 86400) });

  // ---- "aprobar dispositivo" (device mode)
  if (parts[0] === 'access' && config.authMode === 'device') {
    const REQ = 'shareit_req';
    const reqCookie = (v, maxAge) => `${REQ}=${v}; Path=/api/access; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
    const secret = parseCookies(req)[REQ];
    const view = (r) => ({
      status: r.status, code: r.code, expiresAt: r.expires_at, isNew: r.user_id == null, adminName: adminName(),
      // Greet a matched person by their real name ("lucia" → "Lucía").
      name: (r.user_id && db.prepare('SELECT display_name FROM users WHERE id = ?').get(r.user_id)?.display_name) || r.name,
    });
    const accessCall = (fn) => {
      try { return fn(); } catch (e) {
        if (e instanceof AccessError) {
          console.warn(`[access] ${parts[1]} failed ip=${ip}: ${e.message}`);
          throw new HttpError(e.status, e.message);
        }
        throw e;
      }
    };
    if (parts[1] === 'request' && method === 'POST') {
      limitOrThrow(`access-req:${ip}`, 20, 10 * 60_000);
      const { name } = await readJson(req);
      if (secret) cancelRequest(secret); // a new request replaces this device's previous one
      const { secret: s, request: r } = accessCall(() => createRequest(name, { ip, ua: req.headers['user-agent'] }));
      console.log(`[access] request #${r.id} name="${r.name}" ${r.user_id ? `user=${r.user_id}` : 'new-person'} code=${r.code} device="${r.device}" ip=${ip}`);
      return sendJson(res, 201, view(r), { 'Set-Cookie': reqCookie(s, config.accessRequestMinutes * 60) });
    }
    if (parts[1] === 'status' && method === 'GET') {
      limitOrThrow(`access-poll:${ip}`, 600, 10 * 60_000);
      const r = requestBySecret(secret);
      if (!r) return sendJson(res, 200, { status: 'none' });
      if (r.status === 'approved') {
        const c = claimApproved(secret);
        if (c) {
          const u = db.prepare('SELECT display_name, is_admin FROM users WHERE id = ?').get(c.userId);
          console.log(`[access] request #${r.id} claimed: device session for user=${c.userId}`);
          res.setHeader('Set-Cookie', [
            sessionCookie(req, c.token, config.sessionDays * 86400),
            reqCookie('', 0),
          ]);
          return sendJson(res, 200, { status: 'approved', user: { name: u.display_name, isAdmin: !!u.is_admin, modelPicker: canPickModel(c.userId) } });
        }
      }
      return sendJson(res, 200, view(r));
    }
    if (parts[1] === 'cancel' && method === 'POST') {
      cancelRequest(secret);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': reqCookie('', 0) });
    }
  }

  // Passkeys and invites only exist in passkey mode (code kept, switched off otherwise).
  if ((parts[0] === 'invites' || (parts[0] === 'auth' && parts[1] === 'passkey')) && config.authMode !== 'passkey') {
    throw new HttpError(404, 'No disponible');
  }

  if (parts[0] === 'auth' && parts[1] === 'passkey' && method === 'POST') {
    if (parts[2] === 'options') {
      limitOrThrow(`pk-opt:${ip}`, 30, 5 * 60_000);
      return sendJson(res, 200, await passkeyCall(req, 'login-options', () => authenticationOptions()));
    }
    if (parts[2] === 'verify') {
      limitOrThrow(`pk-verify:${ip}`, 20, 5 * 60_000);
      const { challengeId, response } = await readJson(req);
      const r = await passkeyCall(req, 'login-verify', () => verifyAuthentication(challengeId, response));
      console.log(`[passkey] login ok user=${r.userId} ip=${ip}`);
      return startSession(r.userId, r.passkeyId);
    }
    if (parts[2] === 'client-error') {
      // Errors inside the browser's passkey prompt never reach the server otherwise.
      limitOrThrow(`pk-cerr:${ip}`, 30, 10 * 60_000);
      const b = await readJson(req);
      const clean = (v, n) => String(v ?? '').replace(/[\r\n]+/g, ' ').slice(0, n);
      console.warn(`[passkey] client ${clean(b.stage, 20)} error ip=${ip} origin=${req.headers.origin || '-'} ` +
        `page=${clean(b.page, 80)} name=${clean(b.name, 40)} message="${clean(b.message, 300)}" ua="${clean(req.headers['user-agent'], 120)}"`);
      return sendJson(res, 200, { ok: true });
    }
  }

  if (parts[0] === 'invites' && parts[1]) {
    limitOrThrow(`invite:${ip}`, 30, 10 * 60_000);
    const token = parts[1];
    if (!parts[2] && method === 'GET') return sendJson(res, 200, await passkeyCall(req, 'invite-info', () => inviteInfo(token)));
    if (parts[2] === 'options' && method === 'POST') return sendJson(res, 200, await passkeyCall(req, 'register-options', () => registrationOptions(token)));
    if (parts[2] === 'verify' && method === 'POST') {
      const { challengeId, response, deviceName } = await readJson(req);
      const r = await passkeyCall(req, 'register-verify', () => verifyRegistration(token, challengeId, response, deviceName));
      console.log(`[passkey] registered user=${r.userId} ip=${ip}`);
      return startSession(r.userId, r.passkeyId);
    }
  }

  if (parts[0] === 'login' && method === 'POST') {
    if (config.authMode !== 'pin') throw new HttpError(404, 'El ingreso con PIN está desactivado. Usá tu passkey.');
    const { username, pin } = await readJson(req);
    const wait = loginBlocked(ip, username);
    if (wait) throw new HttpError(429, `Demasiados intentos. Probá de nuevo en ${wait} min.`);
    const r = login(username, pin);
    if (!r) {
      recordLoginFailure(ip, username);
      throw new HttpError(401, 'Nombre o PIN incorrecto');
    }
    clearLoginFailures(ip, username);
    return sendJson(res, 200, { user: { name: r.user.display_name, isAdmin: !!r.user.is_admin, modelPicker: canPickModel(r.user.id) } }, {
      'Set-Cookie': sessionCookie(req, r.token, config.sessionDays * 86400),
    });
  }

  if (parts[0] === 'logout' && method === 'POST') {
    logout(token);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  const user = userFromToken(token);
  if (!user) throw new HttpError(401, 'Tenés que ingresar');

  if (parts[0] === 'me' && method === 'GET') {
    // Re-issue the cookie so the browser's copy slides along with the server-side expiry.
    res.setHeader('Set-Cookie', sessionCookie(req, token, config.sessionDays * 86400));
    return sendJson(res, 200, { user: { name: user.displayName, isAdmin: user.isAdmin, modelPicker: canPickModel(user.id) } });
  }

  if (parts[0] === 'admin') return handleAdmin(req, res, user, parts, url, { readJson, sendJson, HttpError, inviteBase: () => inviteBase(req) });

  if (parts[0] === 'models' && method === 'GET') {
    const prefs = db.prepare('SELECT default_model, default_effort FROM users WHERE id = ?').get(user.id);
    const def = await choiceFor(user.id, prefs.default_model, prefs.default_effort);
    return sendJson(res, 200, {
      models: await llm.listModels(),
      defaults: { model: def.model, effort: def.effort },
      pickerAllowed: canPickModel(user.id),
    });
  }

  if (parts[0] === 'prefs' && method === 'PUT') {
    if (!canPickModel(user.id)) throw new HttpError(403, 'La elección de modelo está desactivada');
    const choice = await validateChoice(await readJson(req));
    db.prepare('UPDATE users SET default_model = ?, default_effort = ? WHERE id = ?').run(choice.model, choice.effort, user.id);
    return sendJson(res, 200, { ok: true });
  }

  if (parts[0] === 'attachments' && parts[1] && method === 'GET') return serveAttachment(req, res, user, parts[1]);

  if (parts[0] !== 'chats') throw new HttpError(404, 'No encontrado');
  const chatId = parts[1];

  if (!chatId) {
    if (method === 'GET') {
      const rows = db.prepare('SELECT * FROM chats WHERE user_id = ? ORDER BY updated_at DESC').all(user.id);
      return sendJson(res, 200, { chats: rows.map(chatDto) });
    }
    if (method === 'POST') {
      const body = await readJson(req);
      const t = now();
      const prefs = db.prepare('SELECT default_model, default_effort FROM users WHERE id = ?').get(user.id);
      const chat = db.prepare(`INSERT INTO chats (id, user_id, title, model, effort, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`)
        .get(crypto.randomUUID(), user.id, cleanTitle(body.title) || DEFAULT_TITLE, prefs.default_model, prefs.default_effort, t, t);
      return sendJson(res, 201, { chat: chatDto(chat) });
    }
  } else if (!parts[2]) {
    const chat = getChat(user.id, chatId);
    if (method === 'GET') return sendJson(res, 200, { chat: chatDto(chat) });
    if (method === 'PATCH') {
      const body = await readJson(req);
      const upd = { ...chat };
      if (body.title !== undefined) {
        upd.title = cleanTitle(body.title);
        if (!upd.title) throw new HttpError(400, 'Poné un nombre');
      }
      if (body.model !== undefined || body.effort !== undefined) {
        if (!canPickModel(user.id)) throw new HttpError(403, 'La elección de modelo está desactivada');
        const choice = await validateChoice(body);
        upd.model = choice.model;
        upd.effort = choice.effort;
        // The last choice becomes the default for new chats.
        db.prepare('UPDATE users SET default_model = ?, default_effort = ? WHERE id = ?').run(choice.model, choice.effort, user.id);
      }
      db.prepare('UPDATE chats SET title = ?, model = ?, effort = ? WHERE id = ?').run(upd.title, upd.model, upd.effort, chat.id);
      return sendJson(res, 200, { chat: chatDto(upd) });
    }
    if (method === 'DELETE') {
      if (busyChats.has(chat.id)) throw new HttpError(409, 'Esperá a que termine la respuesta');
      db.prepare('DELETE FROM chats WHERE id = ?').run(chat.id);
      removeChatFiles(chat.id);
      removeCliImages(chat.thread_id);
      if (chat.thread_id) {
        llm.start().then(() => llm.request('thread/archive', { threadId: chat.thread_id }))
          .catch((e) => console.warn('[llm] archive failed:', e.message));
      }
      return sendJson(res, 200, { ok: true });
    }
  } else if (parts[2] === 'messages') {
    if (method === 'GET') {
      const chat = getChat(user.id, chatId);
      const rows = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id').all(chat.id);
      const byMsg = new Map();
      for (const a of db.prepare('SELECT * FROM attachments WHERE chat_id = ? AND message_id IS NOT NULL ORDER BY created_at').all(chat.id)) {
        if (!byMsg.has(a.message_id)) byMsg.set(a.message_id, []);
        byMsg.get(a.message_id).push(a);
      }
      return sendJson(res, 200, {
        chat: chatDto(chat),
        messages: rows.map((m) => msgDto(m, byMsg.get(m.id))),
        busy: busyChats.has(chat.id),
      });
    }
    if (method === 'POST') return handleSend(req, res, user, chatId);
  } else if (parts[2] === 'attachments' && method === 'POST') {
    return handleUpload(req, res, user, chatId);
  } else if (parts[2] === 'attachments' && parts[3] && method === 'DELETE') {
    const chat = getChat(user.id, chatId);
    const a = db.prepare('SELECT * FROM attachments WHERE id = ? AND chat_id = ? AND message_id IS NULL').get(parts[3], chat.id);
    if (a) { fs.rm(a.path, { force: true }, () => {}); db.prepare('DELETE FROM attachments WHERE id = ?').run(a.id); }
    return sendJson(res, 200, { ok: true });
  } else if (parts[2] === 'stop' && method === 'POST') {
    const chat = getChat(user.id, chatId);
    const threadId = activeThreads.get(chat.id);
    const ok = threadId ? await llm.interrupt(threadId) : false;
    return sendJson(res, 200, { ok });
  }
  throw new HttpError(405, 'Método no permitido');
}

// ---------------------------------------------------------------- static files
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escJson = (s) => JSON.stringify(String(s)).slice(1, -1);
function brand(text, kind) {
  const esc = kind === '.webmanifest' ? escJson : escHtml;
  return text.replaceAll('{{APP_NAME}}', esc(config.appName)).replaceAll('{{APP_SHORT_NAME}}', esc(config.appShortName));
}
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/admin' || rel === '/admin/') rel = '/admin.html';
  else if (rel === '/' || !path.extname(rel)) rel = '/index.html'; // SPA fallback
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: 'No encontrado' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: 'No encontrado' });
    const headers = {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      'Last-Modified': st.mtime.toUTCString(),
    };
    if (path.basename(file) === 'sw.js') headers['Service-Worker-Allowed'] = '/';
    // HTML and the manifest carry the app name: fill it in from SHAREIT_APP_NAME.
    if (['.html', '.webmanifest'].includes(path.extname(file))) {
      const body = Buffer.from(brand(fs.readFileSync(file, 'utf8'), path.extname(file)));
      headers['Content-Length'] = body.length;
      delete headers['Last-Modified'];
      res.writeHead(200, headers);
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    const ims = req.headers['if-modified-since'];
    if (ims && new Date(ims).getTime() >= Math.floor(st.mtimeMs / 1000) * 1000) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método no permitido');
    return serveStatic(req, res, url);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    if (res.headersSent) return res.end();
    sendJson(res, status, { error: status === 500 ? 'Error interno' : e.message });
  }
});

server.requestTimeout = 0; // long SSE responses

// Home LAN only: drop connections from outside the local network before any HTTP.
if (config.lanOnly) {
  server.on('connection', (socket) => {
    if (!isLanAddress(socket.remoteAddress)) {
      console.warn(`[shareit] rejected non-LAN connection from ${socket.remoteAddress}`);
      socket.destroy();
    }
  });
}
server.listen(config.port, config.host, () => {
  console.log(`[shareit] listening on http://${config.host}:${config.port} (data: ${config.dataDir})`);
});

purgeExpiredSessions();
if (config.authMode === 'device') {
  const n = purgeNonDeviceSessions();
  if (n) console.log(`[shareit] device mode: closed ${n} non-device session(s)`);
}
if (config.authMode === 'passkey') {
  const n = purgePinSessions();
  if (n) console.log(`[shareit] passkey mode: closed ${n} PIN session(s)`);
}
cleanupOrphanAttachments();
setInterval(() => { purgeExpiredSessions(); cleanupOrphanAttachments(); }, 6 * 3600_000).unref();
llm.start().catch((e) => console.error('[llm] initial start failed:', e.message));

function shutdown() {
  console.log('[shareit] shutting down');
  llm.stop();
  server.close();
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
