'use strict';

const $ = (sel) => document.querySelector(sel);
const MAX_UPLOAD = 20 * 1024 * 1024;
const state = {
  appName: document.title, appShortName: document.title, // filled from /api/auth/config
  user: null, chats: [], current: null, streaming: false,
  models: [], defaults: { model: null, effort: null },
  choice: { model: null, effort: null },   // model of the open chat (or of the next new chat)
  pending: [],                              // attachments in the composer
};

const ICONS = {
  edit: '<svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>',
};

const EFFORT_LABELS = {
  none: 'Sin pensar', minimal: 'Mínimo', low: 'Rápido', medium: 'Normal', high: 'Pensar más',
  xhigh: 'Pensar mucho', max: 'Máximo', ultra: 'Ultra (muy lento)',
};

// ------------------------------------------------------------------ API
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && path !== '/login' && !path.startsWith('/auth/')) { showLogin(); }
  if (res.status === 401) {
    const err = new Error(data.error || 'Tenés que ingresar');
    err.fromServer = true;
    err.status = 401;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(data.error || `Error ${res.status}`);
    err.fromServer = true;
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
}

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1).replace('.', ',')} MB`;
}

// ------------------------------------------------------------------ Markdown
function renderMarkdown(target, text) {
  const html = window.marked
    ? window.marked.parse(text, { gfm: true, breaks: true })
    : text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  target.innerHTML = window.DOMPurify ? window.DOMPurify.sanitize(html) : '';
  target.querySelectorAll('a[href]').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  target.querySelectorAll('pre > code').forEach((code) => {
    const pre = code.parentElement;
    const lang = (code.className.match(/language-([\w+#-]+)/) || [])[1] || 'código';
    const head = el('div', 'code-head');
    const btn = el('button', null, 'Copiar');
    btn.type = 'button';
    btn.addEventListener('click', () => copyText(code.innerText, btn));
    head.append(el('span', null, lang), btn);
    pre.prepend(head);
  });
}

async function copyText(text, btn) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    btn.textContent = '¡Copiado!';
  } catch { btn.textContent = 'No se pudo'; }
  setTimeout(() => { btn.textContent = 'Copiar'; }, 1500);
}

// ------------------------------------------------------------------ Views
function showLogin() {
  state.user = null;
  stopAdminPoll();
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
  $('#invite-view').hidden = true;
  const mode = state.authMode;
  $('#login-form').hidden = mode !== 'pin';
  $('#passkey-login').hidden = mode !== 'passkey';
  $('#device-login').hidden = mode !== 'device';
  $('#device-wait').hidden = true;
  if (mode === 'pin') $('#login-name').focus();
  if (mode === 'device') resumeDeviceRequest();
}

// ------------------------------------------------------------------ Device approval
let waitTimer = null;

function showDeviceForm(errorText) {
  clearTimeout(waitTimer);
  $('#device-wait').hidden = true;
  $('#device-login').hidden = false;
  const err = $('#device-error');
  err.hidden = !errorText;
  err.textContent = errorText || '';
  $('#device-name').focus();
}

function showWaiting(r) {
  $('#device-login').hidden = true;
  $('#device-wait').hidden = false;
  $('#wait-title').textContent = `¡Hola, ${r.name}!`;
  const who = r.adminName ? `${r.adminName} (o a quien administre)` : 'a quien administre la app';
  $('#wait-text').textContent = `Avisale a ${who} que te apruebe. Código: ${r.code}`;
  $('#wait-code').textContent = r.code;
  $('#wait-status').hidden = false;
  $('#wait-retry').hidden = true;
  $('#wait-cancel').hidden = false;
}

function showWaitEnd(title, text) {
  clearTimeout(waitTimer);
  $('#wait-title').textContent = title;
  $('#wait-text').textContent = text;
  $('#wait-status').hidden = true;
  $('#wait-retry').hidden = false;
  $('#wait-cancel').hidden = true;
}

async function pollDevice() {
  clearTimeout(waitTimer);
  let r;
  try { r = await api('/access/status'); } catch { waitTimer = setTimeout(pollDevice, 5000); return; }
  if (r.status === 'approved' && r.user) { await showApp(r.user); return; }
  if (r.status === 'pending') { waitTimer = setTimeout(pollDevice, 3000); return; }
  if (r.status === 'rejected') return showWaitEnd('Rechazado', 'No aprobaron este pedido. Si fue un error, pedí acceso de nuevo y avisale a quien administra.');
  if (r.status === 'expired') return showWaitEnd('Se venció el pedido', 'Pasaron más de 15 minutos sin aprobación. Podés volver a pedir acceso.');
  showDeviceForm();
}

async function resumeDeviceRequest() {
  try {
    const r = await api('/access/status');
    if (r.status === 'pending') { showWaiting(r); waitTimer = setTimeout(pollDevice, 3000); }
    else if (r.status === 'approved' && r.user) await showApp(r.user);
  } catch { /* stay on the form */ }
}

async function requestAccess(e) {
  e.preventDefault();
  const btn = $('#device-btn');
  const name = $('#device-name').value.trim();
  if (!name) return showDeviceForm('Escribí tu nombre.');
  btn.disabled = true;
  try {
    const r = await api('/access/request', { method: 'POST', body: { name } });
    if (r.status === 'approved' && r.user) { await showApp(r.user); return; } // same phone: in right away
    showWaiting(r);
    waitTimer = setTimeout(pollDevice, 3000);
  } catch (ex) {
    showDeviceForm(ex.message);
  } finally { btn.disabled = false; }
}

// Re-check right away when the app comes back to the foreground (iOS pauses timers).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !$('#device-wait').hidden && !$('#wait-status').hidden) pollDevice();
});

// ------------------------------------------------------------------ Admin: pending requests badge
let adminPoll = null;
let lastPending = 0;
function stopAdminPoll() { clearInterval(adminPoll); adminPoll = null; }
// Auto-approved entries (same phone, other browser): toast each one once.
function seenAutoId(set) {
  try {
    if (set != null) localStorage.setItem('shareit_seen_auto', String(set));
    return Number(localStorage.getItem('shareit_seen_auto') || 0);
  } catch { return set ?? 0; }
}
async function checkPendingRequests() {
  try {
    const { requests, recentAuto = [] } = await api('/admin/requests');
    const maxAuto = Math.max(0, ...recentAuto.map((a) => a.id));
    const seen = seenAutoId();
    if (seen) {
      for (const a of recentAuto.filter((x) => x.id > seen).reverse()) {
        toast(`${a.name} entró desde otro navegador del mismo celular (${a.device}).`);
      }
    }
    if (maxAuto > seen || !seen) seenAutoId(Math.max(maxAuto, seen) || -1);
    const n = requests.length;
    const badge = $('#admin-badge');
    badge.hidden = !n;
    badge.textContent = n;
    if (n > lastPending) {
      const r = requests[requests.length - 1];
      toast(`${r.name} pide acceso (código ${r.code}). Abrí Administración para aprobar.`);
    }
    lastPending = n;
  } catch { /* ignore */ }
}
function startAdminPoll() {
  stopAdminPoll();
  if (state.authMode !== 'device') return;
  checkPendingRequests();
  adminPoll = setInterval(checkPendingRequests, 10_000);
}

// ------------------------------------------------------------------ Passkeys
const webauthn = () => window.SimpleWebAuthnBrowser;

// Server errors are shown as-is. Browser/OS errors get a friendly line plus the
// exact technical text, and are reported to the server log for debugging.
function passkeyErrorText(e) {
  if (e?.fromServer) return e.message;
  const tech = `${e?.name || 'Error'}: ${e?.message || 'sin detalle'}`;
  const friendly = {
    NotAllowedError: 'Se canceló, se venció el tiempo o este dispositivo no encontró tu passkey.',
    InvalidStateError: 'Este dispositivo ya tiene una passkey para tu cuenta.',
    SecurityError: 'Este sitio no puede usar passkeys desde esta dirección.',
    AbortError: 'Se canceló.',
  }[e?.name];
  return friendly ? `${friendly} (${tech})` : tech;
}

function reportPasskeyError(stage, e) {
  if (e?.fromServer) return; // already logged by the server
  fetch('/api/auth/passkey/client-error', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stage, name: e?.name, message: e?.message, page: location.pathname.replace(/\/invitacion\/.+/, '/invitacion/…') }),
    credentials: 'same-origin',
  }).catch(() => {});
}

async function passkeyLogin() {
  const err = $('#passkey-error');
  const btn = $('#passkey-btn');
  err.hidden = true;
  if (!webauthn()?.browserSupportsWebAuthn()) {
    err.textContent = 'Este navegador no soporta passkeys.';
    err.hidden = false;
    return;
  }
  btn.disabled = true;
  try {
    const { challengeId, options } = await api('/auth/passkey/options', { method: 'POST', body: {} });
    const response = await webauthn().startAuthentication({ optionsJSON: options });
    const { user } = await api('/auth/passkey/verify', { method: 'POST', body: { challengeId, response } });
    await showApp(user);
  } catch (e) {
    reportPasskeyError('login', e);
    err.textContent = passkeyErrorText(e);
    err.hidden = false;
    $('#login-view').hidden = false;
    $('#passkey-login').hidden = false;
  } finally { btn.disabled = false; }
}

function guessDeviceName() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Dispositivo';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return br ? `${os} · ${br}` : os;
}

// On a computer (or a device without a built-in authenticator) suggest opening
// the link on the phone instead, but still allow continuing here.
async function showDesktopNote() {
  const ua = navigator.userAgent;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  let platform = false;
  try { platform = !!(await window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable?.()); } catch { /* no */ }
  if (mobile && platform) return;
  $('#invite-desktop').hidden = false;
  const b = $('#invite-copy-link');
  b.onclick = async () => {
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(location.href); ok = true; }
    } catch { /* fall back */ }
    if (!ok) {
      const ta = document.createElement('textarea');
      ta.value = location.href; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.append(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
    }
    b.textContent = ok ? '¡Link copiado!' : 'Copialo de la barra de direcciones';
    setTimeout(() => { b.textContent = 'Copiar link'; }, 1800);
  };
}

async function showInvite(token) {
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
  $('#login-form').hidden = true;
  $('#passkey-login').hidden = true;
  $('#invite-view').hidden = false;
  const err = $('#invite-error');
  const btn = $('#invite-btn');
  $('#invite-device').value = guessDeviceName();
  try {
    const info = await api(`/invites/${encodeURIComponent(token)}`);
    $('#invite-title').textContent = `¡Hola, ${info.name}!`;
  } catch (e) {
    $('#invite-title').textContent = 'Invitación no válida';
    $('#invite-text').textContent = e.message;
    btn.hidden = true;
    $('#invite-device').parentElement.hidden = true;
    return;
  }
  showDesktopNote();
  btn.onclick = async () => {
    err.hidden = true;
    if (!webauthn()?.browserSupportsWebAuthn()) { err.textContent = 'Este navegador no soporta passkeys.'; err.hidden = false; return; }
    btn.disabled = true;
    try {
      const { challengeId, options } = await api(`/invites/${encodeURIComponent(token)}/options`, { method: 'POST', body: {} });
      const response = await webauthn().startRegistration({ optionsJSON: options });
      const { user } = await api(`/invites/${encodeURIComponent(token)}/verify`, {
        method: 'POST', body: { challengeId, response, deviceName: $('#invite-device').value },
      });
      history.replaceState(null, '', '/');
      toast('¡Listo! La próxima vez entrás con “Entrar con passkey”.');
      await showApp(user);
    } catch (e) {
      reportPasskeyError('register', e);
      err.textContent = passkeyErrorText(e);
      err.hidden = false;
    } finally { btn.disabled = false; }
  };
}

async function showApp(user) {
  state.user = user;
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  $('#me-name').textContent = user.name;
  $('#admin-link').hidden = !user.isAdmin;
  clearTimeout(waitTimer);
  if (user.isAdmin) startAdminPoll(); else stopAdminPoll();
  setPickerVisible(user.modelPicker !== false);
  $('#me-avatar').textContent = (user.name.trim()[0] || '?').toUpperCase();
  await Promise.all([loadChats(), loadModels()]);
  const id = chatIdFromHash();
  if (id && state.chats.some((c) => c.id === id)) await openChat(id);
  else newChat();
}

function chatIdFromHash() {
  const m = location.hash.match(/^#\/c\/([\w-]+)$/);
  return m ? m[1] : null;
}

// ------------------------------------------------------------------ Models
async function loadModels() {
  try {
    const { models, defaults, pickerAllowed } = await api('/models');
    state.models = models;
    state.defaults = defaults;
    setPickerVisible(pickerAllowed !== false);
  } catch (e) { toast(e.message); }
}

// When an admin turned the picker off, the server ignores model choices anyway;
// we just hide the button (and show the chat title in its place on phones).
function setPickerVisible(on) {
  state.pickerAllowed = on;
  $('#model-btn').hidden = !on;
  $('#app-view').classList.toggle('no-picker', !on);
}

const modelInfo = (id) => state.models.find((m) => m.id === id) || state.models.find((m) => m.isDefault) || state.models[0];
const modelName = (id) => state.models.find((m) => m.id === id)?.name || id || '';

function effectiveChoice(choice) {
  const m = modelInfo(choice.model);
  if (!m) return { model: null, effort: null, info: null };
  const effort = m.efforts.some((e) => e.value === choice.effort) ? choice.effort : m.defaultEffort;
  return { model: m.id, effort, info: m };
}

function renderModelButton() {
  const c = effectiveChoice(state.choice);
  $('#model-name').textContent = c.info ? c.info.name : 'Modelo';
  $('#model-btn').title = c.effort ? `${c.info.name} · ${EFFORT_LABELS[c.effort] || c.effort}` : '';
}

async function pickModel() {
  if (state.pickerAllowed === false) return;
  if (!state.models.length) await loadModels();
  if (!state.models.length) return toast('No pude cargar los modelos');
  const cur = effectiveChoice(state.choice);
  let selected = cur.model;
  const list = $('#model-list');
  const sel = $('#effort-select');

  const fillEfforts = (keep) => {
    const m = modelInfo(selected);
    sel.textContent = '';
    for (const e of m.efforts) {
      const o = el('option', null, EFFORT_LABELS[e.value] || e.value);
      o.value = e.value;
      if (e.value === m.defaultEffort) o.textContent += ' (recomendado)';
      sel.append(o);
    }
    sel.value = m.efforts.some((e) => e.value === keep) ? keep : m.defaultEffort;
    $('#effort-wrap').hidden = !m.efforts.length;
  };

  list.textContent = '';
  for (const m of state.models) {
    const row = el('label', 'model-row');
    const radio = document.createElement('input');
    radio.type = 'radio'; radio.name = 'model'; radio.value = m.id; radio.checked = m.id === selected;
    radio.addEventListener('change', () => { selected = m.id; fillEfforts(sel.value); });
    const txt = el('span', 'model-text');
    txt.append(el('strong', null, m.name + (m.isDefault ? ' · predeterminado' : '')));
    if (m.description) txt.append(el('small', null, m.description));
    row.append(radio, txt);
    list.append(row);
  }
  fillEfforts(cur.effort);

  if (!(await askDialog($('#dlg-model')))) return;
  const choice = { model: selected, effort: sel.value || null };
  try {
    if (state.current) {
      const { chat } = await api(`/chats/${state.current}`, { method: 'PATCH', body: choice });
      const c = state.chats.find((x) => x.id === chat.id);
      if (c) Object.assign(c, chat);
    } else {
      await api('/prefs', { method: 'PUT', body: choice });
    }
    state.choice = choice;
    state.defaults = choice;
    renderModelButton();
    toast(`Usando ${modelName(choice.model)} · ${EFFORT_LABELS[choice.effort] || choice.effort || ''}`);
  } catch (e) { toast(e.message); }
}

// ------------------------------------------------------------------ Sidebar
async function loadChats() {
  const { chats } = await api('/chats');
  state.chats = chats;
  renderChatList();
}

function dayLabel(ts) {
  const d = new Date(ts), today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ts >= start) return 'Hoy';
  if (ts >= start - 86400_000) return 'Ayer';
  if (ts >= start - 7 * 86400_000) return 'Últimos 7 días';
  if (ts >= start - 30 * 86400_000) return 'Últimos 30 días';
  return d.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
}

function renderChatList() {
  const list = $('#chat-list');
  list.textContent = '';
  let last = null;
  for (const c of state.chats) {
    const label = dayLabel(c.updatedAt);
    if (label !== last) { list.append(el('div', 'list-label', label)); last = label; }
    const item = el('div', 'chat-item' + (state.current === c.id ? ' active' : ''));
    const a = el('a', null, c.title);
    a.href = `#/c/${c.id}`;
    a.addEventListener('click', (e) => { e.preventDefault(); openChat(c.id); closeDrawer(); });
    const actions = el('div', 'actions');
    const ren = el('button');
    ren.type = 'button'; ren.innerHTML = ICONS.edit; ren.setAttribute('aria-label', 'Cambiar nombre');
    ren.addEventListener('click', () => renameChat(c));
    const del = el('button');
    del.type = 'button'; del.innerHTML = ICONS.trash; del.setAttribute('aria-label', 'Borrar');
    del.addEventListener('click', () => deleteChat(c));
    actions.append(ren, del);
    item.append(a, actions);
    list.append(item);
  }
}

