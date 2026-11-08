import { Skeleton } from '@repo/ui';

/** The order page while it loads: the product card, the status card and the steps. */
export function OrderSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only" role="status">
        {label}
      </span>
      <div className="flex gap-3.5 rounded-[24px] border border-border bg-card p-3">
        <Skeleton className="size-[72px] rounded-[18px]" />
        <span className="flex flex-1 flex-col justify-center gap-2.5">
          <Skeleton shape="text" className="h-5 w-40" />
          <Skeleton shape="text" className="h-3.5 w-32" />
        </span>
      </div>
      <Skeleton className="h-[190px] rounded-[24px]" />
      <Skeleton className="h-[200px] rounded-[24px]" />
    </div>
  );
}
