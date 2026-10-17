#!/usr/bin/env node
// Admin CLI for Shareit users. Run on the server (via scripts/shareit-admin.sh):
//   add "Ana" --admin             create a user (optionally as administrator)
//   list                          list users
//   reset-pin "Mamá" 5678         change PIN (closes their sessions)
//   rename "Mamá" "Mami"          change display/login name
//   promote "Mamá" / demote "Mamá"
//   revoke "Mamá"                 close all their sessions
//   remove "Mamá"                 delete user, chats and files
import { config } from '../server/config.js';
import { db } from '../server/db.js';
import { PasskeyError, createInvite, inviteUrl, listPasskeys } from '../server/passkeys.js';
import { AccessError, approveRequest, listPending, rejectRequest } from '../server/access.js';
import {
  UserError, createUser, deleteUser, findUserByName, listUsers, renameUser,
  revokeSessions, setAdmin, setPin,
} from '../server/users.js';

const argv = process.argv.slice(2);
// --as "Nombre" takes a value; other --flags are booleans.
const asIdx = argv.indexOf('--as');
const asName = asIdx >= 0 ? argv[asIdx + 1] : null;
const rest = asIdx >= 0 ? argv.filter((_, i) => i !== asIdx && i !== asIdx + 1) : argv;
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const [cmd, name, arg] = rest.filter((a) => !a.startsWith('--'));

/** "47" → code 47; "#12" or a number outside 10–99 → request id 12. */
function requestRef(v) {
  const s = String(v || '').trim();
  if (s.startsWith('#')) return { id: Number(s.slice(1)) };
  const n = Number(s);
  if (!Number.isInteger(n)) { console.error('Indicá el código (ej. 47) o el número de pedido (ej. #12).'); process.exit(1); }
  return n >= 10 && n <= 99 ? { code: n } : { id: n };
}

function need(...vals) {
  if (vals.some((v) => !v)) {
    console.error('Faltan datos. Corré sin argumentos para ver la ayuda.');
    process.exit(1);
  }
}

const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hourCycle: 'h23' }) : 'nunca');
const fmtMB = (b) => `${(b / 1048576).toFixed(1)} MB`;

function printInvite(userId, displayName) {
  const { token, expiresAt } = createInvite(userId);
  console.log(`Invitación para "${displayName}" (un solo uso, vence ${fmtDate(expiresAt)}):`);
  console.log(inviteUrl(token));
  console.log('Abrila en el celular de esa persona para crear su passkey.');
}

