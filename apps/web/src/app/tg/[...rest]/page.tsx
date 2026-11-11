import { notFound } from 'next/navigation';

// Same reason as app/[locale]/[...rest]: the 404 must be rendered per request (CSP nonce).
export default function UnmatchedTelegramPage(): never {
  notFound();
}
