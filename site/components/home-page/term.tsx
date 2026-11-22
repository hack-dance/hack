import type { ReactNode } from "react";

/**
 * A terminal or config panel body.
 *
 * The text is written as it should appear, with a short tone around the parts
 * that are coloured: `<f>$</f> hack up` sets the prompt in the faint tone. A
 * tone name is the CSS class it gets (`f`, `d`, `g`, `a`, `k`, `s`, `p`,
 * `c0`–`c3`). Tones do not nest, and panel text never contains `<`.
 */
const tone = /<([a-z][a-z0-9]*)>([^<]*)<\/\1>/g;

export function Term({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  const parts: ReactNode[] = [];
  let end = 0;
  for (const match of children.matchAll(tone)) {
    if (match.index > end) {
      parts.push(children.slice(end, match.index));
    }
    parts.push(
      <span className={match[1]} key={match.index}>
        {match[2]}
      </span>
    );
    end = match.index + match[0].length;
  }
  if (end < children.length) {
    parts.push(children.slice(end));
  }
  return <pre className={className}>{parts}</pre>;
}
