import uz from '@repo/i18n/uz.json';
import { BRAND } from '@repo/shared';

// Phase-0 placeholder; the landing is built from the design handoff in phase 8.
export default function HomePage() {
  return (
    <main>
      <h1>{BRAND.name}</h1>
      <p>{uz.common.comingSoon}</p>
    </main>
  );
}
