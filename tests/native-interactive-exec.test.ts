import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  interactiveRefusalMessage,
  parseInteractiveLeaseWaitEvent,
  parseInteractiveReport,
} from "../src/backends/native-interactive-exec.ts";
import { nativeFailureMessage } from "../src/backends/native-runtime-client.ts";
import { HACK_KEY_MATERIAL_VARIABLES } from "../src/lib/child-environment.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const session = "00000000-0000-4000-8000-000000000001";
test("an env change since up names the restart, not an uncertain outcome (HACK-2740)", () => {
  const report = parseInteractiveReport({
    version: 1,
    outcome: "refused",
    code: "graph_service_exec_environment_changed",
    session,
  });
  expect(report.failure).toBe("graph_service_exec_environment_changed");
  const line =
    "Native exec refused (graph_service_exec_environment_changed): the service has env values that this run did not start with, for example after hack env set. Run hack down, then hack up, to start with them. No command was started.";
  // The whole line: only the restart advice, the same as finite exec prints.
  expect(interactiveRefusalMessage(report.failure ?? "")).toBe(line);
  expect(
    nativeFailureMessage({
      code: "graph_service_exec_environment_changed",
      message:
        "The service has env values that this run did not start with, for example after hack env set. Run hack down, then hack up, to start with them. No command was started.",
    })
  ).toBe(line);
  // Other codes keep their meaning.
  expect(interactiveRefusalMessage("graph_service_exec_launcher")).toContain(
    "managed-environment launcher"
  );
  expect(interactiveRefusalMessage("session_cleanup_uncertain")).toContain(
    "could not confirm admission or completion"
  );
});
test("HACK-2742: an authored interactive exec refused before dispatch says nothing ran", () => {
  const lease = parseInteractiveReport({
    version: 1,
    outcome: "refused",
    code: "provider_busy",
    session: null,
    holder: "project-stop",
  });
  expect(lease).toEqual({
    code: 1,
    retained: false,
    failure: "provider_busy",
    holder: "project-stop",
  });
  expect(
    interactiveRefusalMessage("provider_busy", {
      native: true,
      holder: lease.holder,
      retained: lease.retained,
    }).split("\n")
  ).toEqual([
    "hack exec could not acquire the native runtime lock (provider_busy); nothing ran.",
    "Holder: project stop.",
    "Retry hack exec once that project stop finishes.",
  ]);
  expect(
    interactiveRefusalMessage("graph_authored_exec_lease_busy", {
      native: true,
    }).split("\n")
  ).toEqual([
    "hack exec could not acquire the native runtime lock (provider_busy); nothing ran.",
    "Holder: unavailable.",
    "Retry hack exec once the holder finishes.",
  ]);
  expect(
    interactiveRefusalMessage("graph_authored_command_not_started", {
      native: true,
    })
  ).toContain("(graph_authored_command_not_started); nothing ran.");
  // A Compose exec, or a refusal after its session existed, keeps the old line.
  for (const context of [{ native: false }, { native: true, retained: true }]) {
    expect(interactiveRefusalMessage("provider_busy", context)).toContain(
      "could not confirm admission or completion"
    );
  }
  // The holder field is closed: only with provider_busy, only a token.
  for (const bad of [
    { code: "graph_authored_exec_lease_busy", holder: "project-stop" },
    { code: "provider_busy", holder: "Project Stop" },
    { code: "provider_busy", holder: 7 },
  ]) {
    expect(() =>
      parseInteractiveReport({
        version: 1,
        outcome: "refused",
        session: null,
        ...bad,
      })
    ).toThrow();
  }
});
test("HACK-2742: only the closed lease-wait event line is an event", () => {
  expect(
    parseInteractiveLeaseWaitEvent(
      JSON.stringify({
        version: 1,
        event: "lease-wait",
        holder: "project-stop",
      })
    )
  ).toBe("project-stop");
  for (const line of [
    "",
    "not json",
    JSON.stringify({ version: 2, event: "lease-wait", holder: "start" }),
    JSON.stringify({ version: 1, event: "other", holder: "start" }),
    JSON.stringify({ version: 1, event: "lease-wait", holder: "x y" }),
    JSON.stringify({
      version: 1,
      event: "lease-wait",
      holder: "start",
      extra: 1,
    }),
    JSON.stringify({
      version: 1,
      outcome: "refused",
      code: "x",
      session: null,
    }),
  ]) {
    expect(parseInteractiveLeaseWaitEvent(line)).toBeUndefined();
  }
});
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
            "Frontend PTY: eleven lifetime and five selection cases passed\n"
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
