# VPS bazasi va qattiqlashtirish — runbook, 1-qism (11-bosqich, S4)

> Kim bajaradi: **ega** (sherik bilan). Agentlar VPS’ga kirmaydi.
> Qarorlar: D-73 (3) reachability, (5) VPS’da manba va kompilyator yo‘q, (10) SSH va admin faqat WireGuard orqali;
> docs/05 runbook 1 va 7 (swap, core dump, secret fayllar); docs/10.
> 1-qism: 0–6-qadamlar (provayder, panel, kirish, VPN, SSH, firewall). 2-qism: [README-2.md](README-2.md) (Docker, vaqt,
> swap/core dump, yangilanishlar, preflight, konteyner uid’lari, qurilma yo‘qolsa, E8).
> Keyingi bo‘laklar: S2 (production compose), S3 (Caddy + TLS), S5 (sirlar). Bu hujjat faqat **xostni** tayyorlaydi.

Har qadam oxirida tekshiruv bor. Hammasi tugagach `preflight.sh` FAIL’siz o‘tishi kerak (README-2, 11-qadam).

---

## 0. Provayder: Hostinger (dastlabki tanlov, hali yakuniy emas)

| Narsa     | Qiymat                                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------------------------- |
| Tarif     | KVM 2: 2 vCPU, 8 GB RAM, 100 GB NVMe, 1 Gbps                                                                      |
| Joylashuv | Litva (zaxira — Germaniya). Yurist tasdig‘i kerak (D-73 (3), D-57 (11))                                           |
| OS        | Panelda **toza Ubuntu 24.04** shabloni. «Docker», panel yoki ilova shablonlari **kerak emas** (README-2, 7-qadam) |
| IPv4      | Statik (D-20)                                                                                                     |

**Ogohlantirishlar:**

1. **Joylashuv keyin o‘zgarmaydi** — faqat serverni qayta o‘rnatish (hamma narsa o‘chadi) bilan. Joylashuvni yurist javobidan keyin tanlang.
2. **30 kunlik qaytarish muddati.** Shu muddat ichida tekshiriladi, natija yomon bo‘lsa — refund:
   - `reachability.sh` (1-qadam): Telegram Bot API, MTProto DC’lar, fragment.com, TON API, Let’s Encrypt, registry;
   - O‘zbekiston mobil operatorlaridan (**Uzmobile, Beeline, Ucell, Mobiuz**) test sahifasiga kirish (1b-qadam).
3. **Panel brauzer terminali va VNC konsoli — faqat favqulodda** (SSH/WireGuard yopilib qolsa). Kundalik ish — WireGuard + SSH.
4. **Hostinger’ning haftalik bepul backup’i — qo‘shimcha qatlam, xolos.** Asosiy backup — bizning shifrlangan off-site backup’imiz
   (D-73 (8), S9: WAL + kunlik dump, RPO ≤ 5 daqiqa).
5. **Resurs:** 2 vCPU rejadagi 4 vCPU’dan kam. Yuklama testi (S10) shu tarifda; yetmasa tarif oshiriladi (KVM 4), joylashuv o‘zgarmaydi.

---

## 0b. Hostinger panelga kirish (SA M-2)

Panel — serverning to‘liq boshqaruvi: qayta o‘rnatish, konsol (root), snapshot, backup’ni tiklash. Shuning uchun:

- **Kim kiradi:** faqat ega va sherik, **har biri o‘z login’i bilan**; umumiy login va parol yo‘q. Hostinger’da akkauntga boshqa
  foydalanuvchini qo‘shish (access sharing) bo‘lsa — shuni ishlating. **Ochiq savol:** Hostinger VPS uchun alohida foydalanuvchi berish
  imkoniyati borligi tekshirilmagan; bo‘lmasa, egasi akkaunt egasi bo‘ladi va sherik qanday kirishi alohida hal qilinadi (umumiy parol emas).
- **2FA — TOTP ilova** (Google Authenticator, Aegis, 1Password va h.k.), **SMS emas** (SIM almashtirish hujumi). Zaxira kodlar oflayn, qog‘ozda.
- **Kirish xabarnomalari** yoqiladi (yangi qurilma/IP’dan kirish haqida email). Kutilmagan xabar = darhol parol va 2FA almashtirish.
- **Snapshot va Hostinger backup’i diskning to‘liq nusxasi:** unda `/etc/ggpin/secrets` (shu jumladan `WALLET_ENC_KEY` fayli),
  shifrlangan mnemonic’li DB, WireGuard va SSH host kalitlari bor. Panelga kirgan odam shu nusxadan yangi server ochib, ularni o‘qiy oladi.
- **Qoldiq xavf (egasi yozma qabul qiladi):** panel akkaunti buzilsa, issiq hamyondagi summa xavf ostida. Shuning uchun issiq hamyonda
  faqat 1–3 kunlik summa turadi (D-71), asosiy mablag‘ sovuq hamyonda.

