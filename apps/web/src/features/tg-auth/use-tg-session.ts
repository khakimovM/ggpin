'use client';

import type { Me } from '@repo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { activateTgAuth } from '../../lib/api/client';
import { isApiError } from '../../lib/api/errors';
import { qk } from '../../lib/query-keys';
import { useTgUiStore } from '../../stores/tg-ui-store';
import { useTelegram } from '../../telegram/telegram-context';
import { readInitData } from '../../telegram/webapp';
import { gateForError, SESSION_GATE_CODES, type GateInfo } from './gate-for-error';

export type TgSessionState =
  { status: 'booting' } | { status: 'ready'; user: Me } | { status: 'gate'; gate: GateInfo };

export interface TgSession {
  state: TgSessionState;
  /** Signs in again with the same launch data (the offline and error gates). */
  retry: () => void;
}

type LoginState =
  { status: 'pending' } | { status: 'ok'; user: Me } | { status: 'error'; error: unknown };

/**
 * Signs the Mini App in: `POST /auth/telegram/webapp` with the Telegram initData, once, when the
 * page opens. The bearer token stays inside the auth module's memory (auth-tg.ts); this hook only
 * sees the user, which it puts into the `/me` query so screens find it cached, and whose locale it
 * adopts. The initData is read at the moment of the request and goes nowhere else.
 *
 * The sign-in is not a TanStack mutation on purpose: activating the Mini App channel clears the
 * mutation cache (it may hold the previous channel's results), which would cut a mutation that
 * has just started.
 *
 * It also watches the query cache: if a later request ends the session for good (the account got
 * blocked, the launch data expired and a silent re-login was refused), the gate comes back
 * instead of every screen showing its own error.
 */
export function useTgSession(): TgSession {
  const { phase } = useTelegram();
  const client = useQueryClient();
  const setLocale = useTgUiStore((state) => state.setLocale);
  const [login, setLogin] = useState<LoginState>({ status: 'pending' });
  const [lost, setLost] = useState<GateInfo | null>(null);
  // Only the newest attempt may write its result (a slow first answer after a retry is dropped).
  const attempt = useRef(0);

  const signIn = useCallback(async () => {
    const mine = ++attempt.current;
    try {
      const { user } = await activateTgAuth(readInitData).login();
      if (mine !== attempt.current) return;
      client.setQueryData(qk.me(), user);
      setLocale(user.locale);
      setLost(null);
      setLogin({ status: 'ok', user });
    } catch (error) {
      if (mine === attempt.current) setLogin({ status: 'error', error });
    }
  }, [client, setLocale]);

  const started = useRef(false);
  useEffect(() => {
    if (phase !== 'telegram' || started.current) return;
    started.current = true;
    void signIn();
  }, [phase, signIn]);

  // A request that ends the session for good closes the app, whether it was a query or a mutation
  // (a purchase that comes back USER_BLOCKED is as final as a catalog load that does).
  useEffect(() => {
    const onError = (error: unknown) => {
      if (isApiError(error) && SESSION_GATE_CODES.has(error.code)) setLost(gateForError(error));
    };
    const stopQueries = client.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error') onError(event.action.error);
    });
    const stopMutations = client.getMutationCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error') onError(event.action.error);
    });
    return () => {
      stopQueries();
      stopMutations();
    };
  }, [client]);

  const retry = useCallback(() => {
    setLost(null);
    setLogin({ status: 'pending' });
    void signIn();
  }, [signIn]);

  // Coming back online is as good as pressing "retry" on the offline gate.
  const offlineGate = login.status === 'error' && gateForError(login.error).kind === 'offline';
  useEffect(() => {
    if (!offlineGate) return;
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [offlineGate, retry]);

  let state: TgSessionState = { status: 'booting' };
  if (phase === 'browser') state = { status: 'gate', gate: { kind: 'bot' } };
  else if (lost) state = { status: 'gate', gate: lost };
  else if (login.status === 'error') state = { status: 'gate', gate: gateForError(login.error) };
  else if (login.status === 'ok') state = { status: 'ready', user: login.user };

  return { state, retry };
}
