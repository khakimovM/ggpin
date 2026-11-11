import { defineConfig } from '@playwright/test';
import base, { QA_HEAVY } from './playwright.config';

// The heavy half of the phase 7 S11 QA (see e2e/qa/README.md): the screenshot + axe matrix
// (every screen x width x theme x language) and the focus and motion sweeps. It reuses the main
// configuration (same server, same width projects) and only swaps what is run:
//   npx playwright test -c playwright.qa.config.ts --workers=2
const WIDTH_PROJECTS = new Set(['w375', 'w768', 'w1440']);

export default defineConfig({
  ...base,
  projects: (base.projects ?? [])
    .filter((project) => WIDTH_PROJECTS.has(project.name ?? ''))
    .map((project) => ({ ...project, testMatch: QA_HEAVY, testIgnore: [] })),
});
