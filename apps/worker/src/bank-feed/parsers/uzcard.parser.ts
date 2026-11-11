import { parseWithProfile, type BankProfile } from './message-engine';
import type { BankParseResult } from './parse-result';

/**
 * @CardXabarBot. Structure (plan §2.4): 🟢/🔴 + title; ➕/➖ amount "D DDD.DD UZS"; 💳 "***NNNN";
 * 📍 channel (may run over several lines); clock + "DD.MM.YY HH:MM"; 💵 balance. Titles only
 * refuse a message whose amount sign they contradict; an unknown title is not an error.
 */
export const UZCARD_PROFILE: BankProfile = {
  // "***NNNN" only; never the Humo "HUMOCARD *NNNN" / "*NNNN".
  cardPattern: /^\*{3}\d{4}$/,
  titles: [
    // Seen in the Russian UI (Latin transliteration).
    { text: 'Perevod na kartu', direction: 'CREDIT' },
    { text: 'Pokupka', direction: 'DEBIT' },
    { text: 'E-Com oplata', direction: 'DEBIT' },
    // Uzbek UI: ASSUMED wording, to be confirmed against a real message in phase 4, S11.
    { text: "Kartaga o'tkazma", direction: 'CREDIT' },
    { text: 'Xarid', direction: 'DEBIT' },
  ],
};

export function parseUzcardMessage(text: string): BankParseResult {
  return parseWithProfile(text, UZCARD_PROFILE);
}