try {
  switch (cmd) {
    case 'add': {
      need(name);
      if (config.authMode === 'pin') need(arg);
      const u = createUser(name, arg, { isAdmin: flags.has('--admin') });
      console.log(`Usuario "${u.display_name}" creado${u.is_admin ? ' como administrador' : ''}.`);
      if (config.authMode === 'passkey') printInvite(u.id, u.display_name);
      else if (config.authMode === 'device') console.log('Que abra la app, escriba su nombre y toque "Pedir acceso"; después aprobalo con: approve <código>');
      else console.log('Ingresa con su nombre y PIN.');
      break;
    }
    case 'requests': {
      const list = listPending();
      if (!list.length) console.log('No hay pedidos de acceso pendientes.');
      for (const r of list) {
        const who = r.isNew ? 'persona nueva' : `= ${r.matchedName}`;
        const mins = Math.max(0, Math.round((r.expiresAt - Date.now()) / 60000));
        console.log(`- código ${r.code}  (#${r.id})  "${r.name}" (${who})  ${r.device}  pedido ${fmtDate(r.createdAt)}, vence en ${mins} min`);
      }
      break;
    }
    case 'approve': {
      need(name);
      const asUserId = asName ? findUserByName(asName).id : null;
      const r = approveRequest(requestRef(name), { asUserId, isAdmin: flags.has('--admin') });
      const u = db.prepare('SELECT display_name FROM users WHERE id = ?').get(r.userId);
      console.log(`Aprobado: el dispositivo (${r.request.device}) entra como "${u.display_name}"${r.created ? ' (persona nueva creada)' : ''}.`);
      break;
    }
    case 'reject': {
      need(name);
      const r = rejectRequest(requestRef(name));
      console.log(`Rechazado el pedido de "${r.name}" (código ${r.code}).`);
      break;
    }
    case 'invite': {
      need(name);
      const u = findUserByName(name);
      printInvite(u.id, u.display_name);
      break;
    }
    case 'passkeys': {
      need(name);
      const list = listPasskeys(findUserByName(name).id);
      if (!list.length) console.log('No tiene passkeys.');
      for (const p of list) console.log(`- ${p.name}  (creada: ${fmtDate(p.createdAt)}, último uso: ${fmtDate(p.lastUsedAt)})`);
      break;
    }
    case 'list': {
      const rows = listUsers();
      if (!rows.length) console.log('No hay usuarios todavía.');
      for (const r of rows) {
        console.log(`- ${r.name}${r.isAdmin ? ' [admin]' : ''}  (login: ${r.login}, passkeys: ${r.passkeys}, chats: ${r.chats}, sesiones: ${r.sessions}, ` +
          `adjuntos: ${fmtMB(r.storageBytes)}, última actividad: ${fmtDate(r.lastActiveAt)}, creado: ${fmtDate(r.createdAt)})`);
      }
      break;
    }
    case 'reset-pin': {
      need(name, arg);
      const u = setPin(findUserByName(name).id, arg);
      console.log(`PIN de "${u.display_name}" cambiado. Se cerraron sus sesiones abiertas.`);
      break;
    }
    case 'rename': {
      need(name, arg);
      const u = renameUser(findUserByName(name).id, arg);
      console.log(`Ahora se llama "${u.display_name}" (ingresa con ese nombre).`);
      break;
    }
    case 'promote':
    case 'demote': {
      need(name);
      const u = setAdmin(findUserByName(name).id, cmd === 'promote', { force: flags.has('--force') });
      console.log(`"${u.display_name}" ${u.is_admin ? 'ahora es administrador' : 'ya no es administrador'}.`);
      break;
    }
    case 'revoke': {
      need(name);
      const u = findUserByName(name);
      console.log(`Se cerraron ${revokeSessions(u.id)} sesiones de "${u.display_name}".`);
      break;
    }
    case 'remove': {
      need(name);
      const { user, chats } = deleteUser(findUserByName(name).id, { force: flags.has('--force') });
      console.log(`Usuario "${user.display_name}" borrado junto con sus ${chats} conversaciones.`);
      break;
    }
    default:
      console.log(`Shareit — administración de usuarios (datos en ${config.dbPath}, ingreso: ${config.authMode})

  requests                       pedidos de acceso pendientes (modo dispositivo)
  approve <código|#id> [--as "Nombre"] [--admin]
                                 aprobar un pedido (--as: como otra persona existente;
                                 --admin: si es persona nueva, crearla como administradora)
  reject <código|#id>            rechazar un pedido
  add <nombre> [pin] [--admin]   crear un usuario (con --admin, administrador).
                                 Con passkeys imprime su invitación; el PIN solo hace falta en modo pin
  invite <nombre>                nueva invitación de un solo uso (24 h) para registrar una passkey
  passkeys <nombre>              ver sus passkeys
  list                           listar usuarios
  reset-pin <nombre> <pin>       cambiar el PIN (cierra sus sesiones)
  rename <nombre> <nuevo>        cambiar el nombre
  promote <nombre>               hacerlo administrador
  demote <nombre> [--force]      sacarle el rol de administrador
  revoke <nombre>                cerrar todas sus sesiones
  remove <nombre> [--force]      borrar usuario y sus chats
                                 (--force permite quedarse sin administradores)`);
      if (cmd && cmd !== 'help') process.exit(1);
  }
} catch (e) {
  if (e instanceof UserError || e instanceof PasskeyError || e instanceof AccessError) { console.error(e.message); process.exit(1); }
  throw e;
}
