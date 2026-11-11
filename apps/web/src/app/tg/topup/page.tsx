import { Suspense } from 'react';
import { TopupScreen } from '../../../features/topup/TopupScreen';

// The Mini App's top-up. The bot's "Hisobni to'ldirish" button opens `<MINI_APP_URL>/topup`
// (docs/07-BOT.md), i.e. this path: it must not move. The gate and providers live in the layout.
// `useSearchParams` (the `from` return path) needs a Suspense boundary.
export default function TelegramTopupPage() {
  return (
    <Suspense fallback={null}>
      <TopupScreen />
    </Suspense>
  );
}
