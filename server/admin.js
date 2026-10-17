// Admin API (/api/admin/*). Every route re-checks is_admin from the database.
// Reports are metadata only: no endpoint here returns message text or titles.
import { db, now } from './db.js';
import { config } from './config.js';
import { llm } from './llm.js';
import {
  UserError, createUser, deleteUser, getUser, listUsers, renameUser,
  revokeSessions, setAdmin, setModelPicker, setPin,
} from './users.js';
import QRCode from 'qrcode';
import {
  AccessError, approveRequest, disconnectDevice, listDevices, listPending, recentAutoApprovals, rejectRequest,
} from './access.js';
import {
  PasskeyError, createInvite, deletePasskey, inviteUrl, listPasskeys, renamePasskey,
} from './passkeys.js';
import { adminDefault, canPickModel, pickerGlobal, resolveModel, setSetting } from './settings.js';

export function isAdmin(user) {
  return !!db.prepare('SELECT is_admin FROM users WHERE id = ?').get(user.id)?.is_admin;
}

const userDto = (id) => {
  const u = listUsers().find((x) => x.id === id);
  return u && { ...u, canPickModel: canPickModel(u.id) };
};

async function settingsDto() {
  const d = adminDefault();
  const eff = await resolveModel(d.model, d.effort); // what people without the picker get
  return {
    modelPicker: pickerGlobal(),
    defaultModel: d.model, defaultEffort: d.effort,
    effectiveModel: eff.model, effectiveEffort: eff.effort,
    models: await llm.listModels(),
  };
}

