import uz from '@repo/i18n/uz.json';
import { BRAND } from '@repo/shared';

// Phase-0 placeholder; the admin shell is built from the design handoff in phase 9.
// Admin UI is Uzbek only (D-05), but its strings still come from the i18n catalog.
export function App() {
  const title = `${BRAND.name} · ${uz.admin.shell.title}`;
  return (
    <main>
      <title>{title}</title>
      <h1>{title}</h1>
    </main>
  );
}
