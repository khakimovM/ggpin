'use client';

import { useState } from 'react';
import { CatalogView } from '../catalog/CatalogView';
import { ProfileRow } from '../catalog/ProfileRow';
import { SearchBox } from '../catalog/SearchBox';
import { TgTabBar } from '../account/TgTabBar';
import { PendingPill } from '../topup/PendingPill';
import { WalletCard } from '../wallet/WalletCard';

const productHref = (slug: string) => `/tg/products/${slug}`;

/**
 * The Mini App home (MiniApp.dc.html `screen: home`): profile line, wallet card, search and the
 * catalog. Rendered behind TgGate, so there is a session. Each block has its own loading, error
 * and empty states; the catalog and the wallet fail and retry independently. The tab bar at the
 * bottom leads to the history and the profile (phase 7 S9).
 */
export function TgHome() {
  const [category, setCategory] = useState<string | undefined>(undefined);

  return (
    <>
      <main className="mx-auto flex min-h-dvh w-full max-w-[640px] flex-col gap-5 bg-background px-4 pt-[max(12px,var(--tg-safe-top,0px))] pb-[calc(112px+var(--tg-safe-bottom,0px))] text-foreground">
        <ProfileRow />
        <WalletCard />
        <PendingPill />
        <div className="flex flex-col gap-3">
          <SearchBox />
          <CatalogView
            variant="tg"
            category={category}
            onCategoryChange={setCategory}
            productHref={productHref}
          />
        </div>
      </main>
      <TgTabBar active="home" />
    </>
  );
}
