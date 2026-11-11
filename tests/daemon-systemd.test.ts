import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeSystemdIncompatibleOwner,
  installDaemonSystemdService,
  startViaSystemdIfInstalled,
  stopViaSystemdIfInstalled,
  uninstallDaemonSystemdService,
  withSystemdIncompatibleNextStep,
} from "../src/commands/daemon-systemd.ts";
import { resolveDaemonPaths } from "../src/daemon/paths.ts";
import { summarizeSystemdService } from "../src/daemon/service-summary.ts";
import {
  buildDaemonRepairMessage,
  buildDaemonStatusReport,
} from "../src/daemon/status.ts";
import {
  assessExecutableDurability,
  checkServiceExecutableTrusted,
  checkSystemdLoadedUnitPaths,
  checkSystemdUnitDirectoryChain,
  checkSystemdUnitDropIns,
  checkSystemdUnitFile,
  checkSystemdUnitLoadPaths,
  ensureOwnerWritableOnlyDirectories,
  extractSystemdExecProgram,
  installSystemdUnit,
  isPidInSystemdUnit,
  parseSystemdExecProgram,
  probeSystemdUserManager,
  readSystemdServiceStatus,
  renderSystemdUnit,
  resolveSystemdAccess,
  resolveSystemdUnitPath,
  retargetSystemdUnitProgram,
  type ServiceCommandResult,
  SYSTEMD_READ_ONLY_ENV,
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
  /** Fails every `daemon-reload` with this stderr. */
  readonly reloadError?: string;
};

type Fake = {
  readonly calls: string[];
  deps: SystemdDeps;
  enabled: boolean;
  active: boolean;
  failed: boolean;
  /** Fails `enable` with this stderr while set. */
  enableError: string | null;
  /** Fails the unit-specific `show` while set. */
  showFails: boolean;
  /** Overrides ActiveState, e.g. "activating" during a restart delay. */
  activeState: string | null;
  needsReload: boolean;
  /** The unit's effective `Environment=` as `systemctl show` prints it. */
  unitEnvironment: string;
  /** `EnvironmentFiles=` as `systemctl show` prints it ("" for none). */
  environmentFiles: string;
  /** `FragmentPath=` (defaults to the managed unit path). */
  fragmentPath: string | null;
  /** `DropInPaths=` as `systemctl show` prints it. */
  dropInPaths: string;
  /** The manager's `UnitPath=` (null: config and data dirs under the fixture). */
  unitSearchPath: string | null;
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
  // The service program's directory must not be group-writable, whatever
  // the runner's umask.
  await chmod(join(root, "bin"), 0o755);
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
    enableError: null,
    showFails: false,
    activeState: null,
    needsReload: false,
    unitEnvironment: "PATH=/usr/bin:/bin HACK_NO_INTERACTIVE=1",
    environmentFiles: "",
    fragmentPath: null,
    dropInPaths: "",
    unitSearchPath: null,
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
    if (verb === "show" && args.includes("--property=UnitPath")) {
      return Promise.resolve(
        ok(
          `UnitPath=${state.unitSearchPath ?? `${join(root, "config", "systemd", "user")} ${join(root, "data", "systemd", "user")}`}\n`
        )
      );
    }
    if (verb === "show" && state.showFails) {
      return Promise.resolve({
        exitCode: 1,
        stdout: "",
        stderr: "Failed to get properties: Connection timed out",
      });
    }
    if (
      verb === "show" &&
      args.includes("--property=Environment,EnvironmentFiles")
    ) {
      return Promise.resolve(
        ok(
          `Environment=${state.unitEnvironment}\nEnvironmentFiles=${state.environmentFiles}\n`
        )
      );
    }
    if (verb === "show") {
      return Promise.resolve(
        ok(
          [
            "LoadState=loaded",
            `ActiveState=${state.activeState ?? (state.failed ? "failed" : state.active ? "active" : "inactive")}`,
            `UnitFileState=${state.enabled ? "enabled" : "disabled"}`,
            `MainPID=${state.active ? (opts.mainPid ?? 4242) : 0}`,
            `NeedDaemonReload=${state.needsReload ? "yes" : "no"}`,
            `FragmentPath=${state.fragmentPath ?? unitPath}`,
            `DropInPaths=${state.dropInPaths}`,
          ].join("\n")
        )
      );
    }
    if (verb === "daemon-reload") {
      if (opts.reloadError) {
        return Promise.resolve({
          exitCode: 1,
          stdout: "",
          stderr: opts.reloadError,
        });
      }
      state.needsReload = false;
    }
    if (verb === "enable") {
      if (state.enableError) {
        return Promise.resolve({
          exitCode: 1,
          stdout: "",
          stderr: state.enableError,
        });
      }
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
      state.activeState = null;
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
    "systemctl --user --no-pager show --property=UnitPath",
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
    reloadError: null,
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
    reloadError: null,
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
    needsReload: false,
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
    // Fixtures live under the temp dir; treat them as durable unless a test
    // says otherwise.
    assessDurability: () => Promise.resolve({ durable: true } as const),
    resolveExpected: () => {
      const text = renderSystemdUnit({ hackBinPath });
      return Promise.resolve(text ? { hackBinPath, unitText: text } : null);
    },
  };
}

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

async function writeOldUnit(fake: Fake, extraLine?: string): Promise<string> {
  const old = join(root, "bin", "hack-old");
  await writeFile(old, "#!/bin/sh\n");
  await chmod(old, 0o755);
  let text = renderSystemdUnit({ hackBinPath: old }) ?? "";
  if (extraLine) {
    text = text.replace("[Service]\n", `[Service]\n${extraLine}\n`);
  }
  await installSystemdUnit({ unitPath, unitText: text, deps: fake.deps });
  fake.calls.length = 0;
  return old;
}

