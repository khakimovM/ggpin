# shellcheck shell=bash
# Sourced by preflight.sh (not run on its own): Docker, ggpin container users and secret files,
# swap, core dumps, sysctl, automatic updates. READ-ONLY, like preflight.sh. Uses its helpers
# (pass/warn/fail/section/have) and variables (CONTAINER_UIDS, SECRETS_DIR, ENV_DIR, ALLOW_STAGING).

# Login account = an /etc/passwd entry whose shell is not nologin/false. Defined here, where it is
# used (container users, secret owners).
is_login_uid() {
  getent passwd "$1" | awk -F: '$7 !~ /(nologin|false)$/ {found = 1} END {exit !found}'
}

# ---------------------------------------------------------------------------------------------
section "Docker: official repo, live-restore, log limits, no TCP socket"
if have docker; then
  if grep -rqs 'download.docker.com' /etc/apt/sources.list.d/; then pass "apt source download.docker.com"; else fail "Docker is not from the official repo (download.docker.com)"; fi
  dpkg -s docker.io >/dev/null 2>&1 && fail "distribution package docker.io installed (use docker-ce)"
  if dpkg -s docker-ce >/dev/null 2>&1; then pass "docker-ce $(dpkg-query -W -f='${Version}' docker-ce)"; else fail "docker-ce not installed"; fi
  lr=$(docker info --format '{{.LiveRestoreEnabled}}' 2>/dev/null)
  if [ "$lr" = "true" ]; then pass "live-restore enabled"; else fail "live-restore is '$lr'"; fi
  ld=$(docker info --format '{{.LoggingDriver}}' 2>/dev/null)
  case "$ld" in local|json-file) pass "logging driver $ld" ;; *) warn "logging driver '$ld'" ;; esac
  if [ -r /etc/docker/daemon.json ]; then
    if grep -q '"max-size"' /etc/docker/daemon.json; then pass "daemon.json log max-size set"; else fail "daemon.json has no log max-size"; fi
    if grep -q '"no-new-privileges"[[:space:]]*:[[:space:]]*true' /etc/docker/daemon.json; then pass "daemon no-new-privileges default"; else warn "daemon.json no-new-privileges not set"; fi
    if grep -q '"core"' /etc/docker/daemon.json; then pass "daemon default-ulimits core set"; else warn "daemon.json default-ulimits core not set"; fi
    grep -q 'tcp://' /etc/docker/daemon.json && fail "daemon.json exposes a tcp:// host"
  else
    fail "/etc/docker/daemon.json missing"
  fi
  if systemctl cat docker.service 2>/dev/null | grep -E '^ExecStart' | grep -q -- '-H tcp\|--host=tcp\|tcp://'; then fail "dockerd started with a TCP host"; else pass "dockerd has no TCP host in its unit"; fi
  # Published ports: only the reverse proxy may publish, and only 80/443 (S2).
  pubs=$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -E '0\.0\.0\.0:|\[::\]:|:::')
  if [ -z "$pubs" ]; then
    pass "no container publishes a port on a public address"
  else
    printf '%s\n' "$pubs" | sed 's/^/      /'
    if printf '%s\n' "$pubs" | grep -o -E '(0\.0\.0\.0|\[::\]|::):[0-9]+' | grep -q -v -E ':(80|443)$'; then fail "a container publishes a port other than 80/443 (Docker bypasses ufw)"; else pass "only 80/443 published"; fi
  fi
  members=$(getent group docker | cut -d: -f4)
  if [ -z "$members" ]; then pass "docker group empty (docker via sudo, logged)"; else warn "docker group members: $members (docker group = root)"; fi
else
  fail "docker not installed"
fi

