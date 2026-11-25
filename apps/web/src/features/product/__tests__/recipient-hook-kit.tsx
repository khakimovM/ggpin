import type { ValidateRecipientResponse } from '@repo/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi, type Mock } from 'vitest';
import { useValidateRecipient } from '../use-validate-recipient';

// Shared by the useValidateRecipient tests that hold requests open. The vi.mock of the API module
// must live in each test file, so each passes its own mock in.

export const answerFor = (name: string): ValidateRecipientResponse => ({
  recipientToken: name.padEnd(43, 'R').slice(0, 43),
  displayName: name,
  warnings: [],
});

export interface Pending {
  username: string;
  signal: AbortSignal;
  resolve: (value: ValidateRecipientResponse) => void;
  reject: (error: Error) => void;
}

/**
 * A fake API that holds every request open until the test answers it, counts how many are open at
 * once, and rejects a request whose signal aborts (as `fetch` does) with the signal's reason.
 */
export function heldApi(validateRecipient: Mock) {
  const pending: Pending[] = [];
  let open = 0;
  let maxOpen = 0;
  validateRecipient.mockImplementation(
    (body: { input: { username: string } }, signal: AbortSignal) =>
      new Promise<ValidateRecipientResponse>((resolve, reject) => {
        open += 1;
        maxOpen = Math.max(maxOpen, open);
        let done = false;
        const finish = () => {
          if (done) return false;
          done = true;
          open -= 1;
          return true;
        };
        signal.addEventListener('abort', () => {
          const reason: unknown = signal.reason;
          if (finish()) {
            reject(reason instanceof Error ? reason : new DOMException('aborted', 'AbortError'));
          }
        });
        pending.push({
          username: body.input.username,
          signal,
          resolve: (value) => {
            if (finish()) resolve(value);
          },
          reject: (error) => {
            if (finish()) reject(error);
          },
        });
      }),
  );
  return { pending, maxOpen: () => maxOpen };
}

export function setupHook(onProductChanged: () => void = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useValidateRecipient('p_stars', 'username', onProductChanged), {
    wrapper,
  });
}
