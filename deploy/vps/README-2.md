# VPS bazasi va qattiqlashtirish — runbook, 2-qism (11-bosqich, S4)

> 1-qism: [README.md](README.md) (0–6-qadamlar). Bu qism: 7–14-qadamlar. Kim bajaradi: **ega** (sherik bilan).

---

## 7. Docker — rasmiy repo’dan

Distributiv paketi (`docker.io`) va Hostinger «Docker» shabloni ishlatilmaydi.

```bash
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
gpg --show-keys --with-fingerprint /etc/apt/keyrings/docker.asc
```

Chiqqan fingerprint **aynan** shu bo‘lishi kerak (Docker hujjatidagi qiymat), aks holda to‘xtang va faylni o‘chiring:
`9DC8 5822 9FC7 DD38 854A  E2D8 8D81 803C 0EBF CD88`.

```bash
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

`/etc/docker/daemon.json`:

```json
{
  "live-restore": true,
  "log-driver": "local",
  "log-opts": { "max-size": "20m", "max-file": "5" },
  "no-new-privileges": true,
  "default-ulimits": { "core": { "Name": "core", "Hard": 0, "Soft": 0 } }
}
```

```bash
sudo systemctl restart docker
sudo docker info --format '{{.LiveRestoreEnabled}} {{.LoggingDriver}}'   # true local
```

- `hosts` yozilmaydi: daemon faqat `/var/run/docker.sock` da, TCP yo‘q. `live-restore`: Docker yangilanganda konteynerlar to‘xtamaydi.
- Docker paketlari unattended-upgrades bilan **avtomatik yangilanmaydi** (u faqat Ubuntu security); Docker rejali yangilanadi.

### Ega CLI’sini chaqirish

CLI AuditLog’ga SSH manzili (`SSH_CONNECTION`) va `SUDO_USER` ni yozadi (docs/05, D-46). `sudo` va `docker exec` ularni o‘zi o‘tkazmaydi:

```bash
sudo --preserve-env=SSH_CONNECTION docker compose -p ggpin --env-file /etc/ggpin/compose.env -f /opt/ggpin/compose.prod.yml \
  exec -e SSH_CONNECTION -e SUDO_USER api node dist/cli/ops-cli.js <buyruq>
