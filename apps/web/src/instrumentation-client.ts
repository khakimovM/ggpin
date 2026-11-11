import { config } from 'zod';

// Runs in the browser before the application code (Next 15.3+: after the HTML loads, before
// hydration). The CSP has no 'unsafe-eval', and Zod 4 probes `new Function` once, when its first
// object schema is created. The probe is caught, but the browser still reports it as a CSP
// violation. `jitless` makes Zod skip the probe and validate with its interpreted path; setting
// it here covers every page, including @repo/shared schemas that load with it.
config({ jitless: true });
