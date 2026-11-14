import { RecipientProviderRefSchema, type NeedsReviewProof } from '@repo/shared';
import {
  hasProviderRef,
  type AdapterBalance,
  type ConfirmResult,
  type FulfillmentAdapter,
  type PrepareContext,
  type PrepareResult,
  type PreparedFulfillment,
  type SendResult,
} from '../fulfillment-adapter';

// The interface has no runtime code, so this test is its executable contract: a stub that
// implements it compiles only while the three-stage shape (prepare -> send -> confirm) holds, and
// the calls below pin the ordering rule "send gets exactly what prepare returned".
class StubAdapter implements FulfillmentAdapter {
  readonly code = 'STUB';
  readonly calls: string[] = [];

  validateRecipient(): ReturnType<FulfillmentAdapter['validateRecipient']> {
    return Promise.resolve({ status: 'NOT_FOUND' });
  }

  quote(): ReturnType<FulfillmentAdapter['quote']> {
    return Promise.resolve({ currency: 'TON', costMinor: 4_700_000n });
  }

  prepare(context: PrepareContext): Promise<PrepareResult> {
    this.calls.push(`prepare:${context.orderId}`);
    return Promise.resolve({
      status: 'READY',
      prepared: {
        adapter: this.code,
        costCurrency: 'TON',
        costMinor: 235_000_000n,
        request: { to: 'UQ-pay', amountNanoTon: '235000000' },
        externalRef: 'ext-1',
      },
    });
  }

  send(_context: PrepareContext, prepared: PreparedFulfillment): Promise<SendResult> {
    this.calls.push(`send:${prepared.externalRef ?? ''}`);
    return Promise.resolve({ status: 'SENT', externalRef: prepared.externalRef ?? 'none' });
  }

  confirm(_context: PrepareContext, externalRef: string): Promise<ConfirmResult> {
    this.calls.push(`confirm:${externalRef}`);
    return Promise.resolve({ status: 'DELIVERED' });
  }

  getBalance(): Promise<AdapterBalance> {
    return Promise.resolve({ currency: 'TON', amountMinor: 1_000_000_000n });
  }

  health(): ReturnType<FulfillmentAdapter['health']> {
    return Promise.resolve('OK');
  }
}

const context: PrepareContext = {
  orderId: 'cm0order1',
  attemptNo: 1,
  product: { id: 'cm0prod1', slug: 'telegram-stars' },
  sku: { id: null, quantity: 50 },
  recipient: { fields: { username: 'aziz_k' }, providerRef: 'x7Gq-2' },
};

describe('FulfillmentAdapter contract', () => {
  it('runs prepare, then send with what prepare returned, then confirm with the reference', async () => {
    const adapter = new StubAdapter();
    const prepared = await adapter.prepare(context);
    expect(prepared.status).toBe('READY');
    if (prepared.status !== 'READY') return;
    // The processor commits SENDING with prepared.request and prepared.externalRef right here.
    const sent = await adapter.send(context, prepared.prepared);
    expect(sent).toEqual({ status: 'SENT', externalRef: 'ext-1' });
    if (sent.status !== 'SENT') return;
    expect(await adapter.confirm(context, sent.externalRef)).toEqual({ status: 'DELIVERED' });
    expect(adapter.calls).toEqual(['prepare:cm0order1', 'send:ext-1', 'confirm:ext-1']);
  });

  it('"not sent" results carry a proof of the kind order-state resolution accepts', () => {
    const proof: NeedsReviewProof = {
      kind: 'TON_NOT_SENT',
      extMsgHash: 'a'.repeat(64),
      walletAddress: '0:' + 'b'.repeat(64),
      seqno: 41,
      validUntil: '2026-11-11T10:01:00.000Z',
      checkedSeqno: 41,
      checkedAt: '2026-11-11T10:05:00.000Z',
      reason: 'message expired and the seqno never moved',
    };
    const results: (SendResult | ConfirmResult)[] = [
      { status: 'NOT_SENT', proof },
      { status: 'UNKNOWN', detail: 'timeout' },
    ];
    expect(results.map((r) => r.status)).toEqual(['NOT_SENT', 'UNKNOWN']);
  });

  it('a recipient without providerRef cannot be re-checked: it is never treated as checkable', () => {
    expect(hasProviderRef(context.recipient)).toBe(true);
    expect(hasProviderRef({ fields: {}, providerRef: null })).toBe(false);
    expect(hasProviderRef({ fields: {}, providerRef: '' })).toBe(false);
  });

  it('a whitespace-only providerRef (spaces, NBSP, a tab) is no handle, like the shared schema', () => {
    const nbsp = String.fromCharCode(0xa0);
    for (const blank of ['   ', nbsp, `${nbsp} ${nbsp}`, '\t']) {
      expect(hasProviderRef({ fields: {}, providerRef: blank })).toBe(false);
      expect(RecipientProviderRefSchema.safeParse(blank).success).toBe(false);
    }
    expect(hasProviderRef({ fields: {}, providerRef: ` ${nbsp}x` })).toBe(true);
  });

  it('money is bigint minor units, never a number', async () => {
    const adapter = new StubAdapter();
    const price = await adapter.quote();
    expect(typeof price.costMinor).toBe('bigint');
    expect(typeof (await adapter.getBalance()).amountMinor).toBe('bigint');
  });
});
