import type { ReactNode } from 'react';

// Dev-only layout helpers (plain English headings: the gallery is not a product screen).
export function GallerySection({
  id,
  title,
  note,
  children,
}: {
  id: string;
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section data-section={id} aria-labelledby={`gallery-${id}`} className="flex flex-col gap-5">
      <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
        <h2 id={`gallery-${id}`} className="text-[28px] leading-9 font-extrabold tracking-[-.02em]">
          {title}
        </h2>
        {note ? <p className="text-sm font-medium text-foreground-muted">{note}</p> : null}
      </div>
      <div className="grid gap-x-6 gap-y-7 md:grid-cols-2">{children}</div>
    </section>
  );
}

export function GalleryGroup({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  /** Spans both columns on wide screens. */
  wide?: boolean;
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-3 ${wide ? 'md:col-span-2' : ''}`}>
      <h3 className="text-[11px] leading-[14px] font-bold tracking-[.06em] text-foreground-muted uppercase">
        {label}
      </h3>
      {children}
    </div>
  );
}
