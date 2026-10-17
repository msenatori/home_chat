# Caddy con el módulo DNS de Cloudflare, para sacar el certificado del dominio y su comodín
# por DNS-01 (sin abrir puertos a internet).
FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/cloudflare

FROM caddy:2
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