# ---------------------------------------------------------------------------------------------
# The uid:gid each compose service must run as (H-1). proxy, worker, bankfeed, migrate, postgres and
# redis state it in the compose file; api, web and admin take it from their image's USER.
expected_user() {
  case "$1" in
    proxy|admin) echo 65532:65532 ;;
    api) echo 10001:10001 ;;
    web) echo 10002:10002 ;;
    worker) echo 10003:10003 ;;
    bankfeed) echo 10004:10004 ;;
    migrate) echo 10005:10005 ;;
    postgres) echo 70:70 ;;
    redis) echo 999:999 ;;
  esac
}
COMPOSE_USER_REQUIRED="proxy worker bankfeed migrate postgres redis"

section "Compose file: every service's user: (H-1: worker 10003, bankfeed 10004, migrate 10005)"
# Read from the file itself, not from `docker compose config`: that output inlines the env files.
# Two-space service keys under `services:`, four-space `user:` lines, as in deploy/compose.prod.yml.
if [ -r "$COMPOSE_FILE" ]; then
  cusers=$(awk '
    /^[^ #]/ { in_s = ($0 ~ /^services:/) }
    in_s && /^  [a-z][a-z0-9_-]*:[[:space:]]*$/ { svc = $1; sub(/:$/, "", svc); print svc " -" }
    in_s && svc != "" && /^    user:/ { u = $2; gsub(/["\047]/, "", u); print svc " " u }
  ' "$COMPOSE_FILE")
  for svc in $(printf '%s\n' "$cusers" | awk '{print $1}' | sort -u); do
    got=$(printf '%s\n' "$cusers" | awk -v s="$svc" '$1 == s && $2 != "-" {print $2}' | tail -n 1)
    want=$(expected_user "$svc")
    required=0
    case " $COMPOSE_USER_REQUIRED " in *" $svc "*) required=1 ;; esac
    if [ -n "$got" ] && [ -n "$want" ] && [ "$got" = "$want" ]; then pass "$svc user: $got"
    elif [ -n "$got" ] && [ -n "$want" ]; then fail "$svc user: '$got', expected $want"
    elif [ -n "$got" ]; then warn "$svc user: '$got' (no expected uid for this service)"
    elif [ "$required" -eq 1 ]; then fail "$svc has no user: in $COMPOSE_FILE (expected $want)"
    elif [ -n "$want" ]; then pass "$svc: no user:, the image's USER applies (expected $want, checked below when running)"
    fi
  done
  for svc in $COMPOSE_USER_REQUIRED; do
    printf '%s\n' "$cusers" | awk -v s="$svc" '$1 == s {f = 1} END {exit !f}' || fail "service $svc not found in $COMPOSE_FILE"
  done
else
  warn "$COMPOSE_FILE not readable (S2): compose users not checked"
fi

# ---------------------------------------------------------------------------------------------
section "ggpin containers run as their own uid (never a host login account: H-1)"
# Every running ggpin container (GGPIN_CONTAINERS, preflight-select.sh): the configured user AND
# the real/effective/saved/fs uid and gid of its main process (/proc/<pid>/status).
PROC_DIR=${PROC_DIR:-/proc}
if have docker; then
  while read -r cname svc; do
    [ -n "$cname" ] || continue
    want=$(expected_user "$svc")
    if [ -z "$want" ]; then fail "$cname (service $svc): a ggpin container with no known uid (not a compose.prod.yml service)"; continue; fi
    cfg=$(docker inspect -f '{{.Config.User}}' "$cname" 2>/dev/null)
    pid=$(docker inspect -f '{{.State.Pid}}' "$cname" 2>/dev/null)
    case "$pid" in ''|0) fail "$cname ($svc): container not running (restarting?), its process uid cannot be checked"; continue ;; esac
    uids=$(awk '/^Uid:/ {print $2, $3, $4, $5}' "$PROC_DIR/$pid/status" 2>/dev/null)
    gids=$(awk '/^Gid:/ {print $2, $3, $4, $5}' "$PROC_DIR/$pid/status" 2>/dev/null)
    wu=${want%%:*}; wg=${want#*:}
    if [ "$cfg" != "$want" ]; then fail "$cname ($svc) is configured as user '${cfg:-root}', expected $want"
    elif [ "$uids" != "$wu $wu $wu $wu" ] || [ "$gids" != "$wg $wg $wg $wg" ]; then fail "$cname ($svc) process runs as uid '$uids' gid '$gids', expected $want"
    elif is_login_uid "$wu"; then fail "$cname runs as uid $wu = a host login account ($(getent passwd "$wu" | cut -d: -f1))"
    else pass "$cname ($svc) runs as $want (process uid/gid checked)"; fi
  done <<EOF2
$GGPIN_CONTAINERS
EOF2
fi

# Who may own a secret file: exactly the uid of the ONE container that reads it (compose ignores
# uid/mode for file secrets, so the host file's owner is what the container sees). A login account is
# refused before this. An unknown file must still belong to one of our container uids.
secret_owner_uid() {
  case "${1##*/}" in
    postgres_password) echo 70 ;;
    redis_users.acl) echo 999 ;;
    wallet_enc_key|fragment_session_enc_key) echo 10003 ;;
    bank_feed_*) echo 10004 ;;
  esac
}
secret_owner_hint() {
  case "${1##*/}" in
    postgres_password) echo "uid 70 (postgres image)" ;;
    redis_users.acl) echo "uid 999 (redis image)" ;;
    wallet_enc_key|fragment_session_enc_key) echo "uid 10003 (worker)" ;;
    bank_feed_*) echo "uid 10004 (bankfeed)" ;;
    *) echo "one of $CONTAINER_UIDS" ;;
  esac
}
uid_allowed_for_secret() {
  swant=$(secret_owner_uid "$1")
  if [ -n "$swant" ]; then [ "$2" = "$swant" ]; else printf ' %s ' "$CONTAINER_UIDS" | grep -q " $2 "; fi
}

