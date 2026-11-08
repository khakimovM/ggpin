'use client';

import type { CatalogProductDetail, InputField } from '@repo/shared';
import { useCallback, useEffect } from 'react';
import { useProductUiStore } from '../../stores/product-ui-store';
import { useBackInterceptor } from '../../telegram/use-back-button';
import { useMe } from '../auth/use-me';
import { CheckoutFlow } from '../checkout/CheckoutFlow';
import { HowToFindSheet } from './HowToFindSheet';
import { OrderSummary } from './OrderSummary';
import { PackageSection } from './PackageSection';
import { PriceBar } from './PriceBar';
import { RecipientForm } from './RecipientForm';
import { usePurchase } from './use-purchase';
import { useSelectionLabel } from './use-selection-label';

export interface PurchaseViewProps {
  variant: 'tg' | 'web';
  product: CatalogProductDetail;
  field: InputField;
}

/**
 * Everything the visitor fills in before paying, in the order the design gives it: recipient,
 * package or quantity, summary, and the buy action. Mounted once per product (the screen keys
 * it by id), so the recipient and the choice never leak from one product to another.
 */
export function PurchaseView({ variant, product, field }: PurchaseViewProps) {
  const purchase = usePurchase(product, field);
  const me = useMe();
  const { selectedSku, customQty, openSheet } = useProductUiStore();
  const { selectSku, setCustomQty, setSheet, reset } = useProductUiStore.getState();
  useEffect(() => {
    reset();
    return reset;
  }, [reset, product.id]);

  const help = product.help !== null && product.help.trim() !== '' ? product.help : null;
  const closeSheet = useCallback(() => setSheet(null), [setSheet]);
  // In the Mini App the native BackButton closes the sheet before it leaves the page.
  useBackInterceptor(variant === 'tg' && openSheet === 'help', closeSheet);

  const { recipient, selection, quote, totalTiyin, reason } = purchase;
  const confirmedName = recipient.confirmedToken === null ? null : `@${recipient.state.username}`;
  const qtyValue = customQty ?? String(product.minQty ?? '');
  const selectionLabel = useSelectionLabel();
  const found = recipient.state.found;

  return (
    <>
      <RecipientForm
        field={field}
        controls={recipient}
        ownUsername={me.data?.username ?? null}
        hasHelp={help !== null}
        onHelp={() => setSheet('help')}
      />
      <PackageSection
        product={product}
        selectedSku={selectedSku}
        customQty={qtyValue}
        onSelectSku={selectSku}
        onQtyChange={setCustomQty}
      />
      <OrderSummary
        product={product}
        selection={selection}
        recipient={confirmedName}
        quote={quote.view}
        onRefreshQuote={quote.refresh}
      />
      <PriceBar
        variant={variant}
        totalTiyin={totalTiyin}
        pending={quote.view.status === 'pending'}
        reason={reason}
        onBuy={() => setSheet('checkout')}
        suspended={openSheet === 'checkout'}
      />
      {found !== null && recipient.confirmedToken !== null ? (
        <CheckoutFlow
          variant={variant}
          open={openSheet === 'checkout'}
          onOpenChange={(open) => setSheet(open ? 'checkout' : null)}
          product={product}
          item={`${product.name} · ${selectionLabel(product, selection)}`}
          recipient={{ username: recipient.state.username, displayName: found.displayName }}
          quote={quote}
        />
      ) : null}
      {help !== null ? (
        <HowToFindSheet
          open={openSheet === 'help'}
          onOpenChange={(open) => setSheet(open ? 'help' : null)}
          help={help}
        />
      ) : null}
    </>
  );
}
