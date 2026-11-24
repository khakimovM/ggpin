// Orders fixtures (Admin.dc.html `orders`, AdminOps.dc.html `order`, `review`). Orders have no
// API before phase 9-B (S12): until then these rows are the only data the screens show.
import {
  AdminOrderDetailResponseSchema,
  AdminOrderRowSchema,
  AdminReviewQueueResponseSchema,
  type AdminOrderDetailResponse,
  type AdminOrderRow,
  type OrderStatus,
} from '@repo/shared';
import { ago, mid } from './data-common';

type Sample = [string, string, string, string, number, OrderStatus, string | null, number];
const SAMPLE: Sample[] = [
  [
    'sardor_r',
    'telegram-stars',
    'Telegram Stars',
    '1 000 ⭐',
    18_250_000,
    'DELIVERED',
    'FRAGMENT',
    2,
  ],
  ['jasur_t', 'pubg-mobile', 'PUBG Mobile', '660 UC', 11_000_000, 'NEEDS_REVIEW', 'UCSHOP', 8],
  [
    'dilnoza_k',
    'telegram-premium',
    'Telegram Premium',
    '3 oy',
    19_900_000,
    'PROCESSING',
    'FRAGMENT',
    3,
  ],
  ['bek_99', 'mobile-legends', 'Mobile Legends', '257 💎', 6_400_000, 'HELD', 'MLSHOP', 21],
  ['nilu_r', 'telegram-stars', 'Telegram Stars', '250 ⭐', 4_750_000, 'FAILED', 'FRAGMENT', 40],
  ['madina_a', 'roblox', 'Roblox', '800 Robux', 12_900_000, 'REFUNDED', 'ROBLOXCODES', 95],
  ['otabek', 'telegram-stars', 'Telegram Stars', '500 ⭐', 9_200_000, 'QUEUED', 'FRAGMENT', 1],
  ['akmal_s', 'pubg-mobile', 'PUBG Mobile', '325 UC', 5_600_000, 'DELIVERED', 'UCSHOP', 130],
];

export const ORDERS: readonly AdminOrderRow[] = SAMPLE.map(
  ([username, slug, name, label, totalSom, status, adapter, minutes], index) => {
    const total = `${totalSom}00`;
    const delivered = status === 'DELIVERED';
    return AdminOrderRowSchema.parse({
      id: mid('ord', index + 1),
      number: 48_213 - index,
      createdAt: ago(minutes),
      user: { id: mid('user', index + 1), username },
      product: { id: mid('prod', 1), slug, name },
      sku: { id: mid('sku', index + 1), label },
      quantity: 1,
      recipient: {
        displayName: slug.startsWith('telegram') ? `@${username}` : 'PlayerOne (5521)',
        fields: slug.startsWith('telegram') ? { username } : { playerId: '5521039917' },
      },
      priceTiyin: total,
      discountTiyin: '0',
      totalTiyin: total,
      costCurrency: slug.startsWith('telegram') ? 'TON' : 'USDT',
      costMinor: slug.startsWith('telegram') ? '3920000000' : '7820000',
      profitTiyin: delivered ? `${Math.round(totalSom * 0.09)}00` : null,
      status,
      statusReason:
        status === 'NEEDS_REVIEW' ? 'ADAPTER_ERROR' : status === 'HELD' ? 'PRICE_ABOVE_MAX' : null,
      adapter,
      deliveredAt: delivered ? ago(minutes - 1) : null,
    });
  },
);

