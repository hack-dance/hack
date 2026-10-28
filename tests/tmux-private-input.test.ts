import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExecOptions } from "../src/lib/shell.ts";
import { findExecutableInPath } from "../src/lib/shell.ts";
import { registerScopedModuleMock } from "./helpers/scoped-module-mock.ts";

const tmux = findExecutableInPath("tmux");
const root = await mkdtemp(join(tmpdir(), "tmux-private-test-"));
const socket = join(root, "socket");
const calls: (readonly string[])[] = [];
async function privateExec(
  command: readonly string[],
  options: ExecOptions = {}
) {
  const child = Bun.spawn([...command], {
    stdin: options.stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 5000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}
const shellMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/shell.ts",
  overrides: {
    exec: (command: readonly string[], options: ExecOptions) => {
      calls.push([...command]);
      return privateExec(
        [tmux ?? "tmux", "-S", socket, "-f", "/dev/null", ...command.slice(1)],
        { ...options, timeoutMs: 5000 }
      );
    },
  },
});

beforeAll(() => shellMock.activate());
afterAll(async () => {
  shellMock.deactivate();
  if (tmux) {
    await privateExec([tmux, "-S", socket, "kill-server"], { stdin: "ignore" });
  }
  await rm(root, { recursive: true, force: true });
});

test.skipIf(!tmux)(
  "private tmux input works with fresh and existing servers",
  async () => {
    const { createTmuxBackend } = await import(
      `../src/mux/tmux-backend.ts?private=${Date.now()}`
    );
    const backend = createTmuxBackend();
    const value = "fake-'\"$variable\\value\nline\tend; #{}";
    for (const name of ["first", "second"]) {
      const token = `fake-owner-${name}`;
      const created = await backend.createSession({
        name,
        cwd: root,
        env: { FAKE_TEST_VALUE: value, SHELL: "/bin/sh" },
        lifecycleOwnerToken: token,
      });
      expect(created.ok).toBe(true);
      expect(await backend.readLifecycleOwnerToken?.({ name })).toBe(token);
      const environment = await privateExec(
        [
          tmux ?? "tmux",
          "-S",
          socket,
          "show-environment",
          "-t",
          name,
          "FAKE_TEST_VALUE",
        ],
        { stdin: "ignore" }
      );
      expect(environment.exitCode).toBe(0);
      expect(environment.stdout).toBe(`FAKE_TEST_VALUE=${value}\n`);
      expect(
        calls.every(
          (args) =>
            !args.some((arg) => arg.includes(token) || arg.includes(value))
        )
      ).toBe(true);
    }
    const duplicate = await backend.createSession({
      name: "first",
      lifecycleOwnerToken: "fake-replacement",
    });
    expect(duplicate.ok).toBe(false);
    expect(await backend.readLifecycleOwnerToken?.({ name: "first" })).toBe(
      "fake-owner-first"
    );
  },
  20_000
);
