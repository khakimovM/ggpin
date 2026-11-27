#!/usr/bin/env bash
# ggpin egress reachability check (phase 11 S4, D-73 (3)). Run it on a candidate VPS BEFORE the
# refund window closes, and again on the production host.
#
# For every target: DNS resolution, a TCP connect and, for https targets, one anonymous HTTPS
# request (HEAD, no token, no cookie, no body). It sends no secret and changes nothing.
#
# Usage:
#   bash reachability.sh                       # the default targets below
#   bash reachability.sh --list                # print the targets, connect to nothing
#   bash reachability.sh --targets FILE        # use FILE instead (one target per line, see below)
#   bash reachability.sh --timeout 8           # per-check timeout in seconds (default 10)
#   bash reachability.sh --help
# Target line format (FILE):  <name> <tcp|https> <host> <port> [path]
#   '#' starts a comment. path = a plain path ([A-Za-z0-9._/-], starting with /).
#   Example:  fragment https fragment.com 443 /
# Environment overrides: TON_API_HOST (default toncenter.com), REGISTRY_HOST (default ghcr.io,
# the private registry chosen in S14), EXTRA_TARGETS_FILE (appended, e.g. the off-site backup and
# dead-man hosts once the owner has picked them; an unreadable file is an error).
# Exit: 0 = every target reachable, 1 = at least one FAIL, 2 = bad usage, bad target or missing tool.
#
# The MTProto addresses are the IPv4 production DC list of the worker's MTProto client:
# @mtcute/core 0.32.7, utils/dcs.js (defaultProductionDc main + media, and
# defaultProductionFallbackDcs). They change with a client update or on Telegram's side. The
# bank-feed listener (worker) needs them; the Bot API needs api.telegram.org only.
# (end of usage text)

set -u
export LC_ALL=C

TIMEOUT=10
TARGETS_FILE=""
LIST_ONLY=0

# The header comment from line 2 down to the "(end of usage text)" marker.
usage() { sed -n '2,/(end of usage text)/p' "$0" | sed -e '/(end of usage text)/d' -e 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --timeout) TIMEOUT="${2:-}"; shift 2 || { usage >&2; exit 2; } ;;
    --targets) TARGETS_FILE="${2:-}"; shift 2 || { usage >&2; exit 2; } ;;
    --list) LIST_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
case "$TIMEOUT" in ''|*[!0-9]*|0) echo "--timeout must be a positive integer" >&2; exit 2 ;; esac
if [ -n "$TARGETS_FILE" ] && [ ! -r "$TARGETS_FILE" ]; then echo "cannot read $TARGETS_FILE" >&2; exit 2; fi
# Checked up front: an unreadable extra file must stop the run, not shrink the target list.
if [ -n "${EXTRA_TARGETS_FILE:-}" ] && [ ! -r "$EXTRA_TARGETS_FILE" ]; then
  echo "cannot read EXTRA_TARGETS_FILE ($EXTRA_TARGETS_FILE)" >&2; exit 2
fi

TON_API_HOST="${TON_API_HOST:-toncenter.com}"
REGISTRY_HOST="${REGISTRY_HOST:-ghcr.io}"

default_targets() {
  cat <<EOF
# Telegram Bot API (api: webhook registration, sendMessage, owner alerts)
telegram-bot-api        https api.telegram.org          443 /
# Telegram MTProto production DCs (worker bank-feed listener), @mtcute/core 0.32.7 utils/dcs.js
mtproto-dc2-main        tcp   149.154.167.50            443
mtproto-dc2-media       tcp   149.154.167.222           443
mtproto-dc1             tcp   149.154.175.50            443
mtproto-dc2             tcp   149.154.167.51            443
mtproto-dc2-alt         tcp   95.161.76.100             443
mtproto-dc3             tcp   149.154.175.100           443
mtproto-dc4             tcp   149.154.167.91            443
mtproto-dc5             tcp   149.154.171.5             443
# Fragment (worker: Stars / Premium purchase)
fragment                https fragment.com              443 /
# TON HTTP API (worker: wallet, chain confirmation)
ton-api                 https ${TON_API_HOST}           443 /
# Let's Encrypt ACME (Caddy automatic TLS)
letsencrypt-acme        https acme-v02.api.letsencrypt.org 443 /directory
# Image registry (deploy pulls images by digest)
registry                https ${REGISTRY_HOST}          443 /v2/
# Ubuntu security updates (unattended-upgrades)
ubuntu-security         https security.ubuntu.com       443 /
# Docker apt repository
docker-apt              https download.docker.com       443 /
EOF
}

