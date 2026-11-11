import { TgNotFound } from '../../features/not-found/TgNotFound';

// The response status is 200, not 404, and that is accepted: the gate renders the splash on the
// server, so the missing screen is only found on the client (an app shell nobody indexes). Same
// note in e2e/not-found.spec.ts. This page renders inside the gate, so a visitor who is not
// signed in never sees it.
export default function TelegramNotFound() {
  return <TgNotFound />;
}
