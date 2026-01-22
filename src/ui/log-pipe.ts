import { readLinesFromStream } from "./lines.ts";
import type { LogInputFormat, OutputStream } from "./log-format.ts";
import { formatPrettyLogLine } from "./log-format.ts";

export async function runPrettyLogPipe(opts: {
  readonly format: LogInputFormat;
  readonly stream: OutputStream;
}): Promise<number> {
  if (process.stdin.isTTY) {
    process.stderr.write("No stdin detected. Pipe logs into this command.\n");
    return 1;
  }

  const input = Bun.stdin.stream();
  for await (const line of readLinesFromStream(input)) {
    const formatted = formatPrettyLogLine({
      line,
      stream: opts.stream,
      format: opts.format,
    });
    const out = opts.stream === "stderr" ? process.stderr : process.stdout;
    out.write(`${formatted}\n`);
  }

  return 0;
}
