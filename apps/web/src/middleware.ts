import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

export default createMiddleware(routing);

export const config = {
  // /tg (Mini App: locale comes from the user profile) and /pay (locale from ?locale=) have no
  // locale prefix, so they bypass the locale middleware, as do API routes and static files.
  matcher: ['/((?!api|_next|_vercel|tg(?:/|$)|pay(?:/|$)|.*\\..*).*)'],
};