# ---------------------------------------------------------------------------------------------
section "Secret files in $SECRETS_DIR (0400, owned by its container uid, never a login account)"
if [ -d "$SECRETS_DIR" ]; then
  dmode=$(stat -c '%a %U' "$SECRETS_DIR")
  case "$dmode" in '700 root'|'711 root'|'755 root') pass "$SECRETS_DIR $dmode" ;; *) warn "$SECRETS_DIR is '$dmode' (expected root-owned, 0700/0711/0755)" ;; esac
  nfiles=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    nfiles=$((nfiles + 1))
    read -r mode fuid <<<"$(stat -c '%a %u' "$f")"
    if is_login_uid "$fuid"; then fail "$f owned by login account uid $fuid ($(getent passwd "$fuid" | cut -d: -f1))"
    elif ! uid_allowed_for_secret "$f" "$fuid"; then fail "$f owned by uid $fuid (expected $(secret_owner_hint "$f"))"
    elif [ "$mode" != "400" ]; then fail "$f mode $mode (expected 400)"
    else pass "$f 0400 uid $fuid"; fi
  done <<EOF
$(find "$SECRETS_DIR" -type f 2>/dev/null)
EOF
  [ "$nfiles" -gt 0 ] || warn "$SECRETS_DIR has no files yet (S5)"
  # The compose secrets: compose refuses to start a service whose secret file is missing.
  for n in postgres_password redis_users.acl wallet_enc_key fragment_session_enc_key bank_feed_enc_key; do
    [ -f "$SECRETS_DIR/$n" ] || warn "$SECRETS_DIR/$n missing (expected owner $(secret_owner_hint "$n"), 0400)"
  done
else
  warn "$SECRETS_DIR does not exist yet (S5 creates it)"
fi