load_targets() {
  if [ -n "$TARGETS_FILE" ]; then cat "$TARGETS_FILE" || return 1; else default_targets; fi
  if [ -n "${EXTRA_TARGETS_FILE:-}" ]; then cat "$EXTRA_TARGETS_FILE" || return 1; fi
}

set -o pipefail
TARGETS=$(load_targets | sed -e 's/#.*$//' -e '/^[[:space:]]*$/d') || { echo "cannot read the targets" >&2; exit 2; }
set +o pipefail

if [ "$LIST_ONLY" -eq 1 ]; then
  printf '%s\n' "$TARGETS"
  exit 0
fi

for tool in curl timeout getent; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool" >&2; exit 2; }
done

FAILS=0
WARNS=0
printf 'ggpin reachability  host=%s  utc=%s  timeout=%ss\n' "$(hostname)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TIMEOUT"
printf '%-6s %-22s %-34s %s\n' RESULT NAME TARGET DETAIL

is_ip() { printf '%s' "$1" | grep -q -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; }

while read -r name kind host port path; do
  [ -n "${name:-}" ] || continue
  case "$kind" in tcp|https) ;; *) echo "bad kind '$kind' for $name" >&2; exit 2 ;; esac
  case "$port" in ''|*[!0-9]*) echo "bad port for $name" >&2; exit 2 ;; esac
  case "$host" in ''|*[!A-Za-z0-9.:-]*) echo "bad host for $name" >&2; exit 2 ;; esac
  path="${path:-/}"
  # Only a plain path reaches the URL: no query, fragment, userinfo or second host.
  case "$path" in /*) ;; *) echo "bad path for $name (must start with /)" >&2; exit 2 ;; esac
  if printf '%s' "$path" | grep -q '[^A-Za-z0-9._/-]'; then echo "bad path for $name" >&2; exit 2; fi
  target="$host:$port"

  if is_ip "$host"; then
    ip="$host"
  else
    ip=$(timeout "$TIMEOUT" getent ahostsv4 "$host" 2>/dev/null | awk 'NR == 1 {print $1}')
    if [ -z "$ip" ]; then
      printf '%-6s %-22s %-34s %s\n' FAIL "$name" "$target" "DNS: no IPv4 address"
      FAILS=$((FAILS + 1)); continue
    fi
  fi

  start=$(date +%s%N)
  # The address and port reach the child bash as $1/$2 (escaped here), never spliced into its code.
  if ! timeout "$TIMEOUT" bash -c "exec 3<>\"/dev/tcp/\$1/\$2\"" _ "$ip" "$port" 2>/dev/null; then
    printf '%-6s %-22s %-34s %s\n' FAIL "$name" "$target" "TCP connect to $ip failed or timed out"
    FAILS=$((FAILS + 1)); continue
  fi
  ms=$(( ($(date +%s%N) - start) / 1000000 ))

  if [ "$kind" = "tcp" ]; then
    printf '%-6s %-22s %-34s %s\n' PASS "$name" "$target" "tcp ok ${ms}ms ($ip)"
    continue
  fi

  # Anonymous HEAD request to the address resolved above: any HTTP status proves TLS + HTTP work.
  # 403/451 may mean a geo or IP block (e.g. Fragment refusing a hosting range): WARN, not PASS.
  out=$(curl -sS -o /dev/null -I --max-time "$TIMEOUT" --proto '=https' \
          -A 'reachability-check/1' --resolve "$host:$port:$ip" -w '%{http_code} %{time_total}' \
          "https://$host:$port$path" 2>&1)
  rc=$?
  code=${out%% *}
  if [ "$rc" -ne 0 ]; then
    printf '%-6s %-22s %-34s %s\n' FAIL "$name" "$target" "https: curl exit $rc ($(printf '%s' "$out" | head -n1 | cut -c1-80))"
    FAILS=$((FAILS + 1))
  elif [ "$code" = "403" ] || [ "$code" = "451" ]; then
    printf '%-6s %-22s %-34s %s\n' WARN "$name" "$target" "https $out s: possible geo/IP block"
    WARNS=$((WARNS + 1))
  else
    printf '%-6s %-22s %-34s %s\n' PASS "$name" "$target" "tcp ${ms}ms, https $out s"
  fi
done <<EOF
$TARGETS
EOF

printf '\nSUMMARY  fail=%d  warn=%d\n' "$FAILS" "$WARNS"
[ "$FAILS" -eq 0 ] || exit 1
exit 0