---

## 1. Sotib olgandan keyin darhol: panel firewall’i va reachability (D-73 (3))

**Birinchi ish — panel firewall’i** (VPS → Firewall), hali hech narsa o‘rnatilmasdan: **ACCEPT** 22/tcp **faqat egasining hozirgi IP’sidan**,
80/tcp (faqat 1b sinovi uchun, keyin 6-qadam qoidasi), qolgani **DROP**. Firewall’ni serverga biriktiring. Shu paytgacha root paroli bilan
kirish internetga ochiq bo‘ladi — shuning uchun bu birinchi qadam.

Kompyuteringizdan skriptlarni nusxalang (VPS’ga manba kodi kerak emas, faqat `deploy/vps/` fayllari):

```bash
scp deploy/vps/reachability.sh deploy/vps/preflight.sh deploy/vps/preflight-runtime.sh \
  deploy/vps/preflight-select.sh deploy/vps/preflight-roles.sh root@<VPS_IP>:/root/
ssh root@<VPS_IP> 'bash /root/reachability.sh | tee /root/reachability-$(date -u +%F).txt'
```

- Kutilgan natija: `SUMMARY fail=0`. Har qator — DNS, TCP ulanish va (https uchun) bitta anonim `HEAD` so‘rov. Token yuborilmaydi.
- `WARN ... 403/451` — geo yoki IP blok bo‘lishi mumkin (ayniqsa `fragment`).
- MTProto DC’lardan birortasi `FAIL` — bank-feed ishlamaydi; Telegram Bot API `FAIL` — bot ishlamaydi. Ikkalasi ham refund sababi.
- TON API boshqa xost bo‘lsa: `TON_API_HOST=<xost>`; registry (S14): `REGISTRY_HOST=<xost>`; qo‘shimcha xostlar: `EXTRA_TARGETS_FILE=<fayl>`.
- Natija faylini saqlang (dalil).

### 1b. Mobil operatorlardan kirish (test sahifasi)

```bash
ssh root@<VPS_IP>
mkdir -p /root/probe && echo 'ggpin probe' > /root/probe/index.html
timeout 1800 python3 -m http.server 80 --directory /root/probe   # faqat shu papka; 30 daqiqadan keyin o‘zi to‘xtaydi
```

Har operator SIM’i bilan (Wi-Fi o‘chiq) `http://<VPS_IP>/` ni oching; natijani yozing (ochildi/yo‘q, taxminiy vaqt). Tugagach `Ctrl+C`,
`rm -r /root/probe`.

---

## 2. Birinchi sozlash (root sifatida)

```bash
apt-get update && apt-get -y full-upgrade
timedatectl set-timezone Etc/UTC
hostnamectl set-hostname ggpin-prod
```

`passwd -l root` hozir **emas**: avval shaxsiy foydalanuvchilar, kalit va `sudo -v` ishlashi tekshiriladi (3-qadam oxiri).

---

## 3. Shaxsiy foydalanuvchilar va SSH kalitlari (ed25519)

Har sherikka **alohida** foydalanuvchi (umumiy akkaunt yo‘q): `auth.log` va ega CLI’sining AuditLog’i (`ip`, `after.osUser`, D-46)
kim nima qilganini ajratadi.

Kalit **har kimning o‘z qurilmasida**, passphrase bilan; maxfiy qismi qurilmadan chiqmaydi. Iloji bo‘lsa **FIDO2 kalit** (YubiKey va h.k.):
`sk-ssh-ed25519` — kalit qurilmadan nusxalanmaydi, har kirishda tegish kerak.

```bash
ssh-keygen -t ed25519-sk -O resident -C "<ism>@ggpin" -f ~/.ssh/ggpin_ed25519_sk   # FIDO2 bo‘lsa
ssh-keygen -t ed25519 -a 100 -C "<ism>@ggpin" -f ~/.ssh/ggpin_ed25519              # aks holda
```

VPS’da (root; `<owner>`, `<partner>` — haqiqiy nomlar). Login akkauntlar uid’i **aniq beriladi: ega 2001, sherik 2002**
(keyingi odamlar 2003… 9999 gacha). **10001–10005 konteynerlarga ajratilgan** (api, web, worker, bankfeed, migrate; README-2, 12-qadam) — bu uid’lar xostda
yaratilmaydi: shu uid’dagi odam konteyner jarayonining sirlarini ko‘ra olardi. 1000 ni hech bir konteyner ishlatmaydi.

