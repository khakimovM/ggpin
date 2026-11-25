import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ANALYTICS_BEFORE_SEND } from '../analytics-before-send';
import { ANALYTICS_FILTER } from '../analytics-filter';
import { SiteAnalytics } from '../SiteAnalytics';

const mocks = vi.hoisted(() => ({
  env: { NEXT_PUBLIC_ANALYTICS_SITE_ID: '' },
  nonce: vi.fn<() => Promise<string | undefined>>(),
  scriptProps: vi.fn<(props: Record<string, unknown>) => void>(),
  install: vi.fn<(target: object) => boolean>(),
}));

vi.mock('../../../../env', () => ({ env: mocks.env }));
vi.mock('../../../../csp/request-nonce', () => ({ requestNonce: mocks.nonce }));
// next/script loads the file in an effect; here only the props it is given matter.
vi.mock('next/script', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.scriptProps(props);
    return null;
  },
}));
// The real installer by default (each test says otherwise when it needs to); its own rules are
// tested in analytics-filter.test.ts against fresh objects, not this file's shared window.
vi.mock('../analytics-filter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../analytics-filter')>();
  return { ...actual, installAnalyticsFilter: mocks.install };
});

const SITE_ID = '94db1cb1-74f4-4a40-ad6c-962362670409';

beforeEach(async () => {
  const actual = await vi.importActual<typeof import('../analytics-filter')>('../analytics-filter');
  mocks.env.NEXT_PUBLIC_ANALYTICS_SITE_ID = '';
  mocks.nonce.mockReset().mockResolvedValue('bm9uY2Utbm9uY2Utbm9uY2U=');
  mocks.scriptProps.mockReset();
  mocks.install.mockReset().mockImplementation(actual.installAnalyticsFilter);
});

async function renderAnalytics() {
  const element = await SiteAnalytics();
  if (element === null) throw new Error('expected the analytics tag');
  return render(element);
}

describe('SiteAnalytics', () => {
  it('renders nothing and reads no nonce when the website id is empty (analytics off)', async () => {
    const element = await SiteAnalytics();
    expect(element).toBeNull();
    expect(mocks.nonce).not.toHaveBeenCalled();
  });

  it('renders the Umami tag with a literal same-origin src, the nonce and the privacy flags', async () => {
    mocks.env.NEXT_PUBLIC_ANALYTICS_SITE_ID = SITE_ID;
    await renderAnalytics();

    expect(mocks.scriptProps).toHaveBeenCalledTimes(1);
    expect(mocks.scriptProps).toHaveBeenCalledWith({
      src: '/stats/script.js',
      strategy: 'afterInteractive',
      nonce: 'bm9uY2Utbm9uY2Utbm9uY2U=',
      'data-website-id': SITE_ID,
      'data-exclude-search': 'true',
      'data-exclude-hash': 'true',
      'data-do-not-track': 'true',
      'data-before-send': ANALYTICS_BEFORE_SEND,
    });
  });

  it('renders the tag only after our filter is the window property the tag names', async () => {
    mocks.env.NEXT_PUBLIC_ANALYTICS_SITE_ID = SITE_ID;
    mocks.scriptProps.mockImplementation(() => {
      // At the moment the tag is drawn, the tracker would already find our filter.
      expect(Object.prototype.hasOwnProperty.call(window, ANALYTICS_BEFORE_SEND)).toBe(true);
      expect(Reflect.get(window, ANALYTICS_BEFORE_SEND)).toBe(ANALYTICS_FILTER);
    });
    await renderAnalytics();
    expect(mocks.install).toHaveBeenCalledWith(window);
    expect(mocks.scriptProps).toHaveBeenCalledTimes(1);
  });

  it('fails closed: no tag at all when the filter cannot be installed', async () => {
    mocks.env.NEXT_PUBLIC_ANALYTICS_SITE_ID = SITE_ID;
    mocks.install.mockReturnValue(false);
    await renderAnalytics();
    expect(mocks.install).toHaveBeenCalled();
    expect(mocks.scriptProps).not.toHaveBeenCalled();
  });

  it('a second marketing page in the same window keeps the filter and draws the tag again', async () => {
    mocks.env.NEXT_PUBLIC_ANALYTICS_SITE_ID = SITE_ID;
    const first = await renderAnalytics();
    first.unmount();
    await renderAnalytics();
    const answers = mocks.install.mock.results.map(
      (result) => result.type === 'return' && result.value,
    );
    expect(answers.length).toBeGreaterThanOrEqual(2);
    expect(answers.every((answer) => answer === true)).toBe(true);
    expect(mocks.scriptProps).toHaveBeenCalledTimes(2);
    expect(Reflect.get(window, ANALYTICS_BEFORE_SEND)).toBe(ANALYTICS_FILTER);
  });
});
