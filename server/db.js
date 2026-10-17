import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

export const db = new DatabaseSync(config.dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,      -- lowercase login name
    display_name TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    thread_id TEXT,                 -- conversation id in the LLM CLI
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chats_user ON chats(user_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'done',  -- done | error | interrupted
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, id);

  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,  -- NULL until sent
    kind TEXT NOT NULL,          -- image | file
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    path TEXT NOT NULL,
    extracted TEXT,              -- text pulled out of documents
    note TEXT,                   -- why extraction failed / was truncated
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS attachments_msg ON attachments(message_id);
  CREATE INDEX IF NOT EXISTS attachments_chat ON attachments(chat_id);
`);

// Older installs named the thread column after the CLI: rename it once.
{
  const cols = db.prepare('PRAGMA table_info(chats)').all().map((c) => c.name);
  if (cols.includes(config.legacyThreadColumn) && !cols.includes('thread_id')) {
    db.exec(`ALTER TABLE chats RENAME COLUMN ${config.legacyThreadColumn} TO thread_id`);
  }
}

// Lightweight migrations for columns added after the first release.
function addColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
addColumn('chats', 'model', 'TEXT');
addColumn('chats', 'effort', 'TEXT');
addColumn('messages', 'model', 'TEXT');
addColumn('users', 'default_model', 'TEXT');
addColumn('users', 'default_effort', 'TEXT');
addColumn('users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'last_active_at', 'INTEGER');
addColumn('users', 'model_picker', 'INTEGER');
addColumn('attachments', 'generated', 'INTEGER NOT NULL DEFAULT 0'); // 1 = image drawn by the assistant
addColumn('users', 'webauthn_id', 'TEXT');        // random user handle for passkeys (base64url)
addColumn('sessions', 'passkey_id', 'TEXT');      // passkey that created the session, if any
addColumn('sessions', 'auth_method', 'TEXT');     // 'pin' | 'passkey' | 'device' (NULL = older PIN sessions)
addColumn('sessions', 'device_name', 'TEXT');     // e.g. "iPhone · Safari" (device-approval sessions)
addColumn('sessions', 'last_used_at', 'INTEGER');

// "Aprobar dispositivo": a device asks for access with a name; an admin approves it.
db.exec(`
  CREATE TABLE IF NOT EXISTS access_requests (
    id INTEGER PRIMARY KEY,
    secret_hash TEXT NOT NULL UNIQUE,    -- sha256 of the secret kept in the device's httpOnly cookie
    name TEXT NOT NULL,                  -- as typed
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- matched existing person (NULL = new person)
    code INTEGER NOT NULL,               -- 2-digit code shown on both screens
    device TEXT,                         -- "iPhone · Safari"
    ip TEXT,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | cancelled | consumed
    approved_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    decided_by INTEGER,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS access_requests_status ON access_requests(status, expires_at);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS passkeys (
    id TEXT PRIMARY KEY,                 -- credential ID (base64url)
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key BLOB NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT,                     -- JSON array
    device_type TEXT,                    -- singleDevice | multiDevice
    backed_up INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys(user_id);

  CREATE TABLE IF NOT EXISTS invites (
    token_hash TEXT PRIMARY KEY,         -- sha256 of the token in the link
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_by INTEGER,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS invites_user ON invites(user_id);
`);  // NULL = global setting, 1 = allow, 0 = hide

// One row per assistant turn: metadata only (never message text), used for the
// admin usage reports. Kept when chats/users are deleted so totals stay right.
db.exec(`
  CREATE TABLE IF NOT EXISTS turns (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    user_name TEXT NOT NULL,
    chat_id TEXT,
    model TEXT,
    effort TEXT,
    status TEXT NOT NULL,              -- done | error | interrupted
    input_tokens INTEGER,
    cached_input_tokens INTEGER,
    output_tokens INTEGER,
    reasoning_tokens INTEGER,
    total_tokens INTEGER,
    attachments INTEGER NOT NULL DEFAULT 0,
    attachment_bytes INTEGER NOT NULL DEFAULT 0,
    images INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS turns_time ON turns(created_at);
  CREATE INDEX IF NOT EXISTS turns_user ON turns(user_id, created_at);
`);
addColumn('turns', 'images_generated', 'INTEGER NOT NULL DEFAULT 0');

// Backfill turns from history recorded before the table existed (no token data).
if (!db.prepare('SELECT 1 FROM turns LIMIT 1').get()) {
  db.exec(`
    INSERT INTO turns (user_id, user_name, chat_id, model, status, attachments, attachment_bytes, images, created_at)
    SELECT c.user_id, u.display_name, c.id, m.model, m.status,
      COALESCE((SELECT COUNT(*) FROM attachments a WHERE a.message_id = (SELECT MAX(p.id) FROM messages p WHERE p.chat_id = m.chat_id AND p.id < m.id AND p.role = 'user')), 0),
      COALESCE((SELECT SUM(size) FROM attachments a WHERE a.message_id = (SELECT MAX(p.id) FROM messages p WHERE p.chat_id = m.chat_id AND p.id < m.id AND p.role = 'user')), 0),
      COALESCE((SELECT COUNT(*) FROM attachments a WHERE a.kind = 'image' AND a.message_id = (SELECT MAX(p.id) FROM messages p WHERE p.chat_id = m.chat_id AND p.id < m.id AND p.role = 'user')), 0),
      m.created_at
    FROM messages m JOIN chats c ON c.id = m.chat_id JOIN users u ON u.id = c.user_id
    WHERE m.role = 'assistant'
  `);
}

export const now = () => Date.now();