```bash
uid=2001
for u in <owner> <partner>; do
  adduser --uid "$uid" --disabled-password --gecos "" "$u"; uid=$((uid + 1))
  usermod -aG sudo "$u"
  install -d -m 0700 -o "$u" -g "$u" /home/$u/.ssh
  install -m 0600 -o "$u" -g "$u" /dev/null /home/$u/.ssh/authorized_keys
done
nano /home/<owner>/.ssh/authorized_keys      # faqat bitta qator: ssh-ed25519 AAAA... yoki sk-ssh-ed25519@openssh.com AAAA...
nano /home/<partner>/.ssh/authorized_keys
# sudo paroli: vaqtinchalik parol beriladi va darhol muddati o‘tgan deb belgilanadi (passwd -e) —
# har kim birinchi kirishda o‘z parolini o‘zi qo‘yadi, vaqtinchalik parolni boshqa hech kim bilmaydi.
passwd <owner>;   passwd -e <owner>
passwd <partner>; passwd -e <partner>
# Cloud-init qo‘ygan parolsiz sudo bo‘lsa — olib tashlanadi (preflight NOPASSWD’ni FAIL qiladi):
grep -rn NOPASSWD /etc/sudoers /etc/sudoers.d/
# Shablon uid 1000 li akkaunt (masalan `ubuntu`) yaratgan bo‘lsa — o‘z akkauntlaringiz ishlagach o‘chiriladi:
getent passwd 1000
```

**Tekshiruv:** yangi terminalda `ssh -i ~/.ssh/ggpin_ed25519 <owner>@<VPS_IP>` (birinchi kirishda yangi parol so‘raladi), keyin `sudo -v`.
Ikkala foydalanuvchi ham kirib, `sudo -v` ishlagandan **keyingina**:

```bash
sudo passwd -l root        # root paroli bloklanadi
```

> Docker guruhi = root huquqi. Hech kim `docker` guruhiga qo‘shilmaydi: `sudo docker ...` — har buyruq `auth.log` ga yoziladi.

---

## 4. WireGuard (D-73 (10)): SSH va admin panel faqat VPN orqali

Manzillar: server `10.66.0.1/24`, ega `10.66.0.2`, sherik `10.66.0.3`; UDP `51820`. Har peer IP’si bitta odamning bitta kalitiga tegishli —
shuning uchun auditdagi `ip` (WG manzili) odamni aniq ko‘rsatadi.

```bash
sudo apt-get install -y wireguard-tools
sudo sh -c 'umask 077; wg genkey > /etc/wireguard/server.key; wg pubkey < /etc/wireguard/server.key > /etc/wireguard/server.pub'
sudo cat /etc/wireguard/server.pub          # public kalit — mijozlarga beriladi
```

Mijoz kalitlari **har kimning o‘z qurilmasida** (WireGuard ilovasi «Generate keypair»); serverga faqat public kalit keladi.

`/etc/wireguard/wg0.conf`:

```ini
[Interface]
Address = 10.66.0.1/24
ListenPort = 51820
PostUp = wg set %i private-key /etc/wireguard/server.key

[Peer]
# owner
PublicKey = <owner public key>
AllowedIPs = 10.66.0.2/32

[Peer]
# partner
PublicKey = <partner public key>
AllowedIPs = 10.66.0.3/32
```

```bash
sudo chmod 0700 /etc/wireguard && sudo chmod 0600 /etc/wireguard/*
sudo systemctl enable --now wg-quick@wg0
sudo wg show
```

Mijoz (har qurilmada): `Address = 10.66.0.2/32`, `[Peer] PublicKey = <server public key>`, `Endpoint = <VPS_IP>:51820`,
`AllowedIPs = 10.66.0.1/32` (faqat server trafigi VPN’dan o‘tadi), `PersistentKeepalive = 25`.

**Yangi peer (qurilma) qo‘shish:** keyingi bo‘sh manzil (`10.66.0.4`, ...), `wg0.conf` ga `[Peer]` + `AllowedIPs = 10.66.0.N/32`,
`sudo systemctl restart wg-quick@wg0`. **Caddyfile’ga ham qo‘shing:** `deploy/proxy/Caddyfile` dagi `@not_vpn not remote_ip` qatoriga
`10.66.0.N/32`, keyin proxy qayta yaratiladi (`../proxy/README.md` §6) — aks holda admin panel yangi qurilmaga 404 beradi. Serverning o‘z
manzili `10.66.0.1` u yerga hech qachon yozilmaydi.

Panel firewall’iga **51820/udp ACCEPT** qo‘shing. **Tekshiruv:** VPN yoqilgan holda `ssh <owner>@10.66.0.1` ishlaydi. Shu ishlamaguncha
5–6-qadamlarga o‘tmang.

---

## 5. SSH qattiqlashtirish

Ubuntu 24.04 da SSH socket activation bilan ishlaydi (`ssh.socket`); unda `sshd_config` dagi `ListenAddress`/`Port` e’tiborsiz qoladi.
Oddiy servisga qaytaramiz:

