import { randomBytes } from 'node:crypto';
import type { TestingModule } from '@nestjs/testing';
import type { Prisma, PrismaClient } from '@repo/db';
import { QUEUES, notifyJobId, type NotifyJob } from '@repo/shared';
import { Queue } from 'bullmq';
import { ABANDON_PEEK, type AbandonPeek } from '../../../fulfillment/abandon-counter';
import { FulfillEnqueuer } from '../../../fulfillment/fulfill-enqueuer';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { AuditEffectsRepository } from '../audit-effects.repository';
import { AuditEffectsStep } from '../audit-effects.step';
import { ReconcileNotifier } from '../reconcile-notifier';
import { RECONCILE_ORDER_LOCK, type ReconcileOrderLock } from '../reconcile-order-lock';

// The S9h audit-effects step on real Postgres + Redis, built by hand from a booted reconciler (or
// S9d sweeps) module (the reconciler harness gets the same scoped list by override).
// Its list is narrowed to the targets of this run: the shared test database keeps the audit rows
// of every earlier run (append-only), and the API e2e writes ORDER_RETRY / FX_SET rows too.

/** The real repository, its list narrowed to the audit rows of these targets. */
export class ScopedAuditEffects extends AuditEffectsRepository {
  constructor(
    prisma: PrismaService,
    private readonly targets: ReadonlySet<string>,
  ) {
    super(prisma);
  }

  protected override scope(): Prisma.AuditLogWhereInput {
    return { targetId: { in: [...this.targets] } };
  }
}

/** The step over the module's real notifier, enqueuer, abandon reader and order lock. */
export function auditEffectsStep(
  moduleRef: TestingModule,
  targets: ReadonlySet<string>,
): { readonly step: AuditEffectsStep; readonly repository: ScopedAuditEffects } {
  const options = { strict: false };
  const repository = new ScopedAuditEffects(moduleRef.get(PrismaService, options), targets);
  const step = new AuditEffectsStep(
    repository,
    moduleRef.get(ReconcileNotifier, options),
    moduleRef.get(FulfillEnqueuer, options),
    moduleRef.get<symbol, AbandonPeek>(ABANDON_PEEK, options),
    moduleRef.get<symbol, ReconcileOrderLock>(RECONCILE_ORDER_LOCK, options),
  );
  return { step, repository };
}

export async function dbNowMs(db: PrismaClient): Promise<number> {
  const [row] = await db.$queryRaw<{ ms: string }[]>`
    SELECT floor(extract(epoch from now()) * 1000)::bigint::text AS "ms"`;
  return Number(row?.ms);
}

/** An id-shaped target that is no row of ours (an FxRate or TonTransfer id of a test). */
export function fakeTargetId(prefix: string): string {
  return `${prefix}${randomBytes(8).toString('hex')}`;
}

export interface AuditInput {
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly actorType?: string;
  readonly after?: Prisma.InputJsonObject;
  /** How long before the database's now the row was written. */
  readonly ageMs: number;
}

/** An audit row as its writer stores it, `ageMs` back on the database clock. */
export async function insertAudit(db: PrismaClient, input: AuditInput): Promise<string> {
  const at = new Date((await dbNowMs(db)) - input.ageMs);
  const row = await db.auditLog.create({
    data: {
      actorType: input.actorType ?? 'CLI',
      actorId: null,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      before: {},
      after: input.after ?? {},
      reason: 'e2e: audit effects sweep',
      createdAt: at,
    },
    select: { id: true },
  });
  return row.id;
}

/** The notify queue of the run: what is queued, when, and the jobs a test removes afterwards. */
export function useNotifyJobs(redisUrl: string) {
  const state = {} as { queue: Queue };
  const seen = new Set<string>();

  beforeAll(() => {
    state.queue = new Queue(QUEUES.NOTIFY, { connection: { url: redisUrl } });
  });

  afterAll(async () => {
    for (const id of seen) await (await state.queue.getJob(id))?.remove();
    await state.queue.close();
  });

  return {
    /** When the job was queued (ms), null when it is not: an unchanged value is a dedupe. */
    async queuedAt(job: NotifyJob): Promise<number | null> {
      seen.add(notifyJobId(job));
      return (await state.queue.getJob(notifyJobId(job)))?.timestamp ?? null;
    },
    /** The job lost between a commit and its add (the writer died): removed from Redis. */
    async drop(job: NotifyJob): Promise<void> {
      seen.add(notifyJobId(job));
      await (await state.queue.getJob(notifyJobId(job)))?.remove();
    },
  };
}
