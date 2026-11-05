import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

export default createMiddleware(routing);

export const config = {
  // /tg (Mini App: locale comes from the user profile), /pay (locale from ?locale=) and /dev
  // (component gallery) have no locale prefix, so they bypass the locale middleware, as do API
  // routes and static files.
  matcher: ['/((?!api|_next|_vercel|tg(?:/|$)|pay(?:/|$)|dev(?:/|$)|.*\\..*).*)'],
};
