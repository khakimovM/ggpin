#!/usr/bin/env bash
# ggpin VPS preflight (phase 11 S4). READ-ONLY: it inspects the host and changes nothing.
#
# Proves the bootstrap of deploy/vps/README.md + README-2.md: Ubuntu 24.04, UTC + chrony, accounts
# and sudo, SSH ed25519 keys only and only through WireGuard (D-73 (10)), ufw (IPv4 + IPv6),
# listeners; then (preflight-runtime.sh) Docker, container uids, secret files, compose.env image
# digests, the proxy's ACME settings, runtime DB users, swap, core dumps, sysctl and unattended-upgrades;
# then (preflight-roles.sh) the worker roles (D-76) and each container's secret names (F-5). The
# running containers checked are chosen in preflight-select.sh (any project name or compose file).
#
# Usage:  sudo bash preflight.sh [--wg-if wg0] [--wg-port 51820] [--wg-addr 10.66.0.1]
#                               [--secrets-dir /etc/ggpin/secrets] [--env-dir /etc/ggpin]
#                               [--compose /opt/ggpin/compose.prod.yml] [--allow-staging]
#                               [--before-pull] [--expect-running] [--help]
# --allow-staging: only during the first-start staging ACME step (deploy/proxy/README.md §5); without
#                  it a staging PROXY_ACME_CA in compose.env is a FAIL.
# --before-pull:   only before the first `pull` on a fresh host: a WORKER_IMAGE that is not on the
#                  host yet is a WARN. Without it (the deploy order is pull, then preflight) a FAIL.
#                  Refused (FAIL) when a ggpin container runs or a ggpin*_pgdata volume exists.
# --expect-running: after `up -d`: all eight services (proxy api web admin worker bankfeed postgres
#                  redis) must be running ggpin containers. Not together with --before-pull (exit 2).
# Exit:   0 = no FAIL (WARN lines still deserve a look), 1 = at least one FAIL, 2 = bad usage.
# Root is needed for `sshd -T`, `ufw status`, `wg show` and reading other users' authorized_keys;
# all of them only read. The output contains no secret (no key material, only key TYPES).
# (end of usage text)

set -u
export LC_ALL=C

WG_IF="wg0"
WG_PORT="51820"
WG_ADDR="10.66.0.1"
SECRETS_DIR="/etc/ggpin/secrets"
ENV_DIR="/etc/ggpin"
COMPOSE_FILE="/opt/ggpin/compose.prod.yml"
ALLOW_STAGING=0
BEFORE_PULL=0
EXPECT_RUNNING=0
# Container uids (H-1): never a host account. api, web, worker, bankfeed, migrate; admin and proxy
# run as 65532. The exact uid of each compose service: expected_user() in preflight-runtime.sh.
CONTAINER_UIDS="10001 10002 10003 10004 10005"

usage() { sed -n '2,/(end of usage text)/p' "$0" | sed -e '/(end of usage text)/d' -e 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --wg-if) WG_IF="${2:-}"; shift 2 || { usage >&2; exit 2; } ;;
    --wg-port) WG_PORT="${2:-}"; shift 2 || { usage >&2; exit 2; } ;;
    --wg-addr) WG_ADDR="${2:-}"; shift 2 || { usage >&2; exit 2; } ;;
    --secrets-dir) SECRETS_DIR="${2:-}"; shift 2 || { usage >&2; exit 2; } ;;
    --env-dir) ENV_DIR="${2:-}"; shift 2 || { usage >&2; exit 2; } ;;
    --compose) COMPOSE_FILE="${2:-}"; shift 2 || { usage >&2; exit 2; } ;;
    --allow-staging) ALLOW_STAGING=1; shift ;;
    --before-pull) BEFORE_PULL=1; shift ;;
    --expect-running) EXPECT_RUNNING=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
