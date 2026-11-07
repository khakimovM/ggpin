import { Skeleton } from '@repo/ui';

/** Grid-shaped placeholder (MiniApp.dc.html `state: skeleton`): a heading and two rows of cards. */
export function CatalogSkeleton({ label, columns }: { label: string; columns: string }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-3">
      <span className="sr-only" role="status">
        {label}
      </span>
      <Skeleton shape="text" className="h-[18px] w-24 rounded-[9px]" />
      <div className={`grid gap-3 ${columns}`}>
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-[220px] rounded-[20px]" />
        ))}
      </div>
    </div>
  );
}
