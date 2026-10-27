---
name: money-ledger
description: Implement or review anything that moves money in ggpin — wallet ledger entries, purchases, refunds, top-ups, referral bonuses, cashback coins, FX conversions, price quotes. Use for any code that reads or changes a balance or price.
---

# Money & ledger

## Utilities (packages/shared/src/money.ts — the only place for money math)
`somToTiyin(str)`, `tiyinToSom(bigint)`, `formatMoney(tiyin, locale)` → "12 550 so‘m" / "12 550 сум",
`convert(amount, fxRate, rounding: 'up'|'down')`, `applyMarkup(cost, bps)`, `percentOf(amount, bps)`.
Percentages are basis points (1% = 100 bps) as integers.

## Purchase template
```ts
await this.prisma.$transaction(async (tx) => {
  await tx.$queryRaw`SELECT id FROM "Wallet" WHERE "userId" = ${userId} FOR UPDATE`;
  const quote = await this.quotes.getValid(tx, userId, quoteId);        // throws QUOTE_EXPIRED
  const balance = await this.ledger.balance(tx, userId);
  if (balance < quote.priceTiyin) throw new InsufficientBalanceException(balance, quote.priceTiyin);
  const order = await this.orders.createPaid(tx, userId, quote, idempotencyKey);
  await this.ledger.append(tx, { userId, kind: 'PURCHASE', amountTiyin: -quote.priceTiyin,
                                 refType: 'ORDER', refId: order.id });
  return order;
});
// after commit: cache.del(`wallet:${userId}`); queue.add('fulfill', {orderId}, {jobId: order.id})
```

## Pricing
`price = roundUpToSom(convert(cost, fx, 'up') * (1 + markupBps) )`, then `max(price, cost + minMarginTiyin)`.
Quote stores cost, fxRateId, markup, price, `maxCost` (cost × (1 + toleranceBps)), expiresAt (10 min).

## Checklist
- [ ] No Number/parseFloat on money
- [ ] Ledger entry and state change in the same transaction
- [ ] Unique `(refType, refId, kind)` prevents double entries
- [ ] Rounding direction correct and tested
- [ ] Bonus/cashback only on DELIVERED, reversed on admin refund
