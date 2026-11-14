import type { TestingModuleBuilder } from '@nestjs/testing';
import type { FakeTonGateway } from '../fake-ton.gateway';
import type { TonChainWitness } from '../ton-gateway';
import {
  TON_EXPIRY_WITNESSES,
  TON_GATEWAY,
  TON_PAY_ADDRESSES,
  TON_SENDER_HOOKS,
  TON_TIMING,
  TON_WALLET,
  TON_WALLET_LOCK,
  type TonPayAddresses,
  type TonSenderHooks,
  type TonTiming,
} from '../ton-tokens';
import type { TonWalletLock } from '../ton-lock';
import type { TonWallet } from '../ton-wallet';

// The TON module's test overrides for e2e suites OUTSIDE src/ton (phase 5 S4: the fulfillment
// core's crash tests boot TonModule inside FulfillmentModule). TON_WALLET may only be imported
// within src/ton (lint, audit I-1), so the one override that needs it lives here; two worker
// "processes" of a crash test share the same wallet and in-memory chain through it.

export interface TonOverrides {
  readonly wallet: TonWallet;
  readonly gateway: FakeTonGateway;
  readonly timing: TonTiming;
  readonly hooks: TonSenderHooks;
  readonly payAddresses: TonPayAddresses;
  readonly witnesses?: readonly TonChainWitness[];
  readonly walletLock?: TonWalletLock;
}

export function overrideTon(builder: TestingModuleBuilder, o: TonOverrides): TestingModuleBuilder {
  const result = builder
    .overrideProvider(TON_WALLET)
    .useValue(o.wallet)
    .overrideProvider(TON_GATEWAY)
    .useValue(o.gateway)
    .overrideProvider(TON_TIMING)
    .useValue(o.timing)
    .overrideProvider(TON_SENDER_HOOKS)
    .useValue(o.hooks)
    .overrideProvider(TON_PAY_ADDRESSES)
    .useValue(o.payAddresses)
    .overrideProvider(TON_EXPIRY_WITNESSES)
    .useValue(o.witnesses ?? []);
  return o.walletLock === undefined
    ? result
    : result.overrideProvider(TON_WALLET_LOCK).useValue(o.walletLock);
}
