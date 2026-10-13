import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { testIntegration } from "./helpers/ci.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

function stripTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/** Runs source `hack log-pipe` on `input` with a private HOME and env. */
async function runLogPipe(opts: {
  readonly stream: "stdout" | "stderr";
  readonly input: string;
}): Promise<{
  readonly exitCode: number;
  readonly stdoutText: string;
  readonly stderrText: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "hack-log-pipe-"));
  try {
    const proc = Bun.spawn(
      [
        "bun",
        "index.ts",
        "log-pipe",
        "--format",
        "docker-compose",
        "--stream",
        opts.stream,
      ],
      {
        cwd: process.cwd(),
        env: privateCliEnv({ root }),
        stdin: new Response(opts.input).body,
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [exitCode, stdoutText, stderrText] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, stdoutText, stderrText };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

testIntegration(
  "log-pipe formats docker-compose prefixed lines from stdin",
  { timeout: 15_000 },
  async () => {
    const input = `${[
      'api  | {"level":"warn","msg":"hello","foo":1}',
      "api  | plain text",
    ].join("\n")}\n`;

    const { exitCode, stdoutText, stderrText } = await runLogPipe({
      stream: "stdout",
      input,
    });

    expect(exitCode).toBe(0);
    expect(stderrText).toBe("");

    const lines = stripTrailingNewline(stdoutText).split("\n");
    expect(lines[0]).toBe("[WARN] [api] hello foo=1");
    expect(lines[1]).toBe("[api] plain text");
  }
);

testIntegration(
  "log-pipe --stream stderr forces ERROR level",
  { timeout: 15_000 },
  async () => {
    const input = 'api  | {"level":"info","msg":"boom"}\n';
    const { exitCode, stdoutText, stderrText } = await runLogPipe({
      stream: "stderr",
      input,
    });

    expect(exitCode).toBe(0);
    expect(stdoutText).toBe("");
    expect(stripTrailingNewline(stderrText)).toBe("[ERROR] [api] boom");
  }
);
