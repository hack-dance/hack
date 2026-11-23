import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkRunningLaunchdDaemon,
  refuseLaunchdBeforeReplacing,
  startViaLaunchdIfLoaded,
} from "../src/commands/daemon-launchd.ts";
import {
  describeUnverifiedReplacement,
  type ReplacementStartOutcome,
  type ServiceManagerState,
  startReplacementDaemon,
} from "../src/commands/daemon-replace.ts";
import {
  type InstalledBinary,
  observePostUpdateDaemon,
  type PostUpdateDaemonResult,
  parseStartEnvelope,
  reconcileDaemonAfterUpdate,
  verifyInstalledBinary,
} from "../src/commands/daemon-upgrade.ts";
import {
  executingDaemonArgv,
  resolveExecutingCliPath,
} from "../src/daemon/executing-cli.ts";
import {
  checkLaunchdJobBeforeStart,
  checkLaunchdRetargetTarget,
  classifyLaunchdProgramPath,
  isHackManagedPlist,
  isLaunchdPlistCurrent,
  isLaunchdServiceNotFound,
  isSameExecutableFile,
  LAUNCHCTL_PATH,
  LAUNCHD_MANAGED_MARKER,
  launchctlArgv,
  loadedJobMatchesPlist,
  parseLaunchdPlistProgram,
  plistKeepsThisHome,
  proveLaunchdJobOwnership,
  readLaunchdManagerState,
  renderLaunchdPlist,
} from "../src/daemon/launchd.ts";
import type { LaunchdLoadedJob } from "../src/daemon/launchd-print.ts";
import { resolveDaemonPaths } from "../src/daemon/paths.ts";
import type { DaemonProcessProof } from "../src/daemon/process.ts";
import {
  hasAncestorProcess,
  PS_PATH,
  psParentArgv,
} from "../src/daemon/process-ancestry.ts";
import {
  buildDaemonCommandData,
  createDaemonCommandTrace,
  type DaemonReconcileInput,
  planDaemonReconcile,
  reconcileAction,
} from "../src/daemon/reconcile.ts";
import { detachedDaemonEnvironment } from "../src/daemon/spawn.ts";
import {
  classifySystemdManagerState,
  findDroppedHomeBinding,
  isHackManagedUnit,
  readInvokerInSystemdUnit,
  renderSystemdUnit,
  type SystemdDeps,
} from "../src/daemon/systemd.ts";
import { writeOwnedFixture } from "./helpers/owned-fixture.ts";

/** HACK-2216: the reconcile decision and its `--json` contract, no I/O. */

/**
 * A home whose `~/Library/LaunchAgents` exists and is safe from other
 * accounts: the launchd paths these in-process tests use. Every launchd
 * start checks the plist file and its directories first (HACK-2216). No
 * plist is written there; the tests pin what a plist read returns.
 */
const LAUNCHD_HOME = await mkdtemp(join(tmpdir(), "hack-launchd-home-"));
await mkdir(join(LAUNCHD_HOME, "Library", "LaunchAgents"), {
  recursive: true,
  mode: 0o755,
});
await chmod(join(LAUNCHD_HOME, "Library"), 0o755);
await chmod(join(LAUNCHD_HOME, "Library", "LaunchAgents"), 0o755);
afterAll(async () => {
  await rm(LAUNCHD_HOME, { recursive: true, force: true });
});

const base: DaemonReconcileInput = {
  unit: "current",
  programIsOurs: true,
  readOnly: false,
  running: null,
  cliVersion: "2.0.0",
};

test("a current unit with nothing running is only started", () => {
  const plan = planDaemonReconcile(base);
  expect(plan).toEqual({
    rewrite: "none",
    service: "start",
    reasons: [],
    blocked: null,
  });
  expect(reconcileAction(plan)).toBe("started");
});

test("a current unit running this version is kept", () => {
  const plan = planDaemonReconcile({
    ...base,
    running: { version: "2.0.0" },
  });
  expect(plan.service).toBe("keep");
  expect(reconcileAction(plan)).toBe("none");
});

test("a version mismatch under this hack's unit restarts it", () => {
  const plan = planDaemonReconcile({
    ...base,
    running: { version: "1.0.0" },
  });
  expect(plan).toEqual({
    rewrite: "none",
    service: "restart",
    reasons: ["version-mismatch"],
    blocked: null,
  });
  expect(reconcileAction(plan)).toBe("restarted");
});

test("an unknown daemon version is not a mismatch", () => {
  const plan = planDaemonReconcile({ ...base, running: { version: null } });
  expect(plan.service).toBe("keep");
  expect(plan.reasons).toEqual([]);
});

test("stale content of this hack's unit is rewritten, then started or restarted", () => {
  const stopped = planDaemonReconcile({ ...base, unit: "content" });
  expect(stopped).toMatchObject({ rewrite: "content", service: "start" });
  expect(reconcileAction(stopped)).toBe("reinstalled");
  const running = planDaemonReconcile({
    ...base,
    unit: "content",
    running: { version: "1.0.0" },
  });
  expect(running).toEqual({
    rewrite: "content",
    service: "restart",
    reasons: ["content", "version-mismatch"],
    blocked: null,
  });
});

test("a unit for another existing hack is never rewritten", () => {
  const stopped = planDaemonReconcile({
    ...base,
    unit: "content",
    programIsOurs: false,
  });
  expect(stopped).toMatchObject({
    rewrite: "none",
    service: "start",
    blocked: "other-program",
  });
  const compatible = planDaemonReconcile({
    ...base,
    programIsOurs: false,
    running: { version: "2.0.0" },
  });
  expect(compatible.service).toBe("keep");
  const mismatch = planDaemonReconcile({
    ...base,
    programIsOurs: false,
    running: { version: "1.0.0" },
  });
  expect(mismatch).toMatchObject({
    rewrite: "none",
    service: "refuse",
    blocked: "other-program",
  });
});

test("an unreadable ExecStart with a mismatched daemon is refused", () => {
  const plan = planDaemonReconcile({
    ...base,
    unit: "program-unknown",
    programIsOurs: false,
    running: { version: "1.0.0" },
  });
  expect(plan).toMatchObject({
    service: "refuse",
    blocked: "unknown-program",
    rewrite: "none",
  });
});

test("a missing program is retargeted, except read-only", () => {
  const plan = planDaemonReconcile({
    ...base,
    unit: "program-missing",
    programIsOurs: false,
  });
  expect(plan).toEqual({
    rewrite: "program",
    service: "start",
    reasons: ["program-missing"],
    blocked: null,
  });
  expect(
    planDaemonReconcile({
      ...base,
      unit: "program-missing",
      programIsOurs: false,
      running: { version: "1.0.0" },
    }).service
  ).toBe("restart");
  expect(
    planDaemonReconcile({
      ...base,
      unit: "program-missing",
      programIsOurs: false,
      readOnly: true,
    })
  ).toMatchObject({ rewrite: "none", service: "refuse", blocked: "read-only" });
});

test("read-only never rewrites stale content but still restarts a mismatch", () => {
  const plan = planDaemonReconcile({
    ...base,
    unit: "content",
    readOnly: true,
    running: { version: "1.0.0" },
  });
  expect(plan).toMatchObject({
    rewrite: "none",
    service: "restart",
    blocked: "read-only",
  });
  expect(
    planDaemonReconcile({
      ...base,
      unit: "content",
      readOnly: true,
      running: { version: "2.0.0" },
    }).service
  ).toBe("keep");
});

test("a restart left pending by an earlier rewrite is completed", () => {
  const plan = planDaemonReconcile({
    ...base,
    running: { version: "2.0.0" },
    restartPending: true,
  });
  expect(plan).toMatchObject({ service: "restart", reasons: ["content"] });
});

test("the --json data is closed and schema-tagged", () => {
  const trace = createDaemonCommandTrace();
  trace.manager = "systemd";
  trace.action = "reinstalled";
  trace.stale.add("version-mismatch");
  trace.stale.add("content");
  expect(
    buildDaemonCommandData({
      command: "start",
      trace,
      daemon: { running: true, pid: 12, version: "2.0.0" },
      cliVersion: "2.0.0",
    })
  ).toEqual({
    schema: "hack.daemon-start.v1",
    manager: "systemd",
    action: "reinstalled",
    stale: true,
    stale_reasons: ["content", "version-mismatch"],
    blocked: null,
    fallback: null,
    cli_version: "2.0.0",
    daemon: { running: true, pid: 12, version: "2.0.0", compatible: true },
  });
  expect(
    buildDaemonCommandData({
      command: "stop",
      trace: createDaemonCommandTrace(),
      daemon: { running: false, pid: 12, version: null },
      cliVersion: "2.0.0",
    })
  ).toMatchObject({
    schema: "hack.daemon-stop.v1",
    stale: false,
    stale_reasons: [],
    daemon: { running: false, pid: null, compatible: false },
  });
});

test("an environment-only plist change is stale", () => {
  const opts = {
    hackBinPath: "/opt/hack/bin/hack",
    home: "/Users/example",
    runAtLoad: true,
    guiSessionOnly: true,
  };
  const current = renderLaunchdPlist(opts);
  expect(
    isLaunchdPlistCurrent({
      plistText: current,
      hackBinPath: opts.hackBinPath,
      home: opts.home,
    })
  ).toBe(true);
  const oldPath = current.replace(":/opt/homebrew/bin", "");
  expect(oldPath).not.toBe(current);
  expect(
    isLaunchdPlistCurrent({
      plistText: oldPath,
      hackBinPath: opts.hackBinPath,
      home: opts.home,
    })
  ).toBe(false);
});

