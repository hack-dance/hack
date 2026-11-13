import { resolve } from "node:path";

/** Exercise explicit interactive CLI output on a real private PTY, with caller-owned fixture env. */
export async function runPrivateTtyCli(opts: {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
}) {
  let output = "";
  const terminal = new Bun.Terminal({
    cols: 120,
    rows: 40,
    data(_terminal, bytes) {
      output += new TextDecoder().decode(bytes);
    },
  });
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "../../index.ts"),
        ...opts.args,
      ],
      { cwd: opts.cwd, env: opts.env, terminal, timeout: 10_000 }
    );
    const exitCode = await child.exited;
    return {
      exitCode,
      stdout: exitCode === 0 ? output : "",
      stderr: exitCode === 0 ? "" : output,
    };
  } finally {
    terminal.close();
  }
}
