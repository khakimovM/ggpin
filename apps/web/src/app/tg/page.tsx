import { TgHome } from '../../features/tg-home/TgHome';

// The Mini App entry. The gate, providers and Telegram connection live in the layout (TgRoot);
// this page renders only once a session exists.
export default function TelegramHomePage() {
  return <TgHome />;
}