test("after an update, nothing runs without an installed service or a running daemon", async () => {
  const ran: string[][] = [];
  const runCli = (argv: readonly string[]) => {
    ran.push([...argv]);
    return Promise.resolve({ exitCode: 0, stdout: "" });
  };
  expect(
    await reconcileDaemonAfterUpdate({
      binaryPath: "/opt/hack/bin/hack",
      observe: () =>
        Promise.resolve({ serviceInstalled: false, daemonRunning: true }),
      runCli,
    })
  ).toEqual({ status: "skipped", reason: "no-service" });
  expect(
    await reconcileDaemonAfterUpdate({
      binaryPath: "/opt/hack/bin/hack",
      observe: () =>
        Promise.resolve({ serviceInstalled: true, daemonRunning: false }),
      runCli,
    })
  ).toEqual({ status: "skipped", reason: "not-running" });
  expect(ran).toEqual([]);
});

test("after an update, the new executable's start --json reconciles the service", async () => {
  const ran: string[][] = [];
  const result = await reconcileDaemonAfterUpdate({
    binaryPath: "/opt/hack/bin/hack",
    // The installed binary checks out (verifyInstalledBinary has its own tests).
    verifyBinary: () => Promise.resolve(null),
    observe: () =>
      Promise.resolve({ serviceInstalled: true, daemonRunning: true }),
    runCli: (argv) => {
      ran.push([...argv]);
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          data: {
            schema: "hack.daemon-start.v1",
            manager: "systemd",
            action: "restarted",
            stale_reasons: ["version-mismatch"],
          },
        }),
      });
    },
  });
  expect(ran).toEqual([["/opt/hack/bin/hack", "daemon", "start", "--json"]]);
  expect(result).toEqual({
    status: "reconciled",
    manager: "systemd",
    action: "restarted",
    stale_reasons: ["version-mismatch"],
  });
});

test("a failed or unreadable post-update reconcile is reported, never fatal", async () => {
  expect(
    parseStartEnvelope({
      exitCode: 1,
      stdout: JSON.stringify({
        ok: false,
        error: { code: "E_DAEMON_SERVICE", message: "refused" },
      }),
    })
  ).toEqual({
    status: "failed",
    message: "refused",
    next_step: "hack daemon install",
  });
  expect(parseStartEnvelope({ exitCode: 1, stdout: "" })).toMatchObject({
    status: "failed",
    next_step: "hack daemon install",
  });
  expect(
    parseStartEnvelope({
      exitCode: 0,
      stdout: JSON.stringify({ ok: true, data: { schema: "other/v1" } }),
    })
  ).toMatchObject({ status: "failed" });
  expect(
    await reconcileDaemonAfterUpdate({
      binaryPath: "/opt/hack/bin/hack",
      verifyBinary: () => Promise.resolve(null),
      observe: () =>
        Promise.resolve({ serviceInstalled: true, daemonRunning: true }),
      runCli: () => Promise.reject(new Error("spawn failed")),
    })
  ).toEqual({
    status: "failed",
    message: "spawn failed",
    next_step: "hack daemon install",
  });
});

// Review round 1 (HACK-2216).

test("nothing is rewritten or restarted from inside the running service", () => {
  const stale = planDaemonReconcile({
    ...base,
    unit: "content",
    running: { version: "2.0.0" },
    invokerInsideService: true,
  });
  expect(stale).toEqual({
    rewrite: "none",
    service: "keep",
    reasons: ["content"],
    blocked: "inside-service",
  });
  expect(
    planDaemonReconcile({
      ...base,
      running: { version: "1.0.0" },
      invokerInsideService: true,
    })
  ).toMatchObject({ service: "refuse", blocked: "inside-service" });
  // A current, compatible service is unaffected.
  expect(
    planDaemonReconcile({
      ...base,
      running: { version: "2.0.0" },
      invokerInsideService: true,
    })
  ).toMatchObject({ service: "keep", blocked: null });
});

test("an unmanaged or home-bound unit is not rewritten, but a mismatch still restarts", () => {
  for (const contentBlock of ["unmanaged", "home-binding"] as const) {
    expect(
      planDaemonReconcile({ ...base, unit: "content", contentBlock })
    ).toMatchObject({
      rewrite: "none",
      service: "start",
      blocked: contentBlock,
    });
    expect(
      planDaemonReconcile({
        ...base,
        unit: "content",
        contentBlock,
        running: { version: "1.0.0" },
      })
    ).toMatchObject({
      rewrite: "none",
      service: "restart",
      blocked: contentBlock,
    });
  }
});

test("the managed header and dropped home bindings are recognized", () => {
  const rendered =
    renderSystemdUnit({ hackBinPath: "/opt/hack/bin/hack" }) ?? "";
  expect(isHackManagedUnit({ unitText: rendered })).toBe(true);
  expect(isHackManagedUnit({ unitText: `# mine\n${rendered}` })).toBe(false);
  expect(findDroppedHomeBinding({ unitText: rendered, rendered })).toBeNull();
  const bound = rendered.replace(
    "[Service]\n",
    '[Service]\nEnvironment="HACK_HOME=/srv/other/.hack"\n'
  );
  expect(findDroppedHomeBinding({ unitText: bound, rendered })).toBe(
    'Environment="HACK_HOME=/srv/other/.hack"'
  );
  const homed = rendered.replace(
    "[Service]\n",
    "[Service]\nEnvironment=HOME=/srv/u\n"
  );
  expect(findDroppedHomeBinding({ unitText: homed, rendered })).toBe(
    "Environment=HOME=/srv/u"
  );
  const file = rendered.replace(
    "[Service]\n",
    "[Service]\nEnvironmentFile=/srv/env\n"
  );
  expect(findDroppedHomeBinding({ unitText: file, rendered })).toBe(
    "EnvironmentFile=/srv/env"
  );
  // Other variables are not a home binding.
  const other = rendered.replace(
    "[Service]\n",
    "[Service]\nEnvironment=FOO=1\n"
  );
  expect(findDroppedHomeBinding({ unitText: other, rendered })).toBeNull();
});

function cgroupDeps(group: string | null): SystemdDeps {
  return {
    env: {},
    uid: 1000,
    run: () =>
      Promise.resolve(
        group === null
          ? { exitCode: 1, stdout: "", stderr: "Failed to connect to bus" }
          : { exitCode: 0, stdout: `ControlGroup=${group}\n`, stderr: "" }
      ),
  };
}

test("the caller is inside hackd.service when its cgroup is the unit's or below", async () => {
  const unit =
    "/user.slice/user-1000.slice/user@1000.service/app.slice/hackd.service";
  const self = (path: string) => () => Promise.resolve(`0::${path}\n`);
  const read = (group: string | null, selfPath: string | null) =>
    readInvokerInSystemdUnit({
      deps: cgroupDeps(group),
      readSelfCgroup:
        selfPath === null ? () => Promise.resolve(null) : self(selfPath),
    });
  expect(await read(unit, unit)).toBe("inside");
  expect(await read(unit, `${unit}/job-1`)).toBe("inside");
  expect(await read(unit, `${unit}-other`)).toBe("outside");
  expect(await read(null, unit)).toBe("unknown");
  expect(await read(unit, null)).toBe("unknown");
});

test("unreadable cgroup facts fail closed (review round 2)", async () => {
  const unit =
    "/user.slice/user-1000.slice/user@1000.service/app.slice/hackd.service";
  const read = (deps: SystemdDeps, self: string | null) =>
    readInvokerInSystemdUnit({
      deps,
      readSelfCgroup: () => Promise.resolve(self),
    });
  const outsideSelf = "0::/user.slice/user-1000.slice/session-2.scope\n";
  // A response without the ControlGroup property, or an empty one.
  const noProperty: SystemdDeps = {
    env: {},
    uid: 1000,
    run: () =>
      Promise.resolve({
        exitCode: 0,
        stdout: "ActiveState=active\n",
        stderr: "",
      }),
  };
  expect(await read(noProperty, outsideSelf)).toBe("unknown");
  expect(await read(cgroupDeps(""), outsideSelf)).toBe("unknown");
  expect(await read(cgroupDeps("not-a-path"), outsideSelf)).toBe("unknown");
  // An empty or malformed /proc/self/cgroup.
  expect(await read(cgroupDeps(unit), "")).toBe("unknown");
  expect(await read(cgroupDeps(unit), "garbage\n0:cpu\n")).toBe("unknown");
  expect(await read(cgroupDeps(unit), "x::/a\n")).toBe("unknown");
  // A well-formed answer on both sides.
  expect(await read(cgroupDeps(unit), outsideSelf)).toBe("outside");
});

test("launchd: a loaded job without a readable pid counts as inside (review round 2)", async () => {
  const trace = createDaemonCommandTrace();
  const ancestry: number[] = [];
  const hooks = {
    paths: resolveDaemonPaths({ home: LAUNCHD_HOME }),
    trace,
    pid: 4242,
    waitForReady: () => Promise.reject(new Error("must not start")),
    readStatus: () =>
      Promise.resolve({
        installed: true,
        loaded: true,
        running: true,
        pid: null,
        exitStatus: null,
      }),
    isAncestor: (pid: number) => {
      ancestry.push(pid);
      return Promise.resolve(false);
    },
  };
  expect(await checkRunningLaunchdDaemon({ ...hooks, compatible: false })).toBe(
    1
  );
  expect(trace.blocked).toBe("inside-service");
  expect(
    await checkRunningLaunchdDaemon({ ...hooks, compatible: true })
  ).toBeNull();
  expect(ancestry).toEqual([]);
});

function loadedLaunchd(): () => Promise<{
  installed: boolean;
  loaded: boolean;
  running: boolean;
  pid: number | null;
  exitStatus: number | null;
}> {
  return () =>
    Promise.resolve({
      installed: true,
      loaded: true,
      running: false,
      pid: null,
      exitStatus: null,
    });
}

