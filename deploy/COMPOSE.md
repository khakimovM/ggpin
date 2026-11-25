# deploy/compose.prod.yml — design notes (P11-S2, S3)

The compose file keeps short comments and points here for the reasoning (kept under 300 lines, review K6). Owner runbook (commands, secret
files, uids): `deploy/vps/README-2.md` step 12.

## Commands

```bash
C="sudo docker compose -p ggpin --env-file /etc/ggpin/compose.env -f /opt/ggpin/compose.prod.yml"
$C config -q
$C pull
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

## Worker

Fulfillment (Fragment/TON, suppliers), price sync, reconcilers, top-up matcher. The ONLY holder of the
wallet keys. No published port, no HTTP surface. Health = its Redis heartbeat (image HEALTHCHECK). No
`user:` in compose: the image decides; its real keys go onto the VPS only once the image runs as uid 10003
("Secrets" below). `BANK_FEED_MODE` is pinned `off`: the bank-feed listener belongs to the bankfeed
container only.

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

- **The real worker and bankfeed keys go onto the VPS only after the worker image runs as 10003 and the
  bankfeed role as 10004.** The worker image still runs as uid 1000 (`node`) today; uid 1000 is the
  first login account Ubuntu hands out, so a key owned by 1000 would be readable by a person. Host login
  accounts use uids 2001+ (README step 3), never 1000 and never 10001–10004.
- Values the code reads only from the environment (JWT/OTP/pay-token peppers, the bot token,
  DATABASE_URL/REDIS_URL with their passwords, TON_MNEMONIC_ENC, BANK_FEED_SESSION_ENC, ...) live in
  per-service env files outside the repo: `/etc/ggpin/<service>.env`, 0600 root (`env_file`).
- Worker-only values exist only in worker.env / bankfeed.env and their secrets; api, web and admin never
  get them (the API also refuses to boot if one appears, `packages/shared` env-secrets.ts).
- Runtime services must not use the postgres superuser (`POSTGRES_USER`): P11-S6 creates separate
  runtime roles BEFORE the first `up`; `preflight.sh` fails when api.env/worker.env use the superuser.

## Single replica (D-52 (8))

fulfill-order (worker) and the bank-feed listener (bankfeed) run as exactly one container: `replicas: 1`

- a fixed `container_name`, so `--scale worker=2` fails instead of starting a second consumer. The worker
  is pinned to `BANK_FEED_MODE=off`, so only bankfeed can ever listen.

## bankfeed is disabled until the WORKER_ROLE split (review N1)

Target (D-73 (6)): the worker image with `WORKER_ROLE=bankfeed`, only its own secrets (MTProto session +
its key, owner uid 10004), egress to Telegram MTProto, one replica (D-52 (8)).

The worker code does not read `WORKER_ROLE` yet. A bankfeed container started from the worker image would
be a second full worker: price sync, reconcilers and the matcher, writing simulated FX/price snapshots to
the production DB under `FULFILLMENT_DRY_RUN=true`, and after the p5 merge a second `fulfill-order`
consumer without the wallet keys. The profile alone does not stop that (`up -d bankfeed` by name, or
`COMPOSE_PROFILES=bankfeed`), so the service also has a hard-stop `command:` that prints why and exits 1,
with `restart: "no"`. Both are removed only together with the WORKER_ROLE code change
(fulfillment-engineer + security-auditor) and the uid-10004 image.

## Reserved services (not defined yet, so nothing half-configured can start)

- backup (P11-S9): WAL archive (PITR) + daily encrypted dump, off-site (D-73 (8)); networks
  `data-workers` + its own egress to the off-site store; its keys only in its own secrets; the
  postgresql.conf `archive_*` settings change with it.
- umami (P11-S15): analytics on edge behind the proxy, its own database/role on postgres; no other
  service's secrets.
