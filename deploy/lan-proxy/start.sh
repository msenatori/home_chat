#!/bin/sh
# Entrada del contenedor del proxy. Modos:
#   start.sh [run]     arranca Caddy (lo usa docker-compose)
#   start.sh validate  valida la config (lo usa `lanapp` antes de aplicar)
#   start.sh reload    recarga la config sin cortar conexiones (lo usa `lanapp`)
#
# Lee la config de la instalación del entorno (env_file proxy.env, ver .env.example) y arma
# las variables derivadas que usa el Caddyfile. Nunca debe dejar la casa sin chat: si
# CF_API_TOKEN falta o el módulo de Cloudflare no lo acepta, usa uno de relleno (Caddy arranca,
# los .local andan y el certificado se reintenta cuando haya token).
set -eu
MODE="${1:-run}"
CFG=/etc/caddy/proxy/Caddyfile
ADMIN=unix//run/caddy-admin.sock

die() { echo "lan-proxy: ERROR: $*" >&2; exit 1; }

# --- obligatorias ---
[ -n "${LAN_IP:-}" ] || die "falta LAN_IP en proxy.env (sin eso Caddy escucharía en todas las interfaces)"
[ -n "${BASE_DOMAIN:-}" ] || die "falta BASE_DOMAIN en proxy.env"
APP_PORT="${APP_PORT:-8787}"
APP_NAME="${APP_NAME:-chat}"

# --- derivadas ---
LAN_IPV6_BIND=""
[ -n "${LAN_IPV6:-}" ] && LAN_IPV6_BIND="[$LAN_IPV6]"
# Nombres viejos en HTTP que redirigen a https://$BASE_DOMAIN: <app>.local, <host>.local y la IP.
LEGACY_SITES="http://$APP_NAME.local, http://$LAN_IP"
[ -n "${LOCAL_HOSTNAME:-}" ] && LEGACY_SITES="http://$APP_NAME.local, http://$LOCAL_HOSTNAME.local, http://$LAN_IP"
export LAN_IP BASE_DOMAIN APP_PORT APP_NAME LAN_IPV6_BIND LEGACY_SITES

token_ok() { [ -n "${CF_API_TOKEN:-}" ] && caddy validate --config "$CFG" --adapter caddyfile >/dev/null 2>&1; }
use_placeholder() {
  echo "lan-proxy: AVISO: CF_API_TOKEN falta o es inválido; HTTPS sin certificado hasta corregir cloudflare.env" >&2
  CF_API_TOKEN="sin-token-sin-token-sin-token-sin-token0"; export CF_API_TOKEN
}

case "$MODE" in
  run)
    token_ok || use_placeholder
    exec caddy run --config "$CFG" --adapter caddyfile ;;
  validate)
    # El módulo de Cloudflare solo mira el formato del token: alcanza con uno de relleno.
    CF_API_TOKEN="sin-token-sin-token-sin-token-sin-token0"; export CF_API_TOKEN
    exec caddy validate --config "$CFG" --adapter caddyfile ;;
  reload)
    token_ok || use_placeholder
    exec caddy reload --config "$CFG" --adapter caddyfile --address "$ADMIN" ;;
  *) die "modo desconocido: $MODE (run|validate|reload)" ;;
esac
