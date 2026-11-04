import { notFound } from 'next/navigation';

// E2E-only fixture: lets Playwright check that token-based utilities win over the element rules
// shipped in tokens.css (button/input/a). It is a 404 unless the build sets E2E_PROBES=1, and it
// holds no user-facing text, so it needs no i18n.
export default function E2eProbePage() {
  if (process.env.E2E_PROBES !== '1') notFound();

  return (
    <main className="p-6">
      <button
        data-testid="probe-button"
        className="bg-primary text-primary-foreground text-sm font-semibold rounded-lg shadow-md ring-2 ring-ring transition duration-fast ease-standard"
      />
      <a data-testid="probe-link" href="#probe" className="text-foreground-secondary" />
    </main>
  );
}
