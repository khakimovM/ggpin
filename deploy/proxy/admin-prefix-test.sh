#!/usr/bin/env bash
# Regression test of the public API name's path rules in deploy/proxy/Caddyfile (README §10): the
# admin prefix (S3-1, proxy SA F-1) and dot segments (F-4) are a proxy 404, public routes (ids that
# merely start with "admin" included) reach the upstream. Runs the real Caddyfile in front of an
# echo upstream named `api` on an internal network; local images only, nothing leaves the machine.
#
# Usage:  bash deploy/proxy/admin-prefix-test.sh [Caddyfile]     (default: the one next to this file)
# Exit:   0 = every case as expected, 1 = a case failed or the setup broke.
# Images: CADDY_IMAGE and NODE_IMAGE (defaults: the pinned images of deploy/proxy/Dockerfile and
#         apps/worker/Dockerfile) must already be present: `--pull never`.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
CADDYFILE=${1:-$HERE/Caddyfile}
CADDY_IMAGE=${CADDY_IMAGE:-caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d}
NODE_IMAGE=${NODE_IMAGE:-node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9}
API=api.prefix-test.invalid
P=ggpin-prefix-test-$$
export MSYS_NO_PATHCONV=1
[ -r "$CADDYFILE" ] || { echo "Caddyfile not readable: $CADDYFILE" >&2; exit 1; }
WORK=$(mktemp -d) || exit 1
trap 'docker rm -f "$P-proxy" "$P-api" >/dev/null 2>&1; docker network rm "$P" >/dev/null 2>&1; rm -rf "$WORK"' EXIT
trap 'exit 1' INT TERM
cp "$CADDYFILE" "$WORK/Caddyfile" || exit 1
printf '{\n\tadmin off\n}\n:5000 {\n\trespond "UPSTREAM {http.request.uri}" 200\n}\n' > "$WORK/Upstream"
# Docker Desktop on Windows needs a Windows path for bind mounts.
MNT=$WORK
command -v cygpath >/dev/null 2>&1 && MNT=$(cygpath -w "$WORK")

docker network create --internal "$P" >/dev/null || exit 1
docker run -d --pull never --name "$P-api" --network "$P" --network-alias api \
  -v "$MNT/Upstream:/etc/caddy/Caddyfile:ro" "$CADDY_IMAGE" >/dev/null || exit 1
docker run -d --pull never --name "$P-proxy" --network "$P" \
  -e SITE_DOMAIN=prefix-test.invalid -e API_DOMAIN=$API -e ADMIN_DOMAIN=admin.prefix-test.invalid \
  -e PROXY_TLS=internal -e PROXY_ACME_CA=https://acme-v02.api.letsencrypt.org/directory \
  -v "$MNT/Caddyfile:/etc/caddy/Caddyfile:ro" "$CADDY_IMAGE" >/dev/null || exit 1
PIP=$(docker inspect -f "{{(index .NetworkSettings.Networks \"$P\").IPAddress}}" "$P-proxy") || exit 1

# One HTTPS request with the path sent byte for byte; prints "<status> <body>".
CLIENT='const [ip, host, path] = process.argv.slice(1);
const go = (left) => {
  const req = require("https").request({ host: ip, port: 443, method: "GET", path, servername: host,
    headers: { Host: host }, rejectUnauthorized: false, timeout: 5000 }, (res) => {
    let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => console.log(res.statusCode, b));
  });
  req.on("error", (e) => (left > 0 ? setTimeout(() => go(left - 1), 500) : console.log("ERR", e.code)));
  req.end();
};
go(20);'

fails=0
run() { # expected(upstream|proxy404) path
  local out got
  out=$(docker run --rm --pull never --network "$P" --read-only --cap-drop ALL --entrypoint node \
        "$NODE_IMAGE" -e "$CLIENT" "$PIP" "$API" "$2")
  case "$out" in '200 UPSTREAM'*) got=upstream ;; '404 ') got=proxy404 ;; *) got="other($out)" ;; esac
  if [ "$got" = "$1" ]; then printf 'PASS  %-9s %s\n' "$got" "$2"
  else printf 'FAIL  expected %s, got %s: %s\n' "$1" "$got" "$2"; fails=$((fails + 1)); fi
}

echo "== public routes, ids starting admin/ADMIN included: reach the upstream"
for p in /api/v1/payments/intents/adminq3k9x2v7m1p0r8s5t4w6 /api/v1/payments/intents/adminq3k9x2v7m1p0r8s5t4w6/cancel \
         /api/v1/payments/intents/adminq3k9x2v7m1p0r8s5t4w6/pay-link /api/v1/payments/pay/adminq3k9x2v7m1p0r8s5t4w6 \
         /api/v1/auth/sessions/adminq3k9x2v7m1p0r8s5t4w6 /api/v1/orders/adminq3k9x2v7m1p0r8s5t4w6 \
         /api/v1/auth/telegram/status/ADMINxY0_-abcdefghijklmnopqrstuvwxyz0123456 \
         /api/v1/auth/telegram/status/adminXY0_-abcdefghijklmnopqrstuvwxyz0123456 \
         /api/v1/catalog/categories /api/v1/health/live /api/v1/me /api/v1/quotes /api/v1/recipients \
         '/api/v1/catalog/categories?x=../y' /api/v1/orders/a.b /api/v1/orders/...x; do
  run upstream "$p"
done
echo "== admin prefix (no terminator: F-1) and every bypass form: proxy 404"
for p in /api/v1/admin/auth/me /API/V1/ADMIN/auth/me /api/v1/Admin/auth/me //api/v1/admin/auth/me /api//v1//admin/auth/me \
         /api/v1/admin /api/v1/admin/ /api/v1/adminx /api/v1/admin.x '/api/v1/%61dmin/auth/me' '/api/v1/%41DMIN/auth/me' \
         '/api/v1/admin%2fauth%2fme' '/api/v1/%61dmin%2Fauth%2Fme' '/api/v1/admin;x/auth/me' '/api/v1/admin;x' \
         '/api/v1/admin%3Bx/auth/me' '/api/v1/admin%3Fx' '/api/v1/admin%23x' '/api/v1/admin%00' '/api/v1/admin%2F' \
         '/api/v1/admin/auth/me?x=1' /api/admin/auth/me /api/v2/admin/x '/api%2Fv1%2Fadmin/auth/me'; do
  run proxy404 "$p"
done
echo "== dot segments (F-4), admin or not: proxy 404"
for p in /api/v1/x/../admin/auth/me /api/v1/./admin/auth/me '/api/v1/%2e%2e/v1/admin/auth/me' /x/../api/v1/admin/auth/me \
         /api/v1/admin/../catalog/categories '/api/v1/admin/%2e%2e/catalog/categories' /api/v1/admin/./auth/me \
         /api/v1/catalog/../health /api/v1/catalog/./categories '/api/v1/catalog/%2e%2e/health' '/api/v1/catalog/%2E/x' \
         /api/v1/orders/.. /api/v1/orders/.; do
  run proxy404 "$p"
done
echo "== double-encoded (%2561dmin): the API does not decode it to admin, so it passes"
run upstream '/api/v1/%2561dmin/auth/me'

printf '\nSUMMARY  fail=%d\n' "$fails"
[ "$fails" -eq 0 ] || exit 1
exit 0
