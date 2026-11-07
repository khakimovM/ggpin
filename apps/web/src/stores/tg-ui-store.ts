import { DEFAULT_LOCALE, type Locale } from '@repo/shared';
import { create } from 'zustand';

// UI-only state of the Mini App: the language of the screens. The Mini App has no locale in its
// URL, so it is guessed from Telegram's language_code first and replaced by the profile's locale
// once the session exists. Nothing here is persisted.
interface TgUiState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

export const useTgUiStore = create<TgUiState>((set) => ({
  locale: DEFAULT_LOCALE,
  setLocale: (locale) => set({ locale }),
}));