// Finding 4 / owner decision: start never rewrites a unit whose program exists.
test("start keeps a unit that runs another existing hack and only starts it", async () => {
  const fake = fakeSystemd();
  const old = await writeOldUnit(fake, "Nice=5");
  const before = await readFile(unitPath, "utf8");
  expect(await startViaSystemdIfInstalled(startHooks(fake))).toBe(0);
  expect(await readFile(unitPath, "utf8")).toBe(before);
  expect(before).toContain(`"${old}"`);
  expect(fake.calls).not.toContain("systemctl --user daemon-reload");
  expect(fake.calls).toContain("systemctl --user start hackd.service");
});

test("start retargets only ExecStart when the program is gone and the new one is durable", async () => {
  const fake = fakeSystemd();
  const old = await writeOldUnit(fake, "Nice=5");
  await rm(old);
  fake.enabled = false;
  fake.calls.length = 0;
  expect(await startViaSystemdIfInstalled(startHooks(fake))).toBe(0);
  const after = await readFile(unitPath, "utf8");
  expect(after).toContain(`ExecStart="${program}" daemon start --foreground`);
  // The user's line is kept, and a disabled unit stays disabled.
  expect(after).toContain("Nice=5");
  expect(fake.calls).not.toContain("systemctl --user enable hackd.service");
  const reload = fake.calls.indexOf("systemctl --user daemon-reload");
  expect(reload).toBeGreaterThanOrEqual(0);
  expect(
    fake.calls.indexOf("systemctl --user start hackd.service")
  ).toBeGreaterThan(reload);
});

test("start refuses to retarget a missing program to a non-durable path", async () => {
  const fake = fakeSystemd();
  const old = await writeOldUnit(fake);
  await rm(old);
  const before = await readFile(unitPath, "utf8");
  fake.calls.length = 0;
  const hooks = {
    ...startHooks(fake),
    assessDurability: () =>
      Promise.resolve({
        durable: false,
        reason: "it is in a temporary directory",
      } as const),
  };
  expect(await startViaSystemdIfInstalled(hooks)).toBe(1);
  expect(await readFile(unitPath, "utf8")).toBe(before);
  expect(fake.calls).not.toContain("systemctl --user daemon-reload");
  expect(fake.calls).not.toContain("systemctl --user start hackd.service");
});

test("durability: temp dirs, package caches and checkouts are not durable", async () => {
  const noGit = (_path: string) => Promise.resolve(false);
  const tempDirs = ["/scratch-tmp"];
  const assess = (path: string, exists = noGit) =>
    assessExecutableDurability({
      path,
      tempDirs,
      exists,
      resolveReal: (p) => Promise.resolve(p),
    });
  expect((await assess("/usr/local/bin/hack")).durable).toBe(true);
  expect((await assess("/opt/hack/bin/hack")).durable).toBe(true);
  expect((await assess("/tmp/x/hack")).durable).toBe(false);
  expect((await assess("/scratch-tmp/x/hack")).durable).toBe(false);
  expect((await assess("/srv/app/node_modules/.bin/hack")).durable).toBe(false);
  expect((await assess("/srv/u/.cache/hack/hack")).durable).toBe(false);
  const checkout = (path: string) =>
    Promise.resolve(path === "/srv/src/hack/.git");
  expect((await assess("/srv/src/hack/dist/hack", checkout)).durable).toBe(
    false
  );
});

test("retargeting keeps every other line of an edited unit", () => {
  const edited = `${unitText()}# my note\n`.replace(
    "RestartSec=2",
    "RestartSec=9"
  );
  const out = retargetSystemdUnitProgram({
    unitText: edited,
    hackBinPath: "/usr/local/bin/hack",
  });
  expect(out).toContain(
    'ExecStart="/usr/local/bin/hack" daemon start --foreground'
  );
  expect(out).toContain("RestartSec=9");
  expect(out).toContain("# my note");
});

// Finding 5 / owner decision: doctor --fix without a TTY never writes or reloads.
test("read-only start neither writes nor reloads the unit", async () => {
  const fake = fakeSystemd();
  fake.deps = {
    ...fake.deps,
    env: { ...fake.deps.env, [SYSTEMD_READ_ONLY_ENV]: "1" },
  };
  const old = await writeOldUnit(fake);
  await rm(old);
  const before = await readFile(unitPath, "utf8");
  fake.calls.length = 0;
  expect(await startViaSystemdIfInstalled(startHooks(fake))).toBe(1);
  expect(await readFile(unitPath, "utf8")).toBe(before);
  expect(fake.calls).not.toContain("systemctl --user daemon-reload");

  // With the program present but a reload pending, it starts without reloading.
  await writeFile(old, "#!/bin/sh\n");
  await chmod(old, 0o755);
  fake.needsReload = true;
  fake.calls.length = 0;
  expect(await startViaSystemdIfInstalled(startHooks(fake))).toBe(0);
  expect(fake.calls).not.toContain("systemctl --user daemon-reload");
  expect(fake.calls).toContain("systemctl --user start hackd.service");
});

// Finding 6: a reload left pending by a failed daemon-reload is completed on retry.
test("start completes a pending reload before starting", async () => {
  const fake = fakeSystemd();
  await installSystemdUnit({ unitPath, unitText: unitText(), deps: fake.deps });
  fake.needsReload = true;
  fake.calls.length = 0;
  expect(await startViaSystemdIfInstalled(startHooks(fake))).toBe(0);
  const reload = fake.calls.indexOf("systemctl --user daemon-reload");
  expect(reload).toBeGreaterThanOrEqual(0);
  expect(
    fake.calls.indexOf("systemctl --user start hackd.service")
  ).toBeGreaterThan(reload);
  expect(fake.needsReload).toBe(false);
});

test("a failed reload after a rewrite is recovered by the next install", async () => {
  const failing = fakeSystemd({
    reloadError: "Failed to reload daemon: timeout",
  });
  const first = await installSystemdUnit({
    unitPath,
    unitText: unitText(),
    deps: failing.deps,
  });
  expect(first.ok).toBe(false);
  // The file is written, systemd still has the old copy loaded.
  const fake = fakeSystemd();
  fake.needsReload = true;
  const status = await readSystemdServiceStatus({ unitPath, deps: fake.deps });
  expect(status?.needsReload).toBe(true);
  fake.calls.length = 0;
  const second = await installSystemdUnit({
    unitPath,
    unitText: unitText(),
    deps: fake.deps,
    forceReload: status?.needsReload === true,
  });
  expect(second).toEqual({ ok: true, changed: false });
  expect(fake.calls).toContain("systemctl --user daemon-reload");
});

