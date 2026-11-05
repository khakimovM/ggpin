'use client';

import { BottomActionBar, Button, Icon, MoneyText } from '@repo/ui';
import { ArrowRight, Copy, Plus, Search, Trash2, Wallet } from 'lucide-react';
import { useState } from 'react';
import { GalleryGroup, GallerySection } from './GallerySection';
import { sampleMoney, type GalleryLang } from './samples';
import type { Sample } from './samples-uz';

export function ActionsSection({ lang, s }: { lang: GalleryLang; s: Sample }) {
  const wallet = sampleMoney('8540000', lang);
  const total = sampleMoney('6150000', lang);
  const big = sampleMoney('11000000', lang);
  const missing = sampleMoney('3535000', lang);
  const [paying, setPaying] = useState(false);

  return (
    <GallerySection
      id="actions"
      title="Buttons and action bar"
      note="sm 36 (hit area 44) · md 44 · lg 52 · icon 44"
    >
      <GalleryGroup label="Variants · md">
        <div className="flex flex-wrap items-center gap-2.5">
          <Button>{s.buy}</Button>
          <Button variant="secondary">
            <Icon icon={Plus} size={18} />
            {s.topUp}
          </Button>
          <Button variant="outline">{s.change}</Button>
          <Button variant="ghost">{s.cancel}</Button>
          <Button variant="danger">
            <Icon icon={Trash2} size={17} />
            {s.remove}
          </Button>
          <Button variant="link">
            {s.more}
            <Icon icon={ArrowRight} size={16} />
          </Button>
        </div>
      </GalleryGroup>

      <GalleryGroup label="Sizes">
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm">sm · {s.buy}</Button>
          <Button size="md">md · {s.buy}</Button>
          <Button size="lg">lg · {s.pay}</Button>
          <Button variant="outline" size="icon" aria-label={s.change}>
            <Icon icon={Copy} size={18} />
          </Button>
          <Button variant="secondary" size="icon" aria-label={s.change} className="rounded-full">
            <Icon icon={Search} size={18} />
          </Button>
        </div>
      </GalleryGroup>

      <GalleryGroup label="States · primary / outline: default · disabled · loading">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Button>{s.buy}</Button>
          <Button disabled>{s.buy}</Button>
          <Button loading>{s.buy}</Button>
          <Button variant="outline">{s.change}</Button>
          <Button variant="outline" disabled>
            {s.change}
          </Button>
          <Button variant="outline" loading>
            {s.change}
          </Button>
        </div>
      </GalleryGroup>

      <GalleryGroup label="Long labels wrap (Russian QA: buttons are never nowrap)">
        <div className="flex max-w-[300px] flex-col gap-2">
          <Button size="lg">{s.longMoneyButton}</Button>
          <Button variant="secondary">{s.topUpWallet}</Button>
        </div>
      </GalleryGroup>

      <GalleryGroup label="BottomActionBar · default / loading / price loading" wide>
        <div className="grid gap-4 md:grid-cols-2">
          <BottomActionBar
            label={s.pay}
            hint={`${s.inWallet} ${wallet.amount} ${wallet.unit}`}
            price={<MoneyText size="lg" {...total} />}
            loading={paying}
            loadingLabel={s.paying}
            onAction={() => {
              setPaying(true);
              setTimeout(() => setPaying(false), 1800);
            }}
          />
          <BottomActionBar
            label={s.pay}
            hint={`${s.inWallet} ${wallet.amount} ${wallet.unit}`}
            priceLoading
          />
        </div>
      </GalleryGroup>

      <GalleryGroup label="BottomActionBar · disabled says why / insufficient balance" wide>
        <div className="grid gap-4 md:grid-cols-2">
          <BottomActionBar
            label={s.pay}
            hint={`${s.inWallet} ${wallet.amount} ${wallet.unit}`}
            price={<MoneyText size="lg" {...big} />}
            disabledReason={s.confirmRecipient}
          />
          <BottomActionBar
            label={s.topUpWallet}
            icon={<Icon icon={Wallet} size={18} />}
            hintTone="warning"
            hint={`${s.shortBy} ${missing.amount} ${missing.unit}`}
            price={<MoneyText size="lg" {...big} />}
          />
        </div>
      </GalleryGroup>
    </GallerySection>
  );
}
