import { Icon } from '@repo/ui';
import { ChevronDown } from 'lucide-react';

export interface FaqItem {
  question: string;
  answer: string;
}

export interface FaqAccordionProps {
  items: readonly FaqItem[];
  /** Index of the item that starts open (the first by default); `null` starts all closed. */
  openIndex?: number | null;
  /**
   * The `name` of the <details> group: browsers keep one item of a group open at a time. Two
   * accordions on one page need different names.
   */
  group?: string;
}

/**
 * The questions and answers, as native <details>: it needs no JavaScript (a crawler sees every
 * answer in the HTML, a keyboard opens an item with Enter or Space) and the browser keeps one
 * item open at a time through the shared `name`. Used by the landing, and by the FAQ page.
 */
export function FaqAccordion({ items, openIndex = 0, group = 'faq' }: FaqAccordionProps) {
  return (
    <div className="overflow-hidden rounded-3xl border border-border bg-card">
      {items.map((item, index) => (
        <details
          key={item.question}
          name={group}
          open={index === openIndex}
          className="group border-b border-border"
        >
          <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-base leading-[22px] font-bold hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
            <h3 className="m-0 min-w-0 flex-1 text-base leading-[22px] font-bold">
              {item.question}
            </h3>
            <Icon
              icon={ChevronDown}
              size={20}
              className="shrink-0 text-foreground-muted transition-transform duration-base ease-standard group-open:rotate-180"
            />
          </summary>
          <p className="m-0 max-w-[640px] px-5 pb-5 text-[15px] leading-[23px] font-medium text-foreground-secondary">
            {item.answer}
          </p>
        </details>
      ))}
    </div>
  );
}
