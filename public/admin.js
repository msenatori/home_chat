'use strict';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const state = { me: null, users: [], usageLoaded: false, authMode: 'device', appName: 'la app' };

const nf = new Intl.NumberFormat('es-AR');
const fmtN = (n) => nf.format(n || 0);
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.', ',')} M` : n >= 1e4 ? `${Math.round(n / 1e3)} k` : fmtN(n));
const fmtBytes = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1).replace('.', ',')} MB`);
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleDateString('es-AR', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
function fmtAgo(ts) {
  if (!ts) return 'nunca';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 2) return 'recién';
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return d < 30 ? `hace ${d} días` : fmtDate(ts);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401) { location.href = '/'; throw new Error('Tenés que ingresar'); }
  if (!res.ok) throw new Error(data.error || 'Algo salió mal');
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
}

// ------------------------------------------------------------------ dialogs
function openDialog(dlg) {
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.returnValue = '';
    dlg.showModal();
  });
}

/** In-page confirmation. `action` runs on confirm; errors are shown inside the dialog. */
function confirmAction({ title, text, ok = 'Confirmar', danger = true, action }) {
  const dlg = $('#dlg-confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  const btn = $('#confirm-ok');
  btn.textContent = ok;
  btn.className = danger ? 'btn-danger' : 'btn-primary';
  const err = $('#confirm-error');
  err.hidden = true;
  const onClick = async (e) => {
    e.preventDefault();
    btn.disabled = true;
    try {
      await action();
      dlg.close('ok');
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally { btn.disabled = false; }
  };
  btn.addEventListener('click', onClick);
  dlg.addEventListener('close', () => btn.removeEventListener('click', onClick), { once: true });
  return openDialog(dlg);
}

/** Generic user form: fields = subset of ['name','pin','admin']. */
function userForm({ title, fields, values = {}, okText = 'Guardar', submit }) {
  const dlg = $('#dlg-user');
  $('#dlg-user-title').textContent = title;
  $('#fld-name').hidden = !fields.includes('name');
  $('#fld-pin').hidden = !fields.includes('pin');
  $('#fld-admin').hidden = !fields.includes('admin');
  $('#in-name').value = values.name || '';
  $('#in-pin').value = '';
  $('#in-admin').checked = !!values.isAdmin;
  const err = $('#dlg-user-error');
  err.hidden = true;
  const btn = $('#dlg-user-ok');
  btn.textContent = okText;
  const onClick = async (e) => {
    e.preventDefault();
    btn.disabled = true;
    try {
      await submit({ name: $('#in-name').value.trim(), pin: $('#in-pin').value.trim(), isAdmin: $('#in-admin').checked });
      dlg.close('ok');
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally { btn.disabled = false; }
  };
  btn.addEventListener('click', onClick);
  dlg.addEventListener('close', () => btn.removeEventListener('click', onClick), { once: true });
  setTimeout(() => (fields.includes('name') ? $('#in-name') : $('#in-pin')).focus(), 50);
  return openDialog(dlg);
}

// ------------------------------------------------------------------ users
async function loadUsers() {
  const { users, me } = await api('/admin/users');
  state.users = users;
  state.me = me;
  renderUsers();
  fillUserFilter();
}

function renderUsers() {
  const list = $('#user-list');
  list.textContent = '';
  for (const u of state.users) {
    const card = el('article', 'card');
    const head = el('div', 'card-head');
    head.append(el('span', 'avatar', (u.name[0] || '?').toUpperCase()), el('strong', null, u.name));
    if (u.isAdmin) head.append(el('span', 'badge', 'admin'));
    if (u.id === state.me) head.append(el('span', 'badge me', 'vos'));
    const meta = el('dl', 'meta');
    for (const [k, v] of [
      ['Última actividad', fmtAgo(u.lastActiveAt)], ['Creado', fmtDate(u.createdAt)],
      ['Charlas', fmtN(u.chats)], [state.authMode === 'device' ? 'Dispositivos conectados' : 'Sesiones abiertas', fmtN(u.sessions)], ['Adjuntos guardados', fmtBytes(u.storageBytes)],
      ...(state.authMode === 'passkey' ? [['Passkeys', u.inviteUntil ? `${fmtN(u.passkeys)} · invitación pendiente` : fmtN(u.passkeys)]] : []),
    ]) meta.append(el('dt', null, k), el('dd', null, v));
    // Per-person override for the model picker.
    const pick = el('label', 'picker-row');
    pick.append(el('span', null, `Elegir modelo${u.modelPicker === 'inherit' ? ` (ahora: ${u.canPickModel ? 'sí' : 'no'})` : ''}`));
    const sel = el('select');
    for (const [v, t] of [['inherit', 'Como el ajuste general'], ['allow', 'Permitir'], ['hide', 'Ocultar']]) {
      const o = el('option', null, t); o.value = v; sel.append(o);
    }
    sel.value = u.modelPicker;
    sel.addEventListener('change', async () => {
      try {
        await api(`/admin/users/${u.id}`, { method: 'PATCH', body: { modelPicker: sel.value } });
        toast('Listo');
        await loadUsers();
      } catch (e) { toast(e.message); sel.value = u.modelPicker; }
    });
    pick.append(sel);
    const actions = el('div', 'actions-row');
    const act = (label, fn, cls) => { const b = el('button', cls, label); b.type = 'button'; b.addEventListener('click', fn); actions.append(b); };
    act('Cambiar nombre', () => userForm({
      title: `Cambiar nombre de ${u.name}`, fields: ['name'], values: u,
      submit: async (v) => { await api(`/admin/users/${u.id}`, { method: 'PATCH', body: { name: v.name } }); toast('Nombre cambiado'); await loadUsers(); },
    }));
    if (state.authMode === 'device') act('Dispositivos', () => showDevices(u));
    if (state.authMode === 'passkey') {
      act('Passkeys', () => showPasskeys(u));
      act('Nueva invitación', () => newInvite(u));
    }
    if (state.authMode === 'pin') {
      act('Cambiar PIN', () => userForm({
        title: `Nuevo PIN para ${u.name}`, fields: ['pin'], okText: 'Cambiar PIN',
        submit: async (v) => { await api(`/admin/users/${u.id}`, { method: 'PATCH', body: { pin: v.pin } }); toast('PIN cambiado; se cerraron sus sesiones'); await loadUsers(); },
      }));
    }
    act('Cerrar sesiones', () => confirmAction({
      title: `¿Cerrar las sesiones de ${u.name}?`,
      text: u.id === state.me ? 'Se cierran tus otras sesiones; esta queda abierta.' : 'Va a tener que volver a ingresar con su PIN en todos sus dispositivos.',
      ok: 'Cerrar sesiones', danger: false,
      action: async () => { const r = await api(`/admin/users/${u.id}/revoke`, { method: 'POST', body: {} }); toast(`Se cerraron ${r.revoked} sesiones`); await loadUsers(); },
    }));
    act(u.isAdmin ? 'Quitar admin' : 'Hacer admin', () => confirmAction({
      title: u.isAdmin ? `¿Quitarle el rol de administrador a ${u.name}?` : `¿Hacer administrador a ${u.name}?`,
      text: u.isAdmin ? 'Ya no va a poder entrar a esta sección.' : 'Va a poder manejar cuentas y ver los reportes de uso (no las conversaciones).',
      ok: u.isAdmin ? 'Quitar admin' : 'Hacer admin', danger: u.isAdmin,
      action: async () => {
        await api(`/admin/users/${u.id}`, { method: 'PATCH', body: { isAdmin: !u.isAdmin } });
        if (u.id === state.me && u.isAdmin) { location.href = '/'; return; }
        await loadUsers();
      },
    }));
    act('Borrar', () => confirmAction({
      title: `¿Borrar a ${u.name}?`,
      text: `Se borran su cuenta, sus ${u.chats} charlas y sus adjuntos. No se puede deshacer. (Las estadísticas de uso se conservan.)`,
      ok: 'Borrar para siempre',
      action: async () => {
        await api(`/admin/users/${u.id}`, { method: 'DELETE' });
        toast(`${u.name} fue borrado`);
        if (u.id === state.me) { location.href = '/'; return; }
        await loadUsers();
      },
    }), 'danger');
    card.append(head, meta, pick, actions);
    list.append(card);
  }
}

// ------------------------------------------------------------------ usage
const RANGES = {
  day: [[7, 'Últimos 7 días'], [30, 'Últimos 30 días'], [90, 'Últimos 90 días']],
  week: [[84, 'Últimas 12 semanas'], [182, 'Últimas 26 semanas'], [364, 'Último año']],
};

function fillRanges() {
  const sel = $('#f-range');
  const period = $('#f-period').value;
  sel.textContent = '';
  for (const [v, label] of RANGES[period]) { const o = el('option', null, label); o.value = v; sel.append(o); }
  sel.value = period === 'day' ? 30 : 84;
}

function fillUserFilter() {
  const sel = $('#f-user');
  const cur = sel.value;
  sel.length = 1;
  for (const u of state.users) { const o = el('option', null, u.name); o.value = u.id; sel.append(o); }
  sel.value = state.users.some((u) => String(u.id) === cur) ? cur : '';
}

async function loadUsage() {
  const q = new URLSearchParams({ period: $('#f-period').value, days: $('#f-range').value });
  if ($('#f-user').value) q.set('userId', $('#f-user').value);
  const r = await api(`/admin/usage?${q}`);
  state.usageLoaded = true;
  renderTiles(r);
  const label = (b) => {
    const d = new Date(b + 'T12:00:00Z');
    return d.toLocaleDateString('es-AR', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  };
  barChart($('#chart-messages'), $('#legend-messages'), r.series, label, [
    ['ok', 'Respondidos', 'c1'], ['interrupted', 'Detenidos', 'c2'], ['errors', 'Con error', 'c3'],
  ], fmtN);
  barChart($('#chart-tokens'), $('#legend-tokens'), r.series.map((s) => ({
    ...s, fresh: Math.max(0, s.inputTokens - s.cachedTokens),
  })), label, [
    ['fresh', 'Entrada', 'c4'], ['cachedTokens', 'Entrada en caché', 'c5'], ['outputTokens', 'Salida', 'c1'],
  ], fmtTok);
  renderTables(r);
}

function renderTiles(r) {
  const t = r.totals;
  const tiles = $('#tiles');
  tiles.textContent = '';
  const tile = (k, v, s) => { const d = el('div', 'tile'); d.append(el('div', 'k', k), el('div', 'v', v)); if (s) d.append(el('div', 's', s)); tiles.append(d); };
  tile('Mensajes', fmtN(t.messages), `${fmtN(t.ok)} respondidos`);
  tile('Errores', fmtN(t.errors), `${fmtN(t.interrupted)} detenidos`);
  tile('Tokens de entrada', fmtTok(t.inputTokens), `${fmtTok(t.cachedTokens)} en caché`);
  tile('Tokens de salida', fmtTok(t.outputTokens), `${fmtTok(t.reasoningTokens)} pensando`);
  tile('Adjuntos enviados', fmtN(t.attachments), `${fmtN(t.images)} fotos · ${fmtBytes(t.attachmentBytes)}`);
  tile('Dibujos generados', fmtN(t.imagesGenerated), 'imágenes hechas por el asistente');
  tile('Espacio en uso', fmtBytes(r.storage.bytes), `${fmtN(r.storage.files)} archivos guardados`);
  tile('Tiempo de respuesta', t.avgDurationMs ? `${(t.avgDurationMs / 1000).toFixed(1).replace('.', ',')} s` : '—', 'promedio');
}

function barChart(box, legend, series, label, stacks, fmt) {
  box.textContent = '';
  legend.textContent = '';
  const totals = series.map((s) => stacks.reduce((n, [k]) => n + (s[k] || 0), 0));
  const max = Math.max(0, ...totals);
  if (!max) {
    box.append(el('span', 'chart-empty', 'Sin datos en este período'));
  } else {
    box.append(el('span', 'max', fmt(max)));
    const every = Math.ceil(series.length / 8);
    series.forEach((s, i) => {
      const col = el('div', 'col');
      col.title = `${label(s.bucket)}: ` + stacks.map(([k, name]) => `${name} ${fmt(s[k] || 0)}`).join(' · ');
      for (const [k, , cls] of stacks) {
        const seg = el('div', `seg ${cls}`);
        seg.style.height = `${((s[k] || 0) / max) * 100}%`;
        col.append(seg);
      }
      const lastGap = (series.length - 1) % every;
      if (i % every === 0 || (i === series.length - 1 && lastGap >= every / 2)) col.append(el('span', 'x', label(s.bucket)));
      box.append(col);
    });
  }
  for (const [, name, cls] of stacks) {
    const item = el('span');
    item.append(el('i', cls), document.createTextNode(name));
    legend.append(item);
  }
}

function table(t, head, rows) {
  t.textContent = '';
  const thead = el('thead');
  const tr = el('tr');
  for (const h of head) tr.append(el('th', null, h));
  thead.append(tr);
  const tbody = el('tbody');
  if (!rows.length) {
    const r = el('tr'); const td = el('td', null, 'Sin datos'); td.colSpan = head.length; r.append(td); tbody.append(r);
  }
  for (const row of rows) {
    const r = el('tr');
    for (const c of row) r.append(el('td', null, c));
    tbody.append(r);
  }
  t.append(thead, tbody);
}

function renderTables(r) {
  table($('#t-users'), ['Persona', 'Mensajes', 'Errores', 'Detenidos', 'Entrada', 'Caché', 'Salida', 'Adjuntos', 'Último uso'],
    r.byUser.map((u) => [u.name + (u.deleted ? ' (borrado)' : ''), fmtN(u.messages), fmtN(u.errors), fmtN(u.interrupted),
      fmtTok(u.inputTokens), fmtTok(u.cachedTokens), fmtTok(u.outputTokens),
      `${fmtN(u.attachments)} · ${fmtBytes(u.attachmentBytes)}`, fmtAgo(u.lastAt)]));
  table($('#t-models'), ['Modelo', 'Razonamiento', 'Mensajes', 'Tokens'],
    r.byModel.map((m) => [m.model, m.effort || '—', fmtN(m.messages), fmtTok(m.totalTokens)]));
}

// ------------------------------------------------------------------ limits
function windowName(mins) {
  if (!mins) return 'Límite';
  if (mins % 10080 === 0) return mins === 10080 ? 'Semanal' : `Cada ${mins / 10080} semanas`;
  if (mins % 1440 === 0) return mins === 1440 ? 'Diario' : `Cada ${mins / 1440} días`;
  if (mins % 60 === 0) return `Cada ${mins / 60} h`;
  return `Cada ${mins} min`;
}

async function loadLimits() {
  const box = $('#limits');
  box.textContent = 'Cargando…';
  try {
    const { limits } = await api('/admin/limits');
    box.textContent = '';
    if (!limits || !limits.buckets.length) { box.append(el('p', 'muted', 'El proveedor no informó límites todavía.')); return; }
    if (limits.plan) box.append(el('p', 'muted', `Plan: ${limits.plan}`));
    if (limits.ordinaryUsageAllowed === false) box.append(el('p', 'error', '⚠ La cuenta llegó al límite: por ahora el asistente no va a responder.'));
    for (const b of limits.buckets) {
      const card = el('div', 'limit-card');
      card.append(el('h3', null, b.name || (limits.buckets.length > 1 ? 'Otro límite' : 'Uso del plan')));
      if (b.reached) card.append(el('p', 'error', 'Límite alcanzado'));
      for (const w of b.windows) {
        const row = el('div', 'limit-row');
        const top = el('div', 'top');
        top.append(el('span', null, windowName(w.windowMins)), el('span', null, `${Math.round(w.usedPercent)}% usado`));
        const meter = el('div', 'meter' + (w.usedPercent >= 90 ? ' bad' : w.usedPercent >= 70 ? ' warn' : ''));
        const fill = el('span');
        fill.style.width = `${Math.min(100, Math.max(0, w.usedPercent))}%`;
        meter.append(fill);
        const sub = el('div', 'sub', w.resetsAt
          ? `Se renueva el ${new Date(w.resetsAt).toLocaleString('es-AR', { weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
          : '');
        row.append(top, meter, sub);
        card.append(row);
      }
      if (b.credits && (b.credits.hasCredits || b.credits.unlimited)) {
        card.append(el('p', 'muted small-note', b.credits.unlimited ? 'Créditos: ilimitados' : `Créditos extra: ${b.credits.balance ?? 'sí'}`));
      }
      box.append(card);
    }
    box.append(el('p', 'muted small-note', `Actualizado ${fmtAgo(limits.updatedAt)}.`));
  } catch (e) {
    box.textContent = '';
    box.append(el('p', 'error', e.message));
  }
}

