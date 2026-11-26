# shellcheck shell=bash
# Sourced by preflight.sh after preflight-runtime.sh (not run on its own). READ-ONLY. Worker roles
# (D-76 (6)) and the secret NAMES each container sees (F-5); never a secret's content. Uses the
# helpers and variables of preflight.sh and of preflight-select.sh (env_value, GGPIN_CONTAINERS,
# secret_host_file, is_secret_host_file).

# The Docker secrets (= file names under /run/secrets) each compose service may see, sorted; empty =
# none. Each key lives in exactly one container: the wallet keys only with fulfillment, the bank-feed
# session key only with bankfeed (D-76, docs/10).
expected_secrets() {
  case "$1" in
    worker) echo "fragment_session_enc_key wallet_enc_key" ;;
    bankfeed) echo "bank_feed_enc_key" ;;
    postgres) echo "postgres_password" ;;
    redis) echo "redis_users_acl" ;;
    *) echo "" ;;
  esac
}
# The label the worker image carries since the WORKER_ROLE code (apps/worker/Dockerfile): an image
# without it cannot read WORKER_ROLE and would start EVERYTHING in both containers.
ROLE_LABEL=uz.ggpin.worker-roles
role_label_ok() { case ",$1," in *,fulfillment,*) case ",$1," in *,bankfeed,*) return 0 ;; esac ;; esac; return 1; }
words() { tr ' ' '\n' | sed '/^$/d' | sort | tr '\n' ' ' | sed 's/ $//'; }
# Keys a top-level x-* anchor may carry into a service through `<<:` (SA B-2): hardening only, never
# secrets, environment, env_file, user, image, command or volumes (the parser below would not see them).
ANCHOR_KEYS=" read_only tmpfs cap_drop security_opt ulimits restart logging "

# ---------------------------------------------------------------------------------------------
section "Compose file: worker roles and each service's secrets: (D-76 (6), F-5, SA B-2)"
# Read from the file itself (as the user: check). Facts: "<svc> K <key> <rest>" for a four-space key,
# "<svc> ROLE <value>" for WORKER_ROLE under environment:, "<svc> S <name>" for a secret list item
# (short `- name` or long `- source: name`), "BAD <text>" for anything the parser cannot vouch for.
if [ -r "$COMPOSE_FILE" ]; then
  facts=$(awk -v allowed="$ANCHOR_KEYS" '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    /^[[:space:]]*(extends|include):/ { print "BAD line " NR ": extends:/include: (not followed by this check)"; next }
    /&[A-Za-z0-9_-]+/ && !/^x-[a-z0-9_-]+:[[:space:]]*&[A-Za-z0-9_-]+[[:space:]]*$/ { print "BAD line " NR ": an anchor outside a top-level x-* block" }
    /\*[A-Za-z0-9_-]+/ && !/^    <<: \*[A-Za-z0-9_-]+[[:space:]]*$/ { print "BAD line " NR ": an alias outside a service-level <<: merge" }
    /<<:/ && !/^    <<: \*[A-Za-z0-9_-]+[[:space:]]*$/ { print "BAD line " NR ": a <<: merge that is not a service-level <<: *anchor" }
    /^[^ ]/ { in_s = ($0 ~ /^services:/); in_x = ($0 ~ /^x-/); svc = ""; next }
    in_x && /^  [a-z_]+:/ { k = $1; sub(/:.*/, "", k); if (index(allowed, " " k " ") == 0) print "BAD line " NR ": anchor key " k " is not hardening-only" }
    in_s && /^  [a-z][a-z0-9_-]*:[[:space:]]*$/ { svc = $1; sub(/:$/, "", svc); key = ""; print svc " K -"; next }
    in_s && svc != "" && /^    [a-z_<]+:/ {
      key = $1; sub(/:.*/, "", key); rest = $0; sub(/^    [a-z_<]+:[[:space:]]*/, "", rest)
      print svc " K " key " " rest; next
    }
    in_s && svc != "" && key == "environment" && /^      WORKER_ROLE:/ { v = $2; gsub(/["\047]/, "", v); print svc " ROLE " v; next }
    in_s && svc != "" && key == "secrets" {
      if ($0 ~ /^      - [a-z0-9_]+[[:space:]]*$/) print svc " S " $2
      else if ($0 ~ /^      - source: [a-z0-9_]+[[:space:]]*$/) print svc " S " $3
      else print "BAD line " NR ": unrecognised secrets: entry of " svc " (only - name or - source: name)"
    }
  ' "$COMPOSE_FILE")
  fact() { printf '%s\n' "$facts" | awk -v s="$1" -v t="$2" -v k="${3:-}" '$1 == s && $2 == t && (k == "" || $3 == k)'; }
  while read -r _ bad; do
    [ -n "$bad" ] && fail "$COMPOSE_FILE: $bad"
  done <<EOF
$(printf '%s\n' "$facts" | grep '^BAD ')
EOF
  for svc in $(printf '%s\n' "$facts" | awk '$2 == "K" {print $1}' | sort -u); do
    flow=$(fact "$svc" K secrets | cut -d' ' -f4-)
    case "$flow" in ''|'['*']') ;; *) fail "$svc secrets: '$flow' is neither a [a, b] list nor a block list" ;; esac
    flow=$(printf '%s' "$flow" | tr -d '[],"'"'")
    block=$(fact "$svc" S | awk '{print $3}')
    got=$(printf '%s %s' "$flow" "$block" | tr '\n' ' ' | words)
    want=$(expected_secrets "$svc")
    if [ "$got" = "$want" ]; then pass "$svc secrets: ${got:-none}"
    else fail "$svc secrets: '${got:-none}', expected '${want:-none}' (each key only in its own container)"; fi
  done
  for pair in worker:fulfillment bankfeed:bankfeed; do
    svc=${pair%%:*}; want=${pair#*:}
    if [ -z "$(fact "$svc" K -)" ]; then fail "service $svc not found in $COMPOSE_FILE"; continue; fi
    role=$(fact "$svc" ROLE | awk '{print $3}' | tail -n 1)
    if [ "$role" = "$want" ]; then pass "$svc environment: WORKER_ROLE=$role (compose, an env file cannot override it)"
    else fail "$svc environment: WORKER_ROLE='${role:-unset}', expected $want"; fi
    case "$(fact "$svc" K image)" in
      *"\${WORKER_IMAGE"*) pass "$svc image: \${WORKER_IMAGE} (one image, two roles)" ;;
      *) fail "$svc image is not \${WORKER_IMAGE}" ;;
    esac
    for k in profiles command entrypoint; do
      [ -z "$(fact "$svc" K "$k")" ] || fail "$svc has '$k:' (a pre-D-76 compose: bankfeed was disabled by profile + hard-stop)"
    done
    case "$(fact "$svc" K restart | cut -d' ' -f4- | tr -d "\"'")" in no) fail "$svc has restart: \"no\" (pre-D-76 compose)" ;; esac
  done
