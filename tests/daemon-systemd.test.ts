import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installDaemonSystemdService,
  startViaSystemdIfInstalled,
} from "../src/commands/daemon-systemd.ts";
import { resolveDaemonPaths } from "../src/daemon/paths.ts";
import { summarizeSystemdService } from "../src/daemon/service-summary.ts";
import {
  buildDaemonRepairMessage,
  buildDaemonStatusReport,
} from "../src/daemon/status.ts";
import {
  extractSystemdExecProgram,
  installSystemdUnit,
  isPidInSystemdUnit,
  probeSystemdUserManager,
  readSystemdServiceStatus,
  renderSystemdUnit,
  resolveSystemdAccess,
  resolveSystemdUnitPath,
  type ServiceCommandResult,
  type SystemdDeps,
  type SystemdServiceStatus,
  uninstallSystemdUnit,
} from "../src/daemon/systemd.ts";
import {
  buildDaemonServiceCheck,
  decideDaemonServiceFix,
} from "../src/lib/doctor-daemon-service.ts";

/**
 * The systemd path through a fake `systemctl`/`loginctl` runner (HACK-2052).
 * No real service manager is contacted and the unit is written only under a
 * temp XDG_CONFIG_HOME.
 */

type FakeOptions = {
  /** stderr for the availability probe; null means available. */
  readonly probeError?: {
    readonly exitCode: number;
    readonly stderr: string;
  } | null;
  readonly linger?: "yes" | "no" | null;
  readonly active?: boolean;
  readonly mainPid?: number;
};

type Fake = {
  readonly calls: string[];
  deps: SystemdDeps;
  enabled: boolean;
  active: boolean;
  failed: boolean;
};

let root: string;
let unitPath: string;
let program: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-systemd-"));
  unitPath = resolveSystemdUnitPath({
    env: { XDG_CONFIG_HOME: join(root, "config") },
  });
  program = join(root, "bin", "hack");
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(program, "#!/bin/sh\n");
  await chmod(program, 0o755);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function fakeSystemd(opts: FakeOptions = {}): Fake {
  const calls: string[] = [];
  const state: Fake = {
    calls,
    enabled: false,
    active: opts.active ?? false,
    failed: false,
    deps: undefined as unknown as SystemdDeps,
  };
  const ok = (stdout = ""): ServiceCommandResult => ({
    exitCode: 0,
    stdout,
    stderr: "",
  });
  const run: SystemdDeps["run"] = (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "loginctl") {
      return Promise.resolve(
        opts.linger === null
          ? { exitCode: 1, stdout: "", stderr: "Failed" }
          : ok(`${opts.linger ?? "yes"}\n`)
      );
    }
    const verbs = args.filter((a) => !a.startsWith("--"));
    const verb = verbs[0];
    if (verb === "show" && args.includes("--property=Version")) {
      return Promise.resolve(
        opts.probeError
          ? {
              exitCode: opts.probeError.exitCode,
              stdout: "",
              stderr: opts.probeError.stderr,
            }
          : ok("Version=255\n")
      );
    }
    if (verb === "show") {
      return Promise.resolve(
        ok(
          [
            "LoadState=loaded",
            `ActiveState=${state.failed ? "failed" : state.active ? "active" : "inactive"}`,
            `UnitFileState=${state.enabled ? "enabled" : "disabled"}`,
            `MainPID=${state.active ? (opts.mainPid ?? 4242) : 0}`,
          ].join("\n")
        )
      );
    }
    if (verb === "enable") {
      state.enabled = true;
    }
    if (verb === "disable") {
      state.enabled = false;
      if (args.includes("--now")) {
        state.active = false;
      }
    }
    if (verb === "reset-failed") {
      state.failed = false;
    }
    if (verb === "start" || verb === "restart") {
      if (state.failed) {
        return Promise.resolve({
          exitCode: 1,
          stdout: "",
          stderr: "Job failed: start request repeated too quickly",
        });
      }
      state.active = true;
    }
    if (verb === "stop") {
      state.active = false;
    }
    return Promise.resolve(ok());
  };
  state.deps = {
    env: { XDG_CONFIG_HOME: join(root, "config"), HOME: root },
    run,
    uid: 1000,
  };
  return state;
}

