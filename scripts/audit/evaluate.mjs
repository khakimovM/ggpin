// Pure decision logic of the npm audit gate (no I/O), so it can be tested on fixtures.
//
// Input: the `npm audit --json` report (auditReportVersion 2, as built by @npmcli/arborist
// AuditReport#toJSON / Vuln#toJSON). Each `vulnerabilities[name]` has `severity`, `via`, `range`
// and `nodes`. A `via` item is either an advisory object ({ source, name, dependency, title, url,
// severity, range, ... }) or a plain string: the name of another vulnerable package this one
// depends on (a "metavuln"). Advisory objects are judged per install path. A high/critical entry
// must be explained: by a high/critical advisory of its own, or by pointers that all exist and
// lead (through other pointers, cycles cut) to such an advisory. Anything else fails closed.

export const FAILING = new Set(['high', 'critical']);
const REPORTED = new Set(['info', 'low', 'moderate']);
const GHSA_RE = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DECISION_RE = /^D-\d+$/;
const ALLOWLIST_KEYS = ['id', 'package', 'path', 'reason', 'decision', 'reviewBy'];
/** An exception is re-decided at least this often: a reviewBy further out is refused. */
export const MAX_REVIEW_DAYS = 180;

/** `day` (YYYY-MM-DD) plus `n` days, as YYYY-MM-DD (UTC). */
export function addDays(day, n) {
  return new Date(Date.parse(day) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * True for a real calendar date written as YYYY-MM-DD (2027-02-31 and "" are rejected).
 * @param {unknown} s
 * @returns {boolean}
 */
export function isIsoDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const t = Date.parse(s);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/**
 * The id an allowlist entry is matched on: the GHSA id at the end of the advisory URL, or, when
 * the URL carries none, `npm:<source>`. A GHSA-shaped allowlist id can never match the fallback,
 * so an advisory without a GHSA id cannot be allowlisted.
 * @param {{ url?: unknown, source?: unknown }} via  an advisory object from `via`
 * @returns {string}
 */
export function advisoryId(via) {
  const match = typeof via.url === 'string' ? /\/(GHSA-[a-z0-9-]+)$/i.exec(via.url) : null;
  return match ? match[1] : `npm:${String(via.source)}`;
}

/**
 * Checks the shape of .github/audit-allowlist.json: `{ entries: [...] }`, each entry with exactly
 * id (GHSA), package, path (exact `node_modules/...`, no wildcards), reason, decision (`D-<n>`)
 * and reviewBy (a real YYYY-MM-DD date, at most MAX_REVIEW_DAYS after `today` when given).
 * @param {unknown} allowlist  the parsed file
 * @param {string} [today]  YYYY-MM-DD (UTC); enables the review-horizon check
 * @returns {string[]} problems; empty when the file is valid
 */
export function validateAllowlist(allowlist, today) {
  if (!allowlist || typeof allowlist !== 'object' || !Array.isArray(allowlist.entries)) {
    return ['allowlist: expected an object with an "entries" array'];
  }
  const problems = [];
  allowlist.entries.forEach((entry, i) => {
    const where = `allowlist entry #${i + 1}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`${where}: not an object`);
      return;
    }
    const keys = Object.keys(entry).sort();
    if (keys.join() !== [...ALLOWLIST_KEYS].sort().join()) {
      problems.push(`${where}: keys must be exactly ${ALLOWLIST_KEYS.join(', ')}`);
    }
    if (!GHSA_RE.test(String(entry.id))) problems.push(`${where}: id is not a GHSA id`);
    if (typeof entry.package !== 'string' || entry.package === '') {
      problems.push(`${where}: package is empty`);
    }
    // An exact install path only: no globs, no bare package name.
    if (typeof entry.path !== 'string' || !/^node_modules\/[^*?]+$/.test(entry.path)) {
      problems.push(`${where}: path must be an exact node_modules/... path`);
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 10) {
      problems.push(`${where}: reason is missing`);
    }
    if (!DECISION_RE.test(String(entry.decision))) {
      problems.push(`${where}: decision must be D-<n>`);
    }
    if (!isIsoDate(entry.reviewBy)) {
      problems.push(`${where}: reviewBy must be a real YYYY-MM-DD date`);
    } else if (isIsoDate(today) && entry.reviewBy > addDays(today, MAX_REVIEW_DAYS)) {
      problems.push(
        `${where}: reviewBy ${entry.reviewBy} is more than ${MAX_REVIEW_DAYS} days after ${today}`,
      );
    }
  });
  return problems;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const viaOf = (vuln) => (Array.isArray(vuln.via) ? vuln.via : []);
const hasFailingAdvisory = (vuln) =>
  viaOf(vuln).some((v) => isObject(v) && !REPORTED.has(String(v.severity)));

/**
 * Walks the pointer graph from `name` (cycles cut). `dangling`: some pointer on the way names a
 * package missing from the report; `reached`: some entry on the way has a failing advisory.
 */
function walkPointers(name, vulns) {
  const seen = new Set([name]);
  const queue = viaOf(vulns[name]).filter((v) => typeof v === 'string');
  let dangling = false;
  let reached = false;
  while (queue.length > 0) {
    const next = queue.shift();
    if (seen.has(next)) continue;
    seen.add(next);
    const target = vulns[next];
    if (!isObject(target)) {
      dangling = true;
      continue;
    }
    if (hasFailingAdvisory(target)) reached = true;
    for (const v of viaOf(target)) if (typeof v === 'string') queue.push(v);
  }
  return { dangling, reached };
}

/**
 * @param {unknown} report  parsed `npm audit --json` output
 * @param {unknown} allowlist  parsed allowlist file
 * @param {string} today  YYYY-MM-DD (UTC)
 * @returns {{ ok: boolean, errors: string[], failures: object[], allowed: object[],
 *   reported: object[], expired: object[], unused: object[] }}
 *   `errors` means bad input (exit 2); `failures`/`expired` mean blocked (exit 1).
 */
export function evaluate(report, allowlist, today) {
  const result = { errors: [], failures: [], allowed: [], reported: [], expired: [], unused: [] };
  const done = () => ({
    ok: result.errors.length === 0 && result.failures.length === 0 && result.expired.length === 0,
    ...result,
  });

  if (!isIsoDate(today)) result.errors.push(`today: not a real YYYY-MM-DD date (${String(today)})`);
  result.errors.push(...validateAllowlist(allowlist, today));
  if (!isObject(report)) {
    result.errors.push('audit report: not a JSON object');
    return done();
  }
  if ('error' in report) {
    result.errors.push(`npm audit failed: ${JSON.stringify(report.error)}`);
    return done();
  }
  if (report.auditReportVersion !== 2 || !isObject(report.vulnerabilities)) {
    result.errors.push('audit report: expected auditReportVersion 2 with a vulnerabilities object');
    return done();
  }
  const counts = report.metadata?.vulnerabilities;
  if (!isObject(counts) || !Number.isInteger(counts.high) || !Number.isInteger(counts.critical)) {
    result.errors.push('audit report: metadata.vulnerabilities.high/critical are missing');
    return done();
  }
  const vulns = report.vulnerabilities;
  for (const [name, vuln] of Object.entries(vulns)) {
    if (!isObject(vuln))
      result.errors.push(`audit report: vulnerabilities.${name} is not an object`);
  }
  if (result.errors.length > 0) return done();

  const entries = allowlist.entries;
  const used = new Set();
  for (const entry of entries) {
    if (entry.reviewBy < today) result.expired.push(entry);
  }

  for (const [name, vuln] of Object.entries(vulns)) {
    const nodes = Array.isArray(vuln.nodes) ? vuln.nodes : [];
    const advisories = viaOf(vuln).filter(isObject);
    // Unknown severity strings count as failing.
    if (!REPORTED.has(String(vuln.severity))) {
      // A pointer that goes nowhere fails even when the entry has an advisory of its own.
      const walk = walkPointers(name, vulns);
      const explained = !walk.dangling && (hasFailingAdvisory(vuln) || walk.reached);
      if (!explained) {
        result.failures.push({
          id: 'unexplained',
          name,
          path: nodes.join(' '),
          severity: String(vuln.severity),
          title: 'high/critical without a high/critical advisory behind it',
        });
      }
    }
    if (nodes.length === 0 && advisories.length > 0) {
      result.errors.push(`audit report: ${name} has advisories but no nodes`);
    }
    for (const adv of advisories) {
      const id = advisoryId(adv);
      const severity = String(adv.severity);
      for (const path of nodes) {
        const finding = {
          id,
          name,
          path,
          severity,
          title: String(adv.title ?? ''),
          range: String(adv.range ?? ''),
        };
        if (REPORTED.has(severity)) {
          result.reported.push(finding);
          continue;
        }
        const entry = entries.find((e) => e.id === id && e.path === path && e.package === name);
        if (entry) {
          used.add(entry);
          result.allowed.push({ ...finding, decision: entry.decision, reviewBy: entry.reviewBy });
        } else {
          result.failures.push(finding);
        }
      }
    }
  }
  result.unused = entries.filter((e) => !used.has(e));
  // npm counts high/critical, yet nothing here was judged: the format has changed under us.
  const seriousCount = counts.high + counts.critical;
  if (seriousCount > 0 && result.failures.length === 0 && result.allowed.length === 0) {
    result.errors.push(
      `audit report: metadata counts ${seriousCount} high/critical, but no high/critical finding was read (format changed?)`,
    );
  }
  return done();
}
