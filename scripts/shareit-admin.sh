#!/usr/bin/env bash
# Administración de usuarios. Correr en el servidor:
#   ~/shareit/scripts/shareit-admin.sh requests
#   ~/shareit/scripts/shareit-admin.sh approve 47
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$PATH"
export SHAREIT_DATA_DIR="${SHAREIT_DATA_DIR:-$HOME/shareit-data}"
# Same settings as the service: read KEY=VALUE lines from the env file (systemd
# EnvironmentFile format; values may contain spaces). It is parsed, not executed.
ENV_FILE="${SHAREIT_ENV_FILE:-$SHAREIT_DATA_DIR/env}"
if [ -f "$ENV_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"; val="${line#*=}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    val="${val#\"}"; val="${val%\"}"; val="${val#\'}"; val="${val%\'}"
    [ -n "${!key+x}" ] || export "$key=$val"   # explicit environment wins
  done < "$ENV_FILE"
fi
exec node --disable-warning=ExperimentalWarning scripts/admin.js "$@"