// Finding 7: uninstall reports a failed final reload.
test("uninstall reports a failed final reload and what it already did", async () => {
  const fake = fakeSystemd({ reloadError: "Failed to reload daemon: timeout" });
  await writeFile(unitPath, unitText()).catch(async () => {
    await mkdir(join(root, "config", "systemd", "user"), { recursive: true });
    await writeFile(unitPath, unitText());
  });
  const result = await uninstallSystemdUnit({ unitPath, deps: fake.deps });
  expect(result).toEqual({
    ok: true,
    notInstalled: false,
    managerNotified: true,
    reloadError: "Failed to reload daemon: timeout",
  });
  expect(await Bun.file(unitPath).exists()).toBe(false);

  await mkdir(join(root, "config", "systemd", "user"), { recursive: true });
  await writeFile(unitPath, unitText());
  expect(await uninstallDaemonSystemdService({ deps: fake.deps })).toBe(1);
});

// Finding 2: stop goes through the manager even without a live pid.
test("stop cancels a pending restart through systemd without a live pid", async () => {
  const fake = fakeSystemd();
  await installSystemdUnit({ unitPath, unitText: unitText(), deps: fake.deps });
  fake.activeState = "activating";
  fake.calls.length = 0;
  expect(
    await stopViaSystemdIfInstalled({
      pid: null,
      hackHome: join(root, ".hack"),
      deps: fake.deps,
    })
  ).toEqual({
    handled: true,
    ownedPid: false,
    failed: null,
    refused: null,
  });
  expect(fake.calls).toContain("systemctl --user stop hackd.service");

  fake.calls.length = 0;
  expect(
    await stopViaSystemdIfInstalled({
      pid: null,
      hackHome: join(root, ".hack"),
      deps: fake.deps,
    })
  ).toEqual({
    handled: false,
    ownedPid: false,
    failed: null,
    refused: null,
  });
  expect(fake.calls).not.toContain("systemctl --user stop hackd.service");
});

test("an incompatible hackd that systemd runs from another hack is not replaced", async () => {
  const fake = fakeSystemd({ active: true, mainPid: 4242 });
  await writeOldUnit(fake);
  const message = await describeSystemdIncompatibleOwner({
    pid: 4242,
    deps: fake.deps,
    resolveExpected: startHooks(fake).resolveExpected,
  });
  expect(message).toContain("hack daemon install");
  expect(
    await describeSystemdIncompatibleOwner({
      pid: 777,
      deps: fake.deps,
      resolveExpected: startHooks(fake).resolveExpected,
      isPidInUnit: () => Promise.resolve(false),
    })
  ).toBeNull();
});

function installHooks(fake: Fake, stopped: number[]) {
  return {
    ...startHooks(fake),
    paths: resolveDaemonPaths({ home: root }),
    ignoredOptions: [],
    startDetached: () => Promise.resolve(0),
    stopDirect: (proof: { readonly pid: number }) => {
      stopped.push(proof.pid);
      return Promise.resolve(true);
    },
  };
}

async function writePidFile(pid: number | string): Promise<void> {
  const paths = resolveDaemonPaths({ home: root });
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.pidPath, `${pid}\n`);
}