function openDrawer() { $('#app-view').classList.add('drawer-open'); $('#scrim').hidden = false; }
function closeDrawer() { $('#app-view').classList.remove('drawer-open'); $('#scrim').hidden = true; }

function askDialog(dlg) {
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.returnValue = '';
    dlg.showModal();
  });
}

async function renameChat(c) {
  const input = $('#rename-input');
  input.value = c.title;
  setTimeout(() => input.select(), 50);
  if (!(await askDialog($('#dlg-rename')))) return;
  const title = input.value.trim();
  if (!title || title === c.title) return;
  try {
    await api(`/chats/${c.id}`, { method: 'PATCH', body: { title } });
    c.title = title;
    if (state.current === c.id) setTitle(title);
    renderChatList();
  } catch (e) { toast(e.message); }
}

async function deleteChat(c) {
  $('#delete-name').textContent = c.title;
  if (!(await askDialog($('#dlg-delete')))) return;
  try {
    await api(`/chats/${c.id}`, { method: 'DELETE' });
    state.chats = state.chats.filter((x) => x.id !== c.id);
    if (state.current === c.id) newChat(true);
    else renderChatList();
  } catch (e) { toast(e.message); }
}

function setTitle(t) {
  $('#chat-title').textContent = t;
  document.title = t && t !== 'Nueva charla' ? `${t} · ${state.appShortName}` : state.appName;
}