function unitText(): string {
  const text = renderSystemdUnit({ hackBinPath: program });
  if (!text) {
    throw new Error("unit did not render");
  }
  return text;
}

test("unit path follows XDG_CONFIG_HOME and ignores a relative value", () => {
  expect(
    resolveSystemdUnitPath({ env: { XDG_CONFIG_HOME: "/x/config" } })
  ).toBe("/x/config/systemd/user/hackd.service");
  expect(
    resolveSystemdUnitPath({ env: { XDG_CONFIG_HOME: "rel" }, home: "/h" })
  ).toBe("/h/.config/systemd/user/hackd.service");
});

test("access is denied by HACK_SYSTEMD_DISABLE and an isolated HACK_HOME", () => {
  expect(resolveSystemdAccess({ env: { HOME: "/h" } }).allowed).toBe(true);
  expect(
    resolveSystemdAccess({ env: { HOME: "/h", HACK_HOME: "/h/.hack" } }).allowed
  ).toBe(true);
  expect(
    resolveSystemdAccess({ env: { HOME: "/h", HACK_SYSTEMD_DISABLE: "1" } })
  ).toMatchObject({ allowed: false, reason: "disabled" });
  expect(
    resolveSystemdAccess({ env: { HOME: "/h", HACK_HOME: "/tmp/other" } })
  ).toMatchObject({ allowed: false, reason: "isolated-hack-home" });
  expect(
    resolveSystemdAccess({
      env: {
        HOME: "/h",
        HACK_HOME: "/tmp/other",
        HACK_SYSTEMD_ALLOW_ISOLATED_HOME: "1",
      },
    }).allowed
  ).toBe(true);
});

test("the unit runs the absolute hack path in the foreground with Restart=on-failure", () => {
  const text = renderSystemdUnit({ hackBinPath: "/opt/my tools%/hack" });
  expect(text).toContain(
    'ExecStart="/opt/my tools%%/hack" daemon start --foreground'
  );
  expect(text).toContain("Restart=on-failure");
  expect(text).toContain("WantedBy=default.target");
  expect(text).toContain("Environment=HACK_NO_INTERACTIVE=1");
  expect(extractSystemdExecProgram({ unitText: text ?? "" })).toBe(
    "/opt/my tools%/hack"
  );
  expect(renderSystemdUnit({ hackBinPath: "relative/hack" })).toBeNull();
  expect(renderSystemdUnit({ hackBinPath: "/a/$HOME/hack" })).toBeNull();
  expect(renderSystemdUnit({ hackBinPath: '/a/"q/hack' })).toBeNull();
  expect(renderSystemdUnit({ hackBinPath: "/a/b\nc/hack" })).toBeNull();
  expect(renderSystemdUnit({ hackBinPath: "/$bunfs/root/hack" })).toBeNull();
});

test("the availability probe tells a missing bus, a non-systemd host and no systemctl apart", async () => {
  const cases = [
    {
      probeError: {
        exitCode: 1,
        stderr: "Failed to connect to bus: No medium found",
      },
      reason: "no-user-bus",
    },
    {
      probeError: {
        exitCode: 1,
        stderr:
          "System has not been booted with systemd as init system (PID 1). Can't operate.",
      },
      reason: "not-systemd",
    },
    {
      probeError: { exitCode: 127, stderr: "systemctl not found" },
      reason: "no-systemctl",
    },
  ] as const;
  for (const c of cases) {
    const fake = fakeSystemd({ probeError: c.probeError });
    expect(await probeSystemdUserManager(fake.deps)).toMatchObject({
      available: false,
      reason: c.reason,
    });
  }
  expect(await probeSystemdUserManager(fakeSystemd().deps)).toEqual({
    available: true,
  });
});

