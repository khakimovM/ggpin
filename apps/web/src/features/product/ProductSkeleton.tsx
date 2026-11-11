import { Skeleton } from '@repo/ui';

/** Product.dc.html `pageState: skeleton`: the header card and two blocks. */
export function ProductSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only" role="status">
        {label}
      </span>
      <div className="flex gap-3.5 rounded-[24px] border border-border bg-card p-3">
        <Skeleton className="size-[88px] rounded-[20px]" />
        <span className="flex flex-1 flex-col justify-center gap-2.5">
          <Skeleton shape="text" className="h-5 w-40" />
          <Skeleton shape="text" className="h-3.5 w-full max-w-[220px]" />
        </span>
      </div>
      {[150, 110].map((width) => (
        <div
          key={width}
          className="flex flex-col gap-2.5 rounded-[24px] border border-border bg-card p-4"
        >
          <Skeleton shape="text" className="h-4" style={{ width }} />
          <Skeleton className="h-12 rounded-control" />
          <Skeleton className="h-12 rounded-control" />
        </div>
      ))}
    </div>
  );
}
