import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const [signal, behavior, code] of [
  ["SIGTERM", "exit", 143],
  ["SIGINT", "exit", 130],
  ["SIGTERM", "ignore", 143],
] as const) {
  test.skipIf(!Bun.which("python3"))(
    `TTY wrapper-only ${signal} cleans descendants (${behavior}) without signalling a sibling`,
    async () => {
      const proc = Bun.spawn(
        [
          "python3",
          resolve(import.meta.dir, "fixtures/tty-cancellation.py"),
          "probe",
          process.execPath,
          resolve(import.meta.dir, "../index.ts"),
          signal,
          behavior,
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" }
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        exit: code,
        childAlive: false,
        grandchildAlive: false,
        siblingAlive: true,
      });
    },
    20_000
  );
}