else
  warn "$COMPOSE_FILE not readable (S2): roles and secret lists not checked"
fi

# ---------------------------------------------------------------------------------------------
section "Worker image in $ENV_DIR/compose.env supports WORKER_ROLE (label $ROLE_LABEL)"
# The deploy order is pull, then preflight (deploy/COMPOSE.md): an image that is not on the host is
# a FAIL, a WARN only with --before-pull (a fresh host before its first pull).
if [ -r "$ENV_DIR/compose.env" ] && have docker; then
  wimg=$(env_value WORKER_IMAGE)
  if [ -z "$wimg" ]; then fail "WORKER_IMAGE is not set in $ENV_DIR/compose.env"
  elif ! docker image inspect "$wimg" >/dev/null 2>&1; then
    if [ "$BEFORE_PULL" -eq 1 ]; then warn "WORKER_IMAGE is not on this host yet (--before-pull): label not checked"
    else fail "WORKER_IMAGE is not on this host: run pull first, then preflight (--before-pull only on a fresh host)"; fi
  else
    lbl=$(docker image inspect -f "{{index .Config.Labels \"$ROLE_LABEL\"}}" "$wimg" 2>/dev/null)
    if role_label_ok "$lbl"; then pass "WORKER_IMAGE has $ROLE_LABEL=$lbl"
    else fail "WORKER_IMAGE has no $ROLE_LABEL (a pre-D-76 image: it would ignore WORKER_ROLE and run every module)"; fi
  fi
elif [ "$BEFORE_PULL" -eq 1 ]; then
  warn "$ENV_DIR/compose.env missing or no docker (--before-pull): the worker image label not checked"
else
  fail "$ENV_DIR/compose.env missing or no docker: the worker image label not checked"
fi

# ---------------------------------------------------------------------------------------------
section "Running ggpin containers: secret names under /run/secrets and worker roles (F-5, SA B-3, D-76)"
# Names from the mounts (target AND host file), nothing is read inside a container. Of the
# environment only the WORKER_ROLE entry is extracted, by the template itself (CR #3, SA B-4).
if have docker; then
  while read -r cname svc; do
    [ -n "$cname" ] || continue
    got=""
    while IFS='|' read -r dest src; do
      [ -n "$dest" ] || continue
      base=${src##*/}
      case "$dest" in
        /run/secrets/*)
          n=${dest#/run/secrets/}; got="$got $n"
          [ "$base" = "$(secret_host_file "$n")" ] || fail "$cname ($svc): /run/secrets/$n comes from host file '$base', expected '$(secret_host_file "$n")'" ;;
        *) is_secret_host_file "$base" && fail "$cname ($svc): secret file $base is mounted at $dest, not under /run/secrets" ;;
      esac
    done <<EOF2
$(docker inspect -f '{{range .Mounts}}{{.Destination}}|{{.Source}}{{println}}{{end}}' "$cname" 2>/dev/null)
EOF2
    got=$(printf '%s' "$got" | words)
    want=$(expected_secrets "$svc")
    if [ "$got" = "$want" ]; then pass "$cname ($svc) sees secrets: ${got:-none}"
    else fail "$cname ($svc) sees secrets '${got:-none}', expected '${want:-none}'"; fi
    case "$svc" in worker) wantrole=fulfillment ;; bankfeed) wantrole=bankfeed ;; *) continue ;; esac
    role=$(docker inspect -f '{{range .Config.Env}}{{if eq (index (split . "=") 0) "WORKER_ROLE"}}{{println .}}{{end}}{{end}}' "$cname" 2>/dev/null | sed -n 's/^WORKER_ROLE=//p' | tail -n 1)
    lbl=$(docker inspect -f "{{index .Config.Labels \"$ROLE_LABEL\"}}" "$cname" 2>/dev/null)
    if [ "$role" != "$wantrole" ]; then fail "$cname ($svc) runs with WORKER_ROLE='${role:-unset}', expected $wantrole"
    elif ! role_label_ok "$lbl"; then fail "$cname ($svc) runs a pre-D-76 image (no $ROLE_LABEL): recreate it with the current WORKER_IMAGE"
    else pass "$cname ($svc) WORKER_ROLE=$role, image $ROLE_LABEL=$lbl"; fi
  done <<EOF
$GGPIN_CONTAINERS
EOF
fi