test("launchd: a failed refresh is an error, never 'already running' (review round 2)", async () => {
  const kicked: string[] = [];
  for (const onlyIfStale of [true, false]) {
    const trace = createDaemonCommandTrace();
    expect(
      await startViaLaunchdIfLoaded({
        paths: resolveDaemonPaths({ home: LAUNCHD_HOME }),
        trace,
        onlyIfStale,
        waitForReady: () => Promise.resolve(true),
        readStatus: loadedLaunchd(),
        repair: () => Promise.resolve("failed"),
        kickstart: () => {
          kicked.push("kickstart");
          return Promise.resolve({ ok: true });
        },
      })
    ).toBe(1);
  }
  expect(kicked).toEqual([]);
});

test("launchd: a stopped service running another program is not kickstarted (review round 2)", async () => {
  const kicked: string[] = [];
  for (const kind of ["other", "unknown"] as const) {
    const trace = createDaemonCommandTrace();
    expect(
      await startViaLaunchdIfLoaded({
        paths: resolveDaemonPaths({ home: LAUNCHD_HOME }),
        trace,
        waitForReady: () => Promise.resolve(true),
        readStatus: loadedLaunchd(),
        repair: () =>
          Promise.resolve(
            kind === "other" ? "other-program" : "unknown-program"
          ),
        readProgram: () =>
          Promise.resolve({ kind, program: null, resolved: null }),
        kickstart: () => {
          kicked.push("kickstart");
          return Promise.resolve({ ok: true });
        },
      })
    ).toBe(1);
    expect(trace.blocked).toBe(
      kind === "other" ? "other-program" : "unknown-program"
    );
  }
  expect(kicked).toEqual([]);
});

test("launchd program follows Program over ProgramArguments, and unreadable is unknown (review round 2)", () => {
  const wrap = (body: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
  const args = (first: string) =>
    `  <key>ProgramArguments</key>\n  <array>\n    <string>${first}</string>\n    <string>daemon</string>\n  </array>`;
  const program = (path: string) =>
    `  <key>Program</key>\n  <string>${path}</string>`;
  expect(
    parseLaunchdPlistProgram({ plistText: wrap(program("/opt/a/hack")) })
  ).toEqual({ kind: "path", path: "/opt/a/hack" });
  expect(
    parseLaunchdPlistProgram({
      plistText: wrap(`${program("/opt/a/hack")}\n${args("/opt/b/hack")}`),
    })
  ).toEqual({ kind: "path", path: "/opt/a/hack" });
  expect(
    parseLaunchdPlistProgram({ plistText: wrap(args("/opt/b/hack")) })
  ).toEqual({ kind: "path", path: "/opt/b/hack" });
  expect(parseLaunchdPlistProgram({ plistText: wrap("") })).toEqual({
    kind: "none",
  });
  for (const body of [
    "  <key>Program</key>\n  <array/>",
    `${program("/opt/a/hack")}\n${program("/opt/c/hack")}`,
    program("relative/hack"),
    program("/opt/a&amp;b/hack"),
    "  <key>ProgramArguments</key>\n  <string>/opt/b/hack</string>",
  ]) {
    expect(parseLaunchdPlistProgram({ plistText: wrap(body) }).kind).toBe(
      "unknown"
    );
  }
  expect(parseLaunchdPlistProgram({ plistText: "not xml" }).kind).toBe(
    "unknown"
  );
});

test("process ancestry walks parent pids and reports an unreadable chain", async () => {
  const parents = new Map([
    [50, 40],
    [40, 30],
    [30, 1],
  ]);
  const readParent = (pid: number) => Promise.resolve(parents.get(pid) ?? null);
  expect(await hasAncestorProcess({ ancestor: 30, pid: 50, readParent })).toBe(
    true
  );
  expect(await hasAncestorProcess({ ancestor: 99, pid: 50, readParent })).toBe(
    false
  );
  expect(
    await hasAncestorProcess({ ancestor: 99, pid: 60, readParent })
  ).toBeNull();
});

test("launchd: inside the job, a running hackd is kept or refused, never restarted", async () => {
  const trace = createDaemonCommandTrace();
  const hooks = {
    paths: resolveDaemonPaths({ home: LAUNCHD_HOME }),
    trace,
    pid: 4242,
    waitForReady: () => Promise.reject(new Error("must not start")),
    readStatus: () =>
      Promise.resolve({
        installed: true,
        loaded: true,
        running: true,
        pid: 4242,
        exitStatus: null,
      }),
    isAncestor: (pid: number) => Promise.resolve(pid === 4242),
  };
  expect(
    await checkRunningLaunchdDaemon({ ...hooks, compatible: true })
  ).toBeNull();
  expect(trace.blocked).toBe("inside-service");
  expect(await checkRunningLaunchdDaemon({ ...hooks, compatible: false })).toBe(
    1
  );
  // Unreadable ancestry counts as inside.
  expect(
    await checkRunningLaunchdDaemon({
      ...hooks,
      compatible: false,
      isAncestor: () => Promise.resolve(null),
    })
  ).toBe(1);
});

test("the launchd plist carries the managed marker", () => {
  const plist = renderLaunchdPlist({
    hackBinPath: "/opt/hack/bin/hack",
    home: "/Users/example",
    runAtLoad: false,
    guiSessionOnly: false,
  });
  expect(isHackManagedPlist({ plistText: plist })).toBe(true);
  expect(plist).toContain(LAUNCHD_MANAGED_MARKER);
  expect(
    isHackManagedPlist({ plistText: "<plist><dict></dict></plist>\n" })
  ).toBe(false);
  // An earlier Hack's plist (no marker) still counts by its Label.
  const legacy = plist.replace(`${LAUNCHD_MANAGED_MARKER}\n`, "");
  expect(legacy).not.toContain(LAUNCHD_MANAGED_MARKER);
  expect(isHackManagedPlist({ plistText: legacy })).toBe(true);
  expect(
    isHackManagedPlist({
      plistText: legacy.replace("dance.hack.hackd", "example.custom.hackd"),
    })
  ).toBe(false);
});

test("executable identity follows links, not path strings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hack-same-exe-"));
  try {
    const real = join(dir, "hack");
    const other = join(dir, "hack-other");
    await writeFile(real, "#!/bin/sh\n");
    await writeFile(other, "#!/bin/sh\n");
    await chmod(real, 0o755);
    await symlink(real, join(dir, "hack-link"));
    await link(real, join(dir, "hack-hard"));
    expect(await isSameExecutableFile(join(dir, "hack-link"), real)).toBe(true);
    expect(await isSameExecutableFile(join(dir, "hack-hard"), real)).toBe(true);
    expect(await isSameExecutableFile(other, real)).toBe(false);
    expect(await isSameExecutableFile(join(dir, "missing"), real)).toBe(false);
    // Equal strings are compared too: a path that no longer exists is not
    // the same file as itself.
    const gone = join(dir, "gone");
    expect(await isSameExecutableFile(gone, gone)).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Codex security finding on PR #854 (HACK-2216): equal path strings are
// never taken as the same file.

test("equal path strings with a different device or inode are not the same file", async () => {
  // The pathname was replaced between the two reads: each stat of the same
  // resolved path sees another file.
  let ino = 100;
  const io = {
    realpath: (path: string) => Promise.resolve(path),
    stat: () => {
      ino += 1;
      return Promise.resolve({ dev: 1, ino });
    },
  };
  expect(
    await isSameExecutableFile("/srv/tools/hack", "/srv/tools/hack", io)
  ).toBe(false);
  // Same string, another device.
  let dev = 0;
  expect(
    await isSameExecutableFile("/srv/tools/hack", "/srv/tools/hack", {
      realpath: (path: string) => Promise.resolve(path),
      stat: () => {
        dev += 1;
        return Promise.resolve({ dev, ino: 7 });
      },
    })
  ).toBe(false);
  // Same device and inode: the same file.
  expect(
    await isSameExecutableFile("/srv/tools/hack", "/srv/tools/hack", {
      realpath: (path: string) => Promise.resolve(path),
      stat: () => Promise.resolve({ dev: 1, ino: 7 }),
    })
  ).toBe(true);
});

test("after an update, a stale pid file is not a running daemon", async () => {
  const home = await mkdtemp(join(tmpdir(), "hack-stale-pid-"));
  try {
    const paths = resolveDaemonPaths({ home });
    await mkdir(paths.root, { recursive: true });
    // A live pid that is not hackd (this test process), and no socket.
    await writeFile(paths.pidPath, `${process.pid}\n`);
    const installed = () => Promise.resolve(true);
    expect(
      await observePostUpdateDaemon({ paths, serviceInstalled: installed })
    ).toEqual({ serviceInstalled: true, daemonRunning: false });
    // A socket path nobody answers on is not proof either.
    await writeFile(paths.socketPath, "");
    expect(
      await observePostUpdateDaemon({ paths, serviceInstalled: installed })
    ).toEqual({ serviceInstalled: true, daemonRunning: false });
    expect(
      await observePostUpdateDaemon({
        paths,
        serviceInstalled: () => Promise.resolve(false),
      })
    ).toEqual({ serviceInstalled: false, daemonRunning: false });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("after an update, a rejected observer is reported, never thrown", async () => {
  expect(
    await reconcileDaemonAfterUpdate({
      binaryPath: "/opt/hack/bin/hack",
      observe: () => Promise.reject(new Error("status unreadable")),
      runCli: () => Promise.reject(new Error("must not run")),
    })
  ).toEqual({
    status: "failed",
    message: "status unreadable",
    next_step: "hack daemon install",
  });
});

test("after an update, a daemon that stopped before the child ran is not started", async () => {
  // The child runs reconcile-only and reports `none`: a no-op, not a start.
  // (tests/daemon-systemd-cli.test.ts runs that mode through the CLI.)
  const ran: Record<string, string | undefined>[] = [];
  const result = await reconcileDaemonAfterUpdate({
    binaryPath: "/opt/hack/bin/hack",
    verifyBinary: () => Promise.resolve(null),
    observe: () =>
      Promise.resolve({ serviceInstalled: true, daemonRunning: true }),
    runCli: () => {
      ran.push({});
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          data: {
            schema: "hack.daemon-start.v1",
            manager: "none",
            action: "none",
            stale_reasons: [],
          },
        }),
      });
    },
  });
  expect(ran).toHaveLength(1);
  expect(result).toEqual({
    status: "reconciled",
    manager: "none",
    action: "none",
    stale_reasons: [],
  });
});