// ------------------------------------------------------------------ settings
const EFFORT_LABELS = {
  none: 'Sin pensar', minimal: 'Mínimo', low: 'Rápido', medium: 'Normal', high: 'Pensar más',
  xhigh: 'Pensar mucho', max: 'Máximo', ultra: 'Ultra (muy lento)',
};

function fillEffortSelect(models, modelId, effort) {
  const sel = $('#s-effort');
  sel.textContent = '';
  const m = models.find((x) => x.id === modelId);
  const def = el('option', null, m ? `Recomendado (${EFFORT_LABELS[m.defaultEffort] || m.defaultEffort})` : 'Recomendado');
  def.value = '';
  sel.append(def);
  for (const e of m?.efforts || []) { const o = el('option', null, EFFORT_LABELS[e.value] || e.value); o.value = e.value; sel.append(o); }
  sel.value = m?.efforts.some((e) => e.value === effort) ? effort : '';
}

async function loadSettings() {
  const s = await api('/admin/settings');
  $('#s-picker').checked = s.modelPicker;
  const sel = $('#s-model');
  sel.textContent = '';
  const auto = el('option', null, 'El predeterminado del proveedor'); auto.value = ''; sel.append(auto);
  for (const m of s.models) { const o = el('option', null, m.name); o.value = m.id; sel.append(o); }
  sel.value = s.defaultModel || '';
  fillEffortSelect(s.models, s.defaultModel || s.effectiveModel, s.defaultEffort);
  sel.onchange = () => fillEffortSelect(s.models, sel.value || s.effectiveModel, $('#s-effort').value);
  const name = s.models.find((m) => m.id === s.effectiveModel)?.name || s.effectiveModel || '—';
  $('#s-effective').textContent = `Hoy usan: ${name} · ${EFFORT_LABELS[s.effectiveEffort] || s.effectiveEffort || ''}`;
}