test("install writes, reloads and enables; a second install is a no-op", async () => {
  const fake = fakeSystemd();
  const first = await installSystemdUnit({
    unitPath,
    unitText: unitText(),
    deps: fake.deps,
  });
  expect(first).toEqual({ ok: true, changed: true });
  expect(await readFile(unitPath, "utf8")).toBe(unitText());
  expect(fake.calls).toEqual([
    "systemctl --user --no-pager show --property=Version",
    "systemctl --user daemon-reload",
    "systemctl --user enable hackd.service",
  ]);

  fake.calls.length = 0;
  const second = await installSystemdUnit({
    unitPath,
    unitText: unitText(),
    deps: fake.deps,
  });
  expect(second).toEqual({ ok: true, changed: false });
  expect(fake.calls).not.toContain("systemctl --user daemon-reload");
});

test("install rewrites a drifted unit and reports the drift first", async () => {
  const fake = fakeSystemd();
  await mkdir(join(root, "config", "systemd", "user"), { recursive: true });
  await writeFile(
    unitPath,
    unitText().replace("RestartSec=2", "RestartSec=30")
  );

  const before = await readSystemdServiceStatus({
    unitPath,
    deps: fake.deps,
  });
  expect(before?.drift).toBe("content");

  const result = await installSystemdUnit({
    unitPath,
    unitText: unitText(),
    deps: fake.deps,
  });
  expect(result).toEqual({ ok: true, changed: true });
  expect(fake.calls).toContain("systemctl --user daemon-reload");
  const after = await readSystemdServiceStatus({
    unitPath,
    deps: fake.deps,
  });
  expect(after?.drift).toBe("none");
  expect(after?.enabled).toBe(true);
});

test("a unit for another existing hack is not drift", async () => {
  const fake = fakeSystemd();
  const other = join(root, "bin", "hack-other");
  await writeFile(other, "#!/bin/sh\n");
  await chmod(other, 0o755);
  const otherUnit = renderSystemdUnit({ hackBinPath: other });
  await mkdir(join(root, "config", "systemd", "user"), { recursive: true });
  await writeFile(unitPath, otherUnit ?? "");
  const status = await readSystemdServiceStatus({ unitPath, deps: fake.deps });
  expect(status?.drift).toBe("none");
  expect(status?.program).toBe(other);
});

test("a unit whose program was moved reports program-missing", async () => {
  const fake = fakeSystemd();
  await installSystemdUnit({ unitPath, unitText: unitText(), deps: fake.deps });
  await rm(program);
  const status = await readSystemdServiceStatus({
    unitPath,
    deps: fake.deps,
  });
  expect(status?.drift).toBe("program-missing");
  expect(status?.program).toBe(program);
});

test("install refuses without a user bus and writes nothing", async () => {
  const fake = fakeSystemd({
    probeError: {
      exitCode: 1,
      stderr: "Failed to connect to bus: No medium found",
    },
  });
  const result = await installSystemdUnit({
    unitPath,
    unitText: unitText(),
    deps: fake.deps,
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.unavailable?.reason).toBe("no-user-bus");
  }
  expect(await Bun.file(unitPath).exists()).toBe(false);
  expect(fake.calls).toEqual([
    "systemctl --user --no-pager show --property=Version",
  ]);
});

test("uninstall disables --now, removes the unit and reloads", async () => {
  const fake = fakeSystemd();
  await installSystemdUnit({ unitPath, unitText: unitText(), deps: fake.deps });
  fake.active = true;
  fake.calls.length = 0;

  expect(await uninstallSystemdUnit({ unitPath, deps: fake.deps })).toEqual({
    ok: true,
    notInstalled: false,
    managerNotified: true,
  });
  expect(fake.calls).toEqual([
    "systemctl --user --no-pager show --property=Version",
    "systemctl --user disable --now hackd.service",
    "systemctl --user daemon-reload",
  ]);
  expect(await Bun.file(unitPath).exists()).toBe(false);
  expect(fake.active).toBe(false);
});

