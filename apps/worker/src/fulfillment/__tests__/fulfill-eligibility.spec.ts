import { RECIPIENT_REFUSED_NOTE, recipientRefund } from '../fulfill-eligibility';

// Phase 6 S1 (owner Q2 = A): a recipient `prepare` cannot pay is FAILED + REFUND before anything
// is sent. RECIPIENT_REFUSED keeps the existing reason RECIPIENT_GONE (no migration) with a note.

describe('recipientRefund', () => {
  it('a changed or gone recipient refunds under its own reason with the default note', () => {
    expect(recipientRefund('RECIPIENT_CHANGED')).toEqual({
      kind: 'REFUND',
      reason: 'RECIPIENT_CHANGED',
      note: null,
    });
    expect(recipientRefund('RECIPIENT_GONE')).toEqual({
      kind: 'REFUND',
      reason: 'RECIPIENT_GONE',
      note: null,
    });
  });

  it('a refused recipient (Premium after the quote) is a REFUND as RECIPIENT_GONE with a note', () => {
    expect(recipientRefund('RECIPIENT_REFUSED')).toEqual({
      kind: 'REFUND',
      reason: 'RECIPIENT_GONE',
      note: RECIPIENT_REFUSED_NOTE,
    });
    expect(RECIPIENT_REFUSED_NOTE).toMatch(
      /^failed: RECIPIENT_GONE \(.*Premium.*nothing was sent$/,
    );
  });
});