async function saveSettings() {
  const btn = $('#s-save');
  btn.disabled = true;
  try {
    await api('/admin/settings', {
      method: 'PUT',
      body: { modelPicker: $('#s-picker').checked, defaultModel: $('#s-model').value, defaultEffort: $('#s-effort').value },
    });
    toast('Ajustes guardados');
    await Promise.all([loadSettings(), loadUsers()]);
  } catch (e) { toast(e.message); } finally { btn.disabled = false; }
}

// ------------------------------------------------------------------ tabs & init
function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  for (const p of ['users', 'usage', 'limits', 'settings']) $(`#tab-${p}`).hidden = p !== name;
  history.replaceState(null, '', `#${name}`);
  if (name === 'usage') loadUsage().catch((e) => toast(e.message));
  if (name === 'limits') loadLimits();
  if (name === 'settings') loadSettings().catch((e) => toast(e.message));
}

// ------------------------------------------------------------------ access requests & devices
let requestsTimer = null;

async function loadRequests() {
  let requests = [];
  let recentAuto = [];
  try { ({ requests, recentAuto = [] } = await api('/admin/requests')); } catch { return; }
  const autoList = $('#auto-list');
  autoList.textContent = '';
  $('#auto-list-wrap').hidden = !recentAuto.length;
  for (const a of recentAuto) autoList.append(el('li', null, `${a.name} · ${a.device} · ${fmtAgo(a.at)} · aprobado automáticamente`));
  const box = $('#request-list');
  $('#requests').hidden = !requests.length;
  box.textContent = '';
  for (const r of requests) {
    const card = el('article', 'req-card');
    const name = el('div', 'req-name');
    name.append(document.createTextNode(r.name));
    name.append(el('span', r.isNew ? 'badge new' : 'badge', r.isNew ? 'persona nueva' : `= ${r.matchedName}`));
    const meta = el('div', 'req-meta', `${r.device} · ${fmtAgo(r.createdAt)}`);
    const as = el('label', 'req-as');
    as.append(el('span', null, 'Entra como'));
    const sel = el('select');
    const opt0 = el('option', null, r.isNew ? `Persona nueva: ${r.name}` : r.matchedName);
    opt0.value = r.isNew ? '' : String(r.userId);
    sel.append(opt0);
    for (const u of state.users) {
      if (!r.isNew && u.id === r.userId) continue;
      const o = el('option', null, u.name); o.value = String(u.id); sel.append(o);
    }
    as.append(sel);
    const actions = el('div', 'req-actions');
    const ok = el('button', 'btn-primary', 'Aprobar'); ok.type = 'button';
    const no = el('button', 'btn-ghost', 'Rechazar'); no.type = 'button';
    ok.onclick = async () => {
      ok.disabled = no.disabled = true;
      try {
        await api(`/admin/requests/${r.id}/approve`, { method: 'POST', body: { asUserId: sel.value || null } });
        toast(`Aprobado: ${r.name} ya puede entrar`);
        await Promise.all([loadRequests(), loadUsers()]);
      } catch (e) { toast(e.message); ok.disabled = no.disabled = false; }
    };
    no.onclick = async () => {
      ok.disabled = no.disabled = true;
      try { await api(`/admin/requests/${r.id}/reject`, { method: 'POST', body: {} }); toast('Pedido rechazado'); await loadRequests(); } catch (e) { toast(e.message); ok.disabled = no.disabled = false; }
    };
    actions.append(ok, no);
    card.append(el('div', 'req-code', String(r.code)), name, meta, as, actions);
    box.append(card);
  }
}

