'use client';

import { Button, Card, EmptyState, ErrorState, Icon, Skeleton, StatusChip } from '@repo/ui';
import { PackageOpen, Star } from 'lucide-react';
import { useState } from 'react';
import { GalleryGroup, GallerySection } from './GallerySection';
import { commonText, type GalleryLang } from './samples';
import type { Sample } from './samples-uz';

function SkeletonRow() {
  return (
    <div className="flex gap-2.5">
      <Skeleton className="size-9 shrink-0" />
      <div className="flex flex-1 flex-col gap-1.5">
        <Skeleton shape="text" className="w-[90%]" />
        <Skeleton shape="text" className="h-2 w-[55%]" />
        <Skeleton className="h-4 w-[60%] rounded-badge" />
      </div>
    </div>
  );
}

// The four data-view states every list ships: loading, error, empty, filled.
export function StatesSection({ lang, s }: { lang: GalleryLang; s: Sample }) {
  const common = commonText(lang);
  const [retrying, setRetrying] = useState(false);

  return (
    <GallerySection
      id="states"
      title="Data view states"
      note="Skeleton copies the final layout; error = one line + retry; empty = icon + CTA"
    >
      <GalleryGroup label="Loading">
        <div
          aria-busy="true"
          className="flex min-h-[260px] flex-col gap-4 rounded-lg border border-border bg-card p-3"
        >
          <p role="status" className="sr-only">
            {common.loading}
          </p>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      </GalleryGroup>

      <GalleryGroup label="Error">
        <ErrorState
          title={s.errorTitle}
          description={s.errorText}
          retryLabel={common.retry}
          retrying={retrying}
          onRetry={() => {
            setRetrying(true);
            setTimeout(() => setRetrying(false), 1500);
          }}
          className="min-h-[260px]"
        />
      </GalleryGroup>

      <GalleryGroup label="Empty">
        <EmptyState
          icon={<Icon icon={PackageOpen} size={24} />}
          title={s.emptyTitle}
          description={s.emptyText}
          action={<Button size="md">{s.emptyAction}</Button>}
          className="min-h-[260px]"
        />
      </GalleryGroup>

      <GalleryGroup label="Filled">
        <Card padding="none" className="flex min-h-[260px] flex-col gap-3.5 p-3">
          <div className="flex gap-2.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-sm bg-star-soft text-star">
              <Icon icon={Star} size={18} />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[13px] leading-[18px] font-extrabold">{s.orderLine}</span>
              <span className="text-[11px] leading-[14px] font-semibold text-foreground-muted">
                {s.dateUser}
              </span>
              <StatusChip
                status="DELIVERED"
                label={s.status.DELIVERED[0]}
                size="sm"
                className="self-start"
              />
            </span>
          </div>
          <div className="flex gap-2.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-sm bg-premium-soft text-premium">
              <Icon icon={Star} size={18} />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[13px] leading-[18px] font-extrabold">Premium 3</span>
              <span className="text-[11px] leading-[14px] font-semibold text-foreground-muted">
                {s.dateUser}
              </span>
              <StatusChip
                status="PROCESSING"
                label={s.status.PROCESSING[0]}
                size="sm"
                className="self-start"
              />
            </span>
          </div>
        </Card>
      </GalleryGroup>
    </GallerySection>
  );
}