// ------------------------------------------------------------------ Chat
function newChat(force = false) {
  if (state.streaming) return toast('Esperá a que termine la respuesta');
  if (!force && state.pending.some((p) => p.status === 'uploading')) return toast('Esperá a que terminen de subirse los archivos');
  state.current = null;
  state.choice = { ...state.defaults };
  clearPending();
  history.replaceState(null, '', '/');
  setTitle('Nueva charla');
  renderModelButton();
  $('#messages').textContent = '';
  $('#empty').hidden = false;
  renderChatList();
  closeDrawer();
  if (matchMedia('(min-width: 801px)').matches) $('#input').focus();
}

async function openChat(id) {
  if (state.streaming) return toast('Esperá a que termine la respuesta');
  try {
    const { chat, messages, busy } = await api(`/chats/${id}/messages`);
    if (state.current !== id) clearPending();
    state.current = id;
    state.choice = { model: chat.model || state.defaults.model, effort: chat.effort || (chat.model ? null : state.defaults.effort) };
    history.replaceState(null, '', `#/c/${id}`);
    setTitle(chat.title);
    renderModelButton();
    const box = $('#messages');
    box.textContent = '';
    $('#empty').hidden = messages.length > 0;
    for (const m of messages) addMessage(m);
    if (busy) addNote(box.lastElementChild, 'Todavía se está respondiendo… volvé a abrir la charla en un ratito.');
    renderChatList();
    scrollToBottom(true);
  } catch (e) { toast(e.message); }
}