case "$WG_PORT" in ''|*[!0-9]*) echo "--wg-port must be a number" >&2; exit 2 ;; esac
case "$WG_IF" in ''|*[!A-Za-z0-9_.-]*) echo "--wg-if must be an interface name" >&2; exit 2 ;; esac
case "$WG_ADDR" in ''|*[!0-9.]*) echo "--wg-addr must be an IPv4 address" >&2; exit 2 ;; esac
case "$SECRETS_DIR" in /*) ;; *) echo "--secrets-dir must be absolute" >&2; exit 2 ;; esac
case "$ENV_DIR" in /*) ;; *) echo "--env-dir must be absolute" >&2; exit 2 ;; esac
case "$COMPOSE_FILE" in /*) ;; *) echo "--compose must be absolute" >&2; exit 2 ;; esac
if [ "$BEFORE_PULL" -eq 1 ] && [ "$EXPECT_RUNNING" -eq 1 ]; then
  echo "--before-pull (fresh host) and --expect-running (after a deploy) exclude each other" >&2; exit 2
fi

FAILS=0
WARNS=0
pass() { printf 'PASS  %s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*"; WARNS=$((WARNS + 1)); }
fail() { printf 'FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }
section() { printf '\n== %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root (sudo): sshd -T, ufw status and wg show need it; nothing is changed" >&2
  exit 2
fi
HERE=$(cd "$(dirname "$0")" && pwd)
for part in preflight-select.sh preflight-runtime.sh preflight-roles.sh; do
  [ -r "$HERE/$part" ] || { echo "$part missing next to $0" >&2; exit 2; }
done

printf 'ggpin preflight  host=%s  utc=%s\n' "$(hostname)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ---------------------------------------------------------------------------------------------
section "OS"
if [ -r /etc/os-release ]; then
  # Read, not sourced: the file is data, nothing in it is executed.
  os_id=$(sed -n 's/^ID=//p' /etc/os-release | tr -d '"')
  os_ver=$(sed -n 's/^VERSION_ID=//p' /etc/os-release | tr -d '"')
  if [ "$os_id" = "ubuntu" ] && [ "$os_ver" = "24.04" ]; then pass "Ubuntu 24.04 LTS"; else fail "OS is ${os_id} ${os_ver}, expected ubuntu 24.04"; fi
else
  fail "/etc/os-release missing"
fi
pass "kernel $(uname -r)"

# ---------------------------------------------------------------------------------------------
section "Time: UTC + chrony (monotonic, synchronised clock: docs/13)"
if have timedatectl; then
  tz=$(timedatectl show -p Timezone --value 2>/dev/null)
  case "$tz" in UTC|Etc/UTC) pass "timezone $tz" ;; *) fail "timezone is '$tz', expected Etc/UTC" ;; esac
  synced=$(timedatectl show -p NTPSynchronized --value 2>/dev/null)
  if [ "$synced" = "yes" ]; then pass "NTPSynchronized=yes"; else fail "NTPSynchronized=$synced"; fi
else
  fail "timedatectl not found"
fi
if systemctl is-active --quiet chrony 2>/dev/null; then pass "chrony active"; else fail "chrony is not active"; fi
systemctl is-active --quiet systemd-timesyncd 2>/dev/null && warn "systemd-timesyncd also active (two NTP clients)"
if have chronyc; then
  chronyc -n tracking 2>/dev/null | grep -E '^(Reference ID|Stratum|System time|Leap status)' | sed 's/^/      /'
  leap=$(chronyc -n tracking 2>/dev/null | awk -F': ' '/^Leap status/ {print $2}')
  if [ "$leap" = "Normal" ]; then pass "chrony leap status Normal"; else fail "chrony leap status '${leap:-unknown}'"; fi
fi

# ---------------------------------------------------------------------------------------------
section "Accounts and sudo"
uid0=$(awk -F: '$3 == 0 && $1 != "root" {print $1}' /etc/passwd | tr '\n' ' ')
if [ -z "$uid0" ]; then pass "only root has uid 0"; else fail "other uid-0 accounts: $uid0"; fi
logins=$(awk -F: '$7 !~ /(nologin|false|sync|shutdown|halt)$/ {printf "%s(%s) ", $1, $3}' /etc/passwd)
pass "login accounts: $logins"
clash=""
for u in $CONTAINER_UIDS; do
  getent passwd "$u" >/dev/null && clash="$clash $u($(getent passwd "$u" | cut -d: -f1))"
done
if [ -z "$clash" ]; then pass "container uids $CONTAINER_UIDS are not host accounts"; else fail "container uid(s) exist on the host:$clash"; fi
pass "sudo group: $(getent group sudo | cut -d: -f4)"
nopw=$(grep -rhs -E '^[^#]*NOPASSWD' /etc/sudoers /etc/sudoers.d/ | tr '\n' ';')
if [ -z "$nopw" ]; then pass "no NOPASSWD sudo rule"; else fail "NOPASSWD sudo rule(s): $nopw"; fi
if passwd -S root 2>/dev/null | awk '{exit !($2 == "L")}'; then pass "root password locked"; else warn "root password is not locked (passwd -l root)"; fi

# ---------------------------------------------------------------------------------------------
section "SSH: keys only (ed25519), no root, no passwords"
SSHD_T=""
have sshd && SSHD_T=$(sshd -T 2>/dev/null)
if [ -z "$SSHD_T" ]; then
  fail "sshd -T printed nothing (sshd missing or config error)"
else
  sshv() { printf '%s\n' "$SSHD_T" | awk -v k="$1" '$1 == k { $1 = ""; sub(/^ /, ""); print; exit }'; }
  expect() { local v; v=$(sshv "$1"); if [ "$v" = "$2" ]; then pass "sshd $1 $v"; else fail "sshd $1 is '$v', expected '$2'"; fi; }
  expect permitrootlogin no
  expect passwordauthentication no
  expect kbdinteractiveauthentication no
  expect pubkeyauthentication yes
  expect authenticationmethods publickey
  expect permitemptypasswords no
  expect x11forwarding no
  expect allowtcpforwarding no
  expect allowagentforwarding no
  expect permituserenvironment no
  bad_algs=$(sshv pubkeyacceptedalgorithms | tr ',' '\n' | grep -v -E '^(sk-)?ssh-ed25519(-cert-v01)?(@openssh\.com)?$' | grep . | tr '\n' ' ')
  if [ -z "$bad_algs" ]; then pass "pubkeyacceptedalgorithms ed25519 only"; else fail "pubkeyacceptedalgorithms also allows: $bad_algs"; fi
  hk=$(printf '%s\n' "$SSHD_T" | awk '$1 == "hostkey" {print $2}' | tr '\n' ' ')
  case "$hk" in *rsa*|*ecdsa*|*dsa_*) warn "non-ed25519 host keys still served: $hk" ;; *) pass "host keys: $hk" ;; esac
  au=$(sshv allowusers)
  if [ -n "$au" ]; then pass "allowusers $au"; else fail "AllowUsers not set (every account with a key could log in)"; fi
  mat=$(sshv maxauthtries)
  if [ -n "$mat" ] && [ "$mat" -le 3 ] 2>/dev/null; then pass "maxauthtries $mat"; else warn "maxauthtries is '$mat' (expected <= 3)"; fi
  akc=$(sshv authorizedkeyscommand)
  case "$akc" in ''|none) ;; *) fail "AuthorizedKeysCommand is set ($akc): keys come from outside the files checked here" ;; esac
  # Every AuthorizedKeysFile (e.g. .ssh/authorized_keys .ssh/authorized_keys2) of every account.
  # The key TYPE is the first field: a line with options or another type fails. Bodies not printed.
  akf=$(sshv authorizedkeysfile)
  while IFS=: read -r user _ _ _ _ home _; do
    for rel in $akf; do
      f=$(printf '%s' "$rel" | sed -e "s|%h|$home|g" -e "s|%u|$user|g" -e "s|%%|%|g")
      case "$f" in /*) ;; *) f="$home/$f" ;; esac
      [ -f "$f" ] || continue
      types=$(grep -v -E '^[[:space:]]*(#|$)' "$f" | awk '{print $1}' | sort | uniq -c | tr -s ' ' | tr '\n' ';')
      if grep -v -E '^[[:space:]]*(#|$)' "$f" | awk '{print $1}' | grep -q -v -x -E 'ssh-ed25519|sk-ssh-ed25519@openssh\.com'; then
        fail "$f: a key line is not plain ed25519 ($types)"
      else
        pass "$f ed25519 only ($types)"
      fi
      [ "$user" = "root" ] && [ -s "$f" ] && warn "$f is not empty (root login is off, but remove the keys)"
    done
  done < /etc/passwd
fi
systemctl is-enabled --quiet ssh.socket 2>/dev/null && warn "ssh.socket activation enabled: ListenAddress/Port in sshd_config are ignored (README step 5)"

# ---------------------------------------------------------------------------------------------
section "WireGuard ($WG_IF): SSH and admin only through the VPN (D-73 (10))"
if have wg; then
  if wg show interfaces 2>/dev/null | tr ' ' '\n' | grep -qx "$WG_IF"; then
    pass "$WG_IF up, $(wg show "$WG_IF" peers 2>/dev/null | grep -c .) peer(s)"
    port=$(wg show "$WG_IF" listen-port 2>/dev/null)
    if [ "$port" = "$WG_PORT" ]; then pass "$WG_IF listens on udp $port"; else warn "$WG_IF listen-port is '$port', expected $WG_PORT"; fi
  else
    fail "$WG_IF is not up"
  fi
  if systemctl is-enabled --quiet "wg-quick@$WG_IF" 2>/dev/null; then pass "wg-quick@$WG_IF enabled at boot"; else fail "wg-quick@$WG_IF not enabled"; fi
  bad_wg=$(find /etc/wireguard \( -type d ! -perm 0700 \) -o \( -type f -perm /077 \) -o ! -user root 2>/dev/null | tr '\n' ' ')
  if [ -d /etc/wireguard ] && [ -z "$bad_wg" ]; then pass "/etc/wireguard root-only (dir 0700, files no group/other bits)"; else fail "/etc/wireguard permissions: ${bad_wg:-missing}"; fi
else
  fail "wireguard-tools (wg) not installed"
fi

# ---------------------------------------------------------------------------------------------
section "Firewall (ufw): 80/443 + WireGuard udp public, everything else only on $WG_IF"
if have ufw; then
  UFW=$(ufw status verbose 2>/dev/null)
  if printf '%s\n' "$UFW" | grep -q '^Status: active'; then pass "ufw active"; else fail "ufw is not active"; fi
  if printf '%s\n' "$UFW" | grep -q 'Default: deny (incoming)'; then pass "default deny incoming"; else fail "default incoming policy is not deny"; fi
  printf '%s\n' "$UFW" | grep -q 'deny (routed)\|disabled (routed)' || warn "routed policy is not deny/disabled"
  if grep -q '^IPV6=yes' /etc/default/ufw 2>/dev/null; then pass "ufw IPV6=yes (IPv6 filtered too)"; else fail "ufw IPV6 is not yes: IPv6 traffic is not filtered"; fi
  rules=$(printf '%s\n' "$UFW" | sed -n '/^--/,$p' | sed 1d | grep .)
  printf '%s\n' "$rules" | sed 's/^/      /'
  # Each ALLOW/LIMIT rule's "To" part, with "(v6)" removed: allowed are exactly the public ports
  # below, or anything restricted to "on <wg>". Ranges, "Anywhere" and other ports fail.
  ok_public="^(80/tcp|443/tcp|$WG_PORT/udp)$"
  seen=""
  while IFS= read -r line; do
    to=$(printf '%s' "$line" | sed -E 's/[[:space:]]+(ALLOW|LIMIT)( IN| OUT)?[[:space:]].*$//' | sed -E 's/ \(v6\)//')
    case "$to" in
      *" on $WG_IF") seen="$seen wg" ;;
      *) if printf '%s' "$to" | grep -q -E "$ok_public"; then seen="$seen $to"; else fail "public ALLOW rule not permitted: $line"; fi ;;
    esac
  done <<EOF
$(printf '%s\n' "$rules" | grep -E '[[:space:]](ALLOW|LIMIT)([[:space:]]|$)' | grep -v -E '[[:space:]]OUT[[:space:]]')
EOF
  for p in 80/tcp 443/tcp "$WG_PORT/udp"; do
    case "$seen" in *" $p"*) pass "$p allowed" ;; *) fail "$p not allowed" ;; esac
  done
  if printf '%s\n' "$rules" | grep -q -E "^22(/tcp)? on $WG_IF .*ALLOW"; then pass "SSH allowed only on $WG_IF"; else warn "no SSH rule on $WG_IF (lockout risk)"; fi
else
  fail "ufw not installed"
fi

# ---------------------------------------------------------------------------------------------
section "Listening sockets"
if have ss; then
  ss -H -ltnup 2>/dev/null | awk '{print $1, $5, $7}' | sed 's/^/      /'
  addrs=$(ss -H -ltnu 2>/dev/null | awk '{print $5}')
  # Database, cache and Docker API ports never on a wildcard (Docker would bypass ufw).
  if printf '%s\n' "$addrs" | grep -q -E '^(0\.0\.0\.0|\*|\[::\]):(5432|5433|6379|6380|2375|2376)$'; then fail "Postgres/Redis/Docker API port listens on a wildcard address"; else pass "no wildcard listener on 5432/5433/6379/6380/2375/2376"; fi
  # A specific address other than loopback and the WireGuard address = something bound to the
  # public IP on purpose (wildcards are covered by ufw and the checks above). The interface zone
  # (127.0.0.53%lo, [fe80::1%eth0]) is dropped first, then the port. IPv6 link-local (fe80::/10, e.g.
  # the DHCPv6 client on :546) never leaves the link, so it is not a public listener.
  odd=$(printf '%s\n' "$addrs" | sed -E 's/%[^]:]*//; s/:[0-9*]+$//' \
    | grep -v -E '^(0\.0\.0\.0|\*|\[::\]|\[::1\]|\[fe[89ab][0-9a-f]:[0-9a-f:]*\]|127\.[0-9.]+|'"${WG_ADDR//./\\.}"')$' \
    | sort -u | tr '\n' ' ')
  if [ -z "$odd" ]; then pass "no listener on a specific non-loopback, non-VPN address"; else fail "listeners on specific addresses: $odd"; fi
fi

# ---------------------------------------------------------------------------------------------
# Docker, containers and secrets, swap, core dumps, sysctl, updates.
# Which running containers are ggpin's (GGPIN_CONTAINERS), then their checks.
# shellcheck source-path=SCRIPTDIR source=preflight-select.sh
. "$HERE/preflight-select.sh"
# shellcheck source-path=SCRIPTDIR source=preflight-runtime.sh
. "$HERE/preflight-runtime.sh"
# Worker roles (D-76) and each container's secret names (F-5).
# shellcheck source-path=SCRIPTDIR source=preflight-roles.sh
. "$HERE/preflight-roles.sh"

printf '\nSUMMARY  fail=%d  warn=%d\n' "$FAILS" "$WARNS"
[ "$FAILS" -eq 0 ] || exit 1
exit 0
