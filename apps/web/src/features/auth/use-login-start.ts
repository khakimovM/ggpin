'use client';

import type { LoginStartResponse } from '@repo/shared';
import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import { startLogin } from '../../lib/api/auth';

/** `POST /auth/telegram/start`. The result (nonce) is not kept in the mutation cache (`gcTime: 0`). */
export function useLoginStart(): UseMutationResult<LoginStartResponse, Error, void> {
  return useMutation({ mutationFn: () => startLogin(), gcTime: 0 });
}
