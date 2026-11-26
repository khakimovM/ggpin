import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AUDIT_EFFECTS_MIN_AGE_MS,
  AUDIT_EFFECTS_WINDOW_MS,
  NOTIFY_DEDUPE_SEC,
  ORDER_EFFECTS_ACTIONS,
  orderEffectsPlan,
} from '@repo/shared';
import { ORDER_RECONCILE_EVERY_MAX_MS } from '../../../config/order-reconcile-env';
import { AUDIT_EFFECTS_TARGETS } from '../audit-effects.repository';

// D-64 (9), I-3: the sweep's query and the shared plan agree on which (action, targetType) rows have
// effects; the window stays well inside the notify dedupe; the step makes no job id of its own and
// the repository only reads.

const DAY_MS = 86_400_000;
const AUDIT = 'cmaudit0000000000000000a';
const TARGET = 'cmtarget00000000000000000';

function code(file: string): string {
  return readFileSync(join(__dirname, '..', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const planOf = (action: string, targetType: string) =>
  orderEffectsPlan(
    { id: AUDIT, action, targetType, targetId: TARGET, actorType: 'CLI', after: {} },
    null,
  );

describe('audit effects: the rows the sweep reads', () => {
  it('covers every audited action with effects, each once', () => {
    const actions = AUDIT_EFFECTS_TARGETS.map((pair) => pair.action).sort();
    expect(actions).toEqual(Object.values(ORDER_EFFECTS_ACTIONS).sort());
  });

  it.each(AUDIT_EFFECTS_TARGETS.map((p) => [p.action, p.targetType]))(
    '%s on %s is a pair the shared plan acts on',
    (action, targetType) => {
      expect(planOf(action, targetType).notifyJobs.length).toBeGreaterThan(0);
    },
  );

  it('the same action on any other target type plans nothing', () => {
    const types = [...new Set(AUDIT_EFFECTS_TARGETS.map((pair) => pair.targetType)), 'Payment'];
    for (const { action, targetType } of AUDIT_EFFECTS_TARGETS) {
      for (const other of types.filter((type) => type !== targetType)) {
        expect(planOf(action, other).notifyJobs).toEqual([]);
      }
    }
  });
});

describe('audit effects: the window', () => {
  it('is far inside the notify dedupe (the API replays effects up to 29 days)', () => {
    // EFFECTS_REPLAY_MAX_AGE_MS (apps/api order-review.service.ts) = dedupe - 1 day.
    const replayMaxAgeMs = NOTIFY_DEDUPE_SEC * 1000 - DAY_MS;
    // A tick that took its clock long before this step still reads inside it.
    expect(AUDIT_EFFECTS_WINDOW_MS + ORDER_RECONCILE_EVERY_MAX_MS).toBeLessThan(replayMaxAgeMs);
    expect(AUDIT_EFFECTS_MIN_AGE_MS).toBeGreaterThan(0);
    expect(AUDIT_EFFECTS_MIN_AGE_MS).toBeLessThan(AUDIT_EFFECTS_WINDOW_MS);
  });
});

describe('audit effects: static', () => {
  it('the step takes every job from the shared plan: no id, refId or job of its own', () => {
    const step = code('audit-effects.step.ts');
    expect(step).toMatch(/\borderEffectsPlan\(/);
    expect(step).not.toMatch(/\beffectsOf\(|notifyJobId|tgOutboxJobId|refId|OWNER_ALERT|kind:/);
    expect(step).not.toMatch(/queue\.add|\.add\(\s*NOTIFY/);
  });

  it('the repository only reads', () => {
    const repository = code('audit-effects.repository.ts');
    expect(repository).not.toMatch(
      /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(|\$executeRaw|\$queryRaw|\$transaction/,
    );
  });
});
