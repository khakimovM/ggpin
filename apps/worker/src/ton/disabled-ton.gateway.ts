import type { Transaction } from '@ton/core';
import {
  TonGatewayError,
  type TonAccountState,
  type TonChainWitness,
  type TonGateway,
  type TonGatewayOperation,
} from './ton-gateway';

/**
 * The chain of a production process with FULFILLMENT_DRY_RUN=true: nothing may be sent, and the
 * fake chain refuses to exist in production (plan §8), so every call is refused before anything
 * leaves the process. The sender turns that into NOT_SENT (nothing signed); fulfillment itself
 * runs on the simulator adapters in a dry run and never asks for a TON payout.
 */
export class DisabledTonGateway implements TonGateway {
  private refuse<T>(operation: TonGatewayOperation): Promise<T> {
    return Promise.reject(new TonGatewayError(operation, 'REFUSED'));
  }

  getAccountState(): Promise<TonAccountState> {
    return this.refuse('getAccountState');
  }

  getBalance(): Promise<bigint> {
    return this.refuse('getBalance');
  }

  sendBoc(): Promise<void> {
    return this.refuse('sendBoc');
  }

  getTransactions(): Promise<readonly Transaction[]> {
    return this.refuse('getTransactions');
  }

  freshConnection(): TonChainWitness {
    return this;
  }

  findResultTx(): Promise<Transaction | null> {
    return this.refuse('findResultTx');
  }
}
