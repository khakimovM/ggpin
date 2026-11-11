import { ACTOR, useOpsE2e } from '../../../cli/__tests__/ops-e2e.harness';

// D-54: a review credit without an intent counts against the daily cap, so the next review:credit
// of the same new account shows overLimit and needs --confirm-override (code-review-api L-1).
const t = useOpsE2e();
const WHO = ['--reason', 'owner checked the bank app', '--operator', ACTOR.operator];
const FOUR_HUNDRED_THOUSAND_SOM = 40_000_000n; // under ADMIN_CONFIRM_THRESHOLD_TIYIN: no code

async function openReview(): Promise<string> {
  const card = await t.card();
  const message = await t.message({ card, amountTiyin: FOUR_HUNDRED_THOUSAND_SOM });
  return t.review(message.id, 'NO_MATCH', { cardId: card.id });
}

function fields(out: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    out
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
}

describe('review:credit counts the earlier intentless credits (D-54)', () => {
  it('a new account: the first 400 000 so‘m fits, the second one is overLimit and refused without --confirm-override', async () => {
    const userId = await t.user();
    const [first, second] = [await openReview(), await openReview()];

    const ok = await t.run(['review:credit', first, '--user', userId, ...WHO]);
    expect(ok.code).toBe(0);
    expect(fields(ok.out)['overLimit']).toBe('false');

    const refused = await t.run(['review:credit', second, '--user', userId, ...WHO]);
    expect(refused.code).toBe(1);
    expect(fields(refused.out)['overLimit']).toBe('true');
    expect(refused.err.join('\n')).toContain('--confirm-override');
    expect(await t.db().payment.count({ where: { userId } })).toBe(1);

    const forced = await t.run([
      'review:credit',
      second,
      '--user',
      userId,
      '--confirm-override',
      ...WHO,
    ]);
    expect(forced.code).toBe(0);
    expect(await t.db().payment.count({ where: { userId } })).toBe(2);
  });
});
