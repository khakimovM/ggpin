'use client';

import { createContext, useContext, type ReactNode } from 'react';

export type ToastTone = 'success' | 'error' | 'warning' | 'info';

export interface ToastOptions {
  tone?: ToastTone;
  title: string;
  description?: ReactNode;
  /** Milliseconds before it closes itself; default 4000, 8000 for errors. */
  duration?: number;
}

export interface ToastApi {
  /** Shows a toast and returns its id. */
  show: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
}

export const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside <ToastProvider>');
  return api;
}
