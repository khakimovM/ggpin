import { Skeleton } from '@repo/ui';

/**
 * The shape of the final list (Account.dc.html `hSkeleton`): a day heading and five rows of
 * picture, two lines, a chip and an amount. The status text is read once, not per block.
 */
export function HistorySkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-3">
      <span role="status" className="sr-only">
        {label}
      </span>
      <Skeleton shape="text" className="h-3.5 w-[72px] rounded-[7px]" />
      <div className="overflow-hidden rounded-[20px] border border-border bg-card py-1">
        {[1, 2, 3, 4, 5].map((row) => (
          <div
            key={row}
            className="grid grid-cols-[44px_minmax(0,1fr)_72px] items-center gap-3 px-4 py-3"
          >
            <Skeleton className="size-11 rounded-xl" />
            <span className="flex flex-col gap-1.5">
              <Skeleton shape="text" className="h-3 w-4/5 rounded-md" />
              <Skeleton shape="text" className="h-2.5 w-1/2" />
              <Skeleton shape="text" className="h-[18px] w-[84px] rounded-[9px]" />
            </span>
            <Skeleton shape="text" className="mt-1 h-3 self-start rounded-md" />
          </div>
        ))}
      </div>
    </div>
  );
}