// Review round 3 (HACK-2216): only root-dict keys count, and only
// ENOENT/ENOTDIR establish a missing program.

const ROUND3_PLIST = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>dance.hack.hackd</string>\n${body}\n</dict>\n</plist>\n`;
const ROUND3_ARGS = (first: string) =>
  `  <key>ProgramArguments</key>\n  <array>\n    <string>${first}</string>\n    <string>daemon</string>\n  </array>`;

test("a Program key nested in another dict does not count", () => {
  const plist = ROUND3_PLIST(
    `${ROUND3_ARGS("/opt/other/hack")}\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>Program</key>\n    <string>/missing/path</string>\n    <key>ProgramArguments</key>\n    <array><string>/missing/too</string></array>\n  </dict>`
  );
  expect(parseLaunchdPlistProgram({ plistText: plist })).toEqual({
    kind: "path",
    path: "/opt/other/hack",
  });
  // Nested only: the root names no program.
  expect(
    parseLaunchdPlistProgram({
      plistText: ROUND3_PLIST(
        "  <key>EnvironmentVariables</key>\n  <dict>\n    <key>Program</key>\n    <string>/x/hack</string>\n  </dict>"
      ),
    })
  ).toEqual({ kind: "none" });
});

test("a commented-out Program key does not count", () => {
  const plist = ROUND3_PLIST(
    `  <!-- <key>Program</key>\n  <string>/missing/path</string> -->\n${ROUND3_ARGS("/opt/other/hack")}`
  );
  expect(parseLaunchdPlistProgram({ plistText: plist })).toEqual({
    kind: "path",
    path: "/opt/other/hack",
  });
});

test("structures the reader does not handle are unknown", () => {
  for (const body of [
    "  <key>Program</key>\n  <string><![CDATA[/opt/x/hack]]></string>",
    `${ROUND3_ARGS("/opt/other/hack")}\n  <!-- unterminated`,
    `${ROUND3_ARGS("/opt/other/hack")}\n  <key>Nested</key>\n  <dict>\n    <key>A</key>\n  </dict>`,
    `${ROUND3_ARGS("/opt/other/hack")}\n  <key>Odd</key>\n  <set/>`,
    `${ROUND3_ARGS("/opt/other/hack")}\n  <array>`,
  ]) {
    expect(
      parseLaunchdPlistProgram({ plistText: ROUND3_PLIST(body) }).kind
    ).toBe("unknown");
  }
  expect(
    parseLaunchdPlistProgram({
      plistText: '<plist version="1.0">\n<array/>\n</plist>\n',
    }).kind
  ).toBe("unknown");
  expect(parseLaunchdPlistProgram({ plistText: "<plist/>" })).toEqual({
    kind: "none",
  });
});

test("only ENOENT and ENOTDIR make a plist program missing", async () => {
  const failing = (code: string) => () =>
    Promise.reject(Object.assign(new Error(code), { code }));
  const classify = (stat: (path: string) => Promise<unknown>) =>
    classifyLaunchdProgramPath({ path: "/opt/hack/bin/hack", stat });
  expect(await classify(failing("ENOENT"))).toBe("missing");
  expect(await classify(failing("ENOTDIR"))).toBe("missing");
  expect(await classify(failing("EACCES"))).toBe("unknown");
  expect(await classify(failing("EIO"))).toBe("unknown");
  expect(await classify(() => Promise.reject(new Error("no code")))).toBe(
    "unknown"
  );
  expect(await classify(() => Promise.resolve({}))).toBe("exists");
});

// Review round 4 (HACK-2216).

test("read-only: a pending restart alone keeps a compatible daemon", () => {
  expect(
    planDaemonReconcile({
      ...base,
      readOnly: true,
      running: { version: "2.0.0" },
      restartPending: true,
    })
  ).toEqual({
    rewrite: "none",
    service: "keep",
    reasons: ["content"],
    blocked: "read-only",
  });
  // A version mismatch is still restarted.
  expect(
    planDaemonReconcile({
      ...base,
      readOnly: true,
      running: { version: "1.0.0" },
      restartPending: true,
    }).service
  ).toBe("restart");
});

test("root keys are read exactly: escapes are unknown, whitespace is another key", () => {
  const escaped = ROUND3_PLIST(
    "  <key>Progr&#97;m</key>\n  <string>/opt/other/hack</string>"
  );
  expect(parseLaunchdPlistProgram({ plistText: escaped }).kind).toBe("unknown");
  const named = ROUND3_PLIST(
    "  <key>&#80;rogramArguments</key>\n  <array><string>/opt/other/hack</string></array>"
  );
  expect(parseLaunchdPlistProgram({ plistText: named }).kind).toBe("unknown");
  // ` Program ` is not `Program` to launchd: ProgramArguments decides.
  const spaced = ROUND3_PLIST(
    `  <key> Program </key>\n  <string>/missing/path</string>\n${ROUND3_ARGS("/opt/other/hack")}`
  );
  expect(parseLaunchdPlistProgram({ plistText: spaced })).toEqual({
    kind: "path",
    path: "/opt/other/hack",
  });
  // Values are not trimmed either.
  expect(
    parseLaunchdPlistProgram({
      plistText: ROUND3_PLIST(
        "  <key>Program</key>\n  <string> /opt/other/hack</string>"
      ),
    }).kind
  ).toBe("unknown");
});

// Codex findings on PR #854 (HACK-2216).

test("a replacement daemon's environment drops the invocation-only flags", () => {
  const env = detachedDaemonEnvironment({
    PATH: "/usr/bin",
    HACK_DAEMON_RECONCILE_ONLY: "1",
    HACK_DAEMON_SERVICE_READ_ONLY: "1",
    HACK_HOME: "/srv/u/.hack",
  });
  expect(env).toEqual({ PATH: "/usr/bin", HACK_HOME: "/srv/u/.hack" });
  expect("HACK_DAEMON_RECONCILE_ONLY" in env).toBe(false);
});

test("a plist keeps this home only without HACK_HOME and with this HOME", () => {
  const plist = (env: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>dance.hack.hackd</string>\n  <key>EnvironmentVariables</key>\n  <dict>\n${env}\n  </dict>\n</dict>\n</plist>\n`;
  const home = "/Users/example";
  const keeps = (text: string) => plistKeepsThisHome({ plistText: text, home });
  expect(
    keeps(plist(`    <key>HOME</key>\n    <string>${home}</string>`))
  ).toBe(true);
  expect(keeps(plist(""))).toBe(true);
  expect(
    keeps(
      plist(
        `    <key>HOME</key>\n    <string>${home}</string>\n    <key>HACK_HOME</key>\n    <string>${home}/.hack</string>`
      )
    )
  ).toBe(false);
  expect(
    keeps(plist("    <key>HOME</key>\n    <string>/srv/other-home</string>"))
  ).toBe(false);
  // An escaped key inside the environment is unreadable: not proof.
  expect(
    keeps(plist("    <key>HACK_H&#79;ME</key>\n    <string>/x</string>"))
  ).toBe(false);
});

test("a loaded launchd job is this home's only when it runs nothing or its pid is proven", async () => {
  const paths = resolveDaemonPaths({ home: LAUNCHD_HOME });
  const status = (running: boolean, pid: number | null) => ({
    installed: true,
    loaded: true,
    running,
    pid,
    exitStatus: null,
  });
  const owned = () =>
    Promise.resolve({ kind: "owned" } as unknown as DaemonProcessProof);
  const refused = () =>
    Promise.resolve({
      kind: "refused",
      reason: "foreign-socket",
    } as DaemonProcessProof);
  expect(
    await proveLaunchdJobOwnership({ paths, status: status(false, null) })
  ).toBe(true);
  expect(
    await proveLaunchdJobOwnership({ paths, status: status(true, null) })
  ).toBe(false);
  expect(
    await proveLaunchdJobOwnership({
      paths,
      status: status(true, 4242),
      prove: owned,
    })
  ).toBe(true);
  expect(
    await proveLaunchdJobOwnership({
      paths,
      status: status(true, 4242),
      prove: refused,
    })
  ).toBe(false);
});

// Review round 6 (HACK-2216).

test("only launchd's exit 113 'Could not find service' is absence", () => {
  const notFound =
    'Bad request.\nCould not find service "dance.hack.hackd" in domain for port';
  expect(isLaunchdServiceNotFound({ exitCode: 113, output: notFound })).toBe(
    true
  );
  expect(isLaunchdServiceNotFound({ exitCode: 113, output: "" })).toBe(false);
  expect(isLaunchdServiceNotFound({ exitCode: 5, output: notFound })).toBe(
    false
  );
  expect(isLaunchdServiceNotFound({ exitCode: 124, output: "timed out" })).toBe(
    false
  );
});

test("an unloaded job is this home's only when launchd reported it absent", async () => {
  const paths = resolveDaemonPaths({ home: LAUNCHD_HOME });
  const unloaded = (
    observation: "reported" | "not-found" | "failed" | undefined
  ) => ({
    installed: true,
    loaded: false,
    running: false,
    pid: null,
    exitStatus: null,
    ...(observation === undefined ? {} : { observation }),
  });
  expect(
    await proveLaunchdJobOwnership({ paths, status: unloaded("not-found") })
  ).toBe(true);
  expect(
    await proveLaunchdJobOwnership({ paths, status: unloaded("failed") })
  ).toBe(false);
  expect(
    await proveLaunchdJobOwnership({ paths, status: unloaded(undefined) })
  ).toBe(false);
});

