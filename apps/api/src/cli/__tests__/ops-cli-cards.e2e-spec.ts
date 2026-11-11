import { openSecurityPause } from '@repo/db';
import { SECURITY_PAUSE_AUDIT } from '@repo/shared';
import { syntheticPan } from '../../modules/payments/__tests__/payments.fixtures';
import { ACTOR, useOpsE2e } from './ops-e2e.harness';

// D-52 r2 (review M-A, I-A, I-B): the all-cards SECURITY pause as the owner CLI sees it. The
// worker's pause is staged here as it writes it (auto-credit off + a SYSTEM CARD_PAUSE row);
// the worker side itself is covered in apps/worker listener.e2e-spec.ts. Every card this file
// touches is RETIRED at the end: an open security pause on a live card would make every later
// card:add on this database create its card paused.
const t = useOpsE2e();
const SECURITY_OK = '--confirm-security-pause';
const WHO = ['--reason', 'checked the account sessions', '--operator', ACTOR.operator];

async function freshPan(): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const pan = syntheticPan();
    if ((await t.db().topupCard.count({ where: { bank: 'HUMO', last4: pan.slice(-4) } })) === 0) {
      return pan;
    }
  }
  throw new Error('freshPan: no unused last4 in 50 attempts');
}

function fields(out: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    out
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
}

/** What the worker's AutoCreditPauser writes for a card under its card lock. */
async function securityPause(cardId: string): Promise<string> {
  await t.db().topupCard.update({ where: { id: cardId }, data: { autoCreditPaused: true } });
  const row = await t.db().auditLog.create({
    data: {
      ...SECURITY_PAUSE_AUDIT,
      actorId: null,
      ip: null,
      targetId: cardId,
      reason: 'NEW_AUTHORIZATION',
      before: { autoCreditPaused: false },
      after: { autoCreditPaused: true, reason: 'NEW_AUTHORIZATION', ref: 'e2e-hash' },
    },
    select: { id: true },
  });
  return row.id;
}

const paused = async (id: string) =>
  (await t.db().topupCard.findUniqueOrThrow({ where: { id } })).autoCreditPaused;

async function retire(ids: readonly string[]): Promise<void> {
  await t.db().topupCard.updateMany({
    where: { id: { in: [...ids] }, status: { not: 'RETIRED' } },
    data: { status: 'RETIRED', retiredAt: new Date() },
  });
}

describe('owner CLI under a security pause (D-52 r2)', () => {
  it('M-A / I-B: card:add is born paused with its own SYSTEM row and a warning; accept-chain keeps a security-paused card paused; card:resume lifts it', async () => {
    // Relative to the database as found: a pause left open by another run would show here.
    const openBefore = (await openSecurityPause(t.db())) !== null;
    const card = await t.card();
    const touched = [card.id];
    try {
      const pauseId = await securityPause(card.id);

      // I-B: the new card is born paused under the open pause, and the CLI says what to do.
      const added = await t.run(
        ['card:add', '--bank', 'HUMO', '--limit', '100000000', ...WHO],
        ['TESTOV SINOV', await freshPan()],
      );
      expect(added.code).toBe(0);
      const bornId = fields(added.out)['card'] ?? '';
      touched.push(bornId);
      expect(fields(added.out)['autoCreditPaused']).toBe('true');
      const warning = added.out.find((l) => l.startsWith('warning: the card is born paused'));
      expect(warning).toContain('Telegram -> Devices');
      expect(warning).toContain(
        `card:resume ${bornId} --confirm-security-pause BEFORE sending the verify transfer`,
      );
      expect(await paused(bornId)).toBe(true);
      const born = await t.db().auditLog.findFirstOrThrow({
        where: { targetId: bornId, action: 'CARD_PAUSE' },
      });
      expect(born).toMatchObject({
        actorType: 'SYSTEM',
        actorId: null,
        reason: 'NEW_AUTHORIZATION',
        after: { autoCreditPaused: true, ref: pauseId, bornPaused: true },
      });

      // M-A: a chain break on the security-paused card is accepted, the card stays paused.
      const debit = await t.message({ card, direction: 'DEBIT' });
      const breakReview = await t.review(debit.id, 'CHAIN_BREAK', { cardId: card.id });
      const accepted = await t.run(['review:accept-chain', breakReview, ...WHO]);
      expect(accepted.code).toBe(0);
      const acceptAudit = await t.db().auditLog.findUniqueOrThrow({
        where: { id: fields(accepted.out)['audit'] ?? '' },
      });
      expect(acceptAudit.after).toMatchObject({ autoCreditResumed: false });
      expect(await paused(card.id)).toBe(true);

      // card:resume is the owner's decision: it lifts the security pause (CARD_RESUME row) and
      // warns that other cards are paused too. A security pause needs --confirm-security-pause
      // (L-1: its own test below).
      const resumed = await t.run(['card:resume', card.id, SECURITY_OK, ...WHO]);
      expect(resumed.code).toBe(0);
      expect(resumed.out.some((l) => l.includes('other card(s) are paused too'))).toBe(true);
      expect(await paused(card.id)).toBe(false);
      const resumeAudit = await t.db().auditLog.findUniqueOrThrow({
        where: { id: fields(resumed.out)['audit'] ?? '' },
      });
      expect(resumeAudit).toMatchObject({ action: 'CARD_RESUME', actorType: 'CLI' });
      expect((await t.run(['card:resume', bornId, SECURITY_OK, ...WHO])).code).toBe(0);
      expect(await paused(bornId)).toBe(false);

      // Lifted on both: the next card:add is born running again (unless one was open before).
      const next = await t.run(
        ['card:add', '--bank', 'HUMO', '--limit', '100000000', ...WHO],
        ['TESTOV SINOV', await freshPan()],
      );
      touched.push(fields(next.out)['card'] ?? '');
      expect(fields(next.out)['autoCreditPaused']).toBe(String(openBefore));
      expect(next.out.some((l) => l.startsWith('warning: the card is born paused'))).toBe(
        openBefore,
      );
    } finally {
      await retire(touched.filter((id) => id !== ''));
    }
  });
});

