#!/usr/bin/env bash
# Deploy de Shareit al server: copia el código, instala el servicio systemd de
# usuario y lo (re)inicia. Uso: scripts/deploy.sh   (desde la raíz del repo)
# Config (variables de entorno o un .env en la raíz del repo, ver .env.example):
#   SSH_HOST    host o alias de ssh del server (obligatorio)
#   REMOTE_DIR  carpeta del código, relativa al home remoto (por defecto: shareit)
#   APP_PORT    puerto de la app para el chequeo de salud (por defecto: 8787)
set -euo pipefail

cd "$(dirname "$0")/.."

# Lee solo estas claves del .env local (sin ejecutarlo); el entorno tiene prioridad.
envget() { [ -f .env ] && sed -n "s/^[[:space:]]*$1=//p" .env | tail -1 | sed -E "s/^['\"]//; s/['\"][[:space:]]*$//; s/[[:space:]]*$//"; }
SSH_HOST="${SSH_HOST:-${SHAREIT_SSH_HOST:-$(envget SSH_HOST || true)}}"
REMOTE_DIR="${REMOTE_DIR:-$(envget REMOTE_DIR || true)}"; REMOTE_DIR="${REMOTE_DIR:-shareit}"
PORT="${APP_PORT:-${SHAREIT_PORT:-$(envget APP_PORT || true)}}"; PORT="${PORT:-8787}"
[ -n "$SSH_HOST" ] || { echo "Falta SSH_HOST (exportalo o ponelo en .env; ver .env.example)"; exit 1; }
HOST="$SSH_HOST"; APP_DIR="$REMOTE_DIR"

echo "==> Copiando código a $HOST:~/$APP_DIR"
rsync -az --delete \
  --exclude '.git' --exclude 'node_modules' --exclude '.DS_Store' --exclude '.codegraph' \
  --include '.env.example' --exclude '.env' --exclude '.env.*' --exclude '/qr/' \
  ./ "$HOST:$APP_DIR/"

echo "==> Instalando servicio y reiniciando"
ssh "$HOST" bash -s -- "$APP_DIR" "$PORT" <<'REMOTE'
set -euo pipefail
APP_DIR="$1"; PORT="$2"
export PATH="$HOME/.local/bin:$PATH"
command -v node >/dev/null || { echo "node no está en ~/.local/bin"; exit 1; }
LLM_BIN="$(sed -n 's/^SHAREIT_LLM_BIN=//p' "$HOME/shareit-data/env" 2>/dev/null | tail -1)"
if [ -n "$LLM_BIN" ]; then
  command -v "$LLM_BIN" >/dev/null || { echo "$LLM_BIN (SHAREIT_LLM_BIN) no está en el PATH"; exit 1; }
fi

cd "$HOME/$APP_DIR"
# Dependencias de runtime (pdfjs-dist para leer PDFs). Las devDependencies (qrcode) no hacen falta acá.
if grep -q "\"dependencies\"" package.json; then npm ci --omit=dev --no-audit --no-fund --loglevel=error; fi
chmod +x scripts/*.sh

mkdir -p "$HOME/shareit-data/workspace"
chmod 700 "$HOME/shareit-data"

if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
  loginctl enable-linger "$USER" || echo "AVISO: no pude activar linger; el servicio no arrancará solo tras reiniciar."
fi

mkdir -p "$HOME/.config/systemd/user"
install -m 644 deploy/shareit.service "$HOME/.config/systemd/user/shareit.service"
systemctl --user daemon-reload
systemctl --user enable shareit.service >/dev/null 2>&1
systemctl --user restart shareit.service

for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    echo "OK: Shareit corriendo en http://$(hostname -I | awk '{print $1}'):$PORT"
    exit 0
  fi
  sleep 0.5
done
echo "ERROR: el servicio no respondió. Últimos logs:"
journalctl --user -u shareit -n 40 --no-pager
exit 1
REMOTE
