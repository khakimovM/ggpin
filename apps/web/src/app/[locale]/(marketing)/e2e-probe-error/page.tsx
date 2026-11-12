import { notFound } from 'next/navigation';

// E2E-only fixture: a marketing page that throws while rendering, to see the error boundary that
// keeps the site header and footer (app/[locale]/(marketing)/error.tsx). A 404 unless the build
// sets E2E_PROBES=1; no user-facing text. It is not in the site registry, so not in the sitemap.
export default async function E2eMarketingProbeErrorPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  await params;
  if (process.env.E2E_PROBES !== '1') notFound();
  throw new Error('e2e probe: render failure');
}
