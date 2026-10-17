import os from 'node:os';
import path from 'node:path';

const home = os.homedir();
// Allow "~/..." in env files (systemd's EnvironmentFile doesn't expand it).
const expand = (p) => (p && p.startsWith('~/') ? path.join(home, p.slice(2)) : p);

// The headless CLI of your AI subscription (must speak the app-server JSON-RPC
// protocol over stdio). This default is the only place its name appears.
const DEFAULT_LLM_BIN = 'codex';
// Older installs used env names derived from the CLI name (SHAREIT_<CLI>_MODEL…)
// and the CLI's own <CLI>_HOME variable; they are still accepted as fallbacks.
const LEGACY = DEFAULT_LLM_BIN.toUpperCase();
const legacyEnv = (key) => process.env[`SHAREIT_${LEGACY}_${key}`];
const llmBin = process.env.SHAREIT_LLM_BIN || legacyEnv('BIN') || DEFAULT_LLM_BIN;
const binTag = path.basename(llmBin).toUpperCase().replace(/[^A-Z0-9]/g, '_');

export const config = {
  // Branding shown in the UI, the PWA manifest and the browser tab.
  appName: process.env.SHAREIT_APP_NAME || 'Charla en familia',
  appShortName: process.env.SHAREIT_APP_SHORT_NAME || process.env.SHAREIT_APP_NAME || 'Charla',
  // Optional file with the assistant's instructions (replaces the built-in Spanish ones).
  instructionsFile: expand(process.env.SHAREIT_INSTRUCTIONS_FILE || ''),
  host: process.env.SHAREIT_HOST || '::', // dual-stack (IPv4 + IPv6)
  port: Number(process.env.SHAREIT_PORT || 8787),
  dataDir: expand(process.env.SHAREIT_DATA_DIR) || path.join(home, 'shareit-data'),
  llmBin,
  // Optional defaults; empty = whatever the CLI/provider uses by default.
  llmModel: process.env.SHAREIT_LLM_MODEL || legacyEnv('MODEL') || '',
  llmEffort: process.env.SHAREIT_LLM_EFFORT || legacyEnv('EFFORT') || '',
  // Sessions are sliding: each use pushes the expiry this many days ahead.
  sessionDays: Number(process.env.SHAREIT_SESSION_DAYS || 365),
  // Initial value of "Permitir elegir modelo" (the admin panel setting overrides it).
  modelPicker: process.env.SHAREIT_MODEL_PICKER !== '0',
  // Login: 'device' (default: type your name, an admin approves the device),
  // 'passkey' (WebAuthn, kept but off by default) or 'pin' (legacy numeric PIN).
  authMode: ['pin', 'passkey'].includes(process.env.SHAREIT_AUTH) ? process.env.SHAREIT_AUTH : 'device',
  accessRequestMinutes: Number(process.env.SHAREIT_REQUEST_MINUTES || 15),
  // Same phone, another browser/installed app: auto-approve a request for an existing
  // person from the same IP where they have a device used in the last N days (0 = off).
  autoApproveDays: Number(process.env.SHAREIT_AUTO_APPROVE_DAYS ?? 30),
  // WebAuthn relying party. RP ID = registrable domain shared by all origins
  // (e.g. "home.example.com" for https://chat.home.example.com).
  rpId: process.env.SHAREIT_RP_ID || 'localhost',
  rpName: process.env.SHAREIT_RP_NAME || process.env.SHAREIT_APP_NAME || 'Charla en familia',
  // Comma-separated exact origins allowed to use passkeys.
  origins: (process.env.SHAREIT_ORIGINS || `http://localhost:${Number(process.env.SHAREIT_PORT || 8787)}`)
    .split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),
  // Base URL used in invite links printed by the CLI (default: first origin).
  publicUrl: (process.env.SHAREIT_PUBLIC_URL || '').replace(/\/$/, ''),
  inviteHours: Number(process.env.SHAREIT_INVITE_HOURS || 24),
  // Let the assistant draw images in the chat (see server/llm.js for what it enables).
  imageGeneration: process.env.SHAREIT_IMAGE_GENERATION !== '0',
  lanOnly: process.env.SHAREIT_LAN_ONLY !== '0',
  // Reports group by day in this offset (minutes from UTC). Argentina = -180.
  tzOffsetMin: Number(process.env.SHAREIT_TZ_OFFSET_MIN ?? -180),
  maxMessageChars: 8000,
  maxUploadBytes: Number(process.env.SHAREIT_MAX_UPLOAD_MB || 20) * 1024 * 1024,
  maxAttachmentsPerMessage: 10,
  // The CLI's state folder (login, sessions, generated images). Default ~/.<cli-name>.
  llmHome: expand(process.env.SHAREIT_LLM_HOME || process.env[`${LEGACY}_HOME`]) || path.join(home, `.${path.basename(llmBin)}`),
  // Env var the CLI reads for its home folder (<CLI>_HOME); set only if SHAREIT_LLM_HOME is given.
  llmHomeEnv: `${binTag}_HOME`,
  // Name of the chats column that older installs used for the thread id.
  legacyThreadColumn: `${DEFAULT_LLM_BIN}_thread_id`,
};

config.dbPath = path.join(config.dataDir, 'shareit.db');
config.workspaceDir = path.join(config.dataDir, 'workspace');
config.attachmentsDir = path.join(config.dataDir, 'attachments');
