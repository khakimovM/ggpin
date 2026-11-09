import { HistoryScreen } from '../../../features/account/HistoryScreen';

// The Mini App history. The gate, providers and Telegram connection live in the layout (TgRoot).
export default function TelegramHistoryPage() {
  return <HistoryScreen variant="tg" />;
}
