import { notFound } from 'next/navigation';

// E2E-only fixture: a page that throws while rendering, to see the full-page error boundary
// (app/[locale]/error.tsx). A 404 unless the build sets E2E_PROBES=1; no user-facing text.
export default async function E2eProbeErrorPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  // Reading the params keeps the page dynamic, so it fails per request and not at build time.
  await params;
  if (process.env.E2E_PROBES !== '1') notFound();
  throw new Error('e2e probe: render failure');
}
