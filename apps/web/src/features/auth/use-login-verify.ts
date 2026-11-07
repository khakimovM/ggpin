'use client';

import type { LoginVerifyBody, SessionUserResponse } from '@repo/shared';
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { verifyLogin } from '../../lib/api/auth';
import { qk } from '../../lib/query-keys';

/**
 * `POST /auth/telegram/verify`. The code is one-time and goes nowhere but the request body: not
 * into a URL, a log line, or (`gcTime: 0`) the mutation cache that outlives this screen.
 */
export function useLoginVerify(): UseMutationResult<SessionUserResponse, Error, LoginVerifyBody> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginVerifyBody) => verifyLogin(body),
    gcTime: 0,
    // verifyLogin has already dropped the previous user's cache; this is the new user's.
    onSuccess: ({ user }) => queryClient.setQueryData(qk.me(), user),
  });
}