test("uninstall without a unit calls nothing; without a bus it still removes the file", async () => {
  const fake = fakeSystemd();
  expect(
    await uninstallSystemdUnit({ unitPath, deps: fake.deps })
  ).toMatchObject({
    ok: true,
    notInstalled: true,
  });
  expect(fake.calls).toEqual([]);

  await installSystemdUnit({ unitPath, unitText: unitText(), deps: fake.deps });
  const noBus = fakeSystemd({
    probeError: { exitCode: 1, stderr: "Failed to connect to bus" },
  });
  expect(await uninstallSystemdUnit({ unitPath, deps: noBus.deps })).toEqual({
    ok: true,
    notInstalled: false,
    managerNotified: false,
  });
  expect(await Bun.file(unitPath).exists()).toBe(false);
});

test("a denied process never calls the runner", async () => {
  const fake = fakeSystemd();
  const deps = {
    ...fake.deps,
    env: { ...fake.deps.env, HACK_SYSTEMD_DISABLE: "1" },
  };
  expect(await readSystemdServiceStatus({ unitPath, deps })).toBeNull();
  expect(
    (await installSystemdUnit({ unitPath, unitText: unitText(), deps })).ok
  ).toBe(false);
  expect((await uninstallSystemdUnit({ unitPath, deps })).ok).toBe(false);
  expect(fake.calls).toEqual([]);
  expect(await Bun.file(unitPath).exists()).toBe(false);
});

function baseStatus(
  overrides: Partial<SystemdServiceStatus> = {}
): SystemdServiceStatus {
  return {
    unitPath: "/u/hackd.service",
    availability: { available: true },
    installed: true,
    loaded: true,
    enabled: true,
    active: true,
    activeState: "active",
    mainPid: 4242,
    program: "/usr/local/bin/hack",
    drift: "none",
    linger: true,
    ...overrides,
  };
}

test("the summary names one next step in priority order and detects ownership", () => {
  const summarize = (status: SystemdServiceStatus, daemonPid = 4242) =>
    summarizeSystemdService({
      status,
      daemonPid,
      daemonRunning: true,
    });

  const healthy = summarize(baseStatus());
  expect(healthy).toMatchObject({
    severity: "ok",
    nextStep: null,
    ownsDaemon: true,
  });
  expect(summarize(baseStatus(), 99).ownsDaemon).toBe(false);

  expect(
    summarize(baseStatus({ installed: false, active: false }))
  ).toMatchObject({
    severity: "warn",
    nextStep: "hack daemon install",
    ownsDaemon: false,
  });
  expect(summarize(baseStatus({ drift: "content" })).nextStep).toBe(
    "hack daemon install"
  );
  expect(summarize(baseStatus({ drift: "program-missing" })).nextStep).toBe(
    "hack daemon install"
  );
  expect(summarize(baseStatus({ enabled: false })).nextStep).toBe(
    "hack daemon install"
  );
  expect(
    summarize(
      baseStatus({ active: false, activeState: "failed", mainPid: null }),
      4242
    )
  ).toMatchObject({ severity: "warn", nextStep: "hack daemon restart" });
  // A directly started hackd is running and systemd is not running it.
  expect(
    summarize(
      baseStatus({ active: false, activeState: "inactive", mainPid: null }),
      4242
    )
  ).toMatchObject({
    severity: "warn",
    nextStep: "hack daemon restart",
    ownsDaemon: false,
  });
  // A failed unit outranks linger.
  expect(
    summarize(
      baseStatus({ activeState: "failed", active: false, linger: false })
    ).nextStep
  ).toBe("hack daemon restart");
  expect(summarize(baseStatus({ linger: false }))).toMatchObject({
    severity: "warn",
    nextStep: "loginctl enable-linger",
  });
  expect(
    summarize(
      baseStatus({
        availability: { available: false, reason: "not-systemd", detail: "x" },
      })
    )
  ).toMatchObject({ severity: "ok", nextStep: null });
  expect(
    summarize(
      baseStatus({
        availability: { available: false, reason: "no-user-bus", detail: "x" },
      })
    )
  ).toMatchObject({ severity: "warn", nextStep: null });
});

