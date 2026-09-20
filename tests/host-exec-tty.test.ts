import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cases = [
  {
    name: "wrapper-only TERM",
    signal: "SIGTERM",
    behavior: "exit",
    mode: "wrapper",
    code: 143,
  },
  {
    name: "wrapper-only INT",
    signal: "SIGINT",
    behavior: "exit",
    mode: "wrapper",
    code: 130,
  },
  {
    name: "stubborn wrapper-only TERM",
    signal: "SIGTERM",
    behavior: "ignore",
    mode: "wrapper",
    code: 143,
  },
  {
    name: "immediate foreground Ctrl-C",
    signal: "SIGINT",
    behavior: "exit",
    mode: "foreground",
    code: 130,
  },
  {
    name: "foreground Ctrl-C while wrapper paused",
    signal: "SIGINT",
    behavior: "exit",
    mode: "paused",
    code: 130,
  },
  {
    name: "terminal input with separate output",
    signal: "SIGTERM",
    behavior: "io",
    mode: "wrapper",
    code: 143,
  },
  {
    name: "piped stdin retains the controlling terminal",
    signal: "SIGTERM",
    behavior: "pipe",
    mode: "wrapper",
    code: 143,
  },
  {
    name: "normal command return",
    signal: "SIGTERM",
    behavior: "normal",
    mode: "wrapper",
    code: 7,
  },
  {
    name: "Ctrl-Z and fg resume",
    signal: "SIGINT",
    behavior: "exit",
    mode: "resume",
    code: 130,
  },
] as const;

for (const scenario of cases) {
  test.skipIf(!Bun.which("python3"))(
    `TTY ${scenario.name} preserves terminal ownership and cleans only owned processes`,
    async () => {
      const proc = Bun.spawn(
        [
          "python3",
          resolve(import.meta.dir, "fixtures/tty-cancellation.py"),
          "probe",
          process.execPath,
          resolve(import.meta.dir, "../index.ts"),
          scenario.signal,
          scenario.behavior,
          scenario.mode,
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
      const outcome = JSON.parse(stdout);
      expect(outcome).toMatchObject({
        exit: scenario.code,
        foregroundRestored: true,
        childAlive: false,
        grandchildAlive: false,
        siblingAlive: true,
        tty: {
          stdin: scenario.behavior !== "pipe",
          devTty: true,
          foreground: true,
        },
      });
      expect(outcome.record).toMatchObject({
        status: scenario.behavior === "normal" ? "exited" : "cancelled",
        exitCode: scenario.code,
        ownsProcessGroup: true,
        childMatches: true,
        groupDifferentFromChild: true,
      });
      if (scenario.behavior === "normal") {
        expect(outcome.record.maxRssBytes).toBeGreaterThan(0);
        expect(outcome.record.cpuTimeMs).toBeGreaterThan(0);
      }
      if (
        scenario.behavior === "normal" ||
        scenario.behavior === "io" ||
        scenario.behavior === "pipe"
      ) {
        expect(outcome).toMatchObject({
          input: "hello tty\n",
          stdout: "child stdout\n",
          stderr: "child stderr\n",
          tty: { stdout: false, stderr: false },
        });
      }
      if (scenario.behavior === "pipe") {
        expect(outcome.pipeInput).toBe("piped data\n");
      }
      if (scenario.mode === "resume") {
        expect(outcome.stopped).toEqual({ foregroundRestored: true });
      }
    },
    25_000
  );
}

test.skipIf(!Bun.which("python3"))(
  "compiled TTY supervisor survives foreground Ctrl-C while its wrapper is paused",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "hack-compiled-tty-"));
    try {
      const binary = join(directory, "hack");
      const build = Bun.spawn(
        [
          process.execPath,
          "build",
          "index.ts",
          "--compile",
          "--outfile",
          binary,
        ],
        {
          cwd: resolve(import.meta.dir, ".."),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const [buildStdout, buildStderr, buildExit] = await Promise.all([
        new Response(build.stdout).text(),
        new Response(build.stderr).text(),
        build.exited,
      ]);
      expect({
        exit: buildExit,
        stdout: buildStdout,
        stderr: buildStderr,
      }).toMatchObject({ exit: 0 });
      const probe = Bun.spawn(
        [
          "python3",
          resolve(import.meta.dir, "fixtures/tty-cancellation.py"),
          "probe",
          binary,
          "",
          "SIGINT",
          "exit",
          "paused",
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" }
      );
      const [stdout, stderr, exit] = await Promise.all([
        new Response(probe.stdout).text(),
        new Response(probe.stderr).text(),
        probe.exited,
      ]);
      expect(stderr).toBe("");
      expect(exit).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
        exit: 130,
        foregroundRestored: true,
        childAlive: false,
        grandchildAlive: false,
        siblingAlive: true,
        tty: { stdin: true, devTty: true, foreground: true },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  45_000
);
