/** One non-empty line per step; a text with a single line is one paragraph. */
export function helpSteps(help: string): string[] {
  return help
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * The catalog's `help` text as numbered steps (or one paragraph). It is data from the server, so it
 * reaches the page only as text nodes, never as HTML.
 */
export function HelpSteps({ help }: { help: string }) {
  const steps = helpSteps(help);
  if (steps.length <= 1) {
    return <p className="m-0 text-sm leading-5 font-semibold text-pretty">{steps[0] ?? ''}</p>;
  }
  return (
    <ol className="m-0 flex list-none flex-col gap-3 p-0">
      {steps.map((step, index) => (
        <li
          key={`${index}-${step}`}
          className="grid grid-cols-[28px_minmax(0,1fr)] items-start gap-3"
        >
          <span
            aria-hidden="true"
            className="grid size-7 place-items-center rounded-full bg-primary text-xs font-extrabold text-primary-foreground"
          >
            {index + 1}
          </span>
          <span className="text-sm leading-5 font-semibold text-pretty">{step}</span>
        </li>
      ))}
    </ol>
  );
}
