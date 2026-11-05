import { parseWithProfile, type BankProfile } from './message-engine';
import type { BankParseResult } from './parse-result';

/**
 * @HUMOcardbot. Structure (plan §2.4): emoji + title; ➕/➖ amount "D.DDD,DD UZS"; 📍 channel;
 * 💳 "HUMOCARD *NNNN"; clock + "HH:MM DD.MM.YYYY"; 💰 balance. Titles only refuse a message whose
 * amount sign they contradict; an unknown title is not an error.
 */
export const HUMO_PROFILE: BankProfile = {
  // "HUMOCARD *NNNN" (plan §2.4) or "*NNNN" (docs/05 §5); never the Uzcard "***NNNN".
  cardPattern: /^(?:HUMOCARD )?\*\d{4}$/,
  titles: [
    // Seen in the Uzbek UI (ASCII apostrophe).
    { text: "To'ldirish", direction: 'CREDIT' },
    { text: "To'lov", direction: 'DEBIT' },
    // Russian UI: ASSUMED wording, to be confirmed against a real message in phase 4, S11.
    { text: 'Пополнение', direction: 'CREDIT' },
    { text: 'Оплата', direction: 'DEBIT' },
  ],
};

export function parseHumoMessage(text: string): BankParseResult {
  return parseWithProfile(text, HUMO_PROFILE);
}