// Finding 1: install signals only a proven hackd of this HACK_HOME.
test("install leaves an unrelated live process named by the pid file alone", async () => {
  const fake = fakeSystemd();
  // A recycled pid: a live process that is not hackd.
  const other = Bun.spawn(["sleep", "30"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    await writePidFile(other.pid);
    const stopped: number[] = [];
    // Real proof (no injection): it must refuse on identity alone.
    await installDaemonSystemdService(installHooks(fake, stopped));
    expect(stopped).toEqual([]);
    expect(other.exitCode).toBeNull();
    expect(process.kill(other.pid, 0)).toBe(true);
  } finally {
    other.kill("SIGKILL");
    await other.exited;
  }
});

test("install treats a pid of 0 as no daemon and signals nothing", async () => {
  const fake = fakeSystemd();
  await writePidFile(0);
  const stopped: number[] = [];
  let proved = 0;
  await installDaemonSystemdService({
    ...installHooks(fake, stopped),
    proveDaemon: () => {
      proved += 1;
      return Promise.resolve({
        kind: "refused",
        reason: "invalid-pid",
      } as const);
    },
  });
  expect(proved).toBe(0);
  expect(stopped).toEqual([]);
});

test("install hands over only a proven hackd and leaves a systemd-run one alone", async () => {
  const fake = fakeSystemd({ active: true, mainPid: 999_999 });
  // The pid file names a live process (this runner); proof is injected.
  await writePidFile(process.pid);
  await installSystemdUnit({ unitPath, unitText: unitText(), deps: fake.deps });
  const stopped: number[] = [];
  const owned = () =>
    Promise.resolve({
      kind: "owned",
      pid: process.pid,
      birth: "b",
      image: {
        executable: "/usr/local/bin/hack",
        argv: ["/usr/local/bin/hack", "daemon", "start", "--foreground"],
      },
    } as const);
  // Under a wrapper MainPID, the pid runs in the unit's cgroup: not stopped.
  await installDaemonSystemdService({
    ...installHooks(fake, stopped),
    isPidInUnit: () => Promise.resolve(true),
    proveDaemon: owned,
  });
  expect(stopped).toEqual([]);
  // Another state root's daemon (refused proof): not stopped.
  await installDaemonSystemdService({
    ...installHooks(fake, stopped),
    isPidInUnit: () => Promise.resolve(false),
    proveDaemon: () =>
      Promise.resolve({ kind: "refused", reason: "foreign-socket" } as const),
  });
  expect(stopped).toEqual([]);
  // A proven direct hackd outside the unit: handed over.
  await installDaemonSystemdService({
    ...installHooks(fake, stopped),
    isPidInUnit: () => Promise.resolve(false),
    proveDaemon: owned,
  });
  expect(stopped).toEqual([process.pid]);
});

test("install stops when a proven direct hackd could not be confirmed stopped", async () => {
  // Review r2 #6: the old hackd may still hold the socket; starting the unit
  // now would only make its copy exit.
  const fake = fakeSystemd({ mainPid: 999_999 });
  await writePidFile(process.pid);
  const code = await installDaemonSystemdService({
    ...installHooks(fake, []),
    isPidInUnit: () => Promise.resolve(false),
    proveDaemon: () =>
      Promise.resolve({
        kind: "owned",
        pid: process.pid,
        birth: "b",
        image: {
          executable: "/usr/local/bin/hack",
          argv: ["/usr/local/bin/hack", "daemon", "start", "--foreground"],
        },
      } as const),
    stopDirect: () => Promise.resolve(false),
  });
  expect(code).toBe(1);
  expect(fake.calls).not.toContain("systemctl --user start hackd.service");
  expect(fake.calls).not.toContain("systemctl --user restart hackd.service");
});

test("install fails when the ready hackd is not the one systemd runs", async () => {
  const fake = fakeSystemd({ mainPid: 999_999 });
  // A directly started hackd (this runner's pid) whose identity cannot be
  // proven is left running; it answers, but systemd does not run it.
  await writePidFile(process.pid);
  const stopped: number[] = [];
  const code = await installDaemonSystemdService({
    ...installHooks(fake, stopped),
    isPidInUnit: () => Promise.resolve(false),
    proveDaemon: () =>
      Promise.resolve({ kind: "refused", reason: "identity-unknown" } as const),
  });
  expect(code).toBe(1);
  expect(stopped).toEqual([]);

  // When systemd runs the ready hackd, install succeeds.
  expect(
    await installDaemonSystemdService({
      ...installHooks(fake, stopped),
      isPidInUnit: () => Promise.resolve(true),
    })
  ).toBe(0);
});

test("durability: a home directory kept in git is not a checkout", async () => {
  const home = "/users-home/example";
  const exists = (path: string) =>
    Promise.resolve(
      path === `${home}/.git` || path === `${home}/src/hack/.git`
    );
  const assess = (path: string) =>
    assessExecutableDurability({
      path,
      tempDirs: [],
      exists,
      home,
      resolveReal: (p) => Promise.resolve(p),
    });
  expect((await assess(`${home}/.local/bin/hack`)).durable).toBe(true);
  expect((await assess(`${home}/src/hack/dist/hack`)).durable).toBe(false);
});

test("durability: a stable path that resolves into a temp dir, cache or build output is not durable", async () => {
  // Review r2 #5: both the written path and its resolved target must pass.
  const targets: Record<string, string> = {
    "/usr/local/bin/hack-tmp": "/tmp/build-123/hack",
    "/usr/local/bin/hack-cache": "/srv/u/.cache/hack/hack",
    "/usr/local/bin/hack-checkout": "/srv/src/hack/dist/hack",
    "/usr/local/bin/hack": "/opt/hack/5.0.0/hack",
  };
  const assess = (path: string) =>
    assessExecutableDurability({
      path,
      tempDirs: [],
      exists: (p) => Promise.resolve(p === "/srv/src/hack/.git"),
      resolveReal: (p) => Promise.resolve(targets[p] ?? p),
    });
  const tmp = await assess("/usr/local/bin/hack-tmp");
  expect(tmp).toEqual({
    durable: false,
    reason:
      "it resolves to /tmp/build-123/hack, and it is in a temporary directory",
  });
  expect((await assess("/usr/local/bin/hack-cache")).durable).toBe(false);
  expect((await assess("/usr/local/bin/hack-checkout")).durable).toBe(false);
  expect((await assess("/usr/local/bin/hack")).durable).toBe(true);
  // A dangling symlink cannot be resolved: not durable.
  expect(
    (
      await assessExecutableDurability({
        path: "/usr/local/bin/hack",
        tempDirs: [],
        exists: () => Promise.resolve(false),
        resolveReal: () => Promise.reject(new Error("ENOENT")),
      })
    ).durable
  ).toBe(false);
});

test("durability: a real symlink into a temp dir is caught (real filesystem)", async () => {
  const stable = join(root, "stable");
  await mkdir(stable);
  const target = join(root, "target-hack");
  await writeFile(target, "#!/bin/sh\n");
  await symlink(target, join(stable, "hack"));
  const result = await assessExecutableDurability({
    path: join(stable, "hack"),
    // Only the target's directory is temporary here.
    tempDirs: [join(root, "target-hack")],
    exists: () => Promise.resolve(false),
  });
  expect(result.durable).toBe(false);
});

test("an ExecStart prefix or specifier is unknown, never a missing program", () => {
  const base = unitText();
  for (const exec of [
    `ExecStart=-${program} daemon start --foreground`,
    `ExecStart=@${program} hackd daemon start --foreground`,
    "ExecStart=%h/.local/bin/hack daemon start --foreground",
    `ExecStart="%h/.local/bin/hack" daemon start --foreground`,
    `ExecStart=${program}\\`,
  ]) {
    const text = base.replace(/^ExecStart=.*$/m, () => exec);
    expect(parseSystemdExecProgram({ unitText: text }).kind).toBe("unknown");
    expect(extractSystemdExecProgram({ unitText: text })).toBeNull();
    expect(
      retargetSystemdUnitProgram({ unitText: text, hackBinPath: program })
    ).toBeNull();
  }
  const twice = `${base}\nExecStart=${program} daemon start --foreground\n`;
  expect(parseSystemdExecProgram({ unitText: twice }).kind).toBe("unknown");
  // `%%` is the one specifier the parser reads.
  const percent = base.replace(
    /^ExecStart=.*$/m,
    () => 'ExecStart="/opt/100%%/hack" daemon start --foreground'
  );
  expect(parseSystemdExecProgram({ unitText: percent })).toEqual({
    kind: "path",
    path: "/opt/100%/hack",
  });
});

test("start leaves a unit with an ExecStart prefix or specifier as it is", async () => {
  // Review r2 #4: `-/opt/...` and `%h/...` used to read as a missing
  // program, and start rewrote the unit and dropped the prefix.
  const fake = fakeSystemd();
  await installSystemdUnit({ unitPath, unitText: unitText(), deps: fake.deps });
  for (const exec of [
    "ExecStart=-/opt/hack-old/hack daemon start --foreground",
    "ExecStart=%h/.local/bin/hack daemon start --foreground",
  ]) {
    const text = unitText().replace(/^ExecStart=.*$/m, () => exec);
    await writeFile(unitPath, text);
    const status = await readSystemdServiceStatus({
      unitPath,
      deps: fake.deps,
    });
    expect(status?.drift).toBe("program-unknown");
    fake.calls.length = 0;
    expect(await startViaSystemdIfInstalled(startHooks(fake))).toBe(0);
    expect(await readFile(unitPath, "utf8")).toBe(text);
    expect(fake.calls).not.toContain("systemctl --user daemon-reload");
    expect(fake.calls).toContain("systemctl --user start hackd.service");
  }
});

test("retargeting keeps systemd's $$ in the kept arguments", () => {
  const edited = unitText().replace(
    "daemon start --foreground",
    () => "daemon start --foreground --tag=a$$b"
  );
  expect(edited).toContain("--tag=a$$b");
  const out = retargetSystemdUnitProgram({
    unitText: edited,
    hackBinPath: "/usr/local/bin/hack",
  });
  expect(out).toContain(
    'ExecStart="/usr/local/bin/hack" daemon start --foreground --tag=a$$b'
  );
});

test("status and doctor point an incompatible systemd-run old hack at install", async () => {
  const fake = fakeSystemd({ active: true, mainPid: 4242 });
  await writeOldUnit(fake);
  const report = {
    status: "incompatible",
    pid: 4242,
    nextStep: "hack daemon restart",
  };
  const updated = await withSystemdIncompatibleNextStep({
    report,
    deps: fake.deps,
    resolveExpected: startHooks(fake).resolveExpected,
  });
  expect(updated.nextStep).toBe(
    process.platform === "linux" ? "hack daemon install" : "hack daemon restart"
  );
  expect(
    (
      await withSystemdIncompatibleNextStep({
        report: { ...report, status: "running" },
        deps: fake.deps,
      })
    ).nextStep
  ).toBe("hack daemon restart");
});

test("an install retry after a failed reload restarts the running service", async () => {
  // The file already has the new content (an earlier reload failed), the
  // unit is active with the old config loaded.
  const fake = fakeSystemd({ active: true, mainPid: 4242 });
  await installSystemdUnit({ unitPath, unitText: unitText(), deps: fake.deps });
  fake.needsReload = true;
  fake.calls.length = 0;
  const stopped: number[] = [];
  await installDaemonSystemdService({
    ...installHooks(fake, stopped),
    isPidInUnit: () => Promise.resolve(true),
  });
  const reload = fake.calls.indexOf("systemctl --user daemon-reload");
  const restart = fake.calls.indexOf("systemctl --user restart hackd.service");
  expect(reload).toBeGreaterThanOrEqual(0);
  expect(restart).toBeGreaterThan(reload);
  expect(fake.calls).not.toContain("systemctl --user start hackd.service");
});

test("a restart is kept pending across an enable failure", async () => {
  // The active unit runs an old program; install writes the new unit,
  // reloads, then enable fails before any restart.
  const fake = fakeSystemd({ active: true, mainPid: 4242 });
  await writeOldUnit(fake);
  fake.active = true;
  fake.enableError = "Failed to enable unit: Access denied";
  const stopped: number[] = [];
  const hooks = {
    ...installHooks(fake, stopped),
    isPidInUnit: () => Promise.resolve(true),
  };
  expect(await installDaemonSystemdService(hooks)).toBe(1);
  expect(await readFile(unitPath, "utf8")).toBe(unitText());
  expect(fake.calls).not.toContain("systemctl --user restart hackd.service");

  // Retry: the file is current and no reload is pending, but the running
  // service still has the old config, so install must restart it.
  fake.enableError = null;
  fake.calls.length = 0;
  await installDaemonSystemdService(hooks);
  expect(fake.calls).toContain("systemctl --user restart hackd.service");
  expect(fake.calls).not.toContain("systemctl --user start hackd.service");

  // Once restarted, a further install is a plain (no-op) start.
  fake.calls.length = 0;
  await installDaemonSystemdService(hooks);
  expect(fake.calls).not.toContain("systemctl --user restart hackd.service");
});

test("uninstall clears a leftover restart-pending marker", async () => {
  const fake = fakeSystemd();
  await installSystemdUnit({ unitPath, unitText: unitText(), deps: fake.deps });
  const daemonRoot = resolveDaemonPaths({ home: root }).root;
  await mkdir(daemonRoot, { recursive: true });
  const marker = join(daemonRoot, "hackd.service.restart-pending");
  await writeFile(marker, "x");
  expect(
    await uninstallDaemonSystemdService({ deps: fake.deps, daemonRoot })
  ).toBe(0);
  expect(await Bun.file(marker).exists()).toBe(false);
});

test("stop refuses, with the manual command, when the unit cannot be read", async () => {
  // Review r2 decision: an unreadable unit environment may belong to another
  // Hack home, so stop does not touch it and says how to stop it by hand.
  const fake = fakeSystemd();
  await installSystemdUnit({ unitPath, unitText: unitText(), deps: fake.deps });
  fake.activeState = "activating";
  fake.showFails = true;
  fake.calls.length = 0;
  const result = await stopViaSystemdIfInstalled({
    pid: null,
    hackHome: join(root, ".hack"),
    deps: fake.deps,
  });
  expect(result.handled).toBe(false);
  expect(result.refused).toContain("could not be read");
  expect(result.refused).toContain("systemctl --user stop hackd.service");
  expect(fake.calls).not.toContain("systemctl --user stop hackd.service");
});

test("stop refuses a unit whose effective Hack home is another one", async () => {
  const fake = fakeSystemd({ active: true });
  await installSystemdUnit({ unitPath, unitText: unitText(), deps: fake.deps });
  const stop = () =>
    stopViaSystemdIfInstalled({
      pid: null,
      hackHome: join(root, ".hack"),
      deps: fake.deps,
    });
  // A drop-in set HACK_HOME for the unit.
  fake.unitEnvironment = `"PATH=/usr/bin:/bin" HACK_HOME=/srv/other-home HACK_NO_INTERACTIVE=1`;
  fake.calls.length = 0;
  const foreign = await stop();
  expect(foreign.refused).toContain("/srv/other-home");
  expect(fake.calls).not.toContain("systemctl --user stop hackd.service");
  // An EnvironmentFile is not visible here: unknown, refused.
  fake.unitEnvironment = "HACK_NO_INTERACTIVE=1";
  fake.environmentFiles = "/srv/hackd.env (ignore_errors=no)";
  expect((await stop()).refused).toContain("EnvironmentFile");
  expect(fake.calls).not.toContain("systemctl --user stop hackd.service");
  // The same home, explicitly or by default: stopped.
  fake.environmentFiles = "";
  fake.unitEnvironment = `HACK_HOME=${join(root, ".hack")}`;
  expect((await stop()).handled).toBe(true);
  fake.active = true;
  fake.unitEnvironment = "HACK_NO_INTERACTIVE=1";
  expect((await stop()).handled).toBe(true);
});

test("install creates the unit directories without group write under a shared umask", async () => {
  // Codex security review: under umask 0002 the directories were 0775, so a
  // group member could replace the enabled unit.
  const fake = fakeSystemd();
  const previous = process.umask(0o002);
  try {
    const result = await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
    expect(result.ok).toBe(true);
  } finally {
    process.umask(previous);
  }
  for (const dir of [
    join(root, "config"),
    join(root, "config", "systemd"),
    join(root, "config", "systemd", "user"),
  ]) {
    expect((await stat(dir)).mode & 0o777).toBe(0o755);
  }
});

test("install removes group write from an existing unit directory it owns", async () => {
  const fake = fakeSystemd();
  const userDir = join(root, "config", "systemd", "user");
  await mkdir(userDir, { recursive: true });
  await chmod(userDir, 0o775);
  expect(
    (
      await installSystemdUnit({
        unitPath,
        unitText: unitText(),
        deps: fake.deps,
      })
    ).ok
  ).toBe(true);
  expect((await stat(userDir)).mode & 0o777).toBe(0o755);
});

test("the unit directory check refuses a directory owned by another user", async () => {
  const dir = join(root, "shared");
  await mkdir(dir);
  const own = process.getuid?.() ?? 0;
  const result = await ensureOwnerWritableOnlyDirectories({
    dirs: [dir],
    uid: own + 1,
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("owned by another user");
  }
  // A file where a directory belongs is refused too.
  const file = join(root, "not-a-dir");
  await writeFile(file, "");
  const notDir = await ensureOwnerWritableOnlyDirectories({ dirs: [file] });
  expect(notDir.ok).toBe(false);
});

test("drop-ins another account could have written are refused before use", async () => {
  // Codex security review: a pre-created hackd.service.d/override.conf
  // would replace ExecStart and run as this user.
  const userDir = join(root, "config", "systemd", "user");
  const dropInDir = join(userDir, "hackd.service.d");
  await mkdir(dropInDir, { recursive: true });
  const override = join(dropInDir, "override.conf");
  await writeFile(override, "[Service]\nExecStart=\nExecStart=/bin/true\n");
  const own = process.getuid?.() ?? 0;
  // Owned by another user (modelled with the uid the check compares to).
  const foreign = await checkSystemdUnitDropIns({ unitPath, uid: own + 1 });
  expect(foreign).toContain("owned by another user");
  // This user's drop-in that others could write: write access removed.
  await chmod(override, 0o666);
  expect(await checkSystemdUnitDropIns({ unitPath })).toBeNull();
  expect((await stat(override)).mode & 0o777).toBe(0o644);
  // The generic service.d is checked too.
  const generic = join(userDir, "service.d");
  await mkdir(generic);
  await writeFile(join(generic, "x.conf"), "");
  expect(await checkSystemdUnitDropIns({ unitPath, uid: own + 1 })).toContain(
    "owned by another user"
  );
});

test("install and start refuse a drop-in they cannot vouch for", async () => {
  const fake = fakeSystemd();
  await installSystemdUnit({ unitPath, unitText: unitText(), deps: fake.deps });
  // Not a regular file: refused like a foreign one.
  await mkdir(
    join(root, "config", "systemd", "user", "hackd.service.d", "odd"),
    {
      recursive: true,
    }
  );
  fake.calls.length = 0;
  expect(await startViaSystemdIfInstalled(startHooks(fake))).toBe(1);
  expect(fake.calls).not.toContain("systemctl --user start hackd.service");
  const install = await installSystemdUnit({
    unitPath,
    unitText: unitText(),
    deps: fake.deps,
  });
  expect(install.ok).toBe(false);
  expect(fake.calls).not.toContain("systemctl --user daemon-reload");
});

test("start runs only a unit file this user controls", async () => {
  // Codex security review: a planted or editable hackd.service would run
  // its ExecStart as this user.
  const fake = fakeSystemd();
  await installSystemdUnit({ unitPath, unitText: unitText(), deps: fake.deps });
  const userDir = join(root, "config", "systemd", "user");
  const own = process.getuid?.() ?? 0;

  // Owned by another user (modelled with the uid the check compares to).
  expect(await checkSystemdUnitFile({ unitPath, uid: own + 1 })).toContain(
    "owned by another user"
  );

  // This user's unit and directory, writable by the group: fixed, started.
  await chmod(unitPath, 0o664);
  await chmod(userDir, 0o775);
  fake.calls.length = 0;
  expect(await startViaSystemdIfInstalled(startHooks(fake))).toBe(0);
  expect((await stat(unitPath)).mode & 0o777).toBe(0o644);
  expect((await stat(userDir)).mode & 0o777).toBe(0o755);
  expect(fake.calls).toContain("systemctl --user start hackd.service");

  // A symlinked unit is not one Hack wrote: refused, not started.
  const elsewhere = join(root, "planted.service");
  await writeFile(elsewhere, unitText());
  await rm(unitPath);
  await symlink(elsewhere, unitPath);
  fake.calls.length = 0;
  expect(await startViaSystemdIfInstalled(startHooks(fake))).toBe(1);
  expect(fake.calls).not.toContain("systemctl --user start hackd.service");
});

test("start checks the files systemd actually loads, in every load path", async () => {
  // Codex security review: systemd merges drop-ins from every user-unit load
  // path ($XDG_DATA_HOME too); only the manager's own list is complete.
  const fake = fakeSystemd();
  await installSystemdUnit({ unitPath, unitText: unitText(), deps: fake.deps });
  const own = process.getuid?.() ?? 0;
  const dataDropIns = join(root, "data", "systemd", "user", "hackd.service.d");
  await mkdir(dataDropIns, { recursive: true });
  // Whatever the runner's umask, the load directories are not shared.
  for (const dir of ["data", "data/systemd", "data/systemd/user"]) {
    await chmod(join(root, dir), 0o755);
  }
  const dropIn = join(dataDropIns, "payload.conf");
  await writeFile(dropIn, "[Service]\nExecStart=\nExecStart=/bin/true\n");
  fake.dropInPaths = dropIn;

  // Another account's drop-in (modelled with the uid the check compares to).
  expect(
    await checkSystemdLoadedUnitPaths({
      unitPath,
      deps: fake.deps,
      uid: own + 1,
    })
  ).toContain("owned by another user");

  // A drop-in directory others can write, outside Hack's own directories:
  // refused and left unchanged; once fixed by hand, it starts.
  await chmod(dataDropIns, 0o777);
  fake.calls.length = 0;
  expect(await startViaSystemdIfInstalled(startHooks(fake))).toBe(1);
  expect(fake.calls).not.toContain("systemctl --user start hackd.service");
  expect((await stat(dataDropIns)).mode & 0o777).toBe(0o777);
  await chmod(dataDropIns, 0o755);
  await chmod(dropIn, 0o644);
  fake.calls.length = 0;
  expect(await startViaSystemdIfInstalled(startHooks(fake))).toBe(0);

  // A fragment other than the managed unit: refused, not started.
  fake.dropInPaths = "";
  fake.fragmentPath = join(root, "data", "systemd", "user", "hackd.service");
  fake.calls.length = 0;
  expect(await startViaSystemdIfInstalled(startHooks(fake))).toBe(1);
  expect(fake.calls).not.toContain("systemctl --user start hackd.service");

  // systemd cannot say: refused.
  fake.fragmentPath = null;
  fake.showFails = true;
  expect(
    await checkSystemdLoadedUnitPaths({ unitPath, deps: fake.deps })
  ).toContain("did not report");
});

test("the service program and every directory above it must be this user's or root's", async () => {
  // Codex security review: a group member who can replace `hack` gets the
  // enabled unit to run their program as this user.
  const hackHome = join(root, ".hack");
  const check = (path: string, uid?: number) =>
    checkServiceExecutableTrusted({ path, hackHome, uid });
  expect(await check(program)).toBeNull();

  // Outside the Hack home a group-writable directory is refused, unchanged.
  const shared = join(root, "shared-bin");
  await mkdir(shared);
  await chmod(shared, 0o775);
  const sharedHack = join(shared, "hack");
  await writeFile(sharedHack, "#!/bin/sh\n");
  await chmod(sharedHack, 0o755);
  expect(await check(sharedHack)).toContain("chmod go-w");
  expect((await stat(shared)).mode & 0o777).toBe(0o775);

  // A stable symlink into that directory is refused too.
  const stable = join(root, "stable");
  await mkdir(stable);
  await symlink(sharedHack, join(stable, "hack"));
  expect(await check(join(stable, "hack"))).toContain("chmod go-w");

  // A program file others can write is refused.
  await chmod(shared, 0o755);
  await chmod(sharedHack, 0o777);
  expect(await check(sharedHack)).toContain("writable by other users");
  await chmod(sharedHack, 0o755);

  // Inside the Hack home (an installer under umask 0002): fixed.
  const hackBin = join(hackHome, "bin");
  await mkdir(hackBin, { recursive: true });
  await chmod(hackBin, 0o775);
  const installed = join(hackBin, "hack");
  await writeFile(installed, "#!/bin/sh\n");
  await chmod(installed, 0o755);
  expect(await check(installed)).toBeNull();
  expect((await stat(hackBin)).mode & 0o777).toBe(0o755);

  // Another account's program (modelled with the uid the check compares to).
  const own = process.getuid?.() ?? 0;
  expect(await check(installed, own + 1)).toContain("owned by another user");
});

test("install refuses a program in a directory others can write and writes no unit", async () => {
  const fake = fakeSystemd();
  const shared = join(root, "shared-bin");
  await mkdir(shared);
  await chmod(shared, 0o777);
  const sharedHack = join(shared, "hack");
  await writeFile(sharedHack, "#!/bin/sh\n");
  await chmod(sharedHack, 0o755);
  const code = await installDaemonSystemdService({
    ...installHooks(fake, []),
    ...startHooks(fake, sharedHack),
    ignoredOptions: [],
    startDetached: () => Promise.resolve(0),
    stopDirect: () => Promise.resolve(true),
  });
  expect(code).toBe(1);
  expect(await Bun.file(unitPath).exists()).toBe(false);
  expect(fake.calls).not.toContain("systemctl --user enable hackd.service");
});

test("every symlink hop of the service program is checked, not just the ends", async () => {
  // Codex review: stable/hack -> shared/hack -> <program>, with `shared`
  // world-writable, passed because neither end's chain included it.
  const hackHome = join(root, ".hack");
  const shared = join(root, "shared");
  await mkdir(shared);
  await chmod(shared, 0o777);
  await symlink(program, join(shared, "hack"));
  const stable = join(root, "stable");
  await mkdir(stable);
  await chmod(stable, 0o755);
  await symlink(join(shared, "hack"), join(stable, "hack"));
  expect(
    await checkServiceExecutableTrusted({
      path: join(stable, "hack"),
      hackHome,
    })
  ).toContain(shared);

  // A hop through a symlinked directory: linked -> shared-dirs (writable),
  // whose `bin` links to the program's directory.
  const sharedDirs = join(root, "shared-dirs");
  await mkdir(sharedDirs);
  await chmod(sharedDirs, 0o777);
  await symlink(join(root, "bin"), join(sharedDirs, "bin"));
  await symlink(sharedDirs, join(root, "linked"));
  expect(
    await checkServiceExecutableTrusted({
      path: join(root, "linked", "bin", "hack"),
      hackHome,
    })
  ).toContain(sharedDirs);

  // The same chain through protected directories passes.
  await chmod(shared, 0o755);
  expect(
    await checkServiceExecutableTrusted({
      path: join(stable, "hack"),
      hackHome,
    })
  ).toBeNull();
});

test("a writable directory above the config home stops install and start", async () => {
  // Codex review: with a world-writable home, another account can rename
  // `.config` and plant its own hackd.service.
  const fake = fakeSystemd();
  expect(
    (
      await installSystemdUnit({
        unitPath,
        unitText: unitText(),
        deps: fake.deps,
      })
    ).ok
  ).toBe(true);
  // `root` stands in for $HOME (it holds config/ and the fixture bin/).
  await chmod(root, 0o777);
  try {
    fake.calls.length = 0;
    expect(await startViaSystemdIfInstalled(startHooks(fake))).toBe(1);
    expect(fake.calls).not.toContain("systemctl --user start hackd.service");
    const install = await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
    expect(install.ok).toBe(false);
    if (!install.ok) {
      expect(install.error).toContain("chmod go-w");
    }
    // Hack does not change directories outside its own.
    expect((await stat(root)).mode & 0o777).toBe(0o777);
    // The refusal names the writable directory.
    expect(await checkSystemdUnitDirectoryChain({ unitPath })).toContain(root);
  } finally {
    await chmod(root, 0o700);
  }
  expect(await checkSystemdUnitDirectoryChain({ unitPath })).toBeNull();
});

test("every user-unit load directory is checked, including empty and missing ones", async () => {
  // Codex security review: a writable load directory with no drop-in yet
  // lets another account add hackd.service.d/override.conf later.
  const fake = fakeSystemd();
  expect(
    (
      await installSystemdUnit({
        unitPath,
        unitText: unitText(),
        deps: fake.deps,
      })
    ).ok
  ).toBe(true);
  const own = process.getuid?.() ?? 0;

  // An existing, empty, writable data-home load directory: refused.
  const dataUnits = join(root, "data", "systemd", "user");
  await mkdir(dataUnits, { recursive: true });
  await chmod(dataUnits, 0o777);
  expect(await checkSystemdUnitLoadPaths({ deps: fake.deps })).toContain(
    dataUnits
  );
  fake.calls.length = 0;
  expect(await startViaSystemdIfInstalled(startHooks(fake))).toBe(1);
  expect(fake.calls).not.toContain("systemctl --user start hackd.service");
  await chmod(dataUnits, 0o755);

  // A missing load directory whose existing parent others can write.
  const missingParent = join(root, "shared-data");
  await mkdir(missingParent);
  await chmod(missingParent, 0o777);
  fake.unitSearchPath = `${join(root, "config", "systemd", "user")} ${join(missingParent, "systemd", "user")}`;
  expect(await checkSystemdUnitLoadPaths({ deps: fake.deps })).toContain(
    missingParent
  );
  await chmod(missingParent, 0o755);
  expect(await checkSystemdUnitLoadPaths({ deps: fake.deps })).toBeNull();

  // A drop-in already in a load directory, owned by another account.
  fake.unitSearchPath = null;
  await mkdir(join(dataUnits, "hackd.service.d"));
  await writeFile(join(dataUnits, "hackd.service.d", "x.conf"), "");
  expect(
    await checkSystemdUnitLoadPaths({ deps: fake.deps, uid: own + 1 })
  ).toContain("owned by another user");

  // systemd does not report its load paths: refused.
  fake.unitSearchPath = "";
  expect(await checkSystemdUnitLoadPaths({ deps: fake.deps })).toContain(
    "did not report"
  );
});

test("a loaded drop-in's whole ancestor chain is checked", async () => {
  // Codex review: an owner-controlled drop-in under a world-writable,
  // non-sticky ancestor passed the loaded-paths check.
  const fake = fakeSystemd();
  await installSystemdUnit({ unitPath, unitText: unitText(), deps: fake.deps });
  const shared = join(root, "shared");
  const dropInDir = join(shared, "user", "systemd", "user", "hackd.service.d");
  await mkdir(dropInDir, { recursive: true });
  for (const dir of ["user", "user/systemd", "user/systemd/user"]) {
    await chmod(join(shared, dir), 0o755);
  }
  await chmod(dropInDir, 0o755);
  const dropIn = join(dropInDir, "override.conf");
  await writeFile(dropIn, "");
  await chmod(dropIn, 0o644);
  await chmod(shared, 0o777);
  fake.dropInPaths = dropIn;
  expect(
    await checkSystemdLoadedUnitPaths({ unitPath, deps: fake.deps })
  ).toContain(shared);
  await chmod(shared, 0o755);
  expect(
    await checkSystemdLoadedUnitPaths({ unitPath, deps: fake.deps })
  ).toBeNull();
});
