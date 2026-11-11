import { formatMoney } from '@repo/shared';
import { MESSAGES } from '../../../../i18n/messages';
import { RU } from './samples-ru';
import { UZ, type Sample } from './samples-uz';

export type GalleryLang = 'uz' | 'ru';

export const SAMPLES: Record<GalleryLang, Sample> = { uz: UZ, ru: RU };

/** Currency word from the real catalog ("{amount} so‘m" -> "so‘m"). */
export function currencyUnit(lang: GalleryLang): string {
  return MESSAGES[lang].common.money.uzs.replace('{amount}', '').trim();
}

/** Money exactly as the app shows it: server tiyin string -> formatMoney -> number + unit. */
export function sampleMoney(tiyin: string, lang: GalleryLang): { amount: string; unit: string } {
  return { amount: formatMoney(BigInt(tiyin), lang), unit: currencyUnit(lang) };
}

export function commonText(lang: GalleryLang) {
  const { retry, comingSoon, loading } = MESSAGES[lang].common;
  return { retry, comingSoon, loading };
}
