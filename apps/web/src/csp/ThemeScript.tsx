import { requestNonce } from './request-nonce';
import { TG_THEME_SCRIPT, WEB_THEME_SCRIPT } from './theme-script-source';

/** Inline script with the request's nonce. Server component: render it inside <head>. */
export async function ThemeScript({ variant }: { variant: 'web' | 'tg' }) {
  const nonce = await requestNonce();
  return (
    <script
      nonce={nonce}
      // A constant string, no user data: the only reason for dangerouslySetInnerHTML is that
      // React would otherwise escape the quotes.
      dangerouslySetInnerHTML={{ __html: variant === 'tg' ? TG_THEME_SCRIPT : WEB_THEME_SCRIPT }}
    />
  );
}