test("doctor warns about a missing unit with the fix, and --fix only offers install", () => {
  const missing = summarizeSystemdService({
    status: baseStatus({ installed: false, active: false, enabled: false }),
    daemonPid: null,
    daemonRunning: false,
  });
  expect(buildDaemonServiceCheck(missing)).toMatchObject({
    name: "daemon service",
    status: "warn",
  });
  expect(buildDaemonServiceCheck(missing)?.message).toContain(
    "(run: hack daemon install)"
  );
  expect(buildDaemonServiceCheck(null)).toBeNull();

  expect(
    decideDaemonServiceFix({ summary: missing, autostart: { allowed: true } })
  ).toEqual({ kind: "install" });
  expect(
    decideDaemonServiceFix({
      summary: missing,
      autostart: { allowed: false, message: "disabled" },
    })
  ).toMatchObject({ kind: "skip", command: "hack daemon install" });

  const lingerOff = summarizeSystemdService({
    status: baseStatus({ linger: false }),
    daemonPid: 4242,
    daemonRunning: true,
  });
  expect(
    decideDaemonServiceFix({ summary: lingerOff, autostart: { allowed: true } })
  ).toEqual({ kind: "none" });
});

test("status text and JSON name the same next step", () => {
  const stale = buildDaemonStatusReport({
    pid: 123,
    processRunning: false,
    socketExists: true,
    logExists: true,
    apiReachable: false,
    apiCompatible: false,
  });
  expect(
    buildDaemonRepairMessage({
      report: stale,
      launchdStatus: null,
      dockerBackendName: null,
      dockerReachable: true,
    })
  ).toContain(`Run: ${stale.nextStep}`);

  const loadedLaunchd = {
    installed: true,
    loaded: true,
    running: false,
    pid: null,
    exitStatus: 0,
  };
  const stopped = buildDaemonStatusReport({
    pid: null,
    processRunning: false,
    socketExists: false,
    logExists: true,
    apiReachable: false,
    apiCompatible: false,
    serviceLoaded: true,
  });
  expect(stopped.nextStep).toBe("hack daemon restart");
  expect(
    buildDaemonRepairMessage({
      report: stopped,
      launchdStatus: loadedLaunchd,
      dockerBackendName: null,
      dockerReachable: true,
    })
  ).toContain(`Run: ${stopped.nextStep}`);
});

function startHooks(fake: Fake, hackBinPath = program) {
  return {
    paths: resolveDaemonPaths({ home: root }),
    deps: fake.deps,
    waitForReady: () => Promise.resolve(true),
    resolveExpected: () => {
      const text = renderSystemdUnit({ hackBinPath });
      return Promise.resolve(text ? { hackBinPath, unitText: text } : null);
    },
  };
}

test("start rewrites a unit that runs another existing hack, then starts it", async () => {
  const fake = fakeSystemd();
  const old = join(root, "bin", "hack-old");
  await writeFile(old, "#!/bin/sh\n");
  await chmod(old, 0o755);
  await installSystemdUnit({
    unitPath,
    unitText: renderSystemdUnit({ hackBinPath: old }) ?? "",
    deps: fake.deps,
  });
  fake.calls.length = 0;

  expect(await startViaSystemdIfInstalled(startHooks(fake))).toBe(0);
  expect(await readFile(unitPath, "utf8")).toBe(unitText());
  const reload = fake.calls.indexOf("systemctl --user daemon-reload");
  const start = fake.calls.indexOf("systemctl --user start hackd.service");
  expect(reload).toBeGreaterThanOrEqual(0);
  expect(start).toBeGreaterThan(reload);
});

test("a start-time rewrite keeps a disabled unit disabled", async () => {
  const fake = fakeSystemd();
  const old = join(root, "bin", "hack-old");
  await writeFile(old, "#!/bin/sh\n");
  await chmod(old, 0o755);
  await installSystemdUnit({
    unitPath,
    unitText: renderSystemdUnit({ hackBinPath: old }) ?? "",
    deps: fake.deps,
  });
  fake.enabled = false;
  fake.calls.length = 0;
  expect(await startViaSystemdIfInstalled(startHooks(fake))).toBe(0);
  expect(await readFile(unitPath, "utf8")).toBe(unitText());
  expect(fake.calls).not.toContain("systemctl --user enable hackd.service");
  expect(fake.enabled).toBe(false);
});

