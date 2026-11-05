'use client';

import {
  Badge,
  Chip,
  Icon,
  Ribbon,
  SegmentedControl,
  StatusChip,
  StockChip,
  Tabs,
  type StatusChipStatus,
} from '@repo/ui';
import { Clock, Flame } from 'lucide-react';
import { useState } from 'react';
import { GalleryGroup, GallerySection } from './GallerySection';
import { commonText, type GalleryLang } from './samples';
import type { Sample } from './samples-uz';

const STATUSES: StatusChipStatus[] = [
  'PAID',
  'QUEUED',
  'PROCESSING',
  'NEEDS_REVIEW',
  'HELD',
  'DELIVERED',
  'REFUNDED',
  'CANCELLED',
];

const LANG_OPTIONS = [
  { value: 'uz', label: 'UZ', ariaLabel: 'O‘zbekcha' },
  { value: 'ru', label: 'RU', ariaLabel: 'Русский' },
] as const;

export function SelectionSection({ lang, s }: { lang: GalleryLang; s: Sample }) {
  const [chip, setChip] = useState(0);
  const [quick, setQuick] = useState(1);
  const [segment, setSegment] = useState('orders');
  const [switchLang, setSwitchLang] = useState<GalleryLang>('uz');
  const [tab, setTab] = useState('all');
  const [filterShown, setFilterShown] = useState(true);
  const common = commonText(lang);

  const segmentOptions = [
    { value: 'orders', label: s.segments[0] },
    { value: 'finance', label: s.segments[1] },
  ];
  const tabItems = ['all', 'games', 'telegram', 'cards'].map((value, index) => ({
    value,
    label: s.tabs[index] ?? value,
  }));

  return (
    <GallerySection
      id="selection"
      title="Selection and badges"
      note="Chips wrap on long Russian labels"
    >
      <GalleryGroup label="Filter chips (scroll) · quick amounts · removable">
        <div className="flex flex-col gap-3">
          {/* py-1 / -my-1: room for the chips' 44px hit area, which overflow-x-auto would clip. */}
          <div className="-my-1 flex gap-2 overflow-x-auto py-1">
            {s.chips.map((label, index) => (
              <Chip
                key={label}
                selected={chip === index}
                onClick={() => setChip(index)}
                className="shrink-0 whitespace-nowrap"
              >
                {label}
              </Chip>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {[50, 100, 250, 500, 1000].map((amount, index) => (
              <Chip
                key={amount}
                variant="quick"
                selected={quick === index}
                onClick={() => setQuick(index)}
              >
                {amount} ⭐
              </Chip>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {filterShown ? (
              <Chip
                variant="removable"
                removeLabel={s.removeFilter}
                onRemove={() => setFilterShown(false)}
              >
                PUBG Mobile
              </Chip>
            ) : (
              <Chip variant="quick" onClick={() => setFilterShown(true)}>
                PUBG Mobile +
              </Chip>
            )}
            <Chip
              variant="removable"
              removeLabel={s.removeFilter}
              onRemove={() => undefined}
              disabled
            >
              Disabled
            </Chip>
          </div>
        </div>
      </GalleryGroup>

      <GalleryGroup label="SegmentedControl · primary / language switch">
        <div className="flex flex-col gap-4">
          <SegmentedControl
            options={segmentOptions}
            value={segment}
            onValueChange={setSegment}
            ariaLabel={s.segmentsLabel}
          />
          <SegmentedControl
            size="sm"
            variant="neutral"
            options={LANG_OPTIONS}
            value={switchLang}
            onValueChange={setSwitchLang}
            ariaLabel={s.langLabel}
          />
        </div>
      </GalleryGroup>

      <GalleryGroup label="Tabs (underline, scrolls instead of wrapping)">
        <Tabs items={tabItems} value={tab} onValueChange={setTab} ariaLabel={s.tabsLabel} />
      </GalleryGroup>

      <GalleryGroup label="Badges · region / delivery / merch">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="region">Global</Badge>
          <Badge variant="region">{s.sngRegion}</Badge>
          <Badge variant="region">UZ</Badge>
          <Badge variant="regionOnImage">Global</Badge>
          <Badge variant="auto">⚡ {s.auto}</Badge>
          <Badge variant="code">🎟 {s.promoCode}</Badge>
          <Badge variant="popular" icon={<Icon icon={Flame} size={12} />}>
            {s.popular}
          </Badge>
          <Badge variant="premium">{s.premium}</Badge>
          <Badge variant="soon" icon={<Icon icon={Clock} size={12} />}>
            {common.comingSoon}
          </Badge>
          <Badge size="sm" variant="popular">
            {s.popular}
          </Badge>
        </div>
      </GalleryGroup>

      <GalleryGroup label="StockChip · in stock / low / sold out">
        <div className="flex flex-wrap items-center gap-2">
          <StockChip state="inStock" label={s.stock.inStock} />
          <StockChip state="low" label={s.stock.low} />
          <StockChip state="soldOut" label={s.stock.soldOut} />
        </div>
      </GalleryGroup>

      <GalleryGroup label="StatusChip · long labels (wrap) and short form for tables" wide>
        <div className="flex flex-wrap items-start gap-2">
          {STATUSES.map((status) => {
            const [label, short] = s.status[status];
            return (
              <StatusChip key={status} status={status} label={label} shortLabel={short} size="xl" />
            );
          })}
        </div>
        <div className="flex max-w-[260px] flex-col gap-2">
          <StatusChip
            status="REFUNDED"
            label={s.status.REFUNDED[0]}
            shortLabel={s.status.REFUNDED[1]}
            size="lg"
          />
          <StatusChip
            status="REFUNDED"
            form="short"
            label={s.status.REFUNDED[0]}
            shortLabel={s.status.REFUNDED[1]}
            size="sm"
          />
        </div>
      </GalleryGroup>

      <GalleryGroup label="Ribbon on a tile (Russian anchors it to the end)" wide>
        <div className="flex max-w-[360px] gap-3 pt-2">
          <div className="relative min-h-[76px] flex-1 rounded-tile border-[1.5px] border-primary bg-primary-soft p-3.5">
            <Ribbon>{s.ribbon}</Ribbon>
            <p className="text-[17px] leading-[22px] font-extrabold tabular-nums">1800 UC</p>
            <p className="text-[13px] leading-[18px] font-semibold text-foreground-secondary tabular-nums">
              299 150
            </p>
          </div>
        </div>
      </GalleryGroup>
    </GallerySection>
  );
}
