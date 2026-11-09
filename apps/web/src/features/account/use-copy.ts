'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const FLASH_MS = 1600;

/**
 * Copies text and reports "copied" for a moment (the button changes its label, as in the design;
 * there is no toast). A refused clipboard (an old webview, no permission) just does not flash.
 */
export function useCopy(): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback((text: string) => {
    if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return;
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), FLASH_MS);
      },
      () => undefined,
    );
  }, []);
  return { copied, copy };
}
