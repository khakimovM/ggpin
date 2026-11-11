import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest has no globals here, so Testing Library cannot register its own cleanup.
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-reduced');
  window.localStorage.clear();
  // Installed by tests through test/match-media.ts; jsdom itself does not provide it.
  Reflect.deleteProperty(window, 'matchMedia');
});
