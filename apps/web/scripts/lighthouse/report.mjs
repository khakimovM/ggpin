// Turns the Lighthouse runs of one (URL, form factor) cell into a median row, applies the gate
// and prints the table.

export const GATE = 0.9;
const CATEGORIES = ['performance', 'accessibility', 'seo', 'best-practices'];

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Index of the value closest to the median (the run whose report is kept). */
export function medianIndex(values) {
  const mid = median(values);
  let best = 0;
  values.forEach((value, i) => {
    if (Math.abs(value - mid) < Math.abs(values[best] - mid)) best = i;
  });
  return best;
}

const audit = (lhr, id) => lhr.audits[id]?.numericValue ?? 0;

function scriptBytes(lhr) {
  const items = lhr.audits['resource-summary']?.details?.items ?? [];
  const script = items.find((item) => item.resourceType === 'script');
  return script?.transferSize ?? 0;
}

function metricsOf(lhr) {
  return {
    lcp: audit(lhr, 'largest-contentful-paint'),
    tbt: audit(lhr, 'total-blocking-time'),
    cls: audit(lhr, 'cumulative-layout-shift'),
    scriptBytes: scriptBytes(lhr),
    totalBytes: audit(lhr, 'total-byte-weight'),
  };
}

/** Median of every score and metric over the runs; `runs` is a list of Lighthouse results. */
export function summarise(target, formFactor, runs) {
  const scores = Object.fromEntries(
    CATEGORIES.map((id) => [id, median(runs.map((lhr) => lhr.categories[id]?.score ?? 0))]),
  );
  const all = runs.map(metricsOf);
  const metrics = Object.fromEntries(
    Object.keys(all[0]).map((key) => [key, median(all.map((m) => m[key]))]),
  );
  return { ...target, formFactor, scores, metrics };
}

/** Why a row fails the gate; empty when it passes. SEO counts only on indexable pages. */
export function failures(row) {
  const out = [];
  if (row.scores.performance < GATE) out.push('performance');
  if (row.scores.accessibility < GATE) out.push('accessibility');
  if (row.indexable && row.scores.seo < GATE) out.push('seo');
  return out;
}

const score = (value) => String(Math.round(value * 100)).padStart(3);
const seconds = (ms) => `${(ms / 1000).toFixed(2)}s`;
const kib = (bytes) => `${Math.round(bytes / 1024)}K`;

export function printTable(rows) {
  const lines = [
    'path'.padEnd(26) + ' form    perf  a11y   seo    bp    LCP     TBT   CLS   JS    gate',
  ];
  for (const row of rows) {
    const bad = failures(row);
    const { scores, metrics } = row;
    lines.push(
      [
        row.path.padEnd(26),
        row.formFactor.padEnd(8),
        score(scores.performance),
        '  ',
        score(scores.accessibility),
        '  ',
        score(scores.seo) + (row.indexable ? ' ' : '*'),
        ' ',
        score(scores['best-practices']),
        '  ',
        seconds(metrics.lcp).padStart(6),
        ' ',
        `${Math.round(metrics.tbt)}ms`.padStart(6),
        ' ',
        metrics.cls.toFixed(3),
        ' ',
        kib(metrics.scriptBytes).padStart(5),
        '  ',
        bad.length === 0 ? 'ok' : `FAIL ${bad.join(',')}`,
      ].join(''),
    );
  }
  lines.push('(* = page is not indexable: SEO is not gated; best-practices is never gated)');
  console.log(lines.join('\n'));
}