async function showDevices(u) {
  const dlg = $('#dlg-devices');
  const err = $('#devices-error');
  $('#devices-title').textContent = `Dispositivos de ${u.name}`;
  const render = async () => {
    err.hidden = true;
    const box = $('#device-list');
    let list;
    try { ({ devices: list } = await api(`/admin/users/${u.id}/devices`)); } catch (e) { err.textContent = e.message; err.hidden = false; return; }
    box.textContent = '';
    if (!list.length) box.append(el('p', 'pk-empty', 'No tiene dispositivos conectados. Puede pedir acceso desde la app.'));
    for (const d of list) {
      const item = el('div', 'pk-item');
      const meta = el('div', 'pk-meta', `Aprobado ${fmtDateTime(d.approvedAt)} · último uso: ${fmtDateTime(d.lastUsedAt)}`);
      const actions = el('div', 'pk-actions');
      const btn = (label, cls, fn) => { const b = el('button', cls, label); b.type = 'button'; b.addEventListener('click', fn); return b; };
      const normal = () => {
        actions.textContent = '';
        actions.append(btn('Desconectar', 'danger', () => {
          actions.textContent = '';
          actions.append(el('span', 'pk-meta', '¿Desconectarlo? Va a tener que pedir acceso de nuevo.'),
            btn('Sí, desconectar', 'danger solid', async () => {
              try { await api(`/admin/devices/${d.id}`, { method: 'DELETE' }); await render(); await loadUsers(); } catch (e) { err.textContent = e.message; err.hidden = false; }
            }), btn('No', '', normal));
        }));
      };
      normal();
      const title = el('div', 'pk-name', d.name);
      if (d.autoApproved) { title.append(' '); title.append(el('span', 'badge auto', 'aprobado automáticamente')); }
      item.append(title, meta, actions);
      box.append(item);
    }
  };
  await render();
  return openDialog(dlg);
}

