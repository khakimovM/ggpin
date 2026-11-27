# deploy/compose.prod.yml — design notes (P11-S2, S3)

The compose file keeps short comments and points here for the reasoning (kept under 300 lines, review K6). Owner runbook (commands, secret
files, uids): `deploy/vps/README-2.md` step 12.

## Commands

```bash
C="sudo docker compose -p ggpin --env-file /etc/ggpin/compose.env -f /opt/ggpin/compose.prod.yml"
$C config -q
$C pull                                    # then preflight.sh (Roles: deploy order)
$C --profile migrate run --rm migrate      # explicit deploy step BEFORE `up` (docs/05 runbook 13)
$C up -d
```

- Migrations never run implicitly; no service depends on `migrate`. Never `migrate reset` on this stack.
- Images come from the private registry pinned by digest (D-73 (5)). The VPS holds no source and no
  compiler, so there is no `build:`. `/etc/ggpin/compose.env` holds only non-secret interpolation values
  (images, subnets, bind address): `deploy/env/compose.env.example`. `preflight.sh` fails when an
  `*_IMAGE` there is not pinned by `@sha256:`.
- One compose project per environment on the VPS (`-p ggpin`, `-p ggpin-staging`), each with its own
  edge subnet.

## Networks

| Network        | Kind                       | Members                                                              |
| -------------- | -------------------------- | -------------------------------------------------------------------- |
| `ingress`      | bridge, the only published | proxy (also its ACME egress)                                         |
| `edge`         | internal                   | proxy, api, web, admin                                               |
| `data-api`     | internal                   | api, postgres, redis                                                 |
| `data-workers` | internal                   | worker, bankfeed, migrate (backup), postgres, redis                  |
| `egress`       | bridge, no ports, ICC off  | api (Bot API), worker (TON, Fragment, suppliers), bankfeed (MTProto) |

- `data` is split in two (review N2 / SA N-5): the worker cannot reach `api:5000`, and the api cannot
  reach the worker side. Both still reach postgres and redis.
- `egress` has `enable_icc=false`: a container on it cannot reach another one THROUGH it, so it adds no
  path between services. postgres, redis, web, admin and migrate are not on it.
- Only the proxy publishes ports (Docker-published ports bypass ufw: `deploy/vps/README.md` step 6):
  80/tcp and 443/tcp on IPv4, and a plain `up -d` starts it (no profile since P11-S3). Its rules (TLS,
  log redaction, closed readiness, Telegram-only webhook, WireGuard-only admin, no XFF trust), the
  non-root setup and the HTTP/3 decision: `deploy/proxy/README.md`.
- web's server-side calls go to `api:5000` over edge, not through the proxy, so the API sees the web
  container's address for all of them (one rate-limit bucket, SA N-7). Not solved here: p11-plan.

## Proxy (P11-S3)

- Caddy from `deploy/proxy/` (Caddyfile, Dockerfile, README.md). The only public service: a plain `up -d`
  publishes 80/443 (tcp; HTTP/3 off, `deploy/proxy/README.md` §3).
- uid 65532 with NO capability: low ports come from the namespaced sysctl
  `net.ipv4.ip_unprivileged_port_start=0`, and the image strips the upstream binary's file capability.
- `depends_on`: api and web must be healthy before the proxy starts. admin is `service_started` +
  `required: false` (review K4): a crashed or unhealthy admin container must not keep the store and the
  API offline; the admin name then answers 502 (S3 test 3) and the other names keep working.
- The admin SPA and the admin API share one origin (`https://<ADMIN_DOMAIN>`, `/api/v1/admin/*` proxied
  to `api:5000`), so the admin API is reachable only from WireGuard peers; the public API name refuses
  every `admin` path (S3-1). Hence `ADMIN_API_ORIGIN` = the admin name (`deploy/env/compose.env.example`).

## Roles: worker and bankfeed (D-76)

One worker image (`WORKER_IMAGE`), two containers. `WORKER_ROLE` is set in each service's `environment:`
(an `env_file` cannot override it); production refuses a missing role and `all` (dev/test only).