/** Returns true if handled. `h` = { readJson, sendJson, HttpError }. */
export async function handleAdmin(req, res, user, parts, url, h) {
  const { readJson, sendJson, HttpError } = h;
  const makeInvite = async (uid) => {
    const { token, expiresAt } = createInvite(uid, user.id);
    const url = inviteUrl(token, h.inviteBase());
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return { url, expiresAt, qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` };
  };
  if (!isAdmin(user)) throw new HttpError(403, 'Solo para administradores');
  const method = req.method;
  const [, section, id, action] = parts; // parts[0] === 'admin'

  try {
    if (section === 'users') {
      if (!id && method === 'GET') {
        return sendJson(res, 200, { users: listUsers().map((u) => ({ ...u, canPickModel: canPickModel(u.id) })), me: user.id });
      }
      if (!id && method === 'POST') {
        const b = await readJson(req);
        const u = createUser(b.name, b.pin, { isAdmin: !!b.isAdmin });
        // In passkey mode the person enrolls with an invite link right away.
        const invite = config.authMode === 'passkey' ? await makeInvite(u.id) : null;
        // (device mode: the person just opens the app and taps "Pedir acceso")
        return sendJson(res, 201, { user: userDto(u.id), invite });
      }
      const uid = Number(id);
      if (!Number.isInteger(uid)) throw new HttpError(404, 'No encontrado');
      getUser(uid);
      if (!action && method === 'PATCH') {
        const b = await readJson(req);
        if (b.name !== undefined) renameUser(uid, b.name);
        if (b.pin !== undefined) setPin(uid, String(b.pin));
        if (b.isAdmin !== undefined) setAdmin(uid, !!b.isAdmin);
        if (b.modelPicker !== undefined) setModelPicker(uid, String(b.modelPicker));
        return sendJson(res, 200, { user: userDto(uid) });
      }
      if (!action && method === 'DELETE') {
        const r = deleteUser(uid);
        return sendJson(res, 200, { ok: true, chats: r.chats });
      }
      if (action === 'devices' && method === 'GET') return sendJson(res, 200, { devices: listDevices(uid) });
      if (action === 'invite' && method === 'POST') return sendJson(res, 201, { invite: await makeInvite(uid) });
      if (action === 'passkeys' && method === 'GET') return sendJson(res, 200, { passkeys: listPasskeys(uid) });
      if (action === 'revoke' && method === 'POST') {
        // Revoking yourself keeps the session you are using right now.
        const n = revokeSessions(uid, uid === user.id ? user.sessionHash : null);
        return sendJson(res, 200, { ok: true, revoked: n });
      }
    }

    if (section === 'requests') {
      if (!id && method === 'GET') return sendJson(res, 200, { requests: listPending(), recentAuto: recentAutoApprovals() });
      if (id && action === 'approve' && method === 'POST') {
        const b = await readJson(req);
        const asUserId = b.asUserId != null && b.asUserId !== '' ? Number(b.asUserId) : null;
        const r = approveRequest({ id }, { asUserId, by: user.id });
        console.log(`[access] request #${r.request.id} approved by user=${user.id} as user=${r.userId}${r.created ? ' (new person)' : ''}`);
        return sendJson(res, 200, { ok: true, userId: r.userId, created: r.created });
      }
      if (id && action === 'reject' && method === 'POST') {
        const r = rejectRequest({ id }, { by: user.id });
        console.log(`[access] request #${r.id} rejected by user=${user.id}`);
        return sendJson(res, 200, { ok: true });
      }
    }

    if (section === 'devices' && id && method === 'DELETE') {
      disconnectDevice(id);
      return sendJson(res, 200, { ok: true });
    }

    if (section === 'passkeys' && id) {
      if (method === 'PATCH') { renamePasskey(id, (await readJson(req)).name); return sendJson(res, 200, { ok: true }); }
      if (method === 'DELETE') { deletePasskey(id); return sendJson(res, 200, { ok: true }); }
    }

    if (section === 'settings') {
      if (method === 'GET') return sendJson(res, 200, await settingsDto());
      if (method === 'PUT') {
        const b = await readJson(req);
        if (b.modelPicker !== undefined) setSetting('model_picker', b.modelPicker ? '1' : '0');
        if (b.defaultModel !== undefined) {
          const models = await llm.listModels();
          const m = models.find((x) => x.id === b.defaultModel);
          if (b.defaultModel && !m) throw new HttpError(400, 'Ese modelo no está disponible');
          const effort = b.defaultEffort || null;
          if (m && effort && !m.efforts.some((e) => e.value === effort)) throw new HttpError(400, 'Nivel de razonamiento inválido');
          setSetting('default_model', m ? m.id : null);
          setSetting('default_effort', m ? effort : null);
        }
        return sendJson(res, 200, await settingsDto());
      }
    }

    if (section === 'usage' && method === 'GET') return sendJson(res, 200, usageReport(url.searchParams));

    if (section === 'limits' && method === 'GET') {
      return sendJson(res, 200, { limits: formatLimits(await llm.readRateLimits()) });
    }
  } catch (e) {
    if (e instanceof UserError || e instanceof PasskeyError || e instanceof AccessError) throw new HttpError(e.status, e.message);
    throw e;
  }
  throw new HttpError(404, 'No encontrado');
}

