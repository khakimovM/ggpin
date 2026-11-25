import { Inject, Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import type { FragmentSessionKey } from '../../config/fragment-session-env';
import { openAesGcm, sealAesGcm } from '../../crypto/aes-gcm';
import { PrismaService } from '../../infra/prisma/prisma.service';
import {
  MAX_COOKIES,
  isCookieName,
  isCookieValue,
  isPageHash,
  type FragmentJar,
} from './fragment-cookie-jar';

// FragmentSession.cookiesEnc (phase 5 S7, plan §7 "Saqlash"): the cookie jar AND the page `hash`
// in one AES-256-GCM blob, the purpose bound as AAD, so neither is ever at rest in clear (the
// plain `pageHash` column stays NULL on purpose). Opened in memory for one request; stored again
// whenever a `Set-Cookie` (or a new page hash) changes it. One ACTIVE row at most (partial unique
// FragmentSession_single_active_key). Nothing here logs; errors carry no value.

/** AAD of every session blob: a blob sealed for another purpose never opens here. */
export const FRAGMENT_SESSION_AAD = 'ggpin/fragment-session/v1';

/** The worker's FragmentSessionKey (undefined in a dry run or when not configured). */
export const FRAGMENT_SESSION_KEY = Symbol('FRAGMENT_SESSION_KEY');

/** `lastError` of a row the import CLI replaced (not a death: no alert, no revival). */
export const REPLACED_BY_IMPORT = 'REPLACED';

/**
 * `cookiesEnc` of a row that can never be used again (audit I-2): the column is NOT NULL, so an
 * empty string stands for "the cookies were wiped". It never opens (BAD_BLOB), and nothing
 * probes such a row: see importSession.
 */
export const COOKIES_TOMBSTONE = '';

export class FragmentSessionKeyMissingError extends Error {
  constructor() {
    super('FRAGMENT_SESSION_ENC_KEY is not configured: the Fragment session cannot be opened');
    this.name = 'FragmentSessionKeyMissingError';
  }
}

export class FragmentJarFormatError extends Error {
  constructor() {
    super('the Fragment session blob opened but is not a cookie jar');
    this.name = 'FragmentJarFormatError';
  }
}

const JarSchema = z.strictObject({
  v: z.literal(1),
  cookies: z
    .record(z.string().refine(isCookieName), z.string().refine(isCookieValue))
    .refine((c) => Object.keys(c).length <= MAX_COOKIES),
  pageHash: z.string().refine(isPageHash).nullable(),
});

/** The blob of a jar (sealed with a fresh IV). */
export function sealJar(jar: FragmentJar, key: Buffer): string {
  const plain = Buffer.from(
    JSON.stringify({ v: 1, cookies: Object.fromEntries(jar.cookies), pageHash: jar.pageHash }),
    'utf8',
  );
  try {
    return sealAesGcm(plain, key, FRAGMENT_SESSION_AAD);
  } finally {
    plain.fill(0);
  }
}

/** The jar of a blob. AesGcmError for a wrong key, another AAD or damage; never a value. */
export function openJar(blob: string, key: Buffer): FragmentJar {
  const plain = openAesGcm(blob, key, FRAGMENT_SESSION_AAD);
  try {
    let json: unknown;
    try {
      json = JSON.parse(plain.toString('utf8'));
    } catch {
      throw new FragmentJarFormatError();
    }
    const parsed = JarSchema.safeParse(json);
    if (!parsed.success) throw new FragmentJarFormatError();
    return {
      cookies: new Map(Object.entries(parsed.data.cookies)),
      pageHash: parsed.data.pageHash,
    };
  } finally {
    plain.fill(0);
  }
}

type PrismaHolder = Pick<PrismaService, 'client'>;

/** The row a jar was opened from, exactly as it was read (the compare-and-set of `save`). */
export interface ReadSession {
  readonly id: string;
  readonly status: 'ACTIVE' | 'DEAD';
  readonly cookiesEnc: string;
}

@Injectable()
export class FragmentSessionStore {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaHolder,
    @Optional() @Inject(FRAGMENT_SESSION_KEY) private readonly key?: FragmentSessionKey,
  ) {}

  /** Runs `use` with a copy of the key that is zeroed afterwards (audit I-8). */
  private withKey<T>(use: (key: Buffer) => T): T {
    if (this.key === undefined) throw new FragmentSessionKeyMissingError();
    const key = this.key.bytesForSessionStore();
    try {
      return use(key);
    } finally {
      key.fill(0);
    }
  }

  open(cookiesEnc: string): FragmentJar {
    return this.withKey((key) => openJar(cookiesEnc, key));
  }

  /**
   * Stores the jar again (a `Set-Cookie` refresh), only on the row it was read from and only if
   * that row is unchanged since: same status AND the very blob that was read (S7 audit N-1). False
   * when anything moved meanwhile — an import replaced the row and wiped its cookies (a refresh
   * must never write old cookies back onto a tombstone), or another replica stored a newer jar
   * first (its update is not lost under ours).
   */
  async save(read: ReadSession, jar: FragmentJar): Promise<boolean> {
    if (read.cookiesEnc === COOKIES_TOMBSTONE) return false;
    const cookiesEnc = this.withKey((key) => sealJar(jar, key));
    const { count } = await this.prisma.client.fragmentSession.updateMany({
      where: { id: read.id, status: read.status, cookiesEnc: read.cookiesEnc },
      data: { cookiesEnc },
    });
    return count === 1;
  }

  /**
   * The owner's import (Q9): the previous ACTIVE row (if any) becomes DEAD as REPLACED (deadAt
   * stays NULL: not a death, no alert, never revived), and the new jar is the ACTIVE row, in one
   * transaction. Returns the new row's id.
   *
   * Every older row's cookies are wiped in the same transaction (audit I-2): none of them is ever
   * used again. The keep-alive probes the ACTIVE row while there is one, and the new row is ACTIVE
   * until it dies or is replaced in turn; once it died, the newest death is that row (not an older
   * one), so an older DEAD row can never be revived and its cookies have no use at rest.
   */
  async importSession(jar: FragmentJar): Promise<string> {
    const cookiesEnc = this.withKey((key) => sealJar(jar, key));
    return this.prisma.client.$transaction(async (tx) => {
      await tx.fragmentSession.updateMany({
        where: { status: 'ACTIVE' },
        data: { status: 'DEAD', lastError: REPLACED_BY_IMPORT },
      });
      await tx.fragmentSession.updateMany({
        where: { status: 'DEAD', cookiesEnc: { not: COOKIES_TOMBSTONE } },
        data: { cookiesEnc: COOKIES_TOMBSTONE },
      });
      const row = await tx.fragmentSession.create({
        data: { cookiesEnc, status: 'ACTIVE' },
        select: { id: true },
      });
      return row.id;
    });
  }
}
