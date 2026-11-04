import ru from '@repo/i18n/ru.json';
import uz from '@repo/i18n/uz.json';

// Static imports (not a computed import()) so the bundler sees both catalogs.
// Key parity between the two is asserted in packages/i18n/test.
export const MESSAGES = { uz, ru } as const;

export type Messages = typeof uz;