// ---------------------------------------------------------------- reports
function usageReport(q) {
  const period = q.get('period') === 'week' ? 'week' : 'day';
  const days = Math.min(Math.max(Number(q.get('days')) || (period === 'week' ? 84 : 30), 1), 366);
  const userId = q.get('userId') ? Number(q.get('userId')) : null;
  const off = config.tzOffsetMin * 60;
  const local = `date(created_at / 1000 + ${off}, 'unixepoch')`;
  const bucket = period === 'week' ? `date(${local}, '-6 days', 'weekday 1')` : local;

  // Start at local midnight `days-1` days ago (aligned to Monday for weeks).
  const todayLocal = new Date(now() + off * 1000);
  const start = new Date(Date.UTC(todayLocal.getUTCFullYear(), todayLocal.getUTCMonth(), todayLocal.getUTCDate() - (days - 1)));
  if (period === 'week') start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  const since = start.getTime() - off * 1000;

  const where = `created_at >= ?${userId ? ' AND user_id = ?' : ''}`;
  const args = userId ? [since, userId] : [since];
  const metrics = `
    COUNT(*) AS messages,
    SUM(status = 'done') AS ok,
    SUM(status = 'error') AS errors,
    SUM(status = 'interrupted') AS interrupted,
    COALESCE(SUM(input_tokens), 0) AS inputTokens,
    COALESCE(SUM(cached_input_tokens), 0) AS cachedTokens,
    COALESCE(SUM(output_tokens), 0) AS outputTokens,
    COALESCE(SUM(reasoning_tokens), 0) AS reasoningTokens,
    COALESCE(SUM(total_tokens), 0) AS totalTokens,
    COALESCE(SUM(attachments), 0) AS attachments,
    COALESCE(SUM(images), 0) AS images,
    COALESCE(SUM(images_generated), 0) AS imagesGenerated,
    COALESCE(SUM(attachment_bytes), 0) AS attachmentBytes,
    CAST(COALESCE(AVG(duration_ms), 0) AS INTEGER) AS avgDurationMs`;

  const rows = db.prepare(`SELECT ${bucket} AS bucket, ${metrics} FROM turns WHERE ${where} GROUP BY bucket ORDER BY bucket`).all(...args);
  const byBucket = new Map(rows.map((r) => [r.bucket, r]));
  const series = [];
  const step = period === 'week' ? 7 : 1;
  for (let d = new Date(start); d.getTime() <= todayLocal.getTime(); d.setUTCDate(d.getUTCDate() + step)) {
    const key = d.toISOString().slice(0, 10);
    series.push({ bucket: key, ...(byBucket.get(key) || emptyMetrics()) });
  }

  const totals = db.prepare(`SELECT ${metrics} FROM turns WHERE ${where}`).get(...args);
  const byUser = db.prepare(`SELECT user_id AS userId, user_name AS name, ${metrics}, MAX(created_at) AS lastAt
    FROM turns WHERE ${where} GROUP BY COALESCE(user_id, -1), CASE WHEN user_id IS NULL THEN user_name END
    ORDER BY messages DESC`).all(...args)
    .map((r) => ({ ...r, deleted: r.userId == null }));
  const byModel = db.prepare(`SELECT COALESCE(model, '?') AS model, COALESCE(effort, '') AS effort,
    COUNT(*) AS messages, COALESCE(SUM(total_tokens), 0) AS totalTokens
    FROM turns WHERE ${where} GROUP BY model, effort ORDER BY messages DESC`).all(...args);
  const storage = db.prepare(`SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM attachments a
    ${userId ? 'JOIN chats c ON c.id = a.chat_id WHERE c.user_id = ?' : ''}`).get(...(userId ? [userId] : []));

  return { period, days, since, userId, tzOffsetMin: config.tzOffsetMin, series, totals, byUser, byModel, storage };
}

function emptyMetrics() {
  return {
    messages: 0, ok: 0, errors: 0, interrupted: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0,
    reasoningTokens: 0, totalTokens: 0, attachments: 0, images: 0, imagesGenerated: 0, attachmentBytes: 0, avgDurationMs: 0,
  };
}

// ---------------------------------------------------------------- rate limits
function formatLimits(r) {
  if (!r) return null;
  const snap = (s) => s && ({
    id: s.limitId || null,
    name: s.limitName || null, // human name if the provider sends one (raw ids are not shown)
    plan: s.planType || null,
    reached: s.rateLimitReachedType || null,
    windows: ['primary', 'secondary'].map((k) => s[k] && ({
      kind: k,
      usedPercent: s[k].usedPercent,
      windowMins: s[k].windowDurationMins,
      resetsAt: s[k].resetsAt ? s[k].resetsAt * 1000 : null,
    })).filter(Boolean),
    credits: s.credits || null,
  });
  const buckets = r.rateLimitsByLimitId
    ? Object.values(r.rateLimitsByLimitId).filter(Boolean).map(snap)
    : [snap(r.rateLimits)].filter(Boolean);
  return {
    updatedAt: r.at || now(),
    ordinaryUsageAllowed: r.ordinaryUsageAllowed ?? null,
    plan: r.rateLimits?.planType || buckets.find((b) => b.plan)?.plan || null,
    buckets: buckets.length ? buckets : [snap(r.rateLimits)].filter(Boolean),
  };
}