test("any continued line in the main unit file counts as a home binding", () => {
  const rendered =
    renderSystemdUnit({ hackBinPath: "/opt/hack/bin/hack" }) ?? "";
  const carried = rendered.replace(
    "[Service]\n",
    "[Service]\nEnvironment=FOO=1 \\\n  HACK_HOME=/srv/other/.hack\n"
  );
  expect(findDroppedHomeBinding({ unitText: carried, rendered })).toBe(
    "Environment=FOO=1 \\"
  );
  // Any continuation, even of an unrelated setting (trailing spaces too).
  const other = rendered.replace("[Service]\n", "[Service]\nNice=5 \\  \n  \n");
  expect(findDroppedHomeBinding({ unitText: other, rendered })).not.toBeNull();
  // The rendered unit itself has none.
  expect(findDroppedHomeBinding({ unitText: rendered, rendered })).toBeNull();
});

/**
 * A launchd job whose program and PATH are safe from other accounts: a
 * `hack` in a directory of this test's own, which is also the plist's only
 * PATH directory. Every kickstart checks both (HACK-2216). `plist(env)`
 * adds `env` entries to its EnvironmentVariables; `dir` is removed by the
 * caller.
 */
async function safeLaunchdJob(): Promise<{
  readonly dir: string;
  readonly plist: (env?: string) => string;
  /** What launchd reports loaded for that plist (its program and PATH). */
  readonly loaded: () => Promise<LaunchdLoadedJob>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "hack-launchd-job-"));
  await chmod(dir, 0o755);
  const program = join(dir, "hack");
  await writeFile(program, "#!/bin/sh\n");
  await chmod(program, 0o755);
  return {
    dir,
    loaded: () =>
      Promise.resolve({
        kind: "job",
        program,
        arguments: [program, "daemon", "start", "--foreground"],
        path: dir,
      }),
    plist: (env = "") =>
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>dance.hack.hackd</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>${program}</string>\n    <string>daemon</string>\n    <string>start</string>\n    <string>--foreground</string>\n  </array>\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key>\n    <string>${dir}</string>\n${env}\n  </dict>\n</dict>\n</plist>\n`,
  };
}

// Codex finding on PR #854: refuse before stopping a direct daemon.

test("launchd: an incompatible direct daemon is not replaced when the loaded job is another home's", async () => {
  const effects: string[] = [];
  const job = await safeLaunchdJob();
  const plistWith = (env: string) => job.plist(env);
  const hooks = (opts: {
    readonly plist: string;
    readonly proven: boolean;
  }) => ({
    paths: resolveDaemonPaths({ home: LAUNCHD_HOME }),
    trace: createDaemonCommandTrace(),
    pid: 777,
    compatible: false,
    waitForReady: () => Promise.reject(new Error("must not start")),
    readStatus: () =>
      Promise.resolve({
        installed: true,
        loaded: true,
        running: true,
        pid: 4242,
        exitStatus: null,
        observation: "reported" as const,
      }),
    isAncestor: () => Promise.resolve(false),
    readProgram: () =>
      Promise.resolve({
        kind: "ours" as const,
        program: "/opt/hack/bin/hack",
        resolved: "/opt/hack/bin/hack",
      }),
    readPlist: () => Promise.resolve(opts.plist),
    readLoaded: job.loaded,
    proveJob: () => Promise.resolve(opts.proven),
    repair: () => {
      effects.push("repair");
      return Promise.resolve("ok" as const);
    },
    kickstart: () => {
      effects.push("kickstart");
      return Promise.resolve({ ok: true });
    },
  });
  const otherHome = hooks({
    plist: plistWith(
      "    <key>HACK_HOME</key>\n    <string>/srv/other/.hack</string>"
    ),
    proven: true,
  });
  expect(await checkRunningLaunchdDaemon(otherHome)).toBe(1);
  expect(otherHome.trace.blocked).toBe("home-binding");
  expect([...otherHome.trace.stale]).toEqual(["version-mismatch"]);

  const unproven = hooks({ plist: plistWith(""), proven: false });
  expect(await checkRunningLaunchdDaemon(unproven)).toBe(1);
  expect(unproven.trace.blocked).toBe("unproven-owner");

  // This home's job: the replacement may go on (the caller stops and
  // restarts through launchd).
  const ours = hooks({ plist: plistWith(""), proven: true });
  expect(await checkRunningLaunchdDaemon(ours)).toBeNull();
  // Nothing was repaired or kickstarted while deciding.
  expect(effects).toEqual([]);
  await rm(job.dir, { recursive: true, force: true });
});

// Codex security finding on PR #854 (HACK-2216): every kickstart of the
// launchd job, current plist or not, checks its program and PATH first.

test("launchd: a current plist with an unsafe PATH stops nothing and kickstarts nothing", async () => {
  const job = await safeLaunchdJob();
  try {
    // The plist's only PATH directory becomes writable by the group.
    await chmod(job.dir, 0o775);
    const effects: string[] = [];
    const hooks = (running: boolean) => ({
      paths: resolveDaemonPaths({ home: LAUNCHD_HOME }),
      trace: createDaemonCommandTrace(),
      waitForReady: () => Promise.reject(new Error("must not start")),
      readStatus: () =>
        Promise.resolve({
          installed: true,
          loaded: true,
          running,
          pid: running ? 4242 : null,
          exitStatus: null,
          observation: "reported" as const,
        }),
      isAncestor: () => Promise.resolve(false),
      readProgram: () =>
        Promise.resolve({
          kind: "ours" as const,
          program: join(job.dir, "hack"),
          resolved: join(job.dir, "hack"),
        }),
      readPlist: () => Promise.resolve(job.plist()),
      readLoaded: job.loaded,
      proveJob: () => Promise.resolve(true),
      // No refresh is predicted (a source run): launchd starts the plist
      // as it is, which is what the check before a kickstart covers.
      executing: null,
      repair: () => {
        effects.push("repair");
        return Promise.resolve("ok" as const);
      },
      kickstart: () => {
        effects.push("kickstart");
        return Promise.resolve({ ok: true });
      },
    });

    // An incompatible running daemon under a current plist (a version
    // mismatch after an update): refused before anything is stopped.
    const replace = { ...hooks(true), pid: 4242, compatible: false };
    expect(await checkRunningLaunchdDaemon(replace)).toBe(1);
    expect(replace.trace.blocked).toBe("rewrite-refused");
    expect([...replace.trace.stale]).toEqual(["version-mismatch"]);

    // restart's check before its stop refuses the same job.
    const restart = hooks(true);
    expect(await refuseLaunchdBeforeReplacing(restart)).toBe(1);
    expect(restart.trace.blocked).toBe("rewrite-refused");
    expect(effects).toEqual([]);

    // A stopped service: start is not asked to kickstart it.
    const stopped = hooks(false);
    expect(await startViaLaunchdIfLoaded(stopped)).toBe(1);
    expect(stopped.trace.blocked).toBe("rewrite-refused");
    expect(stopped.trace.action).toBe("none");
    expect(effects).toEqual(["repair"]);

    // Control: with the directory safe again, the stopped service starts.
    await chmod(job.dir, 0o755);
    const safe = { ...hooks(false), waitForReady: () => Promise.resolve(true) };
    expect(await startViaLaunchdIfLoaded(safe)).toBe(0);
    expect(effects).toEqual(["repair", "repair", "kickstart"]);
    expect(
      await checkRunningLaunchdDaemon({
        ...hooks(true),
        pid: 4242,
        compatible: false,
      })
    ).toBeNull();
  } finally {
    await rm(job.dir, { recursive: true, force: true });
  }
});

// Review round 30 (HACK-2216): a kickstart runs launchd's LOADED
// configuration, so it must be the checked plist.

test("launchd: a safe plist with an unsafe loaded PATH never kickstarts the loaded configuration", async () => {
  const job = await safeLaunchdJob();
  const shared = await mkdtemp(join(tmpdir(), "hack-shared-bin-"));
  try {
    await chmod(shared, 0o777);
    const safeLoaded = await job.loaded();
    // What launchd still runs: the old configuration, with a PATH directory
    // everyone can write.
    const unsafeLoaded = { ...safeLoaded, path: shared } as const;
    const effects: string[] = [];
    const hooks = (opts: {
      readonly running: boolean;
      /** What launchd reports loaded before and after a reload. */
      readonly loaded: readonly LaunchdLoadedJob[];
      /** The job starts running after this many status reads. */
      readonly startsAfter?: number;
    }) => {
      let reads = 0;
      let statusReads = 0;
      return {
        paths: resolveDaemonPaths({ home: LAUNCHD_HOME }),
        trace: createDaemonCommandTrace(),
        waitForReady: () => Promise.resolve(true),
        readStatus: () => {
          statusReads += 1;
          const running =
            opts.running ||
            (opts.startsAfter !== undefined && statusReads > opts.startsAfter);
          return Promise.resolve({
            installed: true,
            loaded: true,
            running,
            pid: running ? 4242 : null,
            exitStatus: null,
            observation: "reported" as const,
          });
        },
        readPlist: () => Promise.resolve(job.plist()),
        readLoaded: () => {
          const loaded =
            opts.loaded[Math.min(reads, opts.loaded.length - 1)] ??
            unsafeLoaded;
          reads += 1;
          return Promise.resolve(loaded);
        },
        reloadJob: () => {
          effects.push("reload");
          return Promise.resolve({ ok: true });
        },
        repair: () => Promise.resolve("ok" as const),
        kickstart: () => {
          effects.push("kickstart");
          return Promise.resolve({ ok: true });
        },
      };
    };

    // A running job is never reloaded (that would stop hackd) nor
    // kickstarted from the unchecked configuration.
    const running = hooks({ running: true, loaded: [unsafeLoaded] });
    expect(await startViaLaunchdIfLoaded(running)).toBe(1);
    expect(running.trace.blocked).toBe("rewrite-refused");
    expect(effects).toEqual([]);

    // A stopped job is reloaded from the checked plist; when launchd
    // still reports the unsafe configuration, nothing is kickstarted.
    const stale = hooks({ running: false, loaded: [unsafeLoaded] });
    expect(await startViaLaunchdIfLoaded(stale)).toBe(1);
    expect(stale.trace.blocked).toBe("rewrite-refused");
    expect(effects).toEqual(["reload"]);

    // An unreadable loaded configuration on a stopped job is reloaded from
    // the fully checked plist. A re-read that still cannot be parsed after
    // that successful reload is accepted (round 31 owner decision: reading
    // real `launchctl print` output is an unverified compatibility point),
    // so the job starts.
    effects.length = 0;
    const unreadable = hooks({
      running: false,
      loaded: [{ kind: "unknown", reason: "garbled" }],
    });
    expect(await startViaLaunchdIfLoaded(unreadable)).toBe(0);
    expect(effects).toEqual(["reload", "kickstart"]);

    // A positive mismatch after the reload still refuses (above, `stale`).
    // A job that starts running between the check and the reload is not
    // booted out: eligibility is read fresh right before the bootout.
    effects.length = 0;
    const startedMeanwhile = hooks({
      running: false,
      loaded: [unsafeLoaded],
      // start reads the status once; the fresh read before a reload sees
      // the job running.
      startsAfter: 1,
    });
    expect(await startViaLaunchdIfLoaded(startedMeanwhile)).toBe(1);
    expect(startedMeanwhile.trace.blocked).toBe("rewrite-refused");
    expect(effects).toEqual([]);

    // When the reload makes launchd run the checked plist, it starts.
    effects.length = 0;
    const reloaded = hooks({
      running: false,
      loaded: [unsafeLoaded, safeLoaded],
    });
    expect(await startViaLaunchdIfLoaded(reloaded)).toBe(0);
    expect(effects).toEqual(["reload", "kickstart"]);

    // The check before a running daemon is stopped refuses a loaded
    // configuration it cannot read.
    const replace = {
      ...hooks({ running: true, loaded: [{ kind: "unknown", reason: "x" }] }),
      pid: 4242,
      compatible: false,
      isAncestor: () => Promise.resolve(false),
      readProgram: () =>
        Promise.resolve({
          kind: "ours" as const,
          program: join(job.dir, "hack"),
          resolved: join(job.dir, "hack"),
        }),
      proveJob: () => Promise.resolve(true),
      executing: null,
    };
    effects.length = 0;
    expect(await checkRunningLaunchdDaemon(replace)).toBe(1);
    expect(replace.trace.blocked).toBe("rewrite-refused");
    expect(effects).toEqual([]);
  } finally {
    await rm(job.dir, { recursive: true, force: true });
    await rm(shared, { recursive: true, force: true });
  }
});

// Review round 31 (HACK-2216): an automatic start needs the plist's own
// PATH and exactly Hack's command, checked before any unload or bootstrap.

test("launchd: an automatic start needs the plist's own PATH and exactly Hack's command", async () => {
  const job = await safeLaunchdJob();
  try {
    const safe = job.plist();
    expect(await checkLaunchdJobBeforeStart({ plistText: safe })).toBeNull();

    // No PATH of its own: launchd's default or inherited PATH is not
    // checked, so it is not started automatically.
    const noPath = safe.replace(
      `    <key>PATH</key>\n    <string>${job.dir}</string>\n`,
      ""
    );
    expect(noPath).not.toContain("<key>PATH</key>");
    expect(await checkLaunchdJobBeforeStart({ plistText: noPath })).toContain(
      "sets no PATH"
    );
    // A loaded job without its own PATH never matches either.
    expect(
      loadedJobMatchesPlist({
        loaded: {
          kind: "job",
          program: join(job.dir, "hack"),
          arguments: [join(job.dir, "hack"), "daemon", "start", "--foreground"],
          path: null,
        },
        plistText: noPath,
      })
    ).toBe(false);

    // Custom arguments, and a `Program` that differs from the first
    // argument (launchd runs `Program`), are refused.
    const extraArg = safe.replace(
      "<string>--foreground</string>",
      "<string>--foreground</string>\n    <string>--other</string>"
    );
    expect(await checkLaunchdJobBeforeStart({ plistText: extraArg })).toContain(
      "other arguments"
    );
    const otherProgram = safe.replace(
      "  <key>ProgramArguments</key>",
      "  <key>Program</key>\n  <string>/bin/sh</string>\n  <key>ProgramArguments</key>"
    );
    expect(
      await checkLaunchdJobBeforeStart({ plistText: otherProgram })
    ).toContain("other arguments");

    // start on such a plist (not refreshed: not Hack's) unloads, reloads
    // and kickstarts nothing.
    for (const plistText of [noPath, extraArg, otherProgram]) {
      const effects: string[] = [];
      const trace = createDaemonCommandTrace();
      const code = await startViaLaunchdIfLoaded({
        paths: resolveDaemonPaths({ home: LAUNCHD_HOME }),
        trace,
        waitForReady: () => Promise.resolve(true),
        readStatus: () =>
          Promise.resolve({
            installed: true,
            loaded: true,
            running: false,
            pid: null,
            exitStatus: null,
            observation: "reported" as const,
          }),
        readPlist: () => Promise.resolve(plistText),
        readLoaded: () => Promise.resolve({ kind: "unknown", reason: "x" }),
        reloadJob: () => {
          effects.push("reload");
          return Promise.resolve({ ok: true });
        },
        repair: () => Promise.resolve("unmanaged" as const),
        kickstart: () => {
          effects.push("kickstart");
          return Promise.resolve({ ok: true });
        },
      });
      expect(code).toBe(1);
      expect(trace.blocked).toBe("rewrite-refused");
      expect(effects).toEqual([]);
    }
  } finally {
    await rm(job.dir, { recursive: true, force: true });
  }
});

// Review rounds 10 and 11 (HACK-2216): a replacement does not leave hackd
// stopped, but never starts a second daemon next to a pending manager.

type ReplacementCase = {
  readonly outcome?: ReplacementStartOutcome;
  readonly rejects?: Error;
  readonly running?: boolean;
  readonly managerState?: ServiceManagerState;
  readonly directCode?: number;
  /** What the started hackd reports when verified; null: this CLI's. */
  readonly verified?: string | null;
};

async function runReplacement(c: ReplacementCase) {
  const trace = createDaemonCommandTrace();
  const steps: string[] = [];
  const asked: Array<"systemd" | "launchd" | null> = [];
  let thrown: unknown = null;
  let code: number | null = null;
  try {
    code = await startReplacementDaemon({
      trace,
      startViaService: () => {
        steps.push("service");
        if (c.rejects) {
          return Promise.reject(c.rejects);
        }
        return Promise.resolve(
          c.outcome ?? {
            kind: "service-attempted",
            exitCode: 1,
            manager: "systemd",
          }
        );
      },
      startDirect: () => {
        steps.push("direct");
        return Promise.resolve(c.directCode ?? 0);
      },
      isRunning: () => Promise.resolve(c.running ?? false),
      managerState: (manager) => {
        asked.push(manager);
        return Promise.resolve(c.managerState ?? "idle");
      },
      verifyStarted: () => Promise.resolve(c.verified ?? null),
    });
  } catch (error: unknown) {
    thrown = error;
  }
  return { code, thrown, steps, asked, trace };
}

// Codex finding on PR #854 (HACK-2216): a replacement only counts when the
// started hackd is this CLI's, and a direct start runs this CLI itself.

test("a replacement whose started hackd reports an older version fails, not restarted", async () => {
  // Through the service.
  const viaService = await runReplacement({
    outcome: { kind: "service-attempted", exitCode: 0, manager: "systemd" },
    verified: "it reports version 1.0.0, not this CLI's",
  });
  expect(viaService.code).toBe(1);
  expect(viaService.trace.action).toBe("none");
  // Through the direct fallback.
  const viaDirect = await runReplacement({
    verified: "it reports version 1.0.0, not this CLI's",
  });
  expect(viaDirect.steps).toEqual(["service", "direct"]);
  expect(viaDirect.code).toBe(1);
  expect(viaDirect.trace.action).toBe("none");
  expect(viaDirect.trace.fallback).toBeNull();
});

test("a replacement is verified on this home's socket and this CLI's version", () => {
  expect(
    describeUnverifiedReplacement({
      reachable: true,
      compatible: true,
      version: "2.0.0",
    })
  ).toBeNull();
  expect(
    describeUnverifiedReplacement({
      reachable: true,
      compatible: false,
      version: "1.0.0",
    })
  ).toContain("1.0.0");
  expect(
    describeUnverifiedReplacement({
      reachable: false,
      compatible: false,
      version: null,
    })
  ).toContain("does not answer");
});

test("a replacement's direct start runs the executing CLI, never the hack first on PATH", () => {
  // A compiled binary run by absolute path (as `hack update` runs the new
  // one) while an older `hack` comes first on PATH.
  expect(
    executingDaemonArgv({
      main: "/$bunfs/root/hack",
      execPath: "/srv/new/bin/hack",
    })
  ).toEqual(["/srv/new/bin/hack", "daemon", "start", "--foreground"]);
  // A source invocation keeps its runtime and entry point.
  expect(
    executingDaemonArgv({
      main: "/srv/checkout/index.ts",
      execPath: "/srv/runtime/bun",
    })
  ).toEqual([
    "/srv/runtime/bun",
    "/srv/checkout/index.ts",
    "daemon",
    "start",
    "--foreground",
  ]);
});

test("a failed service start falls back to a direct start once the manager is idle", async () => {
  const r = await runReplacement({
    outcome: { kind: "service-attempted", exitCode: 1, manager: "systemd" },
  });
  expect(r.code).toBe(0);
  expect(r.steps).toEqual(["service", "direct"]);
  expect(r.asked).toEqual(["systemd"]);
  expect(r.trace).toMatchObject({ action: "restarted", fallback: "direct" });
  expect(
    buildDaemonCommandData({
      command: "start",
      trace: r.trace,
      daemon: { running: true, pid: 9, version: "2.0.0" },
      cliVersion: "2.0.0",
    })
  ).toMatchObject({ action: "restarted", fallback: "direct" });
});

test("a service still activating (no pid or socket yet) gets no direct start", async () => {
  for (const managerState of ["pending", "unknown"] as const) {
    const r = await runReplacement({
      outcome: { kind: "service-attempted", exitCode: 1, manager: "systemd" },
      running: false,
      managerState,
    });
    expect(r.code).toBe(1);
    expect(r.steps).toEqual(["service"]);
    expect(r.trace.blocked).toBe("service-pending");
    expect(r.trace.fallback).toBeNull();
  }
});

test("a rejected service start is treated as a failed one, behind the same gate", async () => {
  const boom = new Error("systemctl crashed");
  const idle = await runReplacement({ rejects: boom });
  expect(idle.thrown).toBeNull();
  expect(idle.code).toBe(0);
  expect(idle.steps).toEqual(["service", "direct"]);
  // Which manager got how far is unknown: the platform's own is asked.
  expect(idle.asked).toEqual([null]);
  expect(idle.trace.fallback).toBe("direct");
  // Pending, or the direct start fails too: the original error stands.
  const pending = await runReplacement({
    rejects: boom,
    managerState: "pending",
  });
  expect(pending.thrown).toBe(boom);
  expect(pending.steps).toEqual(["service"]);
  const failing = await runReplacement({ rejects: boom, directCode: 1 });
  expect(failing.thrown).toBe(boom);
  expect(failing.steps).toEqual(["service", "direct"]);
});

test("an early service refusal with an empty trace still falls back", async () => {
  // As an untrusted unit refuses before systemd is asked: nothing was
  // recorded on the trace, but the outcome says the service refused.
  const r = await runReplacement({
    outcome: { kind: "service-refused", exitCode: 1, manager: "systemd" },
  });
  expect(r.code).toBe(0);
  expect(r.steps).toEqual(["service", "direct"]);
  expect(r.trace.manager).toBe("none");
  expect(r.trace.fallback).toBe("direct");
});

test("no direct start when the service worked, hackd already answers, or the start was direct", async () => {
  const ok = await runReplacement({
    outcome: { kind: "service-attempted", exitCode: 0, manager: "launchd" },
  });
  expect(ok.code).toBe(0);
  expect(ok.steps).toEqual(["service"]);
  expect(ok.trace.fallback).toBeNull();
  const answering = await runReplacement({ running: true });
  expect(answering.steps).toEqual(["service"]);
  expect(answering.code).toBe(1);
  const direct = await runReplacement({
    outcome: { kind: "direct-attempted", exitCode: 1, manager: null },
  });
  expect(direct.steps).toEqual(["service"]);
  expect(direct.asked).toEqual([]);
  const failing = await runReplacement({ directCode: 1 });
  expect(failing.code).toBe(1);
  expect(failing.trace.fallback).toBeNull();
});

test("systemd counts as idle only when inactive or failed, not restarting, with no job", () => {
  const show = (text: string, exitCode = 0) =>
    classifySystemdManagerState({ exitCode, stdout: text });
  expect(
    show("LoadState=loaded\nActiveState=inactive\nSubState=dead\nJob=\n")
  ).toBe("idle");
  expect(
    show("LoadState=loaded\nActiveState=failed\nSubState=failed\nJob=\n")
  ).toBe("idle");
  expect(show("LoadState=not-found\nActiveState=inactive\n")).toBe("idle");
  expect(
    show("LoadState=loaded\nActiveState=activating\nSubState=start\nJob=12\n")
  ).toBe("pending");
  expect(
    show(
      "LoadState=loaded\nActiveState=activating\nSubState=auto-restart\nJob=\n"
    )
  ).toBe("pending");
  expect(
    show("LoadState=loaded\nActiveState=inactive\nSubState=dead\nJob=34\n")
  ).toBe("pending");
  // A property left out, or a failed query, is not evidence.
  expect(show("LoadState=loaded\nActiveState=inactive\nSubState=dead\n")).toBe(
    "unknown"
  );
  expect(show("", 1)).toBe("unknown");
});

// Review round 12 (HACK-2216, owner decision): launchd is idle only on its
// own confirmed not-found answer for Hack's label.

test("launchd is idle only on launchctl's confirmed not-found answer", async () => {
  const answer =
    (exitCode: number, stdout: string, stderr = "") =>
    () =>
      Promise.resolve({ exitCode, stdout, stderr });
  const notFound = answer(
    113,
    "",
    'Bad request.\nCould not find service "dance.hack.hackd" in domain for port\n'
  );
  expect(await readLaunchdManagerState({ query: notFound })).toBe("idle");
  // Another failure, or the same message with another exit code.
  expect(
    await readLaunchdManagerState({ query: answer(5, "", "simulated failure") })
  ).toBe("unknown");
  expect(
    await readLaunchdManagerState({
      query: answer(1, "", "Could not find service"),
    })
  ).toBe("unknown");
});

test("a loaded launchd job is never idle, whatever its plist file says", async () => {
  const queried: string[] = [];
  const loaded = (stdout: string) => () => {
    queried.push("print");
    return Promise.resolve({ exitCode: 0, stdout, stderr: "" });
  };
  // Loaded but not running, its on-disk plist without KeepAlive: still
  // unknown (the loaded config can differ; StartInterval, WatchPaths...).
  expect(
    await readLaunchdManagerState({ query: loaded("state = not running\n") })
  ).toBe("unknown");
  expect(
    await readLaunchdManagerState({
      query: loaded("state = running\npid = 4242\n"),
    })
  ).toBe("unknown");
  expect(queried).toEqual(["print", "print"]);
});

// Codex findings on PR #854: restart's launchd check, and "this CLI" is
// the executing binary.

test("restart's launchd check refuses a job bound to another home before any stop", async () => {
  const trace = createDaemonCommandTrace();
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>dance.hack.hackd</string>\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>HACK_HOME</key>\n    <string>/srv/other/.hack</string>\n  </dict>\n</dict>\n</plist>\n`;
  const code = await refuseLaunchdBeforeReplacing({
    paths: resolveDaemonPaths({ home: LAUNCHD_HOME }),
    trace,
    waitForReady: () => Promise.reject(new Error("must not start")),
    readStatus: () =>
      Promise.resolve({
        installed: true,
        loaded: true,
        running: false,
        pid: null,
        exitStatus: null,
        observation: "reported" as const,
      }),
    readPlist: () => Promise.resolve(plist),
    proveJob: () => Promise.resolve(true),
  });
  expect(code).toBe(1);
  expect(trace).toMatchObject({ manager: "launchd", blocked: "home-binding" });
});

