import type { AdminConfirmationBody, AdminOtpAnswer } from '@repo/shared';
import { adminConfirmationCanonical } from '@repo/shared';
import { useState } from 'react';
import { confirmProblemOf, type ConfirmCodeProblem } from './ConfirmCodeStep';

/**
 * The state a <ConfirmCodeStep> needs in an action dialog: the typed answer and the last refusal
 * that concerns it. `binding` is the canonical confirmation body (docs/04 «Binding»): use it as
 * the step's React key, so changing any bound field (amount, a flag, a new key after "start as a
 * new action") drops the old challenge at once instead of failing later with CODE_INVALID.
 */
export function useCodeStep(confirmation: AdminConfirmationBody | null) {
  const [otp, setOtp] = useState<AdminOtpAnswer | null>(null);
  const [problem, setProblem] = useState<ConfirmCodeProblem | null>(null);
  const binding = confirmation === null ? 'none' : adminConfirmationCanonical(confirmation);
  const [boundTo, setBoundTo] = useState(binding);
  if (boundTo !== binding) {
    // Render-time reset (React's "adjust state on prop change"): the answer was for another body.
    setBoundTo(binding);
    setOtp(null);
    setProblem(null);
  }
  return {
    otp,
    setOtp,
    problem,
    binding,
    clearProblem: () => setProblem(null),
    /**
     * After a refused submit: keep only what concerns the code (wrong, locked, expired...). A
     * deadline 503 may have spent the code (docs/04): the answer is dropped, a new code is asked.
     */
    refused: (error: unknown) => {
      const next = confirmProblemOf(error);
      if (next?.kind === 'deadline') setOtp(null);
      setProblem(next);
    },
    reset: () => {
      setOtp(null);
      setProblem(null);
    },
  };
}
