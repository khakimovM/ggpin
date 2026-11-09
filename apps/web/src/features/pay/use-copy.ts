'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const SHOWN_MS = 1800;

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies a value and says WHAT was copied for a moment ("Summa nusxalandi"). The clipboard can be
 * refused (an insecure context, a permission); then nothing is claimed.
 */
export function useCopy<K extends string>() {
  const [copied, setCopied] = useState<K | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback(async (kind: K, text: string) => {
    if (!(await writeClipboard(text))) return;
    setCopied(kind);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), SHOWN_MS);
  }, []);
  return { copied, copy };
}
