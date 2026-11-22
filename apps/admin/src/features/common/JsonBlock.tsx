/**
 * A JSON or raw text block (request / response, audit state, bank message). Plain text nodes only:
 * whatever the content holds is never parsed as HTML.
 */
export function JsonBlock({ label, text }: { label: string; text: string }) {
  return (
    <pre
      aria-label={label}
      tabIndex={0}
      className="m-0 max-h-80 overflow-auto rounded-[10px] border border-border bg-surface p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-words text-foreground"
    >
      {text}
    </pre>
  );
}
