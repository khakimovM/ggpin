# Reverse proxy (Caddy) — P11-S3

> Qarorlar: D-13 (domenlar), D-73 (4) Caddy, (10) admin faqat WireGuard orqali. Fayllar: `Caddyfile` (qoidalar), `Dockerfile` (non-root
> image), servis — `deploy/compose.prod.yml` dagi `proxy`. Bu yerda — egasi uchun tartib va tekshiruvlar.

## 1. Proxy nima qiladi

| Qoida                   | Qanday                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domenlar                | `SITE_DOMAIN` → web, `www.` → `SITE_DOMAIN` ga 301, `API_DOMAIN` → api, `ADMIN_DOMAIN` → admin (`/etc/ggpin/compose.env`)                                                                                                                                                                                                                                                                          |
| TLS                     | avtomatik (Let’s Encrypt, faqat `PROXY_ACME_CA` dagi CA), HTTP → HTTPS 308, HSTS `max-age=63072000; includeSubDomains` faqat upstream o‘zi yubormaganda (web’niki o‘zgarmaydi; preload yo‘q)                                                                                                                                                                                                       |
| Log                     | so‘rovning `Cookie`, `Authorization`, `X-Pay-Token`, `X-Telegram-Bot-Api-Secret-Token` sarlavhalari va javobning `Set-Cookie` i yozilmaydi; `uri`, `Referer`, `Location`, `X-Middleware-Rewrite` dan `t` parametri o‘chiriladi (docs/05 runbook 9). Caddy’ning xato log’lari va hech bir saytga mos kelmagan so‘rovlar (`log default`, masalan `Host: API.GGPIN.UZ`) ham xuddi shu filtrdan o‘tadi |
| Readiness               | `/api/v1/health/*` tashqaridan yopiq (404), faqat `/api/v1/health/live` ochiq                                                                                                                                                                                                                                                                                                                      |
| Telegram webhook        | `/api/v1/telegram/webhook` faqat `149.154.160.0/20` va `91.108.4.0/22` dan; secret token tekshiruvi API’da qoladi                                                                                                                                                                                                                                                                                  |
| Admin                   | faqat peer’lar `10.66.0.2/32` (ega), `10.66.0.3/32` (sherik) — `deploy/vps/README.md` 4-qadam; serverning `10.66.0.1` i, `/24` va `private_ranges` emas. SPA va admin API bitta origin’da: `admin` nomida `/api/v1/admin*` → api (faqat peer’lardan), boshqa `/api` — 404 (§6)                                                                                                                     |
| Admin API ochiq nomda   | `api` nomida `admin` bilan boshlanadigan segmentli har qanday yo‘l 404 (katta-kichik harf, `%61dmin`, `//`, `/../` — S3 test 3)                                                                                                                                                                                                                                                                    |
| `X-Forwarded-For`       | mijozdan kelgani e’tiborsiz (`trusted_proxies` yo‘q); API faqat proxy’ning edge manzilidan kelgan XFF ga ishonadi (`TRUST_PROXY`)                                                                                                                                                                                                                                                                  |
| Limit va timeout’lar    | body: web/api va admin API 1 MB, admin SPA 64 KB; sarlavha 16 KB; `read_header` 10s, `read_body` 30s, `write` 60s, `idle` 2m; upstream: ulanish 5s, javob sarlavhasi 60s                                                                                                                                                                                                                           |
| Xavfsizlik sarlavhalari | proxy faqat HSTS qo‘shadi (upstream yubormagan bo‘lsa) va `Server` ni olib tashlaydi, Caddy’ning o‘z xato javoblarida ham (502/504/413, `handle_errors`; status kodi o‘zgarmaydi). Istisno: :80 dagi avtomatik 308 da `Server: Caddy` qoladi (§3a). CSP va boshqalarni web, api, admin **o‘zi** yuboradi — proxy ularni takrorlamaydi va kuchsizlantirmaydi (admin CSP: S3 testida bir xil md5)    |

Rate limit proxy’da yo‘q (standart Caddy’da yo‘q, plagin — yangi bog‘liqlik): anonim `start` limiti API’da (D-73 (4)).

## 2. Non-root (SA N-10)

