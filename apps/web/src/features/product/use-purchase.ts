'use client';

import type { CatalogProductDetail, InputField } from '@repo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect } from 'react';
import { qk } from '../../lib/query-keys';
import { useProductUiStore } from '../../stores/product-ui-store';
import { selectionOf } from './selection';
import { useQuote, type QuoteControls, type Selection } from './use-quote';
import { useValidateRecipient, type RecipientControls } from './use-validate-recipient';

export interface Purchase {
  recipient: RecipientControls;
  selection: Selection | null;
  quote: QuoteControls;
  /** The total of a live quote, as the server wrote it; null otherwise. */
  totalTiyin: string | null;
  /** The translated reason the buy button is off, or undefined when it is on. */
  reason: string | undefined;
}

/**
 * The purchase decision of one product page, in one place. "Sotib olish" is on only when ALL of:
 * the server found the recipient and the visitor confirmed them (invariant 8), a package or a
 * quantity inside the catalog's range is chosen, and a quote for exactly that choice is live.
 * An edit of any of them takes the button away again. (The order itself is placed in S7, where
 * the server checks all of this once more.)
 *
 * Two answers of the quote say that what the page holds is out of date, and the page fixes the
 * cause instead of offering a retry that cannot work:
 * - RECIPIENT_INVALID: the recipient token lives 10 minutes, the quote a while longer, so a stale
 *   price is asked for again with a dead token. The recipient goes back to "look up and confirm"
 *   (the username stays); asking the server again for them is not done behind the visitor's back,
 *   because confirming the person is the visitor's act.
 * - QTY_OUT_OF_RANGE / PRODUCT_UNAVAILABLE: the catalog moved on. The product is loaded again;
 *   the range, the packages or the "unavailable" page then follow from the fresh data.
 */
export function usePurchase(product: CatalogProductDetail, field: InputField): Purchase {
  const t = useTranslations('store.product');
  const locale = useLocale();
  const queryClient = useQueryClient();
  const reloadProduct = useCallback(
    () =>
      void queryClient.invalidateQueries({ queryKey: qk.catalog.product(product.slug, locale) }),
    [queryClient, product.slug, locale],
  );
  const recipient = useValidateRecipient(product.id, field.key, reloadProduct);
  const selectedSku = useProductUiStore((state) => state.selectedSku);
  const customQty = useProductUiStore((state) => state.customQty);
  const selection = selectionOf(product, selectedSku, customQty);
  const quote = useQuote(product.id, recipient.confirmedToken, selection);
  const { view } = quote;

  const { expire } = recipient;
  const { discard } = quote;
  const changedAt = view.status === 'productChanged' ? view.at : null;
  useEffect(() => {
    if (view.status === 'recipientInvalid') {
      // The old answer goes too: a new lookup may return the very same token, and the same request
      // must then be asked again, not meet the error that is still cached.
      discard();
      expire();
    }
  }, [view.status, discard, expire]);
  useEffect(() => {
    if (changedAt !== null) reloadProduct();
  }, [changedAt, reloadProduct]);

  const live = view.status === 'ready' && !view.expired ? view.quote : null;
  let reason: string | undefined;
  if (recipient.state.phase === 'blocked') reason = t('recipient.blocked.title');
  else if (recipient.confirmedToken === null) reason = t('buy.needRecipient');
  else if (selection === null) reason = t('buy.needPackage');
  else if (view.status === 'ready' && view.expired) reason = t('quote.expired');
  else if (view.status !== 'ready' && view.status !== 'pending') reason = t('buy.needPrice');

  return { recipient, selection, quote, totalTiyin: live?.totalTiyin ?? null, reason };
}