// ------------------------------------------------------------------ passkeys & invites
const fmtDateTime = (ts) => (ts ? new Date(ts).toLocaleString('es-AR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'nunca');

// Clipboard works on http:// LAN pages too (falls back to a hidden textarea).
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall back */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.append(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* ignore */ }
  ta.remove();
  return ok;
}

function flash(btn, text, back) {
  btn.textContent = text;
  setTimeout(() => { btn.textContent = back; }, 1600);
}

const inviteMessage = (name, url) =>
  `Hola ${name}, abrí este link en tu celular (conectado al Wi-Fi de casa) para entrar a ${state.appName}: ${url}`;

function showInviteDialog(u, invite) {
  const msg = inviteMessage(u.name, invite.url);
  $('#invite-title').textContent = `Invitación para ${u.name}`;
  $('#invite-expiry').textContent = `el ${fmtDateTime(invite.expiresAt)}`;
  $('#invite-url').value = invite.url;
  $('#invite-msg').value = msg;
  const qr = $('#invite-qr');
  qr.src = invite.qr;
  qr.hidden = true;
  const toggle = $('#invite-qr-toggle');
  toggle.textContent = 'Mostrar QR';
  toggle.onclick = () => { qr.hidden = !qr.hidden; toggle.textContent = qr.hidden ? 'Mostrar QR' : 'Ocultar QR'; };
  const copyBtn = $('#invite-copy');
  copyBtn.onclick = async () => flash(copyBtn, (await copyText(invite.url)) ? '¡Link copiado!' : 'Copialo a mano', 'Copiar link');
  const shareBtn = $('#invite-share');
  const canShare = typeof navigator.share === 'function';
  shareBtn.textContent = canShare ? 'Compartir' : 'Copiar mensaje';
  shareBtn.onclick = async () => {
    if (canShare) {
      try { await navigator.share({ title: state.appName, text: msg }); return; } catch (e) {
        if (e?.name === 'AbortError') return; // user closed the share sheet
      }
    }
    flash(shareBtn, (await copyText(msg)) ? '¡Mensaje copiado!' : 'Copialo a mano', shareBtn.textContent);
  };
  $('#invite-url').onclick = (e) => e.target.select();
  return openDialog($('#dlg-invite'));
}

async function newInvite(u) {
  try {
    const { invite } = await api(`/admin/users/${u.id}/invite`, { method: 'POST', body: {} });
    await loadUsers();
    await showInviteDialog(u, invite);
  } catch (e) { toast(e.message); }
}

async function showPasskeys(u) {
  const dlg = $('#dlg-passkeys');
  const err = $('#passkeys-error');
  $('#passkeys-title').textContent = `Passkeys de ${u.name}`;
  const render = async () => {
    err.hidden = true;
    const box = $('#passkey-list');
    let list;
    try { ({ passkeys: list } = await api(`/admin/users/${u.id}/passkeys`)); } catch (e) { err.textContent = e.message; err.hidden = false; return; }
    box.textContent = '';
    if (!list.length) box.append(el('p', 'pk-empty', 'Todavía no tiene passkeys. Generá una invitación para registrar su celular.'));
    for (const p of list) {
      const item = el('div', 'pk-item');
      const name = el('div', 'pk-name', p.name);
      const meta = el('div', 'pk-meta', `Creada ${fmtDateTime(p.createdAt)} · último uso: ${fmtDateTime(p.lastUsedAt)}${p.synced ? ' · sincronizada' : ''}`);
      const actions = el('div', 'pk-actions');
      const btn = (label, cls, fn) => { const b = el('button', cls, label); b.type = 'button'; b.addEventListener('click', fn); return b; };
      const normal = () => {
        actions.textContent = '';
        actions.append(
          btn('Renombrar', '', () => {
            actions.textContent = '';
            const input = el('input'); input.value = p.name; input.maxLength = 60;
            actions.append(input, btn('Guardar', '', async () => {
              try { await api(`/admin/passkeys/${encodeURIComponent(p.id)}`, { method: 'PATCH', body: { name: input.value } }); await render(); } catch (e) { err.textContent = e.message; err.hidden = false; }
            }), btn('Cancelar', '', normal));
            input.focus();
          }),
          btn('Borrar', 'danger', () => {
            actions.textContent = '';
            actions.append(el('span', 'pk-meta', '¿Borrarla? Ese dispositivo ya no va a poder entrar.'),
              btn('Sí, borrar', 'danger solid', async () => {
                try { await api(`/admin/passkeys/${encodeURIComponent(p.id)}`, { method: 'DELETE' }); await render(); await loadUsers(); } catch (e) { err.textContent = e.message; err.hidden = false; }
              }), btn('No', '', normal));
          }),
        );
      };
      normal();
      item.append(name, meta, actions);
      box.append(item);
    }
  };
  $('#passkeys-invite').onclick = () => { dlg.close('ok'); newInvite(u); };
  await render();
  return openDialog(dlg);
}

async function init() {
  try { const c = await api('/auth/config'); state.authMode = c.mode; state.appName = c.appName || state.appName; } catch { /* default */ }
  let me;
  try { ({ user: me } = await api('/me')); } catch { return; }
  $('#who').textContent = me.name;
  if (!me.isAdmin) {
    $('#denied').hidden = false;
    document.querySelectorAll('.tab-panel, .tabs').forEach((e) => { e.hidden = true; });
    return;
  }
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
  $('#add-user').addEventListener('click', async () => {
    let created = null;
    const pinMode = state.authMode === 'pin';
    await userForm({
      title: 'Nueva persona', fields: pinMode ? ['name', 'pin', 'admin'] : ['name', 'admin'], okText: 'Crear',
      submit: async (v) => {
        if (!pinMode) delete v.pin;
        created = await api('/admin/users', { method: 'POST', body: v });
        await loadUsers();
      },
    });
    if (!created) return;
    if (created.invite) showInviteDialog(created.user, created.invite);
    else if (state.authMode === 'device') toast(`Listo. Que ${created.user.name} abra la app, escriba su nombre y toque "Pedir acceso".`);
    else toast(`${created.user.name} ya puede ingresar con su PIN`);
  });
  $('#f-period').addEventListener('change', () => { fillRanges(); loadUsage().catch((e) => toast(e.message)); });
  $('#f-range').addEventListener('change', () => loadUsage().catch((e) => toast(e.message)));
  $('#f-user').addEventListener('change', () => loadUsage().catch((e) => toast(e.message)));
  $('#reload-limits').addEventListener('click', loadLimits);
  $('#s-save').addEventListener('click', saveSettings);
  fillRanges();
  await loadUsers().catch((e) => toast(e.message));
  if (state.authMode === 'device') {
    loadRequests();
    requestsTimer = setInterval(loadRequests, 5000);
  }
  const fromHash = () => {
    const tab = location.hash.slice(1);
    return ['users', 'usage', 'limits', 'settings'].includes(tab) ? tab : 'users';
  };
  window.addEventListener('hashchange', () => showTab(fromHash()));
  showTab(fromHash());
}

document.addEventListener('DOMContentLoaded', init);