| Service    | `WORKER_ROLE` | uid   | Runs                                                                                                       | Secrets                                      |
| ---------- | ------------- | ----- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `worker`   | `fulfillment` | 10003 | value out: TON hot wallet, Fragment, fulfill-order, recipients, price/FX sync, order reconcile             | `wallet_enc_key`, `fragment_session_enc_key` |
| `bankfeed` | `bankfeed`    | 10004 | value in: bank-feed listener + re-scan, P2P matcher (TOPUP), card limits, top-up expiry, payment reconcile | `bank_feed_enc_key`                          |

- Each role builds only its own Nest modules (`apps/worker/src/worker-role-modules.ts`) and its env loader
  refuses the other side's secrets: the fulfillment process never loads `@mtcute/*` or better-sqlite3, the
  bankfeed process never builds a TON wallet (`FULFILLMENT_DRY_RUN` there: only `true` or unset).
- No published port, no HTTP surface. Health = the role's own Redis heartbeat (image HEALTHCHECK, the
  same rule as the boot): `worker:heartbeat` for fulfillment, `bankfeed:process-heartbeat` for bankfeed.
- `worker` has `BANK_FEED_MODE: off` in compose. `bankfeed` has no profile and the same restart policy
  as worker: a plain `up -d` starts it. Until the Telegram session exists, `BANK_FEED_MODE=off` in
  bankfeed.env keeps the listener off (D-76 (5)); the matcher, expiry and reconcile still run.
- The image carries `LABEL uz.ggpin.worker-roles="fulfillment,bankfeed"`. `preflight.sh`
  (`preflight-roles.sh`) fails on a compose without both roles, a bankfeed with `profiles:`/`command:`/
  `restart: "no"` (the pre-D-76 file), a `WORKER_IMAGE` without the label (the pre-D-76 image would
  ignore `WORKER_ROLE` and run every module), and on any container whose `/run/secrets` names differ
  from the table (names only, never contents).

### Deploy order (both roles)

1. `$C config -q`, then `$C pull` (the images must be on the host before preflight looks at them).
2. `sudo bash deploy/vps/preflight.sh`: compose roles and secret lists, the `WORKER_IMAGE` label (an image
   that is not on the host is a FAIL; `--before-pull` turns it into a WARN, only on a fresh host before
   its first pull, and refused once a ggpin container or a `ggpin_pgdata` volume exists), uids, secret files.
   Preflight is not a security boundary: it catches operator mistakes, and anyone with access to Docker is
   effectively root on the host. From `/etc/ggpin` only the five secret files are mounted; any other mount
   of it (the directory, an env file, a parent such as `/etc` or `/`, a symlink to it) is a FAIL in preflight.
3. `$C --profile migrate run --rm migrate` (the new code may need the new schema), then `$C up -d`:
   worker and bankfeed are recreated from the same `WORKER_IMAGE`.
4. `$C logs worker bankfeed | grep "worker started"`: `role=fulfillment` and `role=bankfeed`, each with
   only its own consumers; both `healthy` in `$C ps`; then `preflight.sh --expect-running` (all eight
   services must be running; uids, secret names, roles of the running containers).
5. Bank feed live (after docs/05 runbook 1/1a): `BANK_FEED_MODE=live` in bankfeed.env, `$C up -d bankfeed`.

## Container uids (SA H-1)