test("start leaves a current unit alone and only starts it", async () => {
  const fake = fakeSystemd();
  await installSystemdUnit({ unitPath, unitText: unitText(), deps: fake.deps });
  fake.calls.length = 0;
  expect(await startViaSystemdIfInstalled(startHooks(fake))).toBe(0);
  expect(fake.calls).not.toContain("systemctl --user daemon-reload");
  expect(fake.calls).toContain("systemctl --user start hackd.service");
});

test("start clears a failed unit before starting it", async () => {
  const fake = fakeSystemd();
  await installSystemdUnit({ unitPath, unitText: unitText(), deps: fake.deps });
  fake.failed = true;
  fake.calls.length = 0;
  expect(await startViaSystemdIfInstalled(startHooks(fake))).toBe(0);
  const reset = fake.calls.indexOf(
    "systemctl --user reset-failed hackd.service"
  );
  const start = fake.calls.indexOf("systemctl --user start hackd.service");
  expect(reset).toBeGreaterThanOrEqual(0);
  expect(start).toBeGreaterThan(reset);
  expect(fake.active).toBe(true);
});

test("start without an installed unit returns null and calls nothing", async () => {
  const fake = fakeSystemd();
  expect(await startViaSystemdIfInstalled(startHooks(fake))).toBeNull();
  expect(fake.calls).toEqual([]);
});

test("cgroup membership identifies hackd under a wrapper MainPID", async () => {
  const cgroup = (text: string | null) => () => Promise.resolve(text);
  expect(
    await isPidInSystemdUnit({
      pid: 1,
      readText: cgroup(
        "0::/user.slice/user-1000.slice/user@1000.service/app.slice/hackd.service\n"
      ),
    })
  ).toBe(true);
  expect(
    await isPidInSystemdUnit({
      pid: 1,
      readText: cgroup("0::/user.slice/user-1000.slice/session-3.scope\n"),
    })
  ).toBe(false);
  expect(
    await isPidInSystemdUnit({
      pid: 1,
      readText: cgroup("0::/system.slice/hackd.service\n"),
    })
  ).toBe(false);
  expect(
    await isPidInSystemdUnit({ pid: 1, readText: cgroup(null) })
  ).toBeNull();

  const owned = summarizeSystemdService({
    status: baseStatus({ mainPid: 100 }),
    daemonPid: 101,
    daemonRunning: true,
    daemonInUnit: true,
  });
  expect(owned.ownsDaemon).toBe(true);
  expect(owned.severity).toBe("ok");
});

test("install leaves a systemd-run hackd under a wrapper MainPID alone", async () => {
  // The pid file names a live process (this test runner); systemd's MainPID
  // is a different pid (a wrapper), but the pid runs in the unit's cgroup.
  const fake = fakeSystemd({ active: true, mainPid: 999_999 });
  const paths = resolveDaemonPaths({ home: root });
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.pidPath, `${process.pid}\n`);
  await installSystemdUnit({ unitPath, unitText: unitText(), deps: fake.deps });
  const stopped: number[] = [];
  const hooks = {
    ...startHooks(fake),
    paths,
    ignoredOptions: [],
    startDetached: () => Promise.resolve(0),
    stopDirect: (pid: number) => {
      stopped.push(pid);
      return Promise.resolve();
    },
  };

  await installDaemonSystemdService({
    ...hooks,
    isPidInUnit: () => Promise.resolve(true),
  });
  expect(stopped).toEqual([]);

  // Outside the unit's cgroup it is a directly started hackd and is handed over.
  await installDaemonSystemdService({
    ...hooks,
    isPidInUnit: () => Promise.resolve(false),
  });
  expect(stopped).toEqual([process.pid]);
});
