'use client';

import {
  Accordion,
  Button,
  Card,
  MoneyText,
  Sheet,
  Timeline,
  useToast,
  type TimelineItem,
} from '@repo/ui';
import { useState } from 'react';
import { GalleryGroup, GallerySection } from './GallerySection';
import { sampleMoney, type GalleryLang } from './samples';
import type { Sample } from './samples-uz';

function SheetDemo({ lang, s }: { lang: GalleryLang; s: Sample }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const total = sampleMoney('6150000', lang);
  // The back arrow and its accessible name travel together (SheetProps enforces the pair).
  const back = step === 2 ? { onBack: () => setStep(1), backLabel: s.back } : {};
  const left = sampleMoney('2390000', lang);

  return (
    <>
      <Button
        variant="outline"
        onClick={() => {
          setStep(1);
          setOpen(true);
        }}
      >
        {s.sheetTitle}
      </Button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title={step === 1 ? s.sheetTitle : s.sheetStep2}
        description={s.sheetDescription}
        closeLabel={s.close}
        {...back}
        footer={
          step === 1 ? (
            <div className="flex flex-col gap-2.5">
              <Button size="lg" glow onClick={() => setStep(2)}>
                {s.next}
              </Button>
              <p className="text-center text-xs leading-4 font-semibold text-foreground-muted">
                {s.autoDelivery}
              </p>
            </div>
          ) : (
            <Button size="lg" glow onClick={() => setOpen(false)}>
              {s.pay}
            </Button>
          )
        }
      >
        <dl className="flex flex-col gap-2.5 text-sm leading-5 font-semibold">
          <div className="flex justify-between gap-3">
            <dt className="text-foreground-muted">{s.product}</dt>
            <dd>PUBG Mobile · 325 UC</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-foreground-muted">Player ID</dt>
            <dd className="tabular-nums">5123456789</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-foreground-muted">{s.remains}</dt>
            <dd>
              <MoneyText size="sm" {...left} />
            </dd>
          </div>
          <div className="h-px bg-border" />
          <div className="flex items-baseline justify-between gap-3">
            <dt className="font-bold">{s.total}</dt>
            <dd>
              <MoneyText size="lg" {...total} />
            </dd>
          </div>
        </dl>
      </Sheet>
    </>
  );
}

function ToastDemo({ s }: { s: Sample }) {
  const toast = useToast();
  return (
    <div className="flex flex-wrap gap-2">
      {(['success', 'error', 'warning', 'info'] as const).map((tone) => (
        <Button
          key={tone}
          variant="outline"
          size="sm"
          onClick={() => {
            const [title, description] = s.toasts[tone];
            toast.show({ tone, title, description });
          }}
        >
          {tone}
        </Button>
      ))}
      {/* Stays for a minute: lets tests reach the close button without racing the 4 s timer. */}
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          const [title, description] = s.toasts.info;
          toast.show({ tone: 'info', title, description, duration: 60_000 });
        }}
      >
        persistent
      </Button>
    </div>
  );
}

export function ContainersSection({ lang, s }: { lang: GalleryLang; s: Sample }) {
  const [step, setStep] = useState(2);
  const items: TimelineItem[] = s.timeline.map(([title, description], index) => ({
    id: `step-${index}`,
    title,
    description,
    state: index < step ? 'done' : index === step ? 'active' : 'pending',
  }));
  const price = sampleMoney('11000000', lang);

  return (
    <GallerySection
      id="containers"
      title="Containers and overlays"
      note="Sheet: bottom on mobile, modal from 768"
    >
      <GalleryGroup label="Card · static / interactive (lifts on hover)">
        <div className="flex flex-col gap-3">
          <Card>
            <p className="text-[15px] leading-5 font-extrabold">{s.orderLine}</p>
            <p className="text-xs leading-4 font-semibold text-foreground-muted tabular-nums">
              {s.orderMeta}
            </p>
          </Card>
          <Card asChild interactive>
            <a href="#containers">
              <p className="text-[15px] leading-5 font-extrabold">Telegram Stars</p>
              <MoneyText size="md" {...price} />
            </a>
          </Card>
        </div>
      </GalleryGroup>

      <GalleryGroup label="Sheet · drag down > 80px, Escape or overlay closes, onBack for steps">
        <SheetDemo lang={lang} s={s} />
      </GalleryGroup>

      <GalleryGroup label="Toast · 4 s, closes on x (the provider is mounted at the page root)">
        <ToastDemo s={s} />
      </GalleryGroup>

      <GalleryGroup label="Accordion · FAQ">
        <Accordion
          defaultValue="faq-0"
          items={s.faq.map(([question, answer], index) => ({
            value: `faq-${index}`,
            question,
            answer,
          }))}
        />
      </GalleryGroup>

      <GalleryGroup label="Timeline · aria-live, active step pulses" wide>
        <div className="flex max-w-[420px] flex-col gap-4">
          <Card padding="lg">
            <Timeline
              items={items}
              ariaLabel={s.timelineLabel}
              stateLabels={s.timelineStates}
              currentLabel={s.currentStep}
            />
          </Card>
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => setStep((n) => (n >= 4 ? 0 : n + 1))}
          >
            {s.next}
          </Button>
        </div>
      </GalleryGroup>
    </GallerySection>
  );
}