function renderAttachments(list, fromAssistant = false) {
  const wrap = el('div', fromAssistant ? 'msg-atts drawn' : 'msg-atts');
  for (const a of list) {
    const href = `/api/attachments/${a.id}`;
    if (a.kind === 'image') {
      const link = el('a', 'att-img');
      link.href = href; link.target = '_blank'; link.rel = 'noopener';
      const img = el('img');
      img.src = a.localUrl || href; img.alt = a.name; img.loading = 'lazy';
      link.append(img);
      wrap.append(link);
    } else {
      const chip = el('a', 'att-file');
      chip.href = href;
      chip.setAttribute('download', a.name);
      const ic = el('span', 'att-icon'); ic.innerHTML = ICONS.file;
      const meta = el('span', 'att-meta');
      meta.append(el('span', 'att-name', a.name), el('span', 'att-size', a.note ? a.note : fmtSize(a.size)));
      if (a.note) chip.classList.add('warn');
      chip.append(ic, meta);
      wrap.append(chip);
    }
  }
  return wrap;
}

function addMessage(m) {
  const { role, content = '', status = 'done', attachments = [] } = m;
  const row = el('div', `msg ${role}` + (status === 'error' ? ' error' : ''));
  if (role === 'user') {
    const col = el('div', 'user-col');
    if (attachments.length) col.append(renderAttachments(attachments));
    if (content) col.append(el('div', 'bubble', content));
    row.append(col);
    $('#messages').append(row);
    return col;
  }
  const bubble = el('div', 'bubble md');
  renderMarkdown(bubble, content);
  row.append(bubble);
  if (attachments.length) row.append(renderAttachments(attachments, true));
  if (status === 'interrupted') addNote(row, 'Respuesta detenida.');
  if (m.model) row.append(el('div', 'model-tag', modelName(m.model)));
  $('#messages').append(row);
  return bubble;
}

