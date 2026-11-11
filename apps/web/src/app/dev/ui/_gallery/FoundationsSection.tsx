import { BRAND } from '@repo/shared';
import { Avatar, Icon, Logo, MoneyText, RelativeTime } from '@repo/ui';
import { Wallet } from 'lucide-react';
import { GalleryGroup, GallerySection } from './GallerySection';
import { sampleMoney, type GalleryLang } from './samples';
import type { Sample } from './samples-uz';

const pad = (value: number) => String(value).padStart(2, '0');
// UTC on purpose: the gallery renders the same text on the server and in every time zone.
const adminDate = (date: Date) =>
  `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
const SAMPLE_DATE = new Date('2026-11-04T09:05:00.000Z');

export function FoundationsSection({ lang, s }: { lang: GalleryLang; s: Sample }) {
  const balance = sampleMoney('8540000', lang);
  const price = sampleMoney('12055000', lang);
  const credit = sampleMoney('12075000', lang);
  const debit = sampleMoney('-6150000', lang);

  return (
    <GallerySection id="foundations" title="Foundations" note="Logo, money, time, icons, avatar">
      <GalleryGroup label="Logo · wordmark / app / bot avatar / 32 / 16">
        <div className="flex flex-wrap items-end gap-6">
          <Logo name={BRAND.name} variant="wordmark" size={34} />
          <Logo name={BRAND.name} size={96} />
          <Logo name={BRAND.name} variant="avatar" size={96} />
          <Logo name={BRAND.name} size={48} />
          <Logo name={BRAND.name} size={32} />
          <Logo name={BRAND.name} size={16} />
        </div>
      </GalleryGroup>

      <GalleryGroup label="MoneyText · xl balance / lg price / md / sm · credit / debit / muted">
        <div className="flex flex-col gap-2.5">
          <MoneyText size="xl" {...balance} />
          <MoneyText size="lg" {...price} />
          <MoneyText size="md" {...price} />
          <MoneyText size="sm" tone="muted" {...price} />
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <MoneyText tone="credit" size="lg" {...credit} />
            <MoneyText size="lg" {...debit} />
          </div>
        </div>
      </GalleryGroup>

      <GalleryGroup label="RelativeTime · user / admin (formatter comes from the caller)">
        <div className="flex flex-col gap-2">
          <RelativeTime value={SAMPLE_DATE} format={() => s.dateUser} />
          <RelativeTime value={SAMPLE_DATE} variant="admin" format={adminDate} />
        </div>
      </GalleryGroup>

      <GalleryGroup label="Icon · 13 / 16 / 18 / 20 / 24">
        <div className="flex items-center gap-4 text-foreground-secondary">
          {[13, 16, 18, 20, 24].map((size) => (
            <Icon key={size} icon={Wallet} size={size} />
          ))}
        </div>
      </GalleryGroup>

      <GalleryGroup label="Avatar · 24 / 32 / 40 / 56 · photo fallback = initials" wide>
        <div className="flex flex-wrap items-center gap-3">
          <Avatar name={s.name} size={24} />
          <Avatar name={s.name} size={32} />
          <Avatar name={s.name} size={40} />
          <Avatar name={s.name} size={56} />
          <Avatar size={56} />
          <span className="flex flex-col gap-0.5">
            <span className="text-[15px] leading-5 font-extrabold">{s.name}</span>
            <span className="text-xs leading-4 font-semibold text-foreground-muted">
              @sardor_r · ID 1187712645
            </span>
          </span>
        </div>
      </GalleryGroup>
    </GallerySection>
  );
}
