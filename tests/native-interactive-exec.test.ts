import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseInteractiveReport } from "../src/backends/native-interactive-exec.ts";
import { HACK_KEY_MATERIAL_VARIABLES } from "../src/lib/child-environment.ts";
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
  "source and compiled frontend contain keys, preserve fd3, reap the reader and restore the PTY",
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
      const protectedKeys = JSON.stringify([...HACK_KEY_MATERIAL_VARIABLES]);
      const runtimeSource = await readFile(
        resolve("tests/fixtures/native-interactive-runtime.py"),
        "utf8"
      );
      await writeFile(
        join(root, "runtime"),
        `#!${python}\n${runtimeSource.replace('["__PROTECTED_KEYS__"]', protectedKeys)}`,
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
          protectedKeys,
          process.execPath,
          source,
        ],
        [
          python,
          resolve("tests/fixtures/native-interactive-frontend.py"),
          root,
          protectedKeys,
          compiled,
        ],
      ];
      for (const cmd of commands) {
        const child = Bun.spawn(cmd, {
          env: {
            ...env,
            ...Object.fromEntries(
              [...HACK_KEY_MATERIAL_VARIABLES].map((name) => [
                name,
                "synthetic-parent-key-canary",
              ])
            ),
          },
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
          expect(out).toBe(
            "Frontend PTY: nine lifetime and five selection cases passed\n"
          );
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  240_000
);

test("finite exec tests explicitly opt out of the developer terminal", async () => {
  for (const path of [
    "tests/native-project-exec.test.ts",
    "tests/native-authored-project-exec.test.ts",
  ]) {
    const source = await readFile(path, "utf8");
    expect(source).toContain('process.env.HACK_NO_INTERACTIVE = "1"');
    expect(source).toContain(
      'restoreEnv("HACK_NO_INTERACTIVE", interactiveEnvironment)'
    );
  }
});