# ---------------------------------------------------------------------------------------------
section "Images in $ENV_DIR/compose.env pinned by digest (D-73 (5): a tag can be moved, a digest cannot)"
if [ -r "$ENV_DIR/compose.env" ]; then
  nimg=0
  while IFS= read -r line; do
    nimg=$((nimg + 1))
    name=${line%%=*}
    value=${line#*=}
    if printf '%s' "$value" | grep -q -E '@sha256:[0-9a-f]{64}$'; then pass "$name pinned by digest"
    else fail "$name is not pinned by @sha256:<64 hex> (got '${value}')"; fi
  done <<EOF
$(grep -E '^[[:space:]]*[A-Z0-9_]+_IMAGE=' "$ENV_DIR/compose.env" | sed 's/^[[:space:]]*//')
EOF
  [ "$nimg" -gt 0 ] || fail "$ENV_DIR/compose.env sets no *_IMAGE"
else
  warn "$ENV_DIR/compose.env missing (S2): image digests not checked"
fi

# ---------------------------------------------------------------------------------------------
section "Proxy ACME settings in $ENV_DIR/compose.env (a real account e-mail, production CA: K3)"
# env_value(): preflight-select.sh (the last assignment wins). The e-mail itself is not
# printed (it is personal data, not a secret, but has no place in a report).
if [ -r "$ENV_DIR/compose.env" ]; then
  tls=$(env_value PROXY_TLS)
  case "$tls" in
    '') fail "PROXY_TLS is not set (the ACME account e-mail)" ;;
    internal) fail "PROXY_TLS=internal: a self-signed local-test CA, never in production" ;;
    *'<'*|*'>'*) fail "PROXY_TLS is still the example placeholder" ;;
    ?*@?*.?*) pass "PROXY_TLS is an e-mail address" ;;
    *) fail "PROXY_TLS is not an e-mail address (expected the owner's ACME account e-mail)" ;;
  esac
  ca=$(env_value PROXY_ACME_CA)
  case "$ca" in
    '') pass "PROXY_ACME_CA not set: compose default = Let's Encrypt production" ;;
    *[Ss][Tt][Aa][Gg][Ii][Nn][Gg]*)
      if [ "$ALLOW_STAGING" -eq 1 ]; then warn "PROXY_ACME_CA is a STAGING directory (--allow-staging: first-start step only)"
      else fail "PROXY_ACME_CA is a STAGING directory: browsers do not trust its certificates (deploy/proxy/README.md §5)"; fi ;;
    https://acme-v02.api.letsencrypt.org/directory) pass "PROXY_ACME_CA = Let's Encrypt production" ;;
    *) warn "PROXY_ACME_CA is '$ca' (not Let's Encrypt production; CAA allows only letsencrypt.org)" ;;
  esac
else
  warn "$ENV_DIR/compose.env missing (S2): proxy ACME settings not checked"
fi

# ---------------------------------------------------------------------------------------------
section "Runtime services do not log in to Postgres as the superuser (P11-S6 before the first up)"
# The superuser is POSTGRES_USER of the postgres service in the compose file. Only the USER part of
# each DATABASE_URL is compared and printed; the password is never read into a variable or printed.
# A value compose accepts (quoted or not) whose user cannot be read is a FAIL: unproven is not safe.
# A missing env file stays a WARN: `up` cannot start that service without it anyway.
su_user=$(awk '/POSTGRES_USER:/ {print $2; exit}' "$COMPOSE_FILE" 2>/dev/null | tr -d "\"'")
if [ ! -r "$COMPOSE_FILE" ]; then
  warn "$COMPOSE_FILE not readable (S2): runtime DB users not checked"
elif [ -z "$su_user" ]; then
  fail "POSTGRES_USER not found in $COMPOSE_FILE: runtime DB users cannot be checked"
else
  for svc in api worker bankfeed; do
    f="$ENV_DIR/$svc.env"
    [ -r "$f" ] || { warn "$f missing: DB user of $svc not checked"; continue; }
    db_user=$(sed -n -E "s#^[[:space:]]*DATABASE_URL=[\"']?[a-z][a-z0-9+.-]*://([^:@/]*)(:[^@/]*)?@.*#\\1#p" "$f" | head -1)
    if [ -z "$db_user" ]; then fail "$f: the DATABASE_URL user cannot be read (it must name a user, a password and a host)"
    elif [ "$db_user" = "$su_user" ]; then fail "$svc.env DATABASE_URL uses the superuser '$su_user' (create the runtime role first: P11-S6)"
    else pass "$svc.env DATABASE_URL user '$db_user' is not the superuser"; fi
  done