function addNote(row, text) {
  if (!row) return;
  const n = el('div', 'note', text);
  (row.querySelector('.bubble') || row).append(n);
}

function scrollToBottom(force = false) {
  const s = $('#scroller');
  const near = s.scrollHeight - s.scrollTop - s.clientHeight < 160;
  if (force || near) s.scrollTop = s.scrollHeight;
}

function setStreaming(on) {
  state.streaming = on;
  const send = $('#send');
  send.classList.toggle('stop', on);
  send.setAttribute('aria-label', on ? 'Detener' : 'Enviar');
  updateSendButton();
}

function updateSendButton() {
  const uploading = state.pending.some((p) => p.status === 'uploading');
  const ready = state.pending.some((p) => p.status === 'ready');
  $('#send').disabled = !state.streaming && (uploading || (!$('#input').value.trim() && !ready));
}

// Creates the chat lazily (first upload or first message). Concurrent callers
// (e.g. several files picked at once) share the same creation request.
let creatingChat = null;
function ensureChat() {
  if (state.current) return Promise.resolve(state.current);
  creatingChat ??= api('/chats', { method: 'POST', body: {} }).then(({ chat }) => {
    state.current = chat.id;
    state.chats.unshift(chat);
    history.replaceState(null, '', `#/c/${chat.id}`);
    renderChatList();
    return chat.id;
  }).finally(() => { creatingChat = null; });
  return creatingChat;
}

