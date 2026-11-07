import { callSdk, getWebApp } from './webapp';

// Haptic feedback through the Telegram client; a silent no-op outside Telegram and on clients
// older than Bot API 6.1.
export const haptics = {
  success: () => callSdk(() => getWebApp()?.HapticFeedback.notificationOccurred('success')),
  error: () => callSdk(() => getWebApp()?.HapticFeedback.notificationOccurred('error')),
  selection: () => callSdk(() => getWebApp()?.HapticFeedback.selectionChanged()),
};
