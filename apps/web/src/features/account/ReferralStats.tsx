import { Badge, Icon } from '@repo/ui';
import { Users } from 'lucide-react';

/**
 * The invited-friends statistics and list are phase 10 (owner decision Q8): an entry that says so
 * instead of numbers that would be made up.
 */
export function ReferralStats({
  title,
  body,
  soon,
}: {
  title: string;
  body: string;
  soon: string;
}) {
  return (
    <section className="flex flex-col items-center gap-2 rounded-[20px] border border-dashed border-input-border bg-card px-5 py-7 text-center">
      <span
        aria-hidden="true"
        className="grid size-14 place-items-center rounded-full bg-muted text-foreground-muted"
      >
        <Icon icon={Users} size={24} />
      </span>
      <h2 className="m-0 flex items-center gap-2 text-base leading-[22px] font-extrabold">
        {title}
        <Badge size="sm" variant="soon">
          {soon}
        </Badge>
      </h2>
      <p className="m-0 text-[13px] leading-[18px] font-medium text-foreground-secondary">{body}</p>
    </section>
  );
}