// ------------------------------------------------------------------ Attachments (composer)
function clearPending() {
  for (const p of state.pending) if (p.localUrl) URL.revokeObjectURL(p.localUrl);
  state.pending = [];
  renderTray();
}

function renderTray() {
  const tray = $('#tray');
  tray.textContent = '';
  tray.hidden = !state.pending.length;
  for (const p of state.pending) {
    const item = el('div', 'tray-item ' + p.status + (p.isImage ? ' is-img' : ''));
    if (p.isImage) {
      const img = el('img'); img.src = p.localUrl; img.alt = p.file.name;
      item.append(img);
    } else {
      const ic = el('span', 'att-icon'); ic.innerHTML = ICONS.file;
      const meta = el('span', 'att-meta');
      meta.append(el('span', 'att-name', p.file.name),
        el('span', 'att-size', p.status === 'error' ? p.error : (p.att?.note || fmtSize(p.file.size))));
      item.append(ic, meta);
    }
    if (p.status === 'uploading') item.append(el('span', 'spinner'));
    if (p.status === 'error' && p.isImage) item.title = p.error;
    const rm = el('button', 'tray-remove');
    rm.type = 'button'; rm.innerHTML = ICONS.x; rm.setAttribute('aria-label', 'Quitar');
    rm.addEventListener('click', () => removePending(p));
    item.append(rm);
    tray.append(item);
  }
  updateSendButton();
}

async function removePending(p) {
  state.pending = state.pending.filter((x) => x !== p);
  if (p.localUrl) URL.revokeObjectURL(p.localUrl);
  renderTray();
  if (p.att && state.current) api(`/chats/${state.current}/attachments/${p.att.id}`, { method: 'DELETE' }).catch(() => {});
}

