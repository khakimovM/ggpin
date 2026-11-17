// One step of the order reconciler's tick (phase 5 S9, D-64 (1)). The service runs the registered
// steps in a fixed order (transfers -> review -> stale (S9d) -> held (S9e) -> late facts (S9f) ->
// audit effects (S9h)); a later slice adds a step by providing it under RECONCILE_STEPS, nothing
// else changes. A step looks at no more than RECONCILE_BATCH_LIMIT rows per tick, works on each
// order under `lock:order:{id}` and reports ids and counts only (never an amount, a username or
// an address).

/** The DI token of the ordered step list (an array provider in OrderReconcileModule). */
export const RECONCILE_STEPS = Symbol('RECONCILE_STEPS');

/** What every step of one tick shares. */
export interface ReconcileContext {
  /** The DATABASE clock read once at the start of the tick (epoch ms): every window uses it. */
  readonly nowMs: number;
}

/** What one step did in one tick: counts per outcome and the ids of the orders it decided. */
export interface StepReport {
  readonly step: string;
  readonly counts: Readonly<Record<string, number>>;
  /** Orders (or transfers) the step changed, for the log line. */
  readonly ids: readonly string[];
}

export interface ReconcileStep {
  /** Short and stable: it names the step in the log line and in the processor's result. */
  readonly name: string;
  run(context: ReconcileContext): Promise<StepReport>;
}

/** Counts outcomes of a step without a mutable record leaking out of it. */
export class StepTally {
  private readonly counts = new Map<string, number>();
  private readonly decided: string[] = [];

  constructor(private readonly step: string) {}

  add(outcome: string, id?: string): void {
    this.counts.set(outcome, (this.counts.get(outcome) ?? 0) + 1);
    if (id !== undefined) this.decided.push(id);
  }

  /** The same outcome for rows only counted (never decided one by one). */
  addMany(outcome: string, count: number): void {
    if (count > 0) this.counts.set(outcome, (this.counts.get(outcome) ?? 0) + count);
  }

  report(): StepReport {
    return {
      step: this.step,
      counts: Object.fromEntries([...this.counts.entries()].sort(([a], [b]) => a.localeCompare(b))),
      ids: [...this.decided],
    };
  }
}

/** `step=review checked=3 delivered=1 ...` (ids follow in brackets when any were decided). */
export function describeReport(report: StepReport): string {
  const counts = Object.entries(report.counts)
    .map(([outcome, count]) => `${outcome}=${String(count)}`)
    .join(' ');
  const ids = report.ids.length === 0 ? '' : ` [${report.ids.join(',')}]`;
  return `step=${report.step} ${counts === '' ? 'idle' : counts}${ids}`;
}
