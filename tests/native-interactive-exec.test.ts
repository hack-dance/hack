import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseInteractiveReport } from "../src/backends/native-interactive-exec.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const session = "00000000-0000-4000-8000-000000000001";
test("interactive report is closed, value-free and preserves command status", () => {
  expect(
    parseInteractiveReport({
      version: 1,
      outcome: "completed",
      completion: { exit_code: 7, session, retained: true },
    })
  ).toEqual({ code: 7, session, retained: true });
  expect(
    parseInteractiveReport({
      version: 1,
      outcome: "refused",
      code: "session_cleanup_uncertain",
      session,
    })
  ).toEqual({
    code: 1,
    session,
    retained: true,
    failure: "session_cleanup_uncertain",
  });
  for (const value of [
    { version: 2 },
    { version: 1, outcome: "refused", code: "private\ncanary", session },
    {
      version: 1,
      outcome: "refused",
      code: "refused",
      session: "private-canary",
    },
    {
      version: 1,
      outcome: "refused",
      code: "refused",
      session,
      message: "private-canary",
    },
    {
      version: 1,
      outcome: "completed",
      completion: { exit_code: 256, session, retained: true },
    },
  ]) {
    expect(() => parseInteractiveReport(value)).toThrow(
      "no request was replayed"
    );
  }
});

test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
  "source and compiled frontend preserve fd3, reap the reader and restore the PTY",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "hack-interactive-frontend-"))
    );
    try {
      const python = Bun.which("python3");
      expect(python).not.toBeNull();
      if (!python) {
        throw new Error("PTY contract requires python3");
      }
      await writeFile(
        join(root, "runtime"),
        `#!${python}\n${await readFile(resolve("tests/fixtures/native-interactive-runtime.py"), "utf8")}`,
        { mode: 0o700 }
      );
      const source = resolve("tests/fixtures/native-interactive-frontend.ts");
      const compiled = join(root, "frontend");
      const env = privateCliEnv({ root });
      const commands = [
        [process.execPath, "build", "--compile", source, "--outfile", compiled],
        [
          python,
          resolve("tests/fixtures/native-interactive-frontend.py"),
          root,
          process.execPath,
          source,
        ],
        [
          python,
          resolve("tests/fixtures/native-interactive-frontend.py"),
          root,
          compiled,
        ],
      ];
      for (const cmd of commands) {
        const child = Bun.spawn(cmd, {
          env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          timeout: 90_000,
        });
        const [out, err, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(code, err + out).toBe(0);
        if (cmd[0] === python) {
          expect(out).toBe("Frontend PTY: four cases passed\n");
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  240_000
);