async function addFiles(files) {
  for (const file of files) {
    if (state.pending.length >= 10) { toast('Máximo 10 adjuntos por mensaje'); break; }
    const isImage = /^image\/(jpeg|png|webp|gif)$/.test(file.type);
    const p = { file, isImage, status: 'uploading', localUrl: isImage ? URL.createObjectURL(file) : null };
    if (file.size > MAX_UPLOAD) { p.status = 'error'; p.error = 'Supera 20 MB'; }
    else if (file.type.startsWith('image/') && !isImage) { p.status = 'error'; p.error = 'Formato no soportado (usá JPG o PNG)'; }
    state.pending.push(p);
    renderTray();
    if (p.status === 'uploading') upload(p);
  }
}

async function upload(p) {
  try {
    const chatId = await ensureChat();
    const res = await fetch(`/api/chats/${chatId}/attachments`, {
      method: 'POST',
      headers: { 'Content-Type': p.file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(p.file.name) },
      body: p.file,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'No se pudo subir');
    p.att = data.attachment;
    p.status = 'ready';
    if (p.att.note && !p.isImage) toast(`${p.file.name}: ${p.att.note}`);
  } catch (e) {
    p.status = 'error';
    p.error = e.message;
    toast(e.message);
  }
  renderTray();
}

// ------------------------------------------------------------------ Sending
async function sendMessage(text) {
  text = text.trim();
  const ready = state.pending.filter((p) => p.status === 'ready');
  if ((!text && !ready.length) || state.streaming) return;
  if (state.pending.some((p) => p.status === 'uploading')) return toast('Esperá a que terminen de subirse los archivos');
  setStreaming(true);
  $('#empty').hidden = true;
  const input = $('#input');
  input.value = '';
  autosize();

  const sentAtts = ready.map((p) => ({ ...p.att, localUrl: p.localUrl }));
  state.pending = [];
  renderTray();

  addMessage({ role: 'user', content: text, attachments: sentAtts });
  const bubble = addMessage({ role: 'assistant' });
  const row = bubble.parentElement;
  bubble.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  scrollToBottom(true);

  let acc = '';
  let raf = 0;
  const paint = () => { raf = 0; renderMarkdown(bubble, acc); scrollToBottom(); };

  try {
    const chatId = await ensureChat();
    const res = await fetch(`/api/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, attachmentIds: sentAtts.map((a) => a.id) }),
      credentials: 'same-origin',
    });
    if (!res.ok) {
      let err = 'Algo salió mal';
      try { err = (await res.json()).error || err; } catch { /* empty */ }
      if (res.status === 401) showLogin();
      throw new Error(err);
    }

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    let finished = false;
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = 'message', data = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        const payload = JSON.parse(data);
        if (event === 'start') {
          const c = state.chats.find((x) => x.id === chatId);
          if (c) { c.title = payload.title; c.updatedAt = Date.now(); }
          state.chats.sort((a, b) => b.updatedAt - a.updatedAt);
          if (state.current === chatId) setTitle(payload.title);
          renderChatList();
        } else if (event === 'drawing') {
          if (payload.started && !acc) bubble.innerHTML = '<span class="drawing">🎨 Dibujando… <span class="typing"><i></i><i></i><i></i></span></span>';
        } else if (event === 'delta') {
          acc += payload.t;
          if (!raf) raf = requestAnimationFrame(paint);
        } else if (event === 'done' || event === 'error') {
          if (raf) cancelAnimationFrame(raf);
          const m = payload.assistantMessage;
          renderMarkdown(bubble, m.content);
          if (m.attachments?.length) row.append(renderAttachments(m.attachments, true));
          if (event === 'error') row.classList.add('error');
          if (m.status === 'interrupted') addNote(row, 'Respuesta detenida.');
          if (m.model) row.append(el('div', 'model-tag', modelName(m.model)));
          finished = true;
        }
      }
    }
    if (!finished) throw new Error('Se cortó la conexión. Volvé a abrir la charla para ver la respuesta.');
  } catch (e) {
    if (!acc) bubble.textContent = '';
    row.classList.add('error');
    addNote(row, e.message);
  } finally {
    setStreaming(false);
    scrollToBottom();
  }
}

async function stopStreaming() {
  if (!state.current) return;
  try { await api(`/chats/${state.current}/stop`, { method: 'POST', body: {} }); } catch { /* ignore */ }
}

function autosize() {
  const ta = $('#input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  updateSendButton();
}

// ------------------------------------------------------------------ Install app (PWA)
let installPrompt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const ua = navigator.userAgent;
const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(ua);

function updateInstallButtons() {
  const show = !isStandalone();
  $('#install-btn').hidden = !show;
  $('#install-login').hidden = !show || !(isIOS || isAndroid || installPrompt);
}

function installVariant() {
  if (isIOS) {
    if (/CriOS\//.test(ua)) return 'ios-chrome';
    if (/FxiOS\/|EdgiOS\/|OPiOS\/|GSA\//.test(ua)) return 'ios-other';
    return 'ios-safari';
  }
  return isAndroid ? 'android' : 'desktop';
}

async function installApp() {
  if (installPrompt) {
    const p = installPrompt;
    installPrompt = null;
    try {
      await p.prompt();
      const choice = await p.userChoice;
      if (choice?.outcome === 'accepted') toast('¡Listo! Abrí la app desde la pantalla de inicio.');
    } catch { /* ignore */ }
    updateInstallButtons();
    return;
  }
  const v = installVariant();
  document.querySelectorAll('#dlg-install .install-variant').forEach((el2) => el2.classList.toggle('show', el2.dataset.variant === v));
  $('#install-note').hidden = state.authMode !== 'device';
  $('#dlg-install').showModal();
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // show our own button instead of the browser's mini-infobar
  installPrompt = e;
  updateInstallButtons();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  $('#install-btn').hidden = true;
  $('#install-login').hidden = true;
});

// ------------------------------------------------------------------ Wiring
function init() {
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#login-error');
    err.hidden = true;
    const btn = e.submitter || $('#login-form button');
    btn.disabled = true;
    try {
      const { user } = await api('/login', {
        method: 'POST',
        body: { username: $('#login-name').value, pin: $('#login-pin').value },
      });
      $('#login-pin').value = '';
      await showApp(user);
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally { btn.disabled = false; }
  });

  $('#logout').addEventListener('click', async () => {
    try { await api('/logout', { method: 'POST', body: {} }); } catch { /* ignore */ }
    state.chats = []; state.current = null;
    clearPending();
    $('#messages').textContent = '';
    history.replaceState(null, '', '/');
    closeDrawer();
    showLogin();
  });

  $('#new-chat').addEventListener('click', () => newChat());
  $('#new-chat-top').addEventListener('click', () => newChat());
  $('#open-sidebar').addEventListener('click', openDrawer);
  $('#scrim').addEventListener('click', closeDrawer);
  $('#model-btn').addEventListener('click', pickModel);

  $('#attach').addEventListener('click', () => $('#file').click());
  $('#file').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });

  const input = $('#input');
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    // Enter sends on desktop; on touch devices Enter adds a new line.
    const touch = matchMedia('(pointer: coarse)').matches;
    if (e.key === 'Enter' && !e.shiftKey && !touch && !e.isComposing) {
      e.preventDefault();
      sendMessage(input.value);
    }
  });
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  const main = document.querySelector('.main');
  main.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  main.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    addFiles([...e.dataTransfer.files]);
  });

  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.streaming) stopStreaming();
    else sendMessage(input.value);
  });
  document.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', () => sendMessage(chip.textContent)));

  window.addEventListener('hashchange', () => {
    const id = chatIdFromHash();
    if (id && id !== state.current) openChat(id);
  });

  $('#passkey-btn').addEventListener('click', passkeyLogin);
  $('#install-btn').addEventListener('click', () => { closeDrawer(); installApp(); });
  $('#install-login').addEventListener('click', installApp);
  updateInstallButtons();
  matchMedia('(display-mode: standalone)').addEventListener?.('change', updateInstallButtons);
  $('#device-login').addEventListener('submit', requestAccess);
  $('#wait-retry').addEventListener('click', () => showDeviceForm());
  $('#wait-cancel').addEventListener('click', async () => {
    try { await api('/access/cancel', { method: 'POST', body: {} }); } catch { /* ignore */ }
    showDeviceForm();
  });
  api('/auth/config').catch(() => ({ mode: 'device' })).then((cfg) => {
    state.authMode = cfg.mode;
    if (cfg.appName) { state.appName = cfg.appName; state.appShortName = cfg.appShortName || cfg.appName; }
    const m = location.pathname.match(/^\/invitacion\/([\w-]+)$/);
    if (m) return showInvite(m[1]);
    return api('/me').then(({ user }) => showApp(user)).catch(() => showLogin());
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