```

(S2/S5 da wrapper skript beriladi.) **Qaysi maydonga ishonish mumkin (SA I-3):** `SUDO_USER` ni `sudo` o‘zi qo‘yadi; `SSH_CONNECTION`
dagi manzil — WireGuard peer IP’si (10.66.0.x), u bitta odamning bitta kalitiga bog‘langan (4-qadam). `--operator`, `--reason` esa
operator o‘zi yozadi — tekshiruvda ularni `auth.log` (kim, qaysi kalit fingerprint, qachon) bilan solishtiring; ishonchli manba — `auth.log`.

---

## 8. Vaqt: UTC + chrony

```bash
sudo apt-get install -y chrony          # systemd-timesyncd o‘rnini oladi
sudo systemctl enable --now chrony
timedatectl                              # Time zone: Etc/UTC, System clock synchronized: yes
chronyc tracking                         # Leap status: Normal
```

Sabab: buyurtma, TON va bank-feed vaqtlari DB soati bilan solishtiriladi (docs/13, D-35 (g)).

---

## 9. Swap o‘chiq, core dump o‘chiq, ptrace faqat root

Bank-feed sessiyasi, hamyon va Fragment kalitlari worker xotirasida ochiq turadi: ular diskka (swap yoki core dump) tushmasligi va boshqa
jarayon tomonidan o‘qilmasligi kerak (docs/05 runbook 1 va 7).

```bash
sudo swapoff -a
sudo sed -i.bak '/\sswap\s/ s/^/#/' /etc/fstab
sudo rm -f /swap.img /swapfile
swapon --show                            # bo‘sh
```

Swap zarur bo‘lsa — faqat shifrlangan, har yuklanishda tasodifiy kalit (`/etc/crypttab`:
`cryptswap /dev/<bo‘lim> /dev/urandom swap,cipher=aes-xts-plain64,size=512`). Swap **fayli** ishlatilmaydi.

Ubuntu’dagi `apport` yuklanishda `core_pattern` ni o‘ziniki qiladi, shuning uchun u o‘chiriladi. `core_pattern` xost uchun umumiy.

```bash
sudo systemctl disable --now apport 2>/dev/null; sudo apt-get purge -y apport
sudo tee /etc/sysctl.d/60-ggpin-hardening.conf >/dev/null <<'EOF'
kernel.core_pattern = |/bin/false
fs.suid_dumpable = 0
kernel.dmesg_restrict = 1
kernel.kptr_restrict = 2
# 2 = faqat root ptrace qila oladi: login akkaunt konteyner jarayonining xotirasini o‘qiy olmaydi
kernel.yama.ptrace_scope = 2
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
EOF
sudo sysctl --system
echo '* hard core 0' | sudo tee /etc/security/limits.d/60-nocore.conf
sudo mkdir -p /etc/systemd/coredump.conf.d
printf '[Coredump]\nStorage=none\nProcessSizeMax=0\n' | sudo tee /etc/systemd/coredump.conf.d/60-disable.conf
```

Konteyner darajasida ham: `daemon.json` dagi `default-ulimits core 0` (7-qadam) va compose’dagi `ulimits.core: 0` (S2).

---

## 10. Avtomatik xavfsizlik yangilanishlari

```bash
sudo apt-get install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades     # «Yes»
cat /etc/apt/apt.conf.d/20auto-upgrades             # Unattended-Upgrade "1"
```

Avtomatik reboot **yoqilmaydi**: kernel yangilansa `preflight.sh` `reboot required` deydi; reboot rejali, kam yuklangan vaqtda.

---

## 11. Yakuniy tekshiruv va snapshot

```bash
sudo bash /root/preflight.sh --before-pull | tee preflight-$(date -u +%F).txt   # yonida: preflight-{select,runtime,roles}.sh
```

- Faqat o‘qiydi; kalit **turlari**ni chiqaradi, kalitlarning o‘zini emas. Kutilgan: `SUMMARY fail=0`; har `WARN` ni ko‘rib chiqing.
- Parametrlar: `--wg-if wg0 --wg-port 51820 --wg-addr 10.66.0.1 --secrets-dir /etc/ggpin/secrets --env-dir /etc/ggpin
--compose /opt/ggpin/compose.prod.yml`; `--allow-staging` faqat proxy’ning staging ACME bosqichida (`../proxy/README.md` §5); `--before-pull` faqat birinchi
  `pull` dan oldin (xostda yo‘q `WORKER_IMAGE` — WARN, aks holda FAIL); `--expect-running` — `up -d` dan keyin (sakkizta servisning hammasi
  ishlab turishi shart; `--before-pull` bilan birga — exit 2). Qaysi konteyner ggpin’niki — loyiha nomidan qat’i nazar (`preflight-select.sh`).
- Tekshiradi: OS; UTC/chrony; uid 0 faqat root, NOPASSWD yo‘q, konteyner uid’lari (10001–10005) xost akkaunti emas; `sshd -T` va har `AuthorizedKeysFile` (faqat
  ed25519); WireGuard va `/etc/wireguard` ruxsatlari; ufw (IPv6 ham; 80/443/51820 dan boshqa umumiy ALLOW, diapazon → FAIL); tinglayotgan
  manzillar (IPv6 link-local hisobga olinmaydi); Docker; ggpin konteynerlari uid’i; secret fayllar; `compose.env` dagi har `*_IMAGE` da
  `@sha256:` bor; `PROXY_TLS` e-mail (`internal` emas) va `PROXY_ACME_CA` da staging yo‘q; api/worker/bankfeed `DATABASE_URL` foydalanuvchisi superuser emas (faqat nom solishtiriladi); worker rollari va har konteynerning secret nomlari
  (`preflight-roles.sh`, D-76/F-5); swap; core dump; sysctl;
  unattended-upgrades.

Natija fayli va 6-qadamdagi `nmap` chiqishlari — S4 dalili. Shundan keyin (hali sir va ma’lumot yo‘q) panelda **snapshot**.

---

## 12. Konteyner uid’lari va secret fayllar (SA H-1)

Konteynerlar xostdagi hech bir login akkaunt bilan bir xil uid’da ishlamaydi. Aks holda shu uid’dagi odam `sudo`’siz
`/proc/<pid>/environ` va `/proc/<pid>/root/run/secrets` ni (hamyon, bank-feed kalitlari) o‘qiy oladi.

| Konteyner      | uid:gid       | Holat                                                 |
| -------------- | ------------- | ----------------------------------------------------- |
| api            | `10001:10001` | image’da (`apps/api/Dockerfile`)                      |
| web            | `10002:10002` | image’da (`apps/web/Dockerfile`)                      |
| worker         | `10003:10003` | image’da (`apps/worker/Dockerfile`) + compose `user:` |
| bankfeed       | `10004:10004` | o‘sha worker image’i, compose `user:` (H-1)           |
| migrate        | `10005:10005` | image’da (`migrate` target) + compose `user:`         |
| admin (statik) | `65532:65532` | image’da (`apps/admin/Dockerfile`)                    |

Secret fayllar (S5) — har biri **o‘zini o‘qiydigan konteyner uid’iga**, `0400`; xostdagi papka root’niki. Nomlar S2 compose’dagi
`secrets:` bilan bir xil (`deploy/compose.prod.yml`):

| Fayl (`/etc/ggpin/secrets/`) | Kim o‘qiydi    | Egasi (uid:gid) |
| ---------------------------- | -------------- | --------------- |
| `postgres_password`          | postgres image | `70:70`         |
| `redis_users.acl`            | redis image    | `999:999`       |
| `wallet_enc_key`             | worker         | `10003:10003`   |
| `fragment_session_enc_key`   | worker         | `10003:10003`   |
| `bank_feed_enc_key`          | bankfeed       | `10004:10004`   |

```bash
sudo install -d -m 0700 -o root -g root /etc/ggpin/secrets
sudo install -m 0400 -o 70    -g 70    <manba> /etc/ggpin/secrets/postgres_password
sudo install -m 0400 -o 999   -g 999   <manba> /etc/ggpin/secrets/redis_users.acl
sudo install -m 0400 -o 10003 -g 10003 <manba> /etc/ggpin/secrets/wallet_enc_key
sudo install -m 0400 -o 10003 -g 10003 <manba> /etc/ggpin/secrets/fragment_session_enc_key
sudo install -m 0400 -o 10004 -g 10004 <manba> /etc/ggpin/secrets/bank_feed_enc_key
```

**Worker va bankfeed kalitlari uchun qoida (SA N-2):** egasi **faqat** o‘qiydigan konteynerning uid’i: `wallet_enc_key` va
`fragment_session_enc_key` — **10003** (worker), `bank_feed_enc_key` — **10004** (bankfeed). Worker image endi uid 10003 da, bankfeed
10004 da ishlaydi (H-1), shuning uchun haqiqiy kalitlar S5 da shu egalar bilan qo‘yiladi. Worker kodi ham buni tekshiradi: fayl egasi
jarayon uid’idan boshqa bo‘lsa yoki ruxsat 0600 dan keng bo‘lsa, kalitni rad etadi. Fayl allaqachon bor bo‘lsa (masalan placeholder):
`cd /etc/ggpin/secrets && sudo chown 10003:10003 wallet_enc_key fragment_session_enc_key && sudo chown 10004:10004 bank_feed_enc_key && sudo chmod 0400 *`.

S5 gacha compose bu uchta secret faylni baribir mount qiladi, fayl bo‘lmasa `up` yiqiladi. Shuning uchun ularning o‘rniga
**tasodifiy placeholder** qo‘yiladi (o‘sha egalar bilan). Haqiqiy kalit S5 da placeholder’ning ustidan yoziladi:

```bash
for f in wallet_enc_key fragment_session_enc_key; do
  openssl rand -base64 32 | sudo install -m 0400 -o 10003 -g 10003 /dev/stdin /etc/ggpin/secrets/$f
