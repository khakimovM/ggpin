import { BRAND, formatMoney, type Locale } from '@repo/shared';
import { cn, Icon } from '@repo/ui';
import {
  BatteryFull,
  CircleUser,
  Crown,
  EllipsisVertical,
  History,
  House,
  ImageIcon,
  Plus,
  Signal,
  Star,
  User,
  type LucideIcon,
} from 'lucide-react';
import { getTranslations } from 'next-intl/server';

// A sample balance for the picture, written as the server would send it (tiyin) and laid out by
// formatMoney like every amount on the site. It is not a price and not anybody's balance.
const SAMPLE_BALANCE_TIYIN = 8_540_000n;

// The tiles of the phone's home screen. Only Stars and Premium have a glyph; the rest are the
// design's empty picture slots. The names are the brand names of `site.products.names`.
const TILES: readonly {
  key: 'stars' | 'premium' | 'pubg' | 'mlbb' | 'steam' | 'roblox';
  icon: LucideIcon;
  box: string;
  glyph: string;
  region?: boolean;
}[] = [
  { key: 'stars', icon: Star, box: 'bg-star-soft', glyph: 'text-star' },
  { key: 'premium', icon: Crown, box: 'bg-premium-soft', glyph: 'text-premium' },
  { key: 'pubg', icon: ImageIcon, box: 'bg-muted', glyph: 'text-foreground-muted', region: true },
  { key: 'mlbb', icon: ImageIcon, box: 'bg-muted', glyph: 'text-foreground-muted' },
  { key: 'steam', icon: ImageIcon, box: 'bg-muted', glyph: 'text-foreground-muted' },
  { key: 'roblox', icon: ImageIcon, box: 'bg-muted', glyph: 'text-foreground-muted' },
];

const TAB =
  'flex flex-col items-center justify-center gap-0.5 rounded-full text-[8px] leading-none';

/**
 * The phone of the classic hero (Site.dc.html `hero: classic`): the bot's Mini App, drawn with
 * the dark theme's tokens whatever the page's theme is. A decorative picture: the caller hides it
 * from assistive technology. The user is a template ("Ism", "@username"), not a real person.
 */
export async function HeroPhone({ locale }: { locale: Locale }) {
  const [t, names, currency] = await Promise.all([
    getTranslations({ locale, namespace: 'site.hero.mock' }),
    getTranslations({ locale, namespace: 'site.products.names' }),
    getTranslations({ locale, namespace: 'common.currency' }),
  ]);

  return (
    <div
      data-theme="dark"
      className="relative h-[clamp(540px,44vw,600px)] w-[286px] rounded-[46px] bg-background p-2 shadow-lg ring-1 ring-border"
    >
      <div className="flex h-full flex-col overflow-hidden rounded-[38px] bg-background text-foreground ring-1 ring-border">
        <div className="flex h-[30px] items-center justify-between px-[22px] text-[11px] leading-none font-bold tabular-nums">
          <span>9:41</span>
          <span className="h-[22px] w-[76px] rounded-full bg-overlay" />
          <span className="flex gap-1">
            <Icon icon={Signal} size={11} />
            <Icon icon={BatteryFull} size={11} />
          </span>
        </div>
        <div className="flex h-10 items-center justify-between px-3.5 text-xs leading-none font-bold text-foreground-secondary">
          <span>{t('close')}</span>
          <span className="text-foreground">
            {BRAND.name}{' '}
            <span className="font-semibold text-foreground-muted">{t('botSuffix')}</span>
          </span>
          <Icon icon={EllipsisVertical} size={14} />
        </div>
        <div className="flex flex-1 flex-col gap-2.5 overflow-hidden px-3 pt-1">
          <div className="flex items-center gap-2">
            <span className="grid size-[30px] place-items-center rounded-full bg-primary-soft text-primary-soft-foreground">
              <Icon icon={User} size={15} />
            </span>
            <span className="flex flex-col gap-px">
              <span className="text-xs leading-[15px] font-extrabold">{t('userName')}</span>
              <span className="text-[10px] leading-3 font-semibold text-foreground-muted">
                {t('userHandle')}
              </span>
            </span>
            <span className="ml-auto inline-flex h-[26px] items-center gap-[5px] rounded-full border border-border bg-card pr-[9px] pl-1 text-[10px] leading-none font-extrabold">
              <span className="grid size-[18px] place-items-center rounded-full bg-accent font-display text-[9px] leading-none font-extrabold text-accent-foreground">
                g
              </span>
              {t('coins')}
            </span>
          </div>
          <div className="flex flex-col gap-2.5 rounded-[20px] bg-primary p-3 text-primary-foreground">
            <span className="text-[10px] leading-none font-bold">{t('balance')}</span>
            <span className="flex items-baseline gap-[5px] tabular-nums">
              <span className="font-display text-[22px] leading-none font-semibold tracking-[-.03em]">
                {formatMoney(SAMPLE_BALANCE_TIYIN, locale)}
              </span>
              <span className="text-[11px] leading-none font-bold">{currency('uzs')}</span>
            </span>
            <span className="grid grid-cols-2 gap-1.5">
              <span className="flex h-[30px] items-center justify-center gap-1 rounded-[10px] bg-primary-foreground text-[10px] leading-none font-extrabold text-primary">
                <Icon icon={Plus} size={10} />
                {t('topup')}
              </span>
              <span className="flex h-[30px] items-center justify-center gap-1 rounded-[10px] bg-primary-pressed text-[10px] leading-none font-extrabold">
                <Icon icon={History} size={10} />
                {t('history')}
              </span>
            </span>
          </div>
          <span className="mt-0.5 text-xs leading-none font-extrabold">{t('products')}</span>
          <div className="grid grid-cols-3 gap-2">
            {TILES.map(({ key, icon, box, glyph, region }) => (
              <span key={key} className="flex flex-col gap-1">
                <span
                  className={cn(
                    'relative grid aspect-square place-items-center overflow-hidden rounded-xl border border-border',
                    box,
                    glyph,
                  )}
                >
                  <Icon icon={icon} size={key === 'stars' || key === 'premium' ? 20 : 14} />
                  {region === true ? (
                    <span className="absolute top-1 right-1 h-3.5 rounded bg-primary px-1 text-[7px] leading-[14px] font-extrabold text-primary-foreground">
                      {t('region')}
                    </span>
                  ) : null}
                </span>
                <span className="truncate text-[9px] leading-[11px] font-bold text-foreground-secondary">
                  {names(key)}
                </span>
              </span>
            ))}
          </div>
        </div>
        <div className="mx-2.5 mt-2 mb-2.5 grid h-[54px] grid-cols-3 gap-1 rounded-full border border-border bg-surface p-1">
          <span className={cn(TAB, 'bg-primary-soft font-extrabold text-primary-soft-foreground')}>
            <Icon icon={House} size={14} />
            {t('tabHome')}
          </span>
          <span className={cn(TAB, 'font-bold text-foreground-muted')}>
            <Icon icon={History} size={14} />
            {t('history')}
          </span>
          <span className={cn(TAB, 'font-bold text-foreground-muted')}>
            <Icon icon={CircleUser} size={14} />
            {t('tabProfile')}
          </span>
        </div>
      </div>
    </div>
  );
}
