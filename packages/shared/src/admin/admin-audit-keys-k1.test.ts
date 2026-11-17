// K1 (S1 re-audit) and SA-S4-2 / SA-S4-3 (S4 audit): the key classification fails closed on secret,
// IP and admin-identity names the services do not write today, without catching harmless words.
import { describe, expect, it } from 'vitest';
import {
  isAuditIpKey,
  isAuditOsUserKey,
  isAuditSecretKey,
  isAuditTelegramIdKey,
  redactAuditJson,
  type AuditRedactionView,
} from './index';

describe('audit secret keys (K1, fail closed)', () => {
  it.each([
    'walletSeed',
    'seedPhrase',
    'telegramAuthKey',
    'auth_key',
    'bankFeedSessionString',
    'webAppInitData',
    'providerSignature',
    'fullCardNumber',
    'panNumber',
    'cardPAN',
    'walletPassphrase',
    'orderIdempotencyKey',
    'privKey',
    'jwt',
    'authorization',
    'bearerValue',
    'cvv',
    'cardCvc',
    // substring layer: one lower-case word
    'clientsecret',
    'adminpassword',
    'walletmnemonic',
    'mysessionstring',
    // S4 re-audit SA-S4R-1 probe (keys2.probe.mts)
    'authtoken',
    'bottoken',
    'BOTTOKEN',
    'bearertoken',
    'sessiontoken',
    'jwttoken',
    'seedphrase',
    'SEEDPHRASE',
    'walletseed',
    'walletSeedPhrase',
    'SEED',
    'seed_words',
    'walletprivkey',
    'privkey',
    'accessKey',
    'secretAccessKey',
    'signingKey',
    'encKey',
    'walletEncKey',
    'WALLET_ENC_KEY',
    'cardNo',
    'cardNum',
    'pin',
    'cardPin',
    'pinCode',
    'pin_code',
    'cvv2',
    'CVV2',
    'credentials',
    'creds',
    'pass.word',
    // fail closed over a harmless name (no service writes these today)
    'seeded',
    'tokenCount',
  ])('%s is hidden', (key) => {
    expect(isAuditSecretKey(key)).toBe(true);
  });

  it.each([
    'company',
    'expand',
    'panel',
    'spanish',
    'pinned',
    'spinner',
    'shipping',
    'opinion',
    'telegramId',
    'revokedSessions',
    'activeSessions',
    'txHash',
    'otpVerified',
    'errorCode',
    'amountTiyin',
    'operator',
    'rawText',
  ])('%s is shown', (key) => {
    expect(isAuditSecretKey(key)).toBe(false);
  });
});

describe('audit IP keys', () => {
  it.each([
    'ip',
    'clientIp',
    'ipAddress',
    'IPAddress',
    'remoteIp',
    'remoteAddr',
    'forwardedFor',
    'xForwardedFor',
    'loginIp',
    'sshClient',
    // SA-S4R-1
    'remoteAddress',
    'peerAddress',
    'clientAddress',
    'ipv4',
    'clientIpv4',
    'ipv6',
    'ipaddr',
    'IPAddr',
    'forwarded',
    'X-Forwarded-For',
    'clientIP',
    'remote_ip',
    'ips',
  ])('%s is an IP field', (key) => {
    expect(isAuditIpKey(key)).toBe(true);
  });

  it.each(['zip', 'zipCode', 'shipId', 'tip', 'description', 'skipped', 'userAgent', 'address'])(
    '%s is not',
    (key) => {
      expect(isAuditIpKey(key)).toBe(false);
    },
  );
});

describe('admin identity in audit JSON (SA-S4-3)', () => {
  const owner: AuditRedactionView = {
    ipFull: true,
    bankMessageRaw: true,
    maskIp: (ip) => ip,
    identityFull: true,
    maskTelegramId: () => 'masked',
  };
  const operator: AuditRedactionView = {
    ipFull: false,
    bankMessageRaw: false,
    maskIp: () => null,
    identityFull: false,
    maskTelegramId: (id) => `${id.slice(0, 2)}***${id.slice(-2)}`,
  };
  const row = {
    telegramId: '7012345678',
    target: { adminTelegramId: 7012345679, telegramIds: ['7012345670'] },
    operator: 'aziz',
    osUser: 'deploy',
    name: 'Ops',
  };

  it.each([
    'telegramId',
    'adminTelegramId',
    'telegramIds',
    'telegram_id',
    'TELEGRAM_ID',
    'TelegramID',
    'telegramid',
    // SA-S4R-1
    'tgId',
    'tgIds',
    'telegramUserId',
    'telegram_user_id',
    'tgUserId',
    'adminTgId',
    'chatId',
    'ownerChatId',
    'fromId',
  ])('%s is a Telegram id', (key) => {
    expect(isAuditTelegramIdKey(key)).toBe(true);
  });

  it.each(['telegram', 'tgDate', 'userId', 'orderId', 'idTg', 'chatTitle', 'identity'])(
    '%s is not a Telegram id',
    (key) => {
      expect(isAuditTelegramIdKey(key)).toBe(false);
    },
  );

  it('classifies the OS user', () => {
    expect(isAuditOsUserKey('os_user')).toBe(true);
    expect(isAuditOsUserKey('user')).toBe(false);
  });

  it('non-OWNER: ids masked, osUser null, keys and shape unchanged', () => {
    expect(redactAuditJson(row, operator)).toEqual({
      telegramId: '70***78',
      target: { adminTelegramId: '70***79', telegramIds: ['70***70'] },
      operator: 'aziz',
      osUser: null,
      name: 'Ops',
    });
  });

  it('non-OWNER: a bigint id is masked; anything that is not an id value is null', () => {
    expect(
      redactAuditJson(
        { telegramId: 7012345678n, a: { telegramId: { x: 1 } }, b: { telegramId: true } },
        operator,
      ),
    ).toEqual({ telegramId: '70***78', a: { telegramId: null }, b: { telegramId: null } });
  });

  it('OWNER: as written', () => {
    expect(redactAuditJson(row, owner)).toEqual(row);
  });
});
