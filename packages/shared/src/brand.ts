// D-10 / D-13: the only place the brand is written in code. Bot username comes from env
// (TELEGRAM_BOT_USERNAME, NEXT_PUBLIC_BOT_USERNAME), never from here.
export const BRAND = {
  name: 'ggpin',
  domain: 'ggpin.uz',
} as const;

export type Brand = typeof BRAND;