Proxy uid **65532** da, **hech qanday capability’siz** (`cap_drop: ALL`, `cap_add` yo‘q). 80/443 ni konteynerning o‘z tarmoq namespace’idagi
`net.ipv4.ip_unprivileged_port_start=0` sysctl’i beradi. Upstream image’dagi `/usr/bin/caddy` da fayl capability bor
(`cap_net_bind_service=ep`): `cap_drop: ALL` bilan bunday binar **ishga tushmaydi** (`exec /usr/bin/caddy: operation not permitted`, S3 testida
root bilan ham). Shuning uchun `Dockerfile` uni `setcap -r` bilan olib tashlaydi, `/data` va `/config` ni 65532 ga beradi. Yangi `caddy_data`
volume shu egalikni image’dan oladi. Root davrida yaratilgan eski volume bo‘lsa (production’da hali yo‘q), uni bir marta
`sudo chown -R 65532:65532 "$(sudo docker volume inspect -f '{{.Mountpoint}}' ggpin_caddy_data)"` bilan o‘tkazish kerak.

Image app image’lari bilan bir xil yo‘l bilan yig‘iladi va registry’ga digest bilan qo‘yiladi (D-73 (5); CI image pipeline’i — S14):
`docker build -t <registry>/ggpin-proxy deploy/proxy`. `compose.env` da `PROXY_IMAGE=...@sha256:...` (preflight tekshiradi).

## 3. HTTP/3 — o‘chiq

443/udp publish qilinmaydi, Caddy’da `protocols h1 h2` (Alt-Svc yo‘q). Sabablar: (1) Docker publish qilgan port ufw’ni chetlab o‘tadi — har
qo‘shimcha port qo‘shimcha ochiq sirt; (2) QUIC (quic-go) — alohida, DoS advisory’lari ko‘p bo‘lgan stek; (3) bizning trafik — kichik JSON va
sahifalar, HTTP/2 yetarli. Shu sababli ufw va panel firewall’ida 443/udp **yo‘q**, preflight 443/udp ALLOW qoidasini FAIL qiladi. Yoqish
kerak bo‘lsa — alohida qaror: compose’ga `443:443/udp`, Caddyfile’ga `h3`, ufw/panel/preflight’ga 443/udp.

## 3a. :80 dagi 308 va `Server` sarlavhasi

HTTP → HTTPS yo‘naltirishni Caddy’ning avtomatik HTTPS’i qiladi; u saytlarimiz route’laridan tashqarida, shuning uchun `header -Server`
unga yetmaydi (javobda `Server: Caddy`, body va HSTS yo‘q; HTTP orqali kelgan HSTS’ni brauzer baribir e’tiborsiz qoldiradi). Uni olib
tashlash uchun avtomatik yo‘naltirish o‘rniga o‘z `http://` saytlarimizni yozish kerak, lekin :80 da ACME HTTP-01 sertifikat
yangilanishi ham ishlaydi va uni lokal sinab bo‘lmaydi (haqiqiy ACME yo‘q). Foyda kichik (Caddy ekanini boshqa belgilardan ham bilish
mumkin), xavf (sertifikat yangilanmay qolishi) katta — avtomatik 308 qoldirildi.

## 4. DNS (ega, birinchi `up` dan oldin)

1. **A** yozuvlari VPS’ning IPv4 manziliga: `ggpin.uz`, `www.ggpin.uz`, `api.ggpin.uz`, `admin.ggpin.uz`. Admin uchun ham ochiq A yozuvi
   kerak — sertifikat shu orqali olinadi va yangilanadi; ochiq internetdan admin baribir 404 qaytaradi.
2. **AAAA yozuvi qo‘yilmaydi.** Proxy faqat IPv4’da publish qilingan (`PROXY_BIND_ADDR=0.0.0.0`). IPv6 ochilsa, Docker uni userland-proxy
   orqali uzatadi va mijoz manzili yo‘qoladi (hamma IPv6 mijozlar bitta rate-limit chelagiga tushadi). IPv6 — alohida qaror.
3. **CAA** (tavsiya): `ggpin.uz. CAA 0 issue "letsencrypt.org"` va `ggpin.uz. CAA 0 issuewild ";"`. Faqat Let’s Encrypt sertifikat bera oladi.
4. TTL avval kichik (300), hammasi ishlagach kattalashtiriladi.