test("the executing CLI is the compiled binary, never a source invocation", () => {
  expect(
    resolveExecutingCliPath({
      main: "/$bunfs/root/hack",
      execPath: "/opt/hack-new/bin/hack",
    })
  ).toBe("/opt/hack-new/bin/hack");
  expect(
    resolveExecutingCliPath({
      main: "/srv/checkout/index.ts",
      execPath: "/opt/bun/bin/bun",
    })
  ).toBeNull();
});

// Review round 17 (HACK-2216): launchd retarget targets and running-daemon
// eligibility.

test("a launchd retarget target must be an installed, durable, trusted hack", async () => {
  const durable = () => Promise.resolve({ durable: true });
  const trusted = () => Promise.resolve(null);
  const head = (text: string) => () => Promise.resolve(text);
  // A source file selected from the invocation's arguments.
  expect(
    await checkLaunchdRetargetTarget("/srv/checkout/bin/hack-dev.ts", {
      readHead: head("console.log(1)\n"),
      assessDurability: durable,
      checkTrusted: trusted,
    })
  ).toContain("source file");
  // A `#!` script run by bun.
  expect(
    await checkLaunchdRetargetTarget("/opt/hack/bin/hack", {
      readHead: head("#!/usr/bin/env bun\nimport './index.ts'\n"),
      assessDurability: durable,
      checkTrusted: trusted,
    })
  ).toContain("run by bun");
  // Not durable.
  expect(
    await checkLaunchdRetargetTarget("/tmp/x/hack", {
      readHead: head("\u007fELF"),
      assessDurability: () =>
        Promise.resolve({
          durable: false,
          reason: "it is in a temporary directory",
        }),
      checkTrusted: trusted,
    })
  ).toContain("not a stable location");
  // An installed, durable, trusted binary.
  expect(
    await checkLaunchdRetargetTarget("/opt/hack/bin/hack", {
      readHead: head("\u007fELF"),
      assessDurability: durable,
      checkTrusted: trusted,
    })
  ).toBeNull();
});

