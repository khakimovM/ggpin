import { createFixtureSanitizer } from '../fixture-sanitizer';
import { createLeakCheck } from '../leak-check';
import { redactPayloadText } from '../payload-text';

// P6-S0a fix round: a payload as an object or array (CR F4), under a single-quoted, unquoted,
// escaped or entity-quoted key (CR F5, SA F6), and id numbers in JSON (SA F3). Regression tests
// of the reviewers' probes CR P2/P2b/P2c and SA A5/A6.

const SECRETS = [{ kind: 'username' as const, value: 'owner_one' }];
const sanitizer = createFixtureSanitizer({ secrets: SECRETS, keepAddresses: [] });
const leakCheck = createLeakCheck({ secrets: SECRETS, keepAddresses: [] });
const BOC = 'te6ccgEBAQEAMgAAYAAAAABUZWxlZ3JhbSBQcmVtaXVt';
const P = '<REDACTED:payload>';

describe('fix round C: payload objects and arrays', () => {
  it('CR P2 / SA A6: an object or array under `payload` is redacted whole', () => {
    const out = sanitizer.sanitizeJson({
      payload: { text: 'Premium for Dilya Kasymova', boc: 'te6ccgEBAQEAAgAAAA' },
      messages: [{ payload: { comment: 'x' } }, { payload: ['abc'] }, { payload: null }],
    });
    expect(out).toEqual({
      payload: P,
      messages: [{ payload: P }, { payload: P }, { payload: null }],
    });
    expect(leakCheck(JSON.stringify(out))).toEqual([]);
  });

  it('the leak check flags an object or array payload', () => {
    expect(leakCheck('{"payload": {"text": "x"}}')).toContain('payload');
    expect(leakCheck('{"payload":["abc"]}')).toContain('payload');
  });
});

describe('fix round C: payload key spellings in text', () => {
  it.each([
    ['single quotes (CR P2b)', `x {'payload':'${BOC}'} y`, `x {'payload':'${P}'} y`],
    ['unquoted JS key (CR F5)', `payload: "abcdEFGH1234"`, `payload: "${P}"`],
    ['escaped JSON (CR P2c)', `{\\"payload\\":\\"${BOC}\\"}`, `{\\"payload\\":\\"${P}\\"}`],
    [
      'entities (SA A5)',
      `data-x="&quot;payload&quot;:&quot;${BOC}&quot;"`,
      `data-x="&quot;payload&quot;:&quot;${P}&quot;"`,
    ],
    [
      'an object in text',
      `x {"payload": {"a": "b", "c": [1]}, "n": 1}`,
      `x {"payload": "${P}", "n": 1}`,
    ],
    ['upper case key (SA A6)', `{"PAYLOAD":"abcd"}`, `{"PAYLOAD":"${P}"}`],
    ['a bare value', `payload: ${BOC};`, `payload: ${P};`],
  ])('%s', (_what, input, expected) => {
    const out = sanitizer.sanitizeText(input);
    expect(out).toBe(expected);
    expect(leakCheck(out)).toEqual([]);
  });

  it('an unclosed value is redacted to the end (fail closed)', () => {
    expect(redactPayloadText(`a 'payload': '${BOC}`, P)).toBe(`a 'payload': '${P}`);
    expect(redactPayloadText('a "payload": {"x": "y"', P)).toBe(`a "payload": "${P}"`);
  });

  it('keeps empty values and short bare words, and runs twice to the same text', () => {
    expect(sanitizer.sanitizeText(`payload: '' ; payload: data;`)).toBe(
      `payload: '' ; payload: data;`,
    );
    const once = sanitizer.sanitizeText(`{'payload':'${BOC}'}`);
    expect(sanitizer.sanitizeText(once)).toBe(once);
  });

  it.each([
    [`{'payload': 'abcdEFGH1234'}`],
    [`payload: "abcdEFGH1234"`],
    [`{\\"payload\\":\\"abc\\"}`],
    [`&quot;payload&quot;:&quot;abc&quot;`],
    [`{"payload" : {"comment": "x"}}`],
  ])('the leak check flags an unredacted %s', (text) => {
    expect(leakCheck(text)).toContain('payload');
  });
});

describe('fix round D: id numbers in JSON', () => {
  it("SA A4: a 5+ digit number under `id` / `*_id` is 0, `req_id` stays (Fragment's own)", () => {
    expect(
      sanitizer.sanitizeJson({
        id: 7123456789,
        peer_id: 7123456789,
        user: { msg_id: '7123456789', id: 42 },
        req_id: 123456789,
        paid: 123456,
      }),
    ).toEqual({
      id: 0,
      peer_id: 0,
      user: { msg_id: '0', id: 42 },
      req_id: 123456789,
      paid: 123456,
    });
  });

  it('the same in text', () => {
    expect(
      sanitizer.sanitizeText('{"id": 7123456789, "peer_id":7123456789, "req_id": 1234567}'),
    ).toBe('{"id": 0, "peer_id":0, "req_id": 1234567}');
  });
});

describe('fix round 2: `=` separators and camelCase ids (SA R5, R6)', () => {
  it.each([
    ['payload=', 'payload=abcdEFGH1234', `payload=${P}`],
    ['"Payload" = "…"', '"Payload" = "abcdEFGH"', `"Payload" = "${P}"`],
    ['percent form', 'payload%22%3A%22abcd1234', `payload%22%3A%22${P}`],
  ])('%s is redacted', (_what, input, expected) => {
    const out = sanitizer.sanitizeText(input);
    expect(out).toBe(expected);
    expect(leakCheck(out)).toEqual([]);
  });

  it.each([['payload=abcdEFGH1234'], ['"Payload" = "abcdEFGH"'], ['{payload:abcdEFGH1234xyz}']])(
    'the leak check flags an unredacted %s',
    (text) => {
      expect(leakCheck(text)).toContain('payload');
    },
  );

  it('camelCase *Id keys are zeroed, in JSON and in text', () => {
    expect(sanitizer.sanitizeJson({ peerId: 7123456789, chatID: '7123456789', reqId: 1 })).toEqual({
      peerId: 0,
      chatID: '0',
      reqId: 1,
    });
    expect(sanitizer.sanitizeText('{"peerId": 7123456789, "valid": 1234567}')).toBe(
      '{"peerId": 0, "valid": 1234567}',
    );
  });
});
