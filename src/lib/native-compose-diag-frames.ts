/**
 * TEMPORARY hosted-CI diagnostic; remove before merge.
 * Prints only source frames (no messages, causes' messages or values) when enabled.
 */
const FRAME = /^\s+at (.*)$/;
export function nativeComposeDiagFrames(site: string, error: unknown): void {
  if (process.env.HACK_NATIVE_COMPOSE_DIAG_FRAMES !== "1") {
    return;
  }
  try {
    const lines: string[] = [];
    let current: unknown = error;
    let depth = 0;
    while (typeof current === "object" && current !== null && depth < 4) {
      const name = Object.getPrototypeOf(current)?.constructor?.name ?? "?";
      lines.push(`[diag ${site}] cause#${depth} ${String(name)}`);
      const stack = Reflect.get(current, "stack");
      for (const line of String(stack ?? "").split("\n")) {
        const match = FRAME.exec(line);
        if (match) {
          lines.push(`[diag ${site}]   at ${match[1]}`);
        }
      }
      current = Reflect.get(current, "cause");
      depth++;
    }
    process.stderr.write(`${lines.join("\n")}\n`);
  } catch {
    // Diagnostics never replace the original rejection.
  }
}