```bash
sudo systemctl disable --now ssh.socket
sudo systemctl enable --now ssh.service
```

`/etc/ssh/sshd_config.d/00-ggpin.conf` (sshd’da **birinchi** topilgan qiymat ishlaydi; `00-` cloud-init’ning `50-cloud-init.conf`
dagi `PasswordAuthentication yes` dan oldin o‘qiladi):

```
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PubkeyAuthentication yes
AuthenticationMethods publickey
PubkeyAcceptedAlgorithms ssh-ed25519,sk-ssh-ed25519@openssh.com
AuthorizedKeysFile .ssh/authorized_keys
HostKey /etc/ssh/ssh_host_ed25519_key
HostKeyAlgorithms ssh-ed25519
AllowUsers <owner> <partner>
MaxAuthTries 3
LoginGraceTime 20
X11Forwarding no
AllowTcpForwarding no
AllowAgentForwarding no
PermitUserEnvironment no
ClientAliveInterval 300
ClientAliveCountMax 2
```

**Nega `ListenAddress 10.66.0.1` emas (SA I-1):** yuklanishda `wg0` sshd’dan keyin ko‘tarilsa, sshd bu manzilga bog‘lana olmaydi va
SSH butunlay yo‘qoladi (faqat panel konsoli qoladi). Shuning uchun sshd barcha manzillarda tinglaydi, 22-port esa **ikki firewall**da
(ufw va panel) faqat `wg0` uchun ochiq. `preflight.sh` buni tekshiradi.

```bash
sudo sshd -t && sudo systemctl reload ssh
```

**Tekshiruv (eski sessiya ochiq turganda!):** yangi terminalda `ssh <owner>@10.66.0.1` ishlaydi; `ssh -o PubkeyAuthentication=no <owner>@10.66.0.1`
va `ssh root@10.66.0.1` rad etiladi. Host kaliti fingerprint’ini panel konsolida `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` bilan solishtiring.

---

## 6. Firewall: ufw **va** Hostinger panel firewall’i (bir xil qoida, IPv4 va IPv6)

Qoida: tashqaridan faqat **80/tcp, 443/tcp** va **WireGuard 51820/udp**. SSH (22) faqat `wg0` ichidan. HTTP/3 (443/udp) o‘chiq —
sababi: [../proxy/README.md](../proxy/README.md) «HTTP/3».

```bash
grep '^IPV6=' /etc/default/ufw           # IPV6=yes bo‘lishi shart (aks holda IPv6 umuman filtrlanmaydi)
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw default deny routed
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 51820/udp
sudo ufw allow in on wg0 to any port 22 proto tcp
sudo ufw enable
sudo ufw status verbose
```

Hostinger panelida firewall’ni yakuniy holatga keltiring: **ACCEPT** 80/tcp, 443/tcp, 51820/udp; qolgan hammasi **DROP**;
1-qadamdagi «22 — egasining IP’sidan» qoidasi **o‘chiriladi** (SSH endi WireGuard tunneli ichida keladi). IPv6 manzil bo‘lsa — u uchun ham.

**Muhim — Docker ufw’ni chetlab o‘tadi.** `ports:` bilan publish qilingan har konteyner porti Docker’ning iptables zanjirlari orqali ochiladi,
ufw unga ta’sir qilmaydi. Shuning uchun S2 da **faqat proxy** 80/443 ni publish qiladi; Postgres, Redis, worker, api, web, admin hech qanday
port publish qilmaydi. Panel firewall’i serverdan tashqarida turgani uchun bu holatda ham himoya qiladi — ikkalasi ham kerak.

**Tekshiruv (VPN o‘chiq, tashqi kompyuterdan):**

```bash
nmap -Pn -p 1-65535 <VPS_IPv4>          # S3 gacha: 80 va 443 — closed (hali hech narsa tinglamaydi), qolgani filtered
nmap -6 -Pn -p 1-65535 <VPS_IPv6>       # IPv6 bo‘lsa: xuddi shunday
sudo nmap -sU -Pn -p 51820 <VPS_IPv4>   # open|filtered (WireGuard notanish paketga javob bermaydi — bu normal)
ssh <owner>@<VPS_IPv4>                  # ulanmaydi (timeout)
```

S3 (Caddy) dan keyin 80/443 — `open` (tcp; 443/udp yopiq qoladi). Proxy tekshiruvlari: [../proxy/README.md](../proxy/README.md). VPN yoqilganda `ssh <owner>@10.66.0.1` ishlaydi. Shundan keyin root sessiyasini yopsa bo‘ladi.

Davomi: [README-2.md](README-2.md) — Docker, vaqt, swap/core dump, yangilanishlar, preflight, konteyner uid’lari, qurilma yo‘qolsa, E8.
