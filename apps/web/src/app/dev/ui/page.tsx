import { notFound } from 'next/navigation';
import { isGalleryEnabled } from '../../../lib/dev-gallery';
import { UiGallery } from './_gallery/UiGallery';

// Decided per request, not at build time: a static page would bake the build environment in, and
// the production 404 branch must run in the running server.
export const dynamic = 'force-dynamic';

// Component gallery for development and for the Playwright screenshot/axe tests. It is a 404 in
// production; only the e2e web server (E2E_PROBES=1, same switch as the token probe page) shows it.
export default function UiGalleryPage() {
  if (!isGalleryEnabled({ NODE_ENV: process.env.NODE_ENV, E2E_PROBES: process.env.E2E_PROBES })) {
    notFound();
  }
  return <UiGallery />;
}