## 5. Birinchi ishga tushirish: avval staging ACME

```bash
C="sudo docker compose -p ggpin --env-file /etc/ggpin/compose.env -f /opt/ggpin/compose.prod.yml"
# /etc/ggpin/compose.env: PROXY_TLS=<ega e-mail>, PROXY_ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory
$C up -d
$C logs proxy | grep -E '"certificate obtained successfully"|"error"' | head
sudo bash /root/preflight.sh --allow-staging     # faqat shu bosqichda: staging CA — WARN; bayroqsiz — FAIL
# staging sertifikatlari olindi -> PROXY_ACME_CA qatorini o‘chiring (default = production), staging sertifikatlarni tashlang:
$C stop proxy && sudo docker run --rm -v ggpin_caddy_data:/data --entrypoint sh <PROXY_IMAGE> -c 'rm -rf /data/caddy/certificates/acme-staging*'
$C up -d proxy
sudo bash /root/preflight.sh                     # bayroqsiz: PROXY_TLS e-mail va staging yo‘q, aks holda FAIL
```

Staging bilan boshlash Let’s Encrypt’ning production limitlariga (bir domenga haftasiga 5 ta takror sertifikat) tushib qolmaslik uchun.
`admin off` — Caddy’ning admin API’si yo‘q, shuning uchun Caddyfile o‘zgarsa `$C up -d --force-recreate proxy` (bir necha soniya uzilish).

## 6. Admin’ga kirish (WireGuard)

Admin vhost faqat ikki peer’dan (`10.66.0.2` ega, `10.66.0.3` sherik) kelgan so‘rovni o‘tkazadi; boshqalarga — 404, `/api` ham.
SPA admin API’ni **o‘z origin’ida** chaqiradi: `https://admin.ggpin.uz/api/v1/admin/...` → proxy → `api:5000`. Shuning uchun admin API’ga
ochiq IP’dan yo‘l yo‘q, API va audit log’dagi `ip` — peer’ning WG manzili. Yig‘ish va sozlash bir-biriga mos bo‘lishi shart:

- admin image: `--build-arg VITE_API_URL=https://admin.ggpin.uz/api/v1` (`apps/admin/Dockerfile`);
- `compose.env`: `ADMIN_API_ORIGIN=https://admin.ggpin.uz` (admin CSP `connect-src`);
- `api.env`: `ADMIN_URL=https://admin.ggpin.uz` (API’ning admin Origin tekshiruvi).

Yangi peer (qurilma) qo‘shilsa: `wg0.conf` dan tashqari Caddyfile’dagi `@not_vpn` ga ham uning `/32` manzili yoziladi va proxy qayta
yaratiladi; peer olib tashlansa — Caddyfile’dan ham (`deploy/vps/README.md` 4-qadam, README-2 13-qadam).

Brauzer `admin.ggpin.uz` ni **10.66.0.1** ga (tunnel ichiga) yuborishi kerak,
ochiq IP’ga emas:

- kompyuterda: `hosts` fayliga `10.66.0.1 admin.ggpin.uz` (Windows: `C:\Windows\System32\drivers\etc\hosts`);
- telefonda `hosts` yo‘q — ochiq savol (§9).

Tekshiruv: VPN yoqilgan holda `https://admin.ggpin.uz` ochiladi; VPN o‘chirilganda (ochiq IP orqali) — 404.

## 7. VPS’dagi tekshiruvlar (S3 dan keyin, tashqi kompyuterdan)

