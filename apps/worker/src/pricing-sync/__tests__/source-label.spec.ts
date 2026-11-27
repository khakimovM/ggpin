import { MANUAL_FX_SOURCE, SIMULATOR_SOURCE } from '@repo/shared';
import { storedSourceLabel } from '../source-label';

// The stored `source` label (phase 5 S9b, plan 31): a real price source may not be named like the
// owner's typed rate (`manual`), the simulator or a derived rate, in any spelling.

describe('storedSourceLabel', () => {
  it.each(['manual', ' Manual ', 'MANUAL', `\t${MANUAL_FX_SOURCE}\n`])(
    'a real source named %j is refused (it would pass for the owner’s own rate)',
    (name) => {
      expect(storedSourceLabel({ name, simulated: false })).toBeNull();
    },
  );

  it.each(['simulator', ' Simulator ', 'derived:fx-1*fx-2', '', '   '])(
    'a real source named %j is refused',
    (name) => {
      expect(storedSourceLabel({ name, simulated: false })).toBeNull();
    },
  );

  it('a simulated source is stored as the simulator, whatever its name (manual included)', () => {
    expect(storedSourceLabel({ name: 'manual', simulated: true })).toBe(SIMULATOR_SOURCE);
    expect(storedSourceLabel({ name: 'exchange-x', simulated: true })).toBe(SIMULATOR_SOURCE);
  });

  it('a real source with its own name keeps it as written', () => {
    expect(storedSourceLabel({ name: 'exchange-x', simulated: false })).toBe('exchange-x');
    expect(storedSourceLabel({ name: 'manual-feed', simulated: false })).toBe('manual-feed');
  });
});