describe('card:resume names the pause it lifts (security audit L-1)', () => {
  const resumeRows = (cardId: string) =>
    t.db().auditLog.count({ where: { targetId: cardId, action: 'CARD_RESUME' } });

  it('refuses a SECURITY pause without --confirm-security-pause and writes nothing; with it, the audit names the lifted pause', async () => {
    const card = await t.card();
    try {
      const pauseId = await securityPause(card.id);
      const lifted = `SECURITY/NEW_AUTHORIZATION:${pauseId}`;

      const refused = await t.run(['card:resume', card.id, ...WHO]);
      expect(refused.code).toBe(1);
      expect(fields(refused.out)['liftsPause']).toBe(lifted);
      expect(refused.out.join('\n')).toContain('--confirm-security-pause');
      expect(refused.err[0]).toContain('SECURITY_PAUSE_OPEN');
      // --confirm-override is about open reviews: it does not confirm a security pause.
      const overridden = await t.run(['card:resume', card.id, '--confirm-override', ...WHO]);
      expect(overridden.code).toBe(1);
      expect(overridden.err[0]).toContain('SECURITY_PAUSE_OPEN');
      expect(await paused(card.id)).toBe(true);
      expect(await resumeRows(card.id)).toBe(0);

      const resumed = await t.run(['card:resume', card.id, SECURITY_OK, ...WHO]);
      expect(resumed.code).toBe(0);
      expect(fields(resumed.out)['liftsPause']).toBe(lifted);
      expect(await paused(card.id)).toBe(false);
      const audit = await t.db().auditLog.findUniqueOrThrow({
        where: { id: fields(resumed.out)['audit'] ?? '' },
      });
      expect(audit.after).toMatchObject({ liftedPause: lifted, override: false });
    } finally {
      await retire([card.id]);
    }
  });

  it("the owner's own card:pause is lifted without the flag, and the audit names it", async () => {
    const card = await t.card();
    try {
      const pause = await t.run(['card:pause', card.id, ...WHO]);
      const pauseId = fields(pause.out)['audit'] ?? '?';
      const resumed = await t.run(['card:resume', card.id, ...WHO]);
      expect(resumed.code).toBe(0);
      expect(fields(resumed.out)['liftsPause']).toBe(`OWNER/CARD_PAUSE:${pauseId}`);
      expect(await paused(card.id)).toBe(false);
      const audit = await t.db().auditLog.findUniqueOrThrow({
        where: { id: fields(resumed.out)['audit'] ?? '' },
      });
      expect(audit.after).toMatchObject({ liftedPause: `OWNER/CARD_PAUSE:${pauseId}` });
    } finally {
      await retire([card.id]);
    }
  });
});