```bash
curl -sI https://ggpin.uz | grep -iE '^(HTTP|strict-transport)'          # 200, HSTS
curl -sI https://www.ggpin.uz | grep -iE '^(HTTP|location)'              # 301 -> https://ggpin.uz/
curl -sI http://api.ggpin.uz/x | grep -iE '^(HTTP|location)'             # 308 -> https://api.ggpin.uz/x
curl -s -o /dev/null -w '%{http_code}\n' https://api.ggpin.uz/api/v1/health/live    # 200
curl -s -o /dev/null -w '%{http_code}\n' https://api.ggpin.uz/api/v1/health/ready   # 404
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.ggpin.uz/api/v1/telegram/webhook   # 404
curl -s -o /dev/null -w '%{http_code}\n' https://admin.ggpin.uz/         # VPN o‘chiq: 404
curl -s -o /dev/null -w '%{http_code}\n' https://admin.ggpin.uz/api/v1/health/live   # VPN o‘chiq: 404
curl -s -o /dev/null -w '%{http_code}\n' https://api.ggpin.uz/api/v1/admin/auth/me   # 404 (admin API ochiq nomda yo‘q)
curl -s -o /dev/null -w '%{http_code}\n' --path-as-is 'https://api.ggpin.uz/api/v1/x/../%61dmin/auth/me'   # 404
curl -sI https://api.ggpin.uz/api/v1/health/live | grep -ciE '^strict-transport-security'   # 1 (bitta sarlavha)
sudo docker inspect -f 'user={{.Config.User}} capadd={{.HostConfig.CapAdd}} sysctls={{json .HostConfig.Sysctls}}' ggpin-proxy-1
# Log redaksiyasi (VPS’da, tekshiruv so‘rovlaridan keyin): hammasi 0 bo‘lishi kerak
$C logs proxy | grep -c -E '"(Cookie|Authorization|X-Pay-Token|X-Telegram-Bot-Api-Secret-Token|Set-Cookie)"|[?&]t='
```

VPN yoqilgan holda: Docker DNAT’dan keyin ham manba IP saqlanishini tasdiqlash. Oxirgi admin so‘rovida `remote_ip` peer’ning WG
manzili bo‘lishi shart; `172.x` yoki `10.66.0.1` chiqsa — userland-proxy yoki NAT manbani almashtirgan, admin hammaga 404 beradi:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://admin.ggpin.uz/api/v1/health/live   # VPN yoqilgan kompyuterdan: 200
$C logs --since 2m proxy | grep '"host":"admin.ggpin.uz"' | tail -n 1 | grep -o '"remote_ip":"[^"]*"'   # "remote_ip":"10.66.0.2"
sudo iptables -t nat -S DOCKER | grep -- '--dport 443'      # DNAT qoidasi: manzil o‘zgaradi, manba emas
```

Webhook yetib kelishi: `setWebhook` dan keyin bot’ga xabar yozing; muammo bo‘lsa Bot API `getWebhookInfo` dagi `last_error_message`.

## 8. Telegram IP oraliqlari o‘zgarsa

Manba: <https://core.telegram.org/bots/webhooks> («149.154.160.0/20 and 91.108.4.0/22»). Telegram o‘zgartirsa, webhook 404 oladi va bot jim
bo‘ladi (`getWebhookInfo` da xato, buyurtma va to‘lovlar ishlayveradi). Caddyfile’dagi `@webhook_foreign` ga yangi oraliqni qo‘shib,
proxy qayta yaratiladi. Oraliqni olib tashlash (cheklovni o‘chirish) — vaqtinchalik ham bo‘lsa, faqat ega qarori bilan: secret token
himoyasi qoladi.

## 9. Ochiq savollar va keyingi ishlar

- **Telefondan admin:** `hosts` yo‘q. Variantlar: WireGuard ichida kichik DNS (masalan dnsmasq, faqat `wg0` da) yoki admin faqat kompyuterdan.
  Ega qarori.
- **SSR rate limit (SA N-7):** web’ning server tomonidagi so‘rovlari proxy’dan o‘tmaydi, `api:5000` ga to‘g‘ridan-to‘g‘ri boradi — API hammasini
  web konteynerining bitta manzili bilan sanaydi. Proxy darajasida hal bo‘lmaydi (p11-plan’ga taklif yozilgan).
- **Admin CSP (M-1/F18):** haqiqiy p9 bundle bilan qayta tekshiriladi; proxy CSP qo‘shmaydi.
- **Bitta origin va API’ning admin tekshiruvi (S3-1, p9 bilan birga hal qilinadi):** brauzer bir origin’dagi `GET` so‘rovida `Origin`
  sarlavhasini yubormaydi, faqat `Sec-Fetch-Site: same-origin`. Hozirgi `AdminCsrfGuard` (p9, S2-5 qoidasi) bunday so‘rovni 404 qiladi,
  ya’ni admin SPA’ning o‘qish so‘rovlari ishlamaydi. Launch’dan oldin p9 tomonida o‘zgarishi kerak (backend + security-auditor qarori).
