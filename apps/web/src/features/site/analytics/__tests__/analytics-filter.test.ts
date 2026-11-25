import { describe, expect, it } from 'vitest';
import { ANALYTICS_BEFORE_SEND } from '../analytics-before-send';
import { ANALYTICS_FILTER, installAnalyticsFilter } from '../analytics-filter';

// Every test installs into a fresh object, not the shared jsdom window: the filter property is
// not configurable, so a window that had it once keeps it for the rest of the file.

describe('installAnalyticsFilter', () => {
  it('installs our filter as a fixed own property and allows the tracker', () => {
    const target = {};
    expect(installAnalyticsFilter(target)).toBe(true);
    const descriptor = Object.getOwnPropertyDescriptor(target, ANALYTICS_BEFORE_SEND);
    expect(descriptor).toMatchObject({
      value: ANALYTICS_FILTER,
      writable: false,
      configurable: false,
    });
    // Nothing can swap it for a filter that lets more through.
    expect(Reflect.set(target, ANALYTICS_BEFORE_SEND, () => ({}))).toBe(false);
    expect(Reflect.defineProperty(target, ANALYTICS_BEFORE_SEND, { value: () => ({}) })).toBe(
      false,
    );
    expect(Reflect.get(target, ANALYTICS_BEFORE_SEND)).toBe(ANALYTICS_FILTER);
  });

  it('allows the tracker again when our own filter is already there (a second page, a dev re-run)', () => {
    const target = {};
    expect(installAnalyticsFilter(target)).toBe(true);
    expect(installAnalyticsFilter(target)).toBe(true);
  });

  it('fails closed when the name is taken through the prototype (DOM clobbering by id or name)', () => {
    // A window's named properties (an <img id>, a <form name>) sit on its prototype chain.
    class NamedProperties {}
    Object.defineProperty(NamedProperties.prototype, ANALYTICS_BEFORE_SEND, {
      value: { tagName: 'IMG' },
    });
    const target = new NamedProperties();
    expect(installAnalyticsFilter(target)).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(target, ANALYTICS_BEFORE_SEND)).toBe(false);
  });

  it.each([
    ['a value that is not a function', 1],
    ['an element', { tagName: 'FORM' }],
    ['another function', () => ({ url: 'https://evil.example/' })],
  ])('fails closed when an own property holds %s', (_what, value) => {
    expect(installAnalyticsFilter({ [ANALYTICS_BEFORE_SEND]: value })).toBe(false);
  });

  it('fails closed when the window cannot take the property', () => {
    expect(installAnalyticsFilter(Object.freeze({}))).toBe(false);
  });
});