done
openssl rand -base64 32 | sudo install -m 0400 -o 10004 -g 10004 /dev/stdin /etc/ggpin/secrets/bank_feed_enc_key
```

**`deploy/` VPS’ga qanday boradi:** faqat repo’dagi `deploy/` papkasi (compose, `postgres/`, `redis/`, `env/*.example`, `vps/`) →
`/opt/ggpin`, egasi `root:root`, papkalar 0755, conf fayllar **0644** (postgres uid 70 va redis uid 999 ularni o‘qiy olishi uchun).
Manba kodi, `.git` va haqiqiy env fayllar u yerga bormaydi (D-73 (5)). Env fayllari `/etc/ggpin/<servis>.env` (0600 root),
secret’lar `/etc/ggpin/secrets`.

```bash
# kompyuterda (repo ildizidan): faqat deploy/ arxivlanadi
tar --owner=0 --group=0 -czf ggpin-deploy.tgz -C deploy .
scp ggpin-deploy.tgz <owner>@10.66.0.1:/tmp/
# VPS’da
sudo install -d -m 0755 -o root -g root /opt/ggpin
sudo tar -xzf /tmp/ggpin-deploy.tgz -C /opt/ggpin --no-same-owner && rm /tmp/ggpin-deploy.tgz
sudo find /opt/ggpin -type d -exec chmod 0755 {} + && sudo find /opt/ggpin -type f -exec chmod 0644 {} +
```

**Tartib — birinchi `up` dan oldin (CR N8, SA N-3):** S5 (sirlar) va **S6 (alohida runtime DB rollari)** bajarilgan bo‘lishi shart:
api, worker va bankfeed env fayllaridagi `DATABASE_URL` superuser (`POSTGRES_USER` = `ggpin`) bilan ulanmaydi, `preflight.sh`
buni FAIL qiladi. Rollarni yaratish uchun avval faqat `$C up -d postgres`, qolgan servislar S6 dan keyin.

**Compose buyruqlari (S2).** Image’lar registry’dan digest bilan keladi (`/etc/ggpin/compose.env` dagi `*_IMAGE`, tag emas:
preflight tekshiradi); VPS’da `build` yo‘q. Har buyruq bir xil prefiks bilan:

```bash
C="sudo docker compose -p ggpin --env-file /etc/ggpin/compose.env -f /opt/ggpin/compose.prod.yml"
$C pull                                   # registry’dan; keyin: sudo bash preflight.sh (fail=0)
$C --profile migrate run --rm migrate     # migratsiya: alohida, aniq qadam (prisma migrate deploy), up’dan oldin
$C up -d                                  # proxy ham: 80/443 (tcp) ochiladi; keyin preflight.sh --expect-running
```

- `proxy` (Caddy) profilsiz: oddiy `up -d` uni ham ko‘taradi va 80/443 ni ochadi. Birinchi `up` dan oldin DNS, staging ACME va
  tekshiruvlar: `deploy/proxy/README.md`.
- Bitta worker image’i — ikki konteyner (D-76): `worker` (`WORKER_ROLE=fulfillment`, chiquvchi qiymat) va `bankfeed` (`WORKER_ROLE=bankfeed`,
  P2P tomoni). Ikkalasi ham profilsiz, `up -d` ikkalasini ko‘taradi; sessiya bo‘lmaguncha bankfeed.env da `BANK_FEED_MODE=off`.
  Deploy tartibi va `role=` tekshiruvi: `deploy/COMPOSE.md` «Roles».
- `migrate reset` bu stack’da hech qachon ishlatilmaydi.

**VPS’dagi tasdiq (S2 dan keyin):** oddiy foydalanuvchi sifatida, `sudo`’siz:

```bash
pid=$(sudo docker inspect -f '{{.State.Pid}}' <worker konteyneri>)
ls /proc/$pid/root/run/secrets      # kutilgan: Permission denied
cat /proc/$pid/environ              # kutilgan: Permission denied
```

Ikkalasi ham rad etilishi shart. `preflight.sh` tekshiradi: uid to‘qnashuvi; compose faylidagi har servisning `user:` qiymati (worker
`10003:10003`, bankfeed `10004:10004`, migrate `10005:10005`, proxy 65532, postgres 70, redis 999); ishlayotgan har ggpin konteyneri jarayonining haqiqiy
uid/gid’i (`/proc/<pid>/status`); secret fayllar: `0400`, login akkaunt emas, `postgres_password` faqat 70, `redis_users.acl` faqat 999,
`wallet_enc_key` va `fragment_session_enc_key` faqat 10003, `bank_feed_*` faqat 10004, boshqalari 10001–10005.

---

## 13. Qurilma yo‘qoldi yoki sherik chiqdi (SA M-3)

Darhol, shu tartibda (boshqa sherik bajaradi):

1. **WireGuard:** `/etc/wireguard/wg0.conf` dan uning `[Peer]` bo‘limini o‘chirish, `sudo systemctl restart wg-quick@wg0`, `sudo wg show` — peer yo‘q. Uning `/32` manzili `deploy/proxy/Caddyfile` dagi
   `@not_vpn` dan ham olib tashlanadi va proxy qayta yaratiladi (`../proxy/README.md` §6).
2. **SSH:** `/home/<u>/.ssh/authorized_keys` ni bo‘shatish; chiqib ketgan bo‘lsa `AllowUsers` dan olib tashlash va `sudo usermod -L -e 1 <u>`.
3. **sudo paroli:** qurilma yo‘qolgan bo‘lsa — yangi parol (`passwd <u>` + `passwd -e <u>`).
4. **Hostinger:** uning panel kirishini o‘chirish, 2FA va parolni almashtirish (0b-qadam).
5. **Tekshiruv:** `auth.log` (`sudo journalctl -u ssh --since -30d`) — uning kalit fingerprint’i bilan kirishlar; AuditLog’dagi CLI amallari
   (`actorType CLI`, `ip` = uning WG manzili) — kutilmagan amal bormi.
6. **Sirlarni almashtirish (S5 runbook’i bo‘yicha), kerak bo‘lsa:** qurilmada VPN/SSH kaliti bilan birga sir nusxasi bo‘lgan bo‘lsa yoki 5-band
   shubhali amal ko‘rsatsa — `WALLET_ENC_KEY`/mnemonic (D-71 almashtirish), `BANK_FEED_ENC_KEY`, `FRAGMENT_SESSION_ENC_KEY`, bot va JWT sirlari.

Oldini olish: FIDO2 `sk-ssh-ed25519` kaliti (3-qadam) — qurilma yo‘qolsa ham kalitni ko‘chirib bo‘lmaydi.

---

## 14. Bank-feed sessiyasi VPS’da (E8) va Fragment (E10) — tartib

S2, S5 va shu runbook tugagach. Batafsil: docs/05 runbook 1, 1a, 3a; D-73 (18).

1. **Eski sessiya avval yopiladi:** ishchi akkauntning MTProto sessiyasi boshqa joyda bo‘lsa — Telegram → Devices’da yopiladi. Blob ko‘chirilmaydi.
2. Login’dan oldin: swap o‘chiq, core dump o‘chiq (9-qadam), worker/bankfeed `read_only` + `/tmp` tmpfs, kalit fayli 0400 o‘z uid’iga (12-qadam).
3. **Login:** ikkala sherik qurilmasi yonida; kod va **2FA paroli faqat TTY orqali** (`docker compose run --rm -it ...`) kiritiladi —
   buyruq qatoriga, env’ga yoki faylga yozilmaydi; ekranda ko‘rinmaydi.
4. Bot chatlaridagi sozlash (`/start`, kontakt, karta ulash) va `card:add` — birinchi `live` start’dan **oldin** (runbook 1a).
5. **Birinchi `live` start:** `newAuthorization` alerti **kutiladi** (yangi login); barcha kartalar avtomatik **pauzada** → ega Devices’ni tekshiradi
   → `card:resume --confirm-security-pause` → test o‘tkazmasi (p4 mezoni).
6. Keyin har yangi qurilma = `newAuthorization` + pauza; sheriklar oldindan kelishadi (runbook 3a).
7. **E10 (Fragment sessiyasi) — faqat E8 dan keyin, o‘sha bitta Telegram akkaunti bilan** (D-58 (5): Fragment akkaunti = bank-feed ishchi
   akkaunti; D-56 (6) dagi «alohida akkaunt» o‘rniga). Fragment’ga **faqat brauzerda** Telegram login; akkauntga yangi qurilma ulanmaydi.
8. **Ishga tushirishdan oldin amalda tekshiriladi:** bank-feed `live` turganda Fragment’ga brauzerdan qayta kiriladi → `newAuthorization`
   alerti **chiqmasligi** va kartalar pauzaga **tushmasligi** kerak. Chiqsa — to‘xtang: bu launch’dan oldin hal qilinadi (D-58 (5) sharti).

---

## Keyingi qadamlar

1. Bajarildi: H-1 (uid 10003/10004/10005, 12-qadam) va S3 (Caddy, `deploy/proxy/README.md`; qolgani: admin CSP p9 bundle bilan, M-1/F18).
2. S5 — sirlar (12-qadamdagidek; env fayllari `/etc/ggpin/` da 0600 root). S6 — runtime DB rollari, birinchi `up` dan oldin.
3. Launch darvozasi (`p11-plan.md`), bu raundda emas: SA N-4 — Redis ACL kalit naqshlari; SA N-6 / N-10 — S3 da bajarildi; N-8 — `*_FILE`
   orqali sirlar (S5); N-11 — bajarildi (WORKER_ROLE, D-76: bankfeed to‘xtatuvchisi olindi); N-13 — yopiq registry; N-14.
