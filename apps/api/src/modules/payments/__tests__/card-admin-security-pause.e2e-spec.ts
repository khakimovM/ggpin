import { openSecurityPause } from '@repo/db';
import { SECURITY_PAUSE_AUDIT } from '@repo/shared';
import { cardAdminHelpers } from './card-admin.e2e-helpers';
import { usePaymentsE2e } from './payments-e2e.helpers';

// D-52 D2, refined in fix round 2: card:add under the all-cards security pause (split out of
// card-admin.e2e-spec.ts). Every card this file touches is RETIRED in `finally`.
const e2e = usePaymentsE2e();
const { ACTOR, admin, pauses, freshPan, input, track } = cardAdminHelpers(e2e);

describe('addCard under a security pause (owner CLI)', () => {
  it('D-52 D2 (r2): only an open SECURITY pause makes a new card born paused (with its SYSTEM row); a chain-break pause does not; resume counts the others', async () => {
    const db = e2e.db();
    // m3: relative to the database as found (another run may have left a pause open).
    const openBefore = (await openSecurityPause(db)) !== null;
    const born = async (id: string) =>
      (await db.topupCard.findUniqueOrThrow({ where: { id } })).autoCreditPaused;
    const chainPaused = await e2e.card();
    const secured = await e2e.card();
    const added: string[] = [];
    const add = async () => {
      const card = await admin().addCard(input(await freshPan()));
      e2e.adopt(card.cardId);
      track('adminAction', card.auditId);
      added.push(card.cardId);
      return card;
    };
    try {
      // A chain break paused a card (no SYSTEM row): new cards are born running.
      await db.topupCard.update({
        where: { id: chainPaused.id },
        data: { autoCreditPaused: true },
      });
      const fresh = await add();
      expect(fresh.autoCreditPaused).toBe(openBefore);
      expect(await born(fresh.cardId)).toBe(openBefore);
      // The worker's security pause on a live card (its own row): new cards are born paused.
      await db.topupCard.update({ where: { id: secured.id }, data: { autoCreditPaused: true } });
      const pause = await db.auditLog.create({
        data: {
          ...SECURITY_PAUSE_AUDIT,
          actorId: null,
          ip: null,
          targetId: secured.id,
          reason: 'BANK_CHAT_ANOMALY',
          after: { autoCreditPaused: true, reason: 'BANK_CHAT_ANOMALY', ref: 'e2e' },
        },
        select: { id: true },
      });
      const during = await add();
      expect(during.autoCreditPaused).toBe(true);
      expect(await born(during.cardId)).toBe(true);
      const row = await db.auditLog.findFirstOrThrow({
        where: { targetId: during.cardId, action: 'CARD_PAUSE' },
      });
      expect(row).toMatchObject({ actorType: 'SYSTEM', reason: 'BANK_CHAT_ANOMALY' });
      expect(row.after).toMatchObject({ ref: pause.id, bornPaused: true });
      const others = await pauses().otherPausedCount(during.cardId);
      expect(others).toBeGreaterThanOrEqual(2); // chainPaused and secured, at least
      // card:resume lifts the security pause of each card on its own.
      track('adminAction', (await pauses().resumeAutoCredit(secured.id, 'checked', ACTOR)).auditId);
      track('adminAction', (await pauses().resumeAutoCredit(during.cardId, 'ok', ACTOR)).auditId);
      expect(await born(during.cardId)).toBe(false);
      const after = await add();
      expect(after.autoCreditPaused).toBe(openBefore);
    } finally {
      // RETIRED ends any security pause of these cards for later card:add calls on this DB.
      await db.topupCard.updateMany({
        where: { id: { in: [chainPaused.id, secured.id, ...added] }, status: { not: 'RETIRED' } },
        data: { status: 'RETIRED', retiredAt: new Date() },
      });
    }
  });
});
