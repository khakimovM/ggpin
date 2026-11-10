import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from '../Button';
import { Chip } from '../Chip';
import { SegmentedControl } from '../SegmentedControl';
import { Switch } from '../Switch';

// The drawn size of a control stays the design's; an invisible `before:` pseudo-element grows the
// pressable area (HIT_AREA_* in lib/styles.ts). jsdom has no layout and no pseudo-element boxes,
// so what is checked here is the wiring on the real components: the area is there, and the control
// is `relative`, which the pseudo-element is placed against. The pixel proof (size, clipping by an
// overflow, overlap, covering) is the Playwright spec e2e/qa/a11y-targets.spec.ts.
function expectHitArea(element: HTMLElement) {
  expect(element.className).toMatch(/(^|\s)relative(\s|$)/);
  expect(element.className).toContain('before:h-11');
  expect(element.className).toContain("before:content-['']");
}

describe('hit areas on the components', () => {
  it('a filter chip keeps its 36 px size and carries the area', () => {
    render(<Chip>Hammasi</Chip>);
    const chip = screen.getByRole('button', { name: 'Hammasi' });
    expect(chip.className).toContain('min-h-9');
    expectHitArea(chip);
  });

  it('a small button keeps its 36 px size and carries the area; a medium one is 44 already', () => {
    render(
      <>
        <Button size="sm">Kichik</Button>
        <Button size="md">O‘rta</Button>
      </>,
    );
    const small = screen.getByRole('button', { name: 'Kichik' });
    expect(small.className).toContain('min-h-9');
    expectHitArea(small);
    expect(screen.getByRole('button', { name: 'O‘rta' }).className).toContain('min-h-11');
  });

  it('a switch carries the area', () => {
    render(<Switch checked={false} onCheckedChange={() => undefined} label="Animatsiyalar" />);
    expectHitArea(screen.getByRole('switch', { name: 'Animatsiyalar' }));
  });

  it('both sizes of the segmented control carry the area on every segment', () => {
    for (const size of ['md', 'sm'] as const) {
      const { unmount } = render(
        <SegmentedControl
          size={size}
          ariaLabel="Til"
          value="uz"
          options={[
            { value: 'uz', label: 'UZ' },
            { value: 'ru', label: 'RU' },
          ]}
          onValueChange={() => undefined}
        />,
      );
      const segments = screen.getAllByRole('radio');
      expect(segments).toHaveLength(2);
      for (const segment of segments) expectHitArea(segment);
      unmount();
    }
  });
});
