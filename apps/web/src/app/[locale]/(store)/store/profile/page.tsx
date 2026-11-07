import { hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { ProfileView } from '../../../../../features/account/ProfileView';
import { routing } from '../../../../../i18n/routing';

// The profile screen proper (language, motion, referral) arrives with phase 7 S9; the sessions
// list and the sign-out button live here already.
export default async function ProfilePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  return <ProfileView />;
}
