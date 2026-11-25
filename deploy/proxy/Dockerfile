#
# ggpin reverse proxy image (P11-S3): the pinned upstream Caddy, made able to run as a non-root uid
# with EVERY capability dropped (SA N-10). Built and pushed to the private registry the same way as the
# app images (D-73 (5), pipeline P11-S14); compose.prod.yml pulls it by digest (PROXY_IMAGE). Context = this folder:
#   docker build -t <registry>/ggpin-proxy deploy/proxy
# The Caddyfile is not baked in: compose mounts deploy/proxy/Caddyfile read-only (deploy/proxy/README.md).

ARG CADDY_IMAGE=caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d

FROM ${CADDY_IMAGE}
# The upstream binary carries cap_net_bind_service=ep as a FILE capability. With cap_drop: ALL the
# capability is not in the bounding set, so exec of such a binary fails with EPERM ("operation not
# permitted") for a non-root user. Low ports come from the container sysctl
# net.ipv4.ip_unprivileged_port_start=0 instead (compose), so the file capability is removed.
# /data (ACME account + certificates, a named volume) and /config start owned by the runtime uid: a
# NEW named volume copies this ownership from the image.
RUN setcap -r /usr/bin/caddy \
 && test -z "$(getcap /usr/bin/caddy)" \
 && mkdir -p /data/caddy /config/caddy \
 && chown -R 65532:65532 /data /config \
 && chmod 0700 /data /config
# Unprivileged uid/gid (no passwd entry or shell needed), the same as the admin image.
USER 65532:65532
EXPOSE 80 443
# A loopback-only listener of the Caddyfile (:8081, bind 127.0.0.1): the process is up and serving.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8081/healthz"]