test("a compatible running daemon is restarted after a repair only when the repair ran", async () => {
  const job = await safeLaunchdJob();
  const run = async (
    repair: "repaired" | "unproven-owner" | "other-program"
  ) => {
    const kicked: string[] = [];
    const trace = createDaemonCommandTrace();
    const code = await startViaLaunchdIfLoaded({
      paths: resolveDaemonPaths({ home: LAUNCHD_HOME }),
      trace,
      onlyIfStale: true,
      waitForReady: () => Promise.resolve(true),
      readPlist: () => Promise.resolve(job.plist()),
      readLoaded: job.loaded,
      readStatus: () =>
        Promise.resolve({
          installed: true,
          loaded: true,
          running: true,
          pid: 4242,
          exitStatus: null,
          observation: "reported" as const,
        }),
      repair: () => Promise.resolve(repair),
      kickstart: () => {
        kicked.push("kickstart");
        return Promise.resolve({ ok: true });
      },
    });
    return { code, kicked, trace };
  };
  const repaired = await run("repaired");
  expect(repaired.code).toBe(0);
  expect(repaired.kicked).toEqual(["kickstart"]);
  expect(repaired.trace.action).toBe("reinstalled");
  for (const refused of ["unproven-owner", "other-program"] as const) {
    const kept = await run(refused);
    expect(kept.code).toBeNull();
    expect(kept.kicked).toEqual([]);
    expect(kept.trace.blocked).toBe(refused);
  }
  await rm(job.dir, { recursive: true, force: true });
});

