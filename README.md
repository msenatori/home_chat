# Charla en familia (shareit)

Un chat de IA para la familia, que funciona en el celular y en la compu.
La idea: usar el **modo headless del CLI de una suscripción paga de IA**,
instalado en un servidor de la casa y logueado con esa suscripción, para que
toda la familia la pueda compartir desde la red de casa.

- Cada persona tiene su cuenta y ve solo sus charlas. Para entrar alcanza con
  escribir el nombre: un administrador **aprueba el dispositivo** (sin contraseñas).
- Las respuestas aparecen de a poco, mientras se escriben.
- Se pueden mandar **fotos** (cámara o galería) y **archivos** (PDF, Word, Excel,
  PowerPoint, OpenDocument, texto, CSV…), hasta 20 MB cada uno.
- El asistente puede **dibujar** ("dibujá un gato astronauta").
- Se puede **elegir el modelo** y cuánto "piensa" antes de responder (o fijarlo desde el panel).
- Se puede "agregar a la pantalla de inicio" en Android y iPhone (es una PWA).
- Pensado para funcionar **solo dentro de la red de casa**.
- Panel de administración: personas, dispositivos, uso (tokens, modelos) y límites del plan.

**Dirección:** `https://<BASE_DOMAIN>` (el dominio que configures en `.env`, ver
[Nombres sin puerto](#nombres-sin-puerto-proxy-de-la-red-de-casa)). Para compartirla con la familia,
`npm run qr` genera `qr/qr-chat.png` con esa dirección.

---

## Cómo se usa (para la familia)

1. Conectate al Wi-Fi de casa y abrí la dirección de la app en el navegador del celular.
2. Escribí tu nombre y tocá **Pedir acceso**. Aparece un **código de 2 cifras**:
   avisale a quien administra para que te apruebe. Cuando lo aprueba, entrás solo.
3. Para tenerlo como app:
   - **Android (Chrome):** menú ⋮ → *Agregar a la pantalla principal* / *Instalar app*.
   - **iPhone (Safari):** botón Compartir → *Agregar a inicio*. (La app de inicio
     es otro "dispositivo" para el iPhone: la primera vez pedí acceso de nuevo.)
4. Con **Nueva charla** empezás una conversación nueva. En la lista podés
   cambiarle el nombre (lápiz) o borrarla (tacho).
5. Con el **clip** 📎 adjuntás una foto o un archivo y preguntás sobre ellos
   ("¿qué dice este PDF?", "¿qué planta es esta?"). También podés pedir un dibujo.
6. Arriba, tocando el **nombre del modelo**, elegís cuál usar y cuánto piensa
   (si el administrador lo permite).

---

## Instalación

Requisitos en el servidor: Linux con **Node 24** y el **CLI de tu suscripción de
IA**, logueado con tu cuenta. El contrato que la app espera de ese CLI:

- un modo headless `app-server` que habla **JSON-RPC 2.0 por stdio** (una línea JSON
  por mensaje), con threads persistentes (`thread/start`, `thread/resume`),
  turnos con streaming (`turn/start`, `item/agentMessage/delta`), lista de modelos
  (`model/list`), uso de tokens y límites del plan;
- banderas `--enable/--disable <feature>` y `-c clave=valor` para apagar sus
  herramientas, y sandbox de solo lectura.

El binario se elige con `SHAREIT_LLM_BIN` (el valor por defecto es el CLI con el
que se desarrolló y probó, versión 0.162.1) y su carpeta de estado con
`SHAREIT_LLM_HOME` (por defecto `~/.<nombre-del-cli>`). Si `node` y el CLI están en
`~/.local/bin`, el servicio y el script de administración ya los encuentran.

1. Copiá el repo al servidor (por ejemplo `~/shareit`) y corré `npm ci --omit=dev`.
   El deploy automático está en `scripts/deploy.sh` (ver más abajo).
2. Configuración: copiá a `~/shareit-data/env` las variables de la sección **App**
   de [`.env.example`](.env.example) que quieras cambiar (todas tienen un valor por defecto).
3. Servicio: `deploy/shareit.service` es un servicio systemd **de usuario**
   (`~/.config/systemd/user/`). Para que arranque solo al prender el servidor:
   `loginctl enable-linger $USER`.
4. Creá el primer administrador y aprobá su primer dispositivo:

   ```bash
   ~/shareit/scripts/shareit-admin.sh add "Ana" --admin
   # Ana abre la app, escribe su nombre y toca "Pedir acceso"; después:
   ~/shareit/scripts/shareit-admin.sh requests
   ~/shareit/scripts/shareit-admin.sh approve 47      # el código que ve en pantalla
   ```

```bash
systemctl --user status shareit
systemctl --user restart shareit
journalctl --user -u shareit -f        # ver logs en vivo
```

### Configuración (`~/shareit-data/env`)

| Variable | Por defecto | Para qué |
| --- | --- | --- |
| `SHAREIT_APP_NAME` / `SHAREIT_APP_SHORT_NAME` | `Charla en familia` / `Charla` | Nombre en la app, la pestaña y el ícono |
| `SHAREIT_INSTRUCTIONS_FILE` | (vacío) | Archivo con instrucciones propias para el asistente (idioma, tono) |
| `SHAREIT_AUTH` | `device` | Ingreso: `device` (aprobar dispositivo), `passkey` o `pin` |
| `SHAREIT_REQUEST_MINUTES` / `SHAREIT_SESSION_DAYS` | `15` / `365` | Vigencia de un pedido de acceso / de un dispositivo aprobado (se renueva con el uso) |
| `SHAREIT_HOST` / `SHAREIT_PORT` | `::` / `8787` | Dónde escucha (IPv4 + IPv6) |
| `SHAREIT_LAN_ONLY` | `1` | Rechaza conexiones que no vengan de la red local |
| `SHAREIT_DATA_DIR` | `~/shareit-data` | Base de datos, adjuntos, carpeta de trabajo vacía del asistente |
| `SHAREIT_LLM_BIN` / `SHAREIT_LLM_HOME` | (el CLI de referencia) / `~/.<cli>` | Binario del CLI de IA y su carpeta de estado (login, sesiones) |
| `SHAREIT_LLM_MODEL` / `SHAREIT_LLM_EFFORT` | (el del proveedor) | Modelo y razonamiento por defecto |
| `SHAREIT_MODEL_PICKER` | `1` | Valor inicial de "Permitir elegir modelo" (después se cambia en el panel) |
| `SHAREIT_IMAGE_GENERATION` | `1` | Dibujos con la herramienta de imágenes del CLI |
| `SHAREIT_MAX_UPLOAD_MB` | `20` | Tamaño máximo por archivo |
| `SHAREIT_TZ_OFFSET_MIN` | `-180` | Huso horario de los reportes (minutos respecto de UTC) |
| `SHAREIT_RP_ID`, `SHAREIT_ORIGINS`, `SHAREIT_PUBLIC_URL`, `SHAREIT_INVITE_HOURS` | — | Solo para `SHAREIT_AUTH=passkey` |

Después de cambiar algo: `systemctl --user restart shareit`.

---

## Administración

### Desde el servidor

```bash
~/shareit/scripts/shareit-admin.sh list                        # personas
~/shareit/scripts/shareit-admin.sh add "Ana" --admin            # crear (con --admin, administradora)
~/shareit/scripts/shareit-admin.sh requests                     # pedidos de acceso pendientes
~/shareit/scripts/shareit-admin.sh approve 47                   # aprobar por código (o #12 por número de pedido)
~/shareit/scripts/shareit-admin.sh approve 47 --as "Lucía"      # aprobarlo como otra persona (nombre mal escrito)
~/shareit/scripts/shareit-admin.sh reject 47
~/shareit/scripts/shareit-admin.sh promote "Lucía"  /  demote "Lucía"
~/shareit/scripts/shareit-admin.sh rename "Lucía" "Lu"
~/shareit/scripts/shareit-admin.sh revoke "Lucía"               # desconectar todos sus dispositivos
~/shareit/scripts/shareit-admin.sh remove "Lucía"               # borrar la persona, sus charlas y archivos
```

Siempre tiene que quedar al menos un administrador: `demote`/`remove` del
último se rechazan (desde la consola del servidor se puede forzar con `--force`).
El nombre no distingue mayúsculas ni tildes ("lucia" = "Lucía").

### Ingreso: aprobar dispositivo (`SHAREIT_AUTH=device`, por defecto)

1. En el celular se escribe **"¿Cómo te llamás?"** y se toca **Pedir acceso**.
2. La pantalla muestra un **código de 2 cifras** y "Avisale a *(nombres de los
   administradores)* que te apruebe".
3. Un administrador lo ve arriba de todo en **Administración → Pedidos de acceso**
   (y un globito rojo en "Administración" en el menú del chat), confirma que el
   código coincide y toca **Aprobar** o **Rechazar**. Si el nombre no existe, el
   pedido llega como **persona nueva** y al aprobarlo se crea la cuenta; si
   alguien escribió mal su nombre, se puede aprobar **como** otra persona existente.
4. El celular entra solo (revisa cada 3 s). Ese dispositivo queda conectado
   1 año, y cada uso lo extiende.

Los pedidos vencen a los 15 minutos; hay límite de pedidos por red y por nombre.
En **Personas → Dispositivos** se ve cada dispositivo (aprobado, último uso) y se
puede **Desconectar**. Al arrancar en este modo se cierran las sesiones abiertas
con PIN o passkey.

### Otros modos de ingreso (apagados por defecto)

- `SHAREIT_AUTH=passkey`: passkeys (WebAuthn) con invitaciones de un solo uso
  (`shareit-admin.sh invite "<nombre>"`). Necesita HTTPS en un dominio propio y
  `SHAREIT_RP_ID` (el dominio "padre", p. ej. `casa.example.com`),
  `SHAREIT_ORIGINS` (orígenes exactos) y `SHAREIT_PUBLIC_URL` (base de los links).
  Credenciales descubribles, verificación de usuario obligatoria, atestación
  `none`, `@simplewebauthn/server`. Al arrancar en este modo se cierran las
  sesiones abiertas con PIN.
- `SHAREIT_AUTH=pin`: nombre + PIN numérico (modo original, `shareit-admin.sh add "<nombre>" 1234`,
  `reset-pin`). Los PIN se guardan con `scrypt`; 5 errores seguidos bloquean 15 minutos.

### Panel de administración

Los administradores ven **Administración** abajo en la lista de charlas, o
entran directo a `/admin`. Funciona bien en el celular:

- **Pedidos de acceso** (arriba, cuando hay): código grande, nombre, dispositivo, Aprobar / Rechazar.
- **Personas:** fecha de creación, última actividad, charlas, dispositivos
  conectados y espacio de sus adjuntos. Crear, cambiar nombre, ver/desconectar
  dispositivos, hacer/quitar administrador y borrar (con confirmación en la página).
- **Uso:** por día o por semana, para toda la familia o por persona: mensajes,
  errores y respuestas detenidas, tokens de entrada / en caché / de salida,
  modelos y razonamiento, adjuntos, dibujos generados, tiempo de respuesta.
  Gráficos de barras y tablas por persona y por modelo.
- **Límites:** cuánto se usó de los límites de tu plan de IA (ventanas y
  renovación). Son de **toda la cuenta**: incluyen cualquier otro uso que hagas con ella.
- **Ajustes:** "Permitir elegir modelo" y el modelo + razonamiento fijo para quienes no
  pueden elegir; en **Personas** cada cuenta puede heredar, permitir u ocultar el
  selector. Cuando no se permite, el botón desaparece **y el servidor rechaza** los cambios (403).

**Privacidad:** los reportes son solo metadatos. Ningún endpoint de
administración devuelve el texto de los mensajes ni los títulos de las charlas.
Cada pedido a `/api/admin/*` vuelve a verificar en la base que quien lo hace sea administrador.
Por cada respuesta se guarda una fila en `turns` (persona, modelo, estado, tokens
de `thread/tokenUsage/updated`, adjuntos, dibujos, duración), que se conserva aunque
se borre la charla. Los límites salen de `account/rateLimits/read`.

### Datos

Todo vive en `SHAREIT_DATA_DIR` (por defecto `~/shareit-data/`):

| Qué | Dónde |
| --- | --- |
| Base de datos (personas, dispositivos, charlas, mensajes, uso) | `shareit.db` (SQLite) |
| Carpeta de trabajo del asistente (vacía, solo lectura) | `workspace/` |
| Adjuntos y dibujos (una carpeta por charla; se borra con la charla) | `attachments/<chat>/` |
| Configuración del servidor | `env` |

Para hacer un backup alcanza con copiar `shareit.db` y `attachments/`
(idealmente con el servicio parado). Los adjuntos que se subieron pero nunca se
mandaron se borran solos a las 24 h.

---

## Deploy

```bash
scripts/deploy.sh        # necesita SSH_HOST (en el entorno o en .env; ver .env.example)
```

Copia el repo al servidor con `rsync` (sin `.git` ni `node_modules`), corre
`npm ci --omit=dev`, instala `deploy/shareit.service`, lo reinicia y verifica `/healthz`.

Dependencias: Node 24 (`node:http`, `node:sqlite`, `node:crypto`) más
`pdfjs-dist` (leer PDFs), `qrcode` (QR de invitaciones) y `@simplewebauthn/server`
(solo modo passkey). En el frontend, `marked`, `DOMPurify` y
`@simplewebauthn/browser` están copiados en `public/vendor/` (nada se carga de internet).

El QR de la dirección se genera en la compu, sin servicios externos: `npm install && npm run qr`
(usa `qrcode`; toma `QR_URL` o `https://$BASE_DOMAIN` del entorno o de `.env` y escribe
`qr/qr-chat.png`, que está en `.gitignore` porque codifica tu dominio).

Pruebas: `npm test` (levanta el servidor real en localhost con datos temporales:
aprobar dispositivo, passkeys con un autenticador por software, nombre de la app).

---

## Cómo funciona por dentro

```
celular ──HTTP──▶ server/index.js (Node, puerto 8787)
                     │  SQLite: personas, dispositivos, charlas, mensajes, uso
                     └─ stdio JSON-RPC ─▶ <cli> app-server (un proceso)
```

- El servidor levanta **un** proceso `<cli> app-server` y le habla por
  JSON-RPC (`server/llm.js`). Cada charla es un *thread* del CLI (`thread/start`, después
  `thread/resume` si el proceso se reinició), así el asistente se acuerda de lo
  hablado. Las respuestas llegan como `item/agentMessage/delta` y se mandan al
  navegador con SSE.
- **Modelos:** la lista sale de `model/list` (si falla, de
  `models_cache.json` en la carpeta del CLI); el modelo y el razonamiento van en cada `turn/start`.
- **Fotos:** se guardan en `attachments/` y van al asistente como `localImage`.
- **Archivos:** el asistente no tiene herramientas para leer archivos (a propósito), así
  que el servidor extrae el texto (`server/extract.js`: pdf.js, un lector de zip
  propio para docx/xlsx/pptx/odt/ods/odp, texto plano) y lo agrega al mensaje.
  Un PDF escaneado no tiene texto: conviene mandarlo como foto.
- **Dibujos:** el resultado llega como ítem `imageGeneration` (PNG en base64);
  se guarda como adjunto de la respuesta. El CLI guarda su propia copia en
  `generated_images/<thread>/` dentro de su carpeta, que se borra junto con la charla.
- Los threads quedan en la carpeta normal del CLI (la misma del login, para que
  la sesión de la suscripción se siga renovando sola).

### Seguridad del asistente

La idea es que nadie pueda, sin querer o queriendo, hacer que el asistente toque el servidor:

- **Sin herramientas peligrosas:** se desactivan `shell_tool`, `unified_exec`,
  plugins, apps/conectores, hooks, skills, multi-agente, navegador, computer use,
  `view_image`, memorias, etc. (lista en `server/llm.js`), y `mcp_servers = {}`.
  El asistente no puede correr comandos ni leer archivos del servidor (ni los adjuntos:
  esos se los pasamos nosotros), así que nadie puede pedirle que lea
  el archivo de login del CLI, claves SSH o charlas de otra persona.
- **Dibujos:** en la versión probada del CLI la herramienta de imágenes solo existe
  dentro del "code mode" (`code_mode_host`: un aislamiento V8 sin Node, sin
  archivos y sin red). Con todo lo demás apagado, las únicas herramientas que ve
  son: imágenes, reloj, recursos MCP (no hay servidores) y `apply_patch`, que el
  sandbox de solo lectura rechaza. La herramienta web se apaga explícitamente
  (`web_search="disabled"`), porque haría pedidos desde el servidor. Se puede
  apagar todo esto con `SHAREIT_IMAGE_GENERATION=0`.
- Las herramientas de "sub-agentes" no se pueden quitar con flags en esta
  versión; quedan limitadas (`agents.max_threads=1`, `agents.max_depth=0`) y un
  sub-agente hereda la misma configuración.
- **Sandbox `read-only`** y **`approval_policy = never`** al arrancar el proceso,
  en cada thread y en cada turno; si el asistente pidiera permiso, el servidor lo rechaza.
- **Carpeta de trabajo vacía** (`workspace/`), sin `AGENTS.md`, e instrucciones
  de asistente general (reemplazables con `SHAREIT_INSTRUCTIONS_FILE`).

### Seguridad de la app

- Dispositivos aprobados: token aleatorio en una cookie `HttpOnly` + `SameSite=Lax`
  (`Secure` sobre HTTPS); en la base solo se guarda su hash. El pedido de acceso
  usa otro secreto en su propia cookie, válido 15 minutos y de un solo uso.
- Límites de pedidos por red y por nombre; chequeo de `Origin` y de
  `Content-Type: application/json` en todo lo que modifica.
- CSP estricta (`default-src 'self'`) y el Markdown se sanitiza con DOMPurify.
- **Solo red local:** escucha en IPv4 e IPv6 (`::`) pero rechaza conexiones que
  no vengan de la red local (IPv4 privadas, IPv6 link-local/ULA y el mismo
  prefijo /64 que el servidor; `server/lan.js`). Importa porque muchas redes de
  casa dan IPv6 públicas. Detrás de un proxy local, `X-Forwarded-For` y
  `X-Forwarded-Proto` solo se aceptan desde loopback.
- Los adjuntos solo los puede bajar su dueño; las imágenes se muestran y el
  resto se descarga siempre como archivo.

## Estructura

```
server/        backend (index.js, llm.js, access.js, admin.js, users.js, settings.js, passkeys.js, extract.js, lan.js, auth.js, db.js, config.js)
public/        frontend (chat: index.html/app.js; panel: admin.html/admin.js; service worker, manifest, íconos, vendor/)
scripts/       shareit-admin.sh + admin.js (administración), deploy.sh, make-icons.js, make-qr.js
test/          npm test
deploy/        shareit.service (systemd de usuario), lan-proxy/ (proxy opcional de la red de casa)
```

---

## Nombres sin puerto (proxy de la red de casa)

En `deploy/lan-proxy/` hay un Caddy (Docker, `network_mode: host`, imagen `lan-proxy-caddy:1` con el
módulo DNS de Cloudflare) que escucha en los puertos 80 y 443 del server, **solo** en `LAN_IP`,
`127.0.0.1` y (opcional) `LAN_IPV6`, y reparte por nombre. Solo acepta IPs privadas (403 si no).

- `https://<BASE_DOMAIN>` y `https://<APP_NAME>.<BASE_DOMAIN>` → la app (`127.0.0.1:APP_PORT`), con
  certificado real de Let's Encrypt. `http://` en esos nombres redirige a `https://`.
- `http://<APP_NAME>.local`, `http://<LOCAL_HOSTNAME>.local` y `http://<LAN_IP>` → redirigen (308) a
  `https://<BASE_DOMAIN>` (el login con passkeys solo anda en HTTPS con nombre real).
- Los `.local` se anuncian por mDNS con `mdns-alias@.service` (IPv4 + la IPv6 privada ULA, nunca la
  pública; así macOS no espera 5 s una respuesta IPv6).

**Configuración.** Todo lo de la instalación va en `~/shareit-data/proxy.env` en el server (copiá la
sección del proxy de `.env.example`: `LAN_IP`, `LAN_IPV6`, `BASE_DOMAIN`, `APP_NAME`, `APP_PORT`,
`LOCAL_HOSTNAME`). `start.sh` arma las variables derivadas que usa el `Caddyfile`.

**Cómo funciona el HTTPS.** En Cloudflare se crean dos registros, `<BASE_DOMAIN>` y
`*.<BASE_DOMAIN>`, ambos `A <LAN_IP>` en modo *solo DNS* (sin la nube naranja). Así cualquier
`<algo>.<BASE_DOMAIN>` apunta al server dentro de casa, y desde afuera no llega a nada. Caddy saca los
certificados del dominio y del comodín por DNS-01 (crea un TXT temporal en Cloudflare), sin abrir
puertos a internet, y los renueva solo. El token de Cloudflare (plantilla *Edit zone DNS*, solo tu
zona) va en `~/shareit-data/cloudflare.env` (`CF_API_TOKEN=...`, modo 600), nunca en el repo. Si falta
o es inválido, el proxy **arranca igual** (avisa en `docker logs lan-proxy`): los `.local` siguen
andando y solo el HTTPS queda sin certificado hasta corregirlo y hacer `docker compose up -d --force-recreate`.
Los certificados quedan en `~/shareit-data/caddy/`. Si el router filtra respuestas DNS públicas que
apuntan a IPs privadas (protección contra *DNS rebinding*), hay que exceptuar `<BASE_DOMAIN>`.

**Primera instalación** (en el server, desde `~/shareit/deploy/lan-proxy`):

```bash
# 1) config y token (ver .env.example)
install -m 600 /dev/null ~/shareit-data/proxy.env && $EDITOR ~/shareit-data/proxy.env
install -m 600 /dev/null ~/shareit-data/cloudflare.env && $EDITOR ~/shareit-data/cloudflare.env
mkdir -p ~/shareit-data/caddy/{apps,data,config}
# 2) piezas root: alias mDNS y la regla sudoers de lanapp
sudo install -m 755 mdns-alias /usr/local/bin/ && sudo install -m 755 mdns-alias-ctl /usr/local/sbin/
sudo install -m 644 mdns-alias@.service /etc/systemd/system/ && sudo systemctl daemon-reload
sed "s/USUARIO/$USER/" lanapp.sudoers | sudo tee /etc/sudoers.d/lanapp >/dev/null
sudo chmod 440 /etc/sudoers.d/lanapp && sudo visudo -c
sudo systemctl enable --now mdns-alias@chat          # el APP_NAME
ln -sf "$PWD/lanapp" ~/.local/bin/lanapp
# 3) proxy
docker compose up -d --build
```

**Agregar una app nueva** (un comando; no hace falta tocar DNS, certificados ni sudo):

```bash
lanapp add fotos 3000     # → https://fotos.<BASE_DOMAIN> y http://fotos.local → 127.0.0.1:3000
lanapp list
lanapp rm fotos           # saca las dos y apaga el alias mDNS
```

`lanapp` guarda la lista en `~/shareit-data/caddy/apps.txt`, genera `apps/routes.caddy` y
`apps/sites.caddy` (que el `Caddyfile` importa), valida y recarga Caddy sin cortar conexiones; si algo
falla, no cambia nada. El alias `.local` lo prende con `sudo -n /usr/local/sbin/mdns-alias-ctl`
(la regla sudoers deja correr solo ese script, que valida el nombre). La app tiene que escuchar en
`127.0.0.1`; recibe `X-Forwarded-For`/`-Proto`/`-Host` de Caddy. Rechaza nombres reservados
(`APP_NAME`, `LOCAL_HOSTNAME`, el hostname, `www`, `localhost`) o inválidos, puertos fuera de
1024–65535 y puertos de bases de datos/redis/inspectores de node (5432, 3306, 6379, 27017, 9229…).

**Cambiar el resto del proxy:** editá `deploy/lan-proxy/`, `scripts/deploy.sh` (o `rsync` de esa
carpeta) y en el server `cd ~/shareit/deploy/lan-proxy && docker compose up -d --build`.

La app sigue respondiendo directo en `APP_PORT`; detrás del proxy toma la IP real del
`X-Forwarded-For` (solo si la conexión viene de loopback) para el límite de intentos de login.

---

## Aviso

Proyecto independiente. Usa el LLM que tengas configurado en el servidor (el CLI
de tu suscripción de IA) con la cuenta de quien lo instala: revisá los términos de tu proveedor y
de tu plan antes de compartir el acceso con otras personas. Se ofrece "tal cual",
bajo licencia MIT.
