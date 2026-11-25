#!/bin/sh
# Entry point of the admin image: refuses to start without a valid ADMIN_API_ORIGIN (it goes into
# the CSP connect-src of every response, apps/admin/docker/Caddyfile), then hands over to Caddy.
# An https origin only: scheme + host [+ port], no path, query or wildcard.
set -eu

origin="${ADMIN_API_ORIGIN:-}"
if [ -z "$origin" ]; then
  echo "admin: ADMIN_API_ORIGIN is required (e.g. https://api.ggpin.uz); not starting" >&2
  exit 1
fi
if ! printf '%s' "$origin" | grep -Eq '^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$'; then
  echo "admin: ADMIN_API_ORIGIN must be an https origin like https://api.ggpin.uz (no path, no wildcard); not starting" >&2
  exit 1
fi

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
