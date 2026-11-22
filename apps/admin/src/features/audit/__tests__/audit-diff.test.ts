import { describe, expect, it } from 'vitest';
import { auditDiff } from '../audit-diff';

describe('audit diff', () => {
  it('shows changed fields as - then +, unchanged as context, sorted by key', () => {
    expect(
      auditDiff(
        { status: 'FAILED', amount: '10', same: true },
        { status: 'REFUNDED', same: true, note: 'x' },
      ),
    ).toEqual([
      { sign: '-', key: 'amount', value: '"10"' },
      { sign: '+', key: 'note', value: '"x"' },
      { sign: ' ', key: 'same', value: 'true' },
      { sign: '-', key: 'status', value: '"FAILED"' },
      { sign: '+', key: 'status', value: '"REFUNDED"' },
    ]);
  });

  it('handles a creation (no before) and nested values as JSON text', () => {
    expect(auditDiff(null, { role: 'SUPPORT', limits: { a: 1 } })).toEqual([
      { sign: '+', key: 'limits', value: '{"a":1}' },
      { sign: '+', key: 'role', value: '"SUPPORT"' },
    ]);
  });

  it('never interprets markup: a value is only text', () => {
    const [line] = auditDiff(null, { reason: '<img src=x onerror=alert(1)>' });
    expect(line?.value).toBe('"<img src=x onerror=alert(1)>"');
  });
});
