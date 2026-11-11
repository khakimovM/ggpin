import { describe, expect, it } from 'vitest';
import { applySafeArea, safeAreaVars } from '../safe-area';

describe('safeAreaVars', () => {
  it('is all zero on clients that report no insets (before Bot API 8.0)', () => {
    expect(safeAreaVars({})).toEqual({
      '--tg-safe-top': '0px',
      '--tg-safe-right': '0px',
      '--tg-safe-bottom': '0px',
      '--tg-safe-left': '0px',
    });
  });

  it('adds the device safe area and the content safe area side by side', () => {
    expect(
      safeAreaVars({
        safeAreaInset: { top: 47, bottom: 34, left: 0, right: 0 },
        contentSafeAreaInset: { top: 56, bottom: 0, left: 0, right: 0 },
      }),
    ).toMatchObject({ '--tg-safe-top': '103px', '--tg-safe-bottom': '34px' });
  });

  it('ignores negative and non-numeric values', () => {
    const vars = safeAreaVars({
      safeAreaInset: { top: -5, bottom: Number.NaN, left: 3, right: 0 },
    });
    expect(vars).toMatchObject({
      '--tg-safe-top': '0px',
      '--tg-safe-bottom': '0px',
      '--tg-safe-left': '3px',
    });
  });

  it('writes the variables on the element', () => {
    const element = document.createElement('div');
    applySafeArea(element, { safeAreaInset: { top: 10, bottom: 20, left: 1, right: 2 } });
    expect(element.style.getPropertyValue('--tg-safe-bottom')).toBe('20px');
    expect(element.style.getPropertyValue('--tg-safe-right')).toBe('2px');
  });
});