fi

# ---------------------------------------------------------------------------------------------
section "Swap: off or encrypted (an in-memory session must not reach disk: docs/05 runbook 1)"
swaps=$(swapon --show=NAME --noheadings 2>/dev/null)
if [ -z "$swaps" ]; then
  pass "no active swap"
else
  for s in $swaps; do
    case "$s" in
      /dev/zram*) pass "swap $s is zram (RAM only)" ;;
      *) t=$(lsblk -no TYPE "$s" 2>/dev/null | head -n1)
         if [ "$t" = "crypt" ]; then pass "swap $s is dm-crypt"; else fail "swap $s is not encrypted (type '${t:-file}')"; fi ;;
    esac
  done
fi
grep -v -E '^\s*#' /etc/fstab 2>/dev/null | awk '$3 == "swap"' | grep -q . && warn "/etc/fstab still has a swap entry"

# ---------------------------------------------------------------------------------------------
section "Core dumps off (keys and the bank-feed session live in process memory)"
cp=$(sysctl -n kernel.core_pattern 2>/dev/null)
case "$cp" in '|/bin/false'|'|/usr/bin/false') pass "kernel.core_pattern $cp" ;; *) fail "kernel.core_pattern is '$cp' (expected |/bin/false)" ;; esac
sd=$(sysctl -n fs.suid_dumpable 2>/dev/null)
if [ "$sd" = "0" ]; then pass "fs.suid_dumpable 0"; else fail "fs.suid_dumpable is '$sd'"; fi
if grep -rqs -E '^\s*\*\s+hard\s+core\s+0' /etc/security/limits.conf /etc/security/limits.d/; then pass "limits: * hard core 0"; else fail "no '* hard core 0' in /etc/security/limits*"; fi
if systemctl is-enabled --quiet apport 2>/dev/null || systemctl is-active --quiet apport 2>/dev/null; then fail "apport enabled (it rewrites core_pattern at boot)"; else pass "apport disabled or absent"; fi
if grep -rqs -E '^\s*Storage\s*=\s*none' /etc/systemd/coredump.conf /etc/systemd/coredump.conf.d/; then pass "systemd-coredump Storage=none"; else warn "systemd-coredump Storage=none not set"; fi

# ---------------------------------------------------------------------------------------------
section "Kernel hardening (sysctl)"
# ptrace_scope 2: only root may attach to a process, so no login account can read a container's
# memory (keys, session) even with a matching uid.
for kv in kernel.dmesg_restrict=1 kernel.kptr_restrict=2 kernel.yama.ptrace_scope=2 net.ipv4.conf.all.accept_redirects=0 net.ipv4.conf.all.send_redirects=0 net.ipv6.conf.all.accept_redirects=0; do
  k=${kv%%=*}; want=${kv#*=}
  got=$(sysctl -n "$k" 2>/dev/null)
  if [ "$got" = "$want" ]; then pass "$k $got"; else fail "$k is '$got', expected $want"; fi
done
if have aa-status; then
  if aa-status --enabled 2>/dev/null; then pass "AppArmor enabled"; else warn "AppArmor not enabled"; fi
fi

# ---------------------------------------------------------------------------------------------
section "Automatic security updates"
if systemctl is-enabled --quiet unattended-upgrades 2>/dev/null; then pass "unattended-upgrades enabled"; else fail "unattended-upgrades not enabled"; fi
if grep -qs 'APT::Periodic::Unattended-Upgrade "1"' /etc/apt/apt.conf.d/20auto-upgrades; then pass "20auto-upgrades on"; else fail "APT::Periodic::Unattended-Upgrade is not \"1\""; fi
[ -f /var/run/reboot-required ] && warn "reboot required (plan it: README-2 step 10)"
