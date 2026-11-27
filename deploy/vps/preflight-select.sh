# shellcheck shell=bash
# Sourced by preflight.sh BEFORE preflight-runtime.sh and preflight-roles.sh (not run on its own).
# READ-ONLY. Decides which RUNNING containers are ggpin's, whatever their project name or compose
# files (CR #1, SA B-1): the later uid, secret and role checks run on exactly this list
# (GGPIN_CONTAINERS, one "<name> <compose service or ->" per line).

# The last uncommented assignment in compose.env wins, as in compose. Quotes are stripped.
env_value() {
  grep -E "^[[:space:]]*$1=" "$ENV_DIR/compose.env" | tail -n 1 | sed -E "s/^[[:space:]]*$1=//; s/^[\"']//; s/[\"'][[:space:]]*$//; s/[[:space:]]+$//"
}
# The Docker secrets (names under /run/secrets) and the host file each one comes from.
SECRET_NAMES="postgres_password redis_users_acl wallet_enc_key fragment_session_enc_key bank_feed_enc_key"
secret_host_file() { case "$1" in redis_users_acl) echo redis_users.acl ;; *) echo "$1" ;; esac; }
is_secret_host_file() {
  case "$1" in postgres_password|redis_users.acl|wallet_enc_key|fragment_session_enc_key|bank_feed_enc_key) return 0 ;; esac
  return 1
}
# Mount sources that reach the secrets or env directory (SA N-1, P-1): the source is that directory,
# lies under it, or is an ancestor of it (/etc, /). Only the five secret files may be mounted from
# there; anything else is an operator error. Paths are compared after readlink -f (P-2), so a
# symlink to the secrets directory counts; a path that does not resolve is compared as given.
norm_path() { local p; p=$(readlink -f -- "$1" 2>/dev/null) && [ -n "$p" ] || p=$1; printf '%s\n' "${p%/}"; }
SECRETS_REAL=$(norm_path "$SECRETS_DIR")
ENV_REAL=$(norm_path "$ENV_DIR")
reaches_ggpin_dir() {
  local d
  for d in "$SECRETS_REAL" "$ENV_REAL"; do
    case "$1" in "$d"|"$d"/*) return 0 ;; esac
    case "$d" in "$1"|"$1"/*) return 0 ;; esac
  done
  return 1
}
is_expected_secret_source() {
  [ "${1%/*}" = "$SECRETS_REAL" ] && is_secret_host_file "${1##*/}"
}
# Repository of an image reference: no @digest, no :tag (a registry :port stays).
image_repo() { local v=${1%%@*}; case "${v##*/}" in *:*) v=${v%:*} ;; esac; printf '%s\n' "$v"; }
# The ggpin image repositories named in compose.env (*_IMAGE whose last path part starts ggpin-).
ggpin_repos() {
  [ -r "$ENV_DIR/compose.env" ] || return 0
  grep -E '^[[:space:]]*[A-Z0-9_]+_IMAGE=' "$ENV_DIR/compose.env" | sed -E 's/^[[:space:]]*[A-Z0-9_]+_IMAGE=//; s/["'"'"']//g' \
    | while read -r ref; do r=$(image_repo "$ref"); case "${r##*/}" in ggpin-*) echo "$r" ;; esac; done | sort -u
}

# ---------------------------------------------------------------------------------------------
section "Running ggpin containers (any project name or compose file: CR #1, SA B-1)"
# A container is ggpin's when ANY of: one of its compose files is compose.prod.yml; its image carries
# uz.ggpin.worker-roles; it mounts one of the five secrets (by target or by host file); its image is
# a ggpin repository of compose.env. A dev stack (ggpin-platform, docker-compose.yml) is none of them.
GGPIN_CONTAINERS=""
if have docker; then
  repos=$(ggpin_repos)
  while read -r cname; do
    [ -n "$cname" ] || continue
    meta=$(docker inspect -f '{{.Config.Image}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.project.config_files"}}|{{index .Config.Labels "uz.ggpin.worker-roles"}}' "$cname" 2>/dev/null)
    IFS='|' read -r image project svc cfiles rlabel <<<"$meta"
    why=""
    case ",$cfiles," in *"/compose.prod.yml,"*|*",compose.prod.yml,"*) why="$why compose.prod.yml" ;; esac
    [ -z "$rlabel" ] || why="$why worker-roles-label"
    while IFS='|' read -r dest src; do
      case "$dest" in /run/secrets/*) printf ' %s ' "$SECRET_NAMES" | grep -q " ${dest#/run/secrets/} " && why="$why secret" ;; esac
      is_secret_host_file "${src##*/}" && why="$why secret-file"
      [ -n "$src" ] || continue
      nsrc=$(norm_path "$src")
      if reaches_ggpin_dir "$nsrc"; then
        why="$why ggpin-dir"
        is_expected_secret_source "$nsrc" \
          || fail "$cname mounts $src (-> ${nsrc:-/}) at $dest: it reaches $SECRETS_DIR / $ENV_DIR, from where only the five secret files may be mounted (SA N-1, P-1)"
      fi
    done <<EOF
$(docker inspect -f '{{range .Mounts}}{{.Destination}}|{{.Source}}{{println}}{{end}}' "$cname" 2>/dev/null)
EOF
    [ -n "$repos" ] && printf '%s\n' "$repos" | grep -Fqx "$(image_repo "$image")" && why="$why ggpin-image"
    if [ -n "$why" ]; then
      GGPIN_CONTAINERS="$GGPIN_CONTAINERS$cname ${svc:--}
"
      pass "$cname: service ${svc:-none}, project ${project:-none} (by:$(printf '%s\n' "$why" | tr ' ' '\n' | sort -u | tr '\n' ' ' | sed 's/ $//'))"
    else
      case "$project" in ggpin*) warn "$cname (project $project) is NOT checked: not compose.prod.yml, no ggpin image, label or secret (a dev stack?)" ;; esac
    fi
  done <<EOF
$(docker ps --format '{{.Names}}' 2>/dev/null)
EOF
  if [ -z "$GGPIN_CONTAINERS" ]; then
    if [ "$EXPECT_RUNNING" -eq 1 ]; then fail "--expect-running: no ggpin container is running"
    else warn "no ggpin container running yet (S2): container uids, secrets and roles not checked"; fi
  fi
  if [ "$EXPECT_RUNNING" -eq 1 ]; then
    for svc in proxy api web admin worker bankfeed postgres redis; do
      printf '%s' "$GGPIN_CONTAINERS" | awk -v s="$svc" '$2 == s {f = 1} END {exit !f}' \
        || fail "--expect-running: no running $svc container (after a deploy all eight services must be up)"
    done
  fi
  # SA N-2: --before-pull is for a FRESH host only. A running ggpin container or an existing
  # database volume means it is not one, and the relaxed image checks must not apply.
  if [ "$BEFORE_PULL" -eq 1 ]; then
    [ -z "$GGPIN_CONTAINERS" ] || fail "--before-pull: ggpin containers are running, this is not a fresh host (run without --before-pull)"
    pgvols=$(docker volume ls --format '{{.Name}}' 2>/dev/null | grep -E '^ggpin[A-Za-z0-9_.-]*_pgdata$' | paste -sd' ' -)
    [ -z "$pgvols" ] || fail "--before-pull: database volume(s) $pgvols exist, this is not a fresh host (run without --before-pull)"
  fi
else
  fail "docker not installed"
fi