One worker image, two uids: `worker` 10003 (image default), `bankfeed` 10004 (compose `user:`); the
`migrate` target runs as 10005 (image `USER` + compose `user:`; it holds the DDL owner's URL). All three
have a passwd entry in the image (no home, nologin) and own no file in it; the image build fails if any
file under `/app` is owned by or writable for 10003 or 10004. With `read_only: true` the only writable place
is the `/tmp` tmpfs (mode 1777), and neither role writes to disk: the MTProto client keeps its session
in memory (`MemoryStorage`, `apps/worker/src/bank-feed/client/mtcute-loader.ts`; better-sqlite3 only opens
`:memory:`), the session blob and keys come from env/secret files, and the Fragment recorder (the only
code that writes files) is removed from the image. `preflight.sh` checks every service's `user:` in the
compose file, the real uid of each running ggpin container (`/proc/<pid>/status`) and the owner of each
secret file.

## Migrate

One-shot `prisma migrate deploy` (`apps/worker/Dockerfile` target `migrate`), the explicit deploy step
`--profile migrate run --rm migrate`. `data-workers` network only; its `DATABASE_URL` is the migration
(DDL owner) role, separate from the runtime role (P11-S6).

## Hardening (`x-hardened`, every service)

read_only rootfs + `/tmp` tmpfs, `cap_drop: ALL`, `no-new-privileges`, core dumps off (`ulimit core 0`:
the worker/bankfeed hold an open MTProto session and key material in memory, docs/05 runbook 7),
pids/memory limits, `restart: unless-stopped`, local log driver with rotation. No service adds a
capability back: the proxy binds 80/443 as uid 65532 through `net.ipv4.ip_unprivileged_port_start=0`
(a per-container network-namespace sysctl).

## Memory budget (KVM 2: 2 vCPU / 8 GB)

postgres 1536m | redis 512m | api 768m | worker 768m | bankfeed 512m | web 768m | admin 64m | proxy 256m
= 5184m steady. Transient: migrate 512m. Reserved: backup 512m (S9), umami 512m (S15) => 6.2 GB with
everything; ~1.8 GB stays for the host (kernel, dockerd, sshd, page cache). Redis `maxmemory 256mb`
inside its 512m limit leaves room for the AOF-rewrite/BGSAVE fork (copy-on-write).

## Secrets

- Docker `secrets:` with a `file:` source only, never `environment:`. Compose IGNORES `mode`/`uid` for
  file secrets (docs/05 runbook 7): the container sees the host file's own mode and owner, so each file is
  installed 0400 and owned by the uid of the ONE container that reads it:

  | File                       | Reader         | Owner |
  | -------------------------- | -------------- | ----- |
  | `postgres_password`        | postgres image | 70    |
  | `redis_users.acl`          | redis image    | 999   |
  | `wallet_enc_key`           | worker         | 10003 |
  | `fragment_session_enc_key` | worker         | 10003 |
  | `bank_feed_enc_key`        | bankfeed       | 10004 |

- Install (root, `deploy/vps/README-2.md` step 12): `install -m 0400 -o 10003 -g 10003 <src>
/etc/ggpin/secrets/wallet_enc_key` (and `fragment_session_enc_key`), `install -m 0400 -o 10004 -g 10004
<src> /etc/ggpin/secrets/bank_feed_enc_key`. An existing file: `chown 10003:10003` / `chown 10004:10004`
  and `chmod 0400`. `preflight.sh` fails on any other owner or mode.
- The worker image runs as 10003 and bankfeed as 10004 (H-1, "Container uids" above), so the real keys
  may go onto the VPS (S5). Host login accounts use uids 2001+ (README step 3), never 10001–10005.
- Values the code reads only from the environment (JWT/OTP/pay-token peppers, the bot token,
  DATABASE_URL/REDIS_URL with their passwords, TON_MNEMONIC_ENC, BANK_FEED_SESSION_ENC, ...) live in
  per-service env files outside the repo: `/etc/ggpin/<service>.env`, 0600 root (`env_file`).
- Worker-only values exist only in worker.env / bankfeed.env and their secrets; api, web and admin never
  get them (the API also refuses to boot if one appears, `packages/shared` env-secrets.ts).
- Runtime services must not use the postgres superuser (`POSTGRES_USER`): P11-S6 creates separate
  runtime roles BEFORE the first `up`; `preflight.sh` fails when api.env/worker.env use the superuser.

## Single replica (D-52 (8))

fulfill-order (worker) and the bank-feed listener (bankfeed) run as exactly one container each: `replicas: 1`

- a fixed `container_name`, so `--scale worker=2` fails instead of starting a second consumer. The worker
  is pinned to `BANK_FEED_MODE=off`, so only bankfeed can ever listen.

## Reserved services (not defined yet, so nothing half-configured can start)

- backup (P11-S9): WAL archive (PITR) + daily encrypted dump, off-site (D-73 (8)); networks
  `data-workers` + its own egress to the off-site store; its keys only in its own secrets; the
  postgresql.conf `archive_*` settings change with it.
- umami (P11-S15): analytics on edge behind the proxy, its own database/role on postgres; no other
  service's secrets.
