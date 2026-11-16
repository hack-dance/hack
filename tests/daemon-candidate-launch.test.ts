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
import { join, resolve } from "node:path";
import pkg from "../package.json";
import {
  candidateOrphanRefusal,
  candidateRunningDaemonRefusal,
  candidateServiceCommandRefusal,
} from "../src/commands/daemon-candidate.ts";
import { DAEMON_CLI_VERSION } from "../src/daemon/client.ts";
import { resolveDaemonLaunch } from "../src/daemon/executing-cli.ts";
import { HACK_VERSION } from "../src/lib/hack-version.ts";
import { fixtureChildren } from "./helpers/fixture-children.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/*
 * HACK-2263: a candidate run (`hack-next`, `hack-v5`) must start its own
 * bundle's hackd, never the `hack` first on PATH (the stable CLI), and
 * must refuse when it cannot prove what it would start.
 */

const ENTRYPOINT = resolve(import.meta.dir, "..", "index.ts");
const COMPILED_MAIN = "/$bunfs/root/hack-cli";
const BUNDLE_CLI = "/opt/candidate/versions/v/bundle/hack-cli";

const children = fixtureChildren("daemon-candidate-launch");
let root: string | null = null;

afterEach(async () => {
  await children.stopAll();
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = null;
  }
});

test("an ordinary run starts the hack it resolves", () => {
  expect(resolveDaemonLaunch({ env: {} })).toEqual({ kind: "path" });
  expect(
    resolveDaemonLaunch({ env: { HACK_CANDIDATE_ENTRYPOINT: "  " } })
  ).toEqual({ kind: "path" });
});

for (const entrypoint of ["hack-next", "hack-v5"]) {
  test(`a compiled ${entrypoint} run starts its own bundle's hack-v5`, () => {
    const checked: string[] = [];
    const launch = resolveDaemonLaunch({
      env: { HACK_CANDIDATE_ENTRYPOINT: entrypoint },
      main: COMPILED_MAIN,
      execPath: BUNDLE_CLI,
      isExecutable: (path) => {
        checked.push(path);
        return true;
      },
    });
    expect(launch).toEqual({
      kind: "candidate",
      argv: [
        "/opt/candidate/versions/v/bundle/hack-v5",
        "daemon",
        "start",
        "--foreground",
      ],
    });
    expect(checked).toEqual(["/opt/candidate/versions/v/bundle/hack-v5"]);
  });
}

test("a candidate run without a launcher next to hack-cli refuses", () => {
  const launch = resolveDaemonLaunch({
    env: { HACK_CANDIDATE_ENTRYPOINT: "hack-next" },
    main: COMPILED_MAIN,
    execPath: BUNDLE_CLI,
    isExecutable: () => false,
  });
  expect(launch.kind).toBe("refused");
  if (launch.kind === "refused") {
    expect(launch.message).toContain("cannot prove which hackd");
    expect(launch.message.split(". ").length).toBe(1);
  }
});

test("a candidate source run refuses", () => {
  const launch = resolveDaemonLaunch({
    env: { HACK_CANDIDATE_ENTRYPOINT: "hack-v5" },
    main: ENTRYPOINT,
    execPath: process.execPath,
    isExecutable: () => true,
  });
  expect(launch.kind).toBe("refused");
});

test("a candidate refuses a running hackd of another version only", () => {
  const env = { HACK_CANDIDATE_ENTRYPOINT: "hack-next" };
  expect(
    candidateRunningDaemonRefusal({
      pid: 42,
      version: DAEMON_CLI_VERSION,
      compatible: true,
      env,
    })
  ).toBeNull();
  const refusal = candidateRunningDaemonRefusal({
    pid: 42,
    version: "4.3.0",
    compatible: false,
    env,
  });
  expect(refusal).toContain("version 4.3.0 (pid 42)");
  expect(refusal).toContain("does not stop or replace it");
  expect(
    candidateRunningDaemonRefusal({
      pid: 42,
      version: "4.3.0",
      compatible: false,
      env: {},
    })
  ).toBeNull();
});

test("a candidate treats an unanswered API as unknown, never compatible", () => {
  const refusal = candidateRunningDaemonRefusal({
    pid: 7,
    version: null,
    compatible: false,
    env: { HACK_CANDIDATE_ENTRYPOINT: "hack-v5" },
  });
  expect(refusal).toContain("did not report its version");
  expect(refusal).toContain("leaves it alone");
});

test("a candidate refuses untracked hackd processes", () => {
  expect(candidateOrphanRefusal({ pids: [] })).toBeNull();
  expect(candidateOrphanRefusal({ pids: [11, 12] })).toContain(
    "hackd process 11, 12 holds this Hack home without its pid file"
  );
});

test("a candidate run refuses daemon install and uninstall", () => {
  for (const command of ["install", "uninstall"] as const) {
    expect(
      candidateServiceCommandRefusal({
        command,
        env: { HACK_CANDIDATE_ENTRYPOINT: "hack-v5" },
      })
    ).toContain(`does not ${command} the hackd login service`);
    expect(candidateServiceCommandRefusal({ command, env: {} })).toBeNull();
  }
});

test("the CLI and hackd share one version source", () => {
  // A source run has no build define, so both are the package version; a
  // prerelease build stamps both (scripts/check-candidate-daemon-identity.ts).
  expect(HACK_VERSION).toBe(pkg.version);
  expect(DAEMON_CLI_VERSION).toBe(HACK_VERSION);
});

for (const command of ["start", "restart", "install"]) {
  test(`candidate source run: daemon ${command} never runs the hack on PATH`, async () => {
    root = await realpath(
      await mkdtemp(join(tmpdir(), "hack-daemon-candidate-"))
    );
    const tools = join(root, "tools");
    const hackLog = join(root, "hack-calls.log");
    await mkdir(tools);
    await writeFile(
      join(tools, "hack"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${hackLog}"\nexit 1\n`,
      { mode: 0o700 }
    );
    const { exitCode, stdout, stderr } = await children.run({
      cmd: [process.execPath, ENTRYPOINT, "daemon", command, "--json"],
      cwd: root,
      env: privateCliEnv({
        root,
        env: {
          HACK_HOME: join(root, "hack-home"),
          HACK_GLOBAL_CONFIG_PATH: join(root, "hack-config.json"),
          HACK_CANDIDATE_ENTRYPOINT: "hack-v5",
          HACK_LOGGER: "console",
          HACK_NO_INTERACTIVE: "1",
          NO_COLOR: "1",
          PATH: `${tools}:/usr/bin:/bin`,
        },
      }),
    });
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout) as {
      ok: boolean;
      error: { message: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.message).toMatch(
      command === "install"
        ? /does not install the hackd login service/
        : /cannot prove which hackd it would start/
    );
    expect(stdout + stderr).not.toContain("hackd started");
    expect(await readFile(hackLog, "utf8").catch(() => "")).toBe("");
  });
}
