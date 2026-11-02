import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  DAEMON_AUTOSTART_DISABLE_ENV,
  resolveDaemonAutostartAccess,
} from "../src/daemon/client.ts";
import { fixtureChildren } from "./helpers/fixture-children.ts";
import {
  PRIVATE_CLI_DAEMON_AUTOSTART_ENV,
  privateCliEnv,
  privateCliRunEnv,
} from "./helpers/private-cli-env.ts";

/*
 * HACK-1696: `hack doctor --fix`, `--migrate-env-config` and `global up` run
 * `hack daemon start` through `resolveHackInvocation`, with no TTY needed.
 * That is a plausible way for a fixture run to leave a daemon behind. It is
 * not proven to be how the daemons in that ticket started.
 * The doctor cases run the source CLI with a recording stub first on PATH, so
 * a regression records a call and cannot start a real daemon.
 */

const ENTRYPOINT = resolve(import.meta.dir, "..", "index.ts");
const TESTS_ROOT = resolve(import.meta.dir);
const DOCTOR_REPAIR_TIMEOUT_MS = 30_000;

const children = fixtureChildren("daemon-autostart-fixture-guard");
let root: string | null = null;

afterEach(async () => {
  // A test timeout does not end the child or its pipe readers, so stop and
  // await any child that is still running before removing its fixture.
  await children.stopAll();
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = null;
  }
});

async function fixtureRoot(): Promise<string> {
  root = await realpath(await mkdtemp(join(tmpdir(), "hack-daemon-guard-")));
  return root;
}

async function writeStub(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
}

async function runDoctorRepair(opts: {
  readonly flag: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): Promise<{ readonly hackCalls: string[]; readonly output: string }> {
  const fixture = await fixtureRoot();
  const tools = join(fixture, "tools");
  const project = join(fixture, "project");
  const hackLog = join(fixture, "hack-calls.log");
  await mkdir(tools);
  await mkdir(join(project, ".hack"), { recursive: true });
  await writeFile(
    join(project, ".hack", "docker-compose.yml"),
    "services:\n  api:\n    image: alpine:3.19\n"
  );
  await writeStub(join(tools, "hack"), `printf '%s\\n' "$*" >> "${hackLog}"`);
  // Docker is unavailable, so doctor stops after the hackd repair step.
  await writeStub(join(tools, "docker"), "exit 1");
  await writeStub(join(tools, "mutagen"), "exit 0");

  const { stdout, stderr } = await children.run({
    cmd: [
      process.execPath,
      ENTRYPOINT,
      "doctor",
      opts.flag,
      "--no-interactive",
      "--path",
      project,
    ],
    cwd: project,
    env: privateCliEnv({
      root: fixture,
      env: {
        HACK_HOME: join(fixture, "hack-home"),
        HACK_GLOBAL_CONFIG_PATH: join(fixture, "hack-config.json"),
        HACK_LOGGER: "console",
        HACK_MUTAGEN_PATH: join(tools, "mutagen"),
        HACK_NO_INTERACTIVE: "1",
        NO_COLOR: "1",
        PATH: `${tools}:/usr/bin:/bin`,
        ...opts.env,
      },
    }),
  });
  const log = await readFile(hackLog, "utf8").catch(() => "");
  return {
    hackCalls: log.split("\n").filter((line) => line.length > 0),
    output: stdout + stderr,
  };
}

test("the private env names the variable the client reads", () => {
  expect(PRIVATE_CLI_DAEMON_AUTOSTART_ENV).toBe(DAEMON_AUTOSTART_DISABLE_ENV);
});

test("privateCliEnv denies implicit daemon starts and a test can opt in", async () => {
  const fixture = await fixtureRoot();
  const denied = privateCliEnv({ root: fixture });
  expect(denied[DAEMON_AUTOSTART_DISABLE_ENV]).toBe("1");
  expect(resolveDaemonAutostartAccess({ env: denied })).toMatchObject({
    allowed: false,
    reason: "disabled",
  });
  expect(privateCliRunEnv({ root: fixture }).env).toMatchObject({
    [DAEMON_AUTOSTART_DISABLE_ENV]: "1",
  });

  const optedIn = privateCliEnv({
    root: fixture,
    env: { [DAEMON_AUTOSTART_DISABLE_ENV]: undefined },
  });
  expect(Object.hasOwn(optedIn, DAEMON_AUTOSTART_DISABLE_ENV)).toBe(false);
  expect(resolveDaemonAutostartAccess({ env: optedIn }).allowed).toBe(true);
});

for (const flag of ["--fix", "--migrate-env-config"]) {
  test(
    `doctor ${flag} with the private env never runs hack daemon`,
    async () => {
      const { hackCalls, output } = await runDoctorRepair({ flag });
      expect(hackCalls).toEqual([]);
      expect(output).toContain("Skipped hackd repair");
    },
    DOCTOR_REPAIR_TIMEOUT_MS
  );

  // Positive control: the same run reaches the stub without the variable, even
  // with HACK_NO_INTERACTIVE=1 and no TTY.
  test(
    `doctor ${flag} that opts in runs hack daemon start from PATH`,
    async () => {
      const { hackCalls } = await runDoctorRepair({
        flag,
        env: { [DAEMON_AUTOSTART_DISABLE_ENV]: undefined },
      });
      expect(hackCalls).toContain("daemon start");
    },
    DOCTOR_REPAIR_TIMEOUT_MS
  );
}

test("no test sets the old variable name that nothing reads", async () => {
  const retired = new RegExp(`${["HACK", "DAEMON", "DISABLE"].join("_")}(?!_)`);
  const offenders: string[] = [];
  for await (const path of new Bun.Glob("**/*.{ts,tsx,mts}").scan({
    cwd: TESTS_ROOT,
    absolute: true,
  })) {
    if (retired.test(await readFile(path, "utf8"))) {
      offenders.push(relative(TESTS_ROOT, path));
    }
  }
  expect(offenders).toEqual([]);
});
