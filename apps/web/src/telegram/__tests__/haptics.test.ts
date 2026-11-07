import { afterEach, describe, expect, it } from 'vitest';
import { haptics } from '../haptics';
import { createFakeWebApp, installWebApp } from './fake-webapp';

afterEach(() => {
  delete window.Telegram;
});

describe('haptics', () => {
  it('maps the three feedbacks to the Telegram calls', () => {
    const app = createFakeWebApp();
    installWebApp(app);
    haptics.success();
    haptics.error();
    haptics.selection();
    expect(app.HapticFeedback.notificationOccurred).toHaveBeenNthCalledWith(1, 'success');
    expect(app.HapticFeedback.notificationOccurred).toHaveBeenNthCalledWith(2, 'error');
    expect(app.HapticFeedback.selectionChanged).toHaveBeenCalledOnce();
  });

  it('does nothing outside Telegram, and survives clients without haptics', () => {
    expect(() => haptics.success()).not.toThrow();
    const app = createFakeWebApp();
    app.HapticFeedback.notificationOccurred = () => {
      throw new Error('WebAppMethodUnsupported');
    };
    installWebApp(app);
    expect(() => haptics.success()).not.toThrow();
  });
});