export function orderDetailFixture(id: string): AdminOrderDetailResponse | undefined {
  const row = ORDERS.find((order) => order.id === id);
  if (row === undefined) return undefined;
  const ton = row.costCurrency === 'TON';
  return AdminOrderDetailResponseSchema.parse({
    ...row,
    events: [
      { from: null, to: 'PAID', actor: 'user', note: null, createdAt: row.createdAt },
      { from: 'PAID', to: 'QUEUED', actor: 'system', note: null, createdAt: row.createdAt },
      ...(row.status === 'QUEUED'
        ? []
        : [
            {
              from: 'QUEUED',
              to: 'PROCESSING',
              actor: 'worker',
              note: null,
              createdAt: row.createdAt,
            },
          ]),
      ...(row.status === 'QUEUED' || row.status === 'PROCESSING'
        ? []
        : [
            {
              from: 'PROCESSING',
              to: row.status === 'REFUNDED' ? 'FAILED' : row.status,
              actor: 'worker',
              note: row.statusReason,
              createdAt: row.deliveredAt ?? row.createdAt,
            },
          ]),
    ],
    attempts: [
      {
        id: mid('att', 1),
        attemptNo: 1,
        adapter: row.adapter ?? 'FRAGMENT',
        status:
          row.status === 'DELIVERED'
            ? 'CONFIRMED'
            : row.status === 'NEEDS_REVIEW'
              ? 'UNKNOWN'
              : 'SENT',
        externalRef: ton ? 'fr_req_8812' : null,
        error: row.status === 'NEEDS_REVIEW' ? 'supplier timeout after 30 s' : null,
        facts: {
          ton: ton
            ? {
                toAddress: 'UQBx…fragment',
                amountNanoTon: '3920000000',
                bounce: null,
                expiry: null,
                witnessConflict: false,
              }
            : null,
        },
        createdAt: row.createdAt,
      },
    ],
    tonTransfers: ton
      ? [
          {
            id: mid('ton', 1),
            attemptId: mid('att', 1),
            status: row.status === 'DELIVERED' ? 'CONFIRMED' : 'BROADCAST',
            network: 'testnet',
            walletAddress: 'UQAi7Kx0hot-wallet-mock-address-0000000000000000',
            toAddress: 'UQBxFragment-mock-address-00000000000000000000000',
            amountNanoTon: '3920000000',
            feeNanoTon: '5400000',
            seqno: 1812,
            validUntil: ago(-2),
            extMsgHash: 'a1f04c2e',
            txHash:
              row.status === 'DELIVERED'
                ? '7cc09a1b2e3f4a5b6c7d8e9f00112233445566778899aabbccddeeff001111be'
                : null,
            txLt: row.status === 'DELIVERED' ? '48120033000001' : null,
            explorerUrl: null,
            confirmedAt: row.deliveredAt,
            createdAt: row.createdAt,
          },
        ]
      : [],
    ledger: [
      {
        id: mid('led', 1),
        kind: 'PURCHASE',
        amountTiyin: `-${row.totalTiyin}`,
        refType: 'ORDER',
        createdAt: row.createdAt,
      },
      ...(row.status === 'REFUNDED'
        ? [
            {
              id: mid('led', 2),
              kind: 'REFUND',
              amountTiyin: row.totalTiyin,
              refType: 'ORDER',
              createdAt: ago(80),
            },
          ]
        : []),
    ],
    refundedTiyin: row.status === 'REFUNDED' ? row.totalTiyin : '0',
    quote: {
      id: mid('quo', 1),
      priceTiyin: row.priceTiyin,
      costMinor: row.costMinor,
      maxCostMinor: ton ? '4040000000' : '8050000',
      costCurrency: row.costCurrency,
      createdAt: row.createdAt,
      expiresAt: row.createdAt,
    },
    fxRate: {
      id: mid('fx', 1),
      pair: ton ? 'TON_UZS' : 'USDT_UZS',
      rate: ton ? '43850.5' : '12680',
      source: ton ? 'derived' : 'binance-p2p',
      createdAt: row.createdAt,
    },
    notes: [],
  });
}

export const REVIEW_QUEUE = AdminReviewQueueResponseSchema.parse(
  ORDERS.filter((order) => order.status === 'NEEDS_REVIEW' || order.status === 'HELD').map(
    (order, index) => ({ ...order, enteredAt: ago(6 + index * 13), ageSec: (6 + index * 13) * 60 }),
  ),
);
