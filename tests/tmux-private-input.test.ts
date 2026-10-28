import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

    const readonlyValues = {
      UID: "fake-uid",
      EUID: "fake-euid",
      FAKE_TEST_VALUE: value,
    };
    const outputPath = join(root, "injected-values");
    // Bash's readonly UID/EUID must not intercept the command's selected environment.
    const bashSession = await privateExec([
      tmux ?? "tmux",
      "-S",
      socket,
      "new-session",
      "-d",
      "-s",
      "readonly",
      "/bin/bash --noprofile --norc",
    ]);
    expect(bashSession.exitCode).toBe(0);
    const report = [
      "const values = [process.env.UID, process.env.EUID, process.env.FAKE_TEST_VALUE];",
      'const parent = Bun.spawnSync(["ps", "-o", "command=", "-p", String(process.ppid)]);',
      "const parentArgv = parent.stdout.toString();",
      "console.log(JSON.stringify({ values, inspected: parent.exitCode === 0 && parentArgv.length > 0,",
      "leaked: values.some(value => parentArgv.includes(value) || process.argv.some(arg => arg.includes(value))),",
      "tty: process.stdin.isTTY === true }));",
    ].join(" ");
    const sent = await backend.execInSession({
      name: "readonly",
      command: `'${process.execPath}' --eval '${report}' | /bin/cat > '${outputPath}'`,
      env: readonlyValues,
    });
    expect(sent.exitCode).toBe(0);
    const expected = `${JSON.stringify({
      values: [readonlyValues.UID, readonlyValues.EUID, value],
      inspected: true,
      leaked: false,
      tty: true,
    })}\n`;
    const deadline = Date.now() + 5000;
    let output = "";
    while (Date.now() < deadline && output !== expected) {
      output = await readFile(outputPath, "utf8").catch(() => "");
      if (output !== expected) {
        await Bun.sleep(20);
      }
    }
    expect(output).toBe(expected);
    for (const values of Object.values(readonlyValues)) {
      expect(
        calls.every((args) => !args.some((arg) => arg.includes(values)))
      ).toBe(true);
    }
  },
  20_000
);