// Review round 19 (HACK-2216): replacing an incompatible launchd daemon
// whose plist names a missing program needs the same eligibility as the
// retarget that follows the stop.

test("an incompatible launchd daemon with a missing plist program is only replaced by its retarget target", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hack-replace-target-"));
  // The PATH a retarget would give hackd includes $HOME/.bun/bin and
  // $HOME/.hack/bin, checked with the real home. Use this test's own empty
  // home, so a developer's own ~/.bun or ~/.hack cannot decide the result.
  const savedHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const target = join(dir, "hack");
    const other = join(dir, "hack-other");
    await writeOwnedFixture(target, "#!/bin/sh\n");
    await writeOwnedFixture(other, "#!/bin/sh\n");
    const run = async (opts: {
      readonly executing: string | null;
      readonly unfit?: boolean;
    }) => {
      const trace = createDaemonCommandTrace();
      const effects: string[] = [];
      const code = await checkRunningLaunchdDaemon({
        paths: resolveDaemonPaths({ home: LAUNCHD_HOME }),
        trace,
        pid: 777,
        compatible: false,
        waitForReady: () => Promise.reject(new Error("must not start")),
        // The launchd job runs this home's hackd (pid 777); this command
        // is not one of its descendants.
        readStatus: () =>
          Promise.resolve({
            installed: true,
            loaded: true,
            running: true,
            pid: 777,
            exitStatus: null,
            observation: "reported" as const,
          }),
        isAncestor: () => Promise.resolve(false),
        // The rendered PATH's system directories: this test's own, not the
        // host's (HACK-2142).
        systemPathDirectories: [dir],
        readProgram: () =>
          Promise.resolve({
            kind: "missing" as const,
            program: "/gone/hack",
            resolved: target,
          }),
        readPlist: () =>
          Promise.resolve(
            '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>dance.hack.hackd</string>\n</dict>\n</plist>\n'
          ),
        proveJob: () => Promise.resolve(true),
        executing: opts.executing,
        validateRetarget: () =>
          Promise.resolve(opts.unfit ? "not a stable location" : null),
        repair: () => {
          effects.push("repair");
          return Promise.resolve("ok" as const);
        },
        kickstart: () => {
          effects.push("kickstart");
          return Promise.resolve({ ok: true });
        },
      });
      return { code, trace, effects };
    };

    // A source run: refused before any stop.
    const source = await run({ executing: null });
    expect(source.code).toBe(1);
    expect(source.trace.blocked).toBe("unproven-owner");
    // A compiled CLI that is not the retarget target: refused.
    const another = await run({ executing: other });
    expect(another.code).toBe(1);
    expect(another.trace.blocked).toBe("other-program");
    // A retarget target unfit for a login service: refused.
    const unfit = await run({ executing: target, unfit: true });
    expect(unfit.code).toBe(1);
    expect(unfit.trace.blocked).toBe("rewrite-refused");
    // The compiled CLI that is the target: the replacement may go on
    // (null: the caller stops the daemon and starts through launchd).
    const eligible = await run({ executing: target });
    expect(eligible.code).toBeNull();
    expect(eligible.trace.blocked).toBeNull();
    // Deciding never repaired or kickstarted anything.
    for (const r of [source, another, unfit, eligible]) {
      expect(r.effects).toEqual([]);
    }

    // restart's pre-stop check applies the same rule.
    const restartTrace = createDaemonCommandTrace();
    expect(
      await refuseLaunchdBeforeReplacing({
        paths: resolveDaemonPaths({ home: LAUNCHD_HOME }),
        trace: restartTrace,
        waitForReady: () => Promise.reject(new Error("must not start")),
        readStatus: () =>
          Promise.resolve({
            installed: true,
            loaded: true,
            running: false,
            pid: null,
            exitStatus: null,
            observation: "reported" as const,
          }),
        readProgram: () =>
          Promise.resolve({
            kind: "missing" as const,
            program: "/gone/hack",
            resolved: target,
          }),
        readPlist: () =>
          Promise.resolve(
            '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>dance.hack.hackd</string>\n</dict>\n</plist>\n'
          ),
        proveJob: () => Promise.resolve(true),
        executing: null,
        validateRetarget: () => Promise.resolve(null),
        systemPathDirectories: [dir],
      })
    ).toBe(1);
    expect(restartTrace.blocked).toBe("unproven-owner");
  } finally {
    if (savedHome === undefined) {
      Reflect.deleteProperty(process.env, "HOME");
    } else {
      process.env.HOME = savedHome;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

// Codex security finding on PR #854 (HACK-2216): the post-update step runs
// the new executable only from a trusted path, while it is still exactly
// the file the update published.

/** A published `hack` in its own directory, with the identity publish saw. */
async function publishedBinary(): Promise<{
  readonly dir: string;
  readonly path: string;
  readonly installed: InstalledBinary;
}> {
  const dir = await mkdtemp(join(tmpdir(), "hack-installed-"));
  await chmod(dir, 0o755);
  const path = join(dir, "hack");
  await writeFile(path, "#!/bin/sh\necho new\n");
  await chmod(path, 0o755);
  const info = await stat(path);
  return {
    dir,
    path,
    installed: {
      dev: Number(info.dev),
      ino: Number(info.ino),
      sha256: createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    },
  };
}

/** The post-update step on a running service, recording what it runs. */
async function reconcileWith(opts: {
  readonly path: string;
  readonly installed: InstalledBinary;
}): Promise<{
  readonly result: PostUpdateDaemonResult;
  readonly ran: string[][];
}> {
  const ran: string[][] = [];
  const result = await reconcileDaemonAfterUpdate({
    binaryPath: opts.path,
    installed: opts.installed,
    observe: () =>
      Promise.resolve({ serviceInstalled: true, daemonRunning: true }),
    runCli: (argv) => {
      ran.push([...argv]);
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          data: {
            schema: "hack.daemon-start.v1",
            manager: "systemd",
            action: "none",
            stale_reasons: [],
          },
        }),
      });
    },
  });
  return { result, ran };
}

test("after an update, the new executable runs only when its path is trusted and it is the published file", async () => {
  const published = await publishedBinary();
  try {
    // Control: trusted and unchanged, so it runs.
    const control = await reconcileWith(published);
    expect(control.ran).toEqual([
      [published.path, "daemon", "start", "--json"],
    ]);
    expect(control.result.status).toBe("reconciled");

    // A link at the final component is never run.
    const link = join(published.dir, "hack-link");
    await symlink(published.path, link);
    const linked = await reconcileWith({ ...published, path: link });
    expect(linked.ran).toEqual([]);
    expect(linked.result).toMatchObject({
      status: "failed",
      next_step: "hack daemon start",
    });

    // The binary was replaced after publish (another inode, same path).
    const replacement = join(published.dir, "payload");
    await writeFile(replacement, "#!/bin/sh\necho payload\n");
    await chmod(replacement, 0o755);
    await rename(replacement, published.path);
    const replaced = await reconcileWith(published);
    expect(replaced.ran).toEqual([]);
    expect(replaced.result).toMatchObject({
      status: "failed",
      next_step: "hack daemon start",
    });
    expect(
      replaced.result.status === "failed" ? replaced.result.message : ""
    ).toContain("replaced after the update installed it");
  } finally {
    await rm(published.dir, { recursive: true, force: true });
  }
});

test("after an update, an install directory others can write is never run from", async () => {
  const published = await publishedBinary();
  try {
    // Another account could rename a payload over the binary.
    await chmod(published.dir, 0o777);
    const untrusted = await reconcileWith(published);
    expect(untrusted.ran).toEqual([]);
    expect(untrusted.result).toMatchObject({
      status: "failed",
      next_step: "hack daemon start",
    });
    // The update itself is never failed by this step.
    expect(untrusted.result.status).not.toBe("reconciled");
  } finally {
    await chmod(published.dir, 0o755);
    await rm(published.dir, { recursive: true, force: true });
  }
});

test("an update that did not record its binary runs nothing", async () => {
  expect(
    await verifyInstalledBinary({ path: "/srv/hack", installed: undefined })
  ).toContain("did not record");
});

// Codex security finding on PR #854 (HACK-2216): launchd tools run by
// absolute path, never from PATH, where a planted binary would run as this
// user after `hack update`.

test("launchctl and ps run by absolute path, never looked up on PATH", () => {
  expect(LAUNCHCTL_PATH).toBe("/bin/launchctl");
  expect(launchctlArgv(["print", "gui/501/dance.hack.hackd"])).toEqual([
    "/bin/launchctl",
    "print",
    "gui/501/dance.hack.hackd",
  ]);
  expect(PS_PATH).toBe("/bin/ps");
  expect(psParentArgv(4242)).toEqual(["/bin/ps", "-o", "ppid=", "-p", "4242"]);
});
