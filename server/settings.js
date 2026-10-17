// App-wide settings editable from the admin panel (stored in SQLite), plus the
// model-choice policy: who may pick a model, and what everyone else gets.
import { db } from './db.js';
import { config } from './config.js';
import { llm } from './llm.js';

db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');

export function getSetting(key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}

export function setSetting(key, value) {
  if (value == null) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

/** Global "Permitir elegir modelo". DB setting wins; SHAREIT_MODEL_PICKER is the initial value. */
export function pickerGlobal() {
  const v = getSetting('model_picker');
  return v == null ? config.modelPicker : v === '1';
}

/** Model + effort used by people who can't pick (and as fallback for everyone). */
export function adminDefault() {
  return {
    model: getSetting('default_model') || config.llmModel || null,
    effort: getSetting('default_effort') || config.llmEffort || null,
  };
}

/** Per-user override: NULL = inherit global, 1 = allow, 0 = hide. */
export function canPickModel(userId) {
  const row = db.prepare('SELECT model_picker FROM users WHERE id = ?').get(userId);
  if (!row || row.model_picker == null) return pickerGlobal();
  return row.model_picker === 1;
}

/** Turns a wanted model/effort into a valid one from the provider's catalog. */
export async function resolveModel(wantedModel, wantedEffort) {
  const def = adminDefault();
  wantedModel ||= def.model;
  wantedEffort ||= def.effort;
  const models = await llm.listModels();
  const model = models.find((m) => m.id === wantedModel) || models.find((m) => m.isDefault) || models[0] || null;
  if (!model) return { model: null, effort: null, info: null };
  const effort = model.efforts.some((e) => e.value === wantedEffort) ? wantedEffort : model.defaultEffort;
  return { model: model.id, effort, info: model };
}

/** The model this user's turn will actually use (admin default if they can't pick). */
export async function choiceFor(userId, wantedModel, wantedEffort) {
  if (!canPickModel(userId)) {
    const d = adminDefault();
    return resolveModel(d.model, d.effort);
  }
  return resolveModel(wantedModel, wantedEffort);
}
