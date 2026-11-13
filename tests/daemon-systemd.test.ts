import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Stats } from "node:fs";
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
import { dirname, join } from "node:path";
import {
  describeSystemdIncompatibleOwner,
  installDaemonSystemdService,
  startViaSystemdIfInstalled,
  stopViaSystemdIfInstalled,
  uninstallDaemonSystemdService,
  withSystemdIncompatibleNextStep,
} from "../src/commands/daemon-systemd.ts";
import { resolveDaemonPaths } from "../src/daemon/paths.ts";
import type { DaemonProcessProof } from "../src/daemon/process.ts";
import { summarizeSystemdService } from "../src/daemon/service-summary.ts";
import {
  buildDaemonRepairMessage,
  buildDaemonStatusReport,
} from "../src/daemon/status.ts";
import {
  assessExecutableDurability,
  checkServiceExecutableTrusted,
  checkServicePathDirectories,
  checkSystemdLoadedUnitPaths,
  checkSystemdServicePrograms,
  checkSystemdUnitDirectoryChain,
  checkSystemdUnitDropIns,
  checkSystemdUnitFile,
  checkSystemdUnitLoadPaths,
  defaultSystemdDeps,
  ensureOwnerWritableOnlyDirectories,
  extractSystemdExecProgram,
  installSystemdUnit,
  isPidInSystemdUnit,
  parseSystemdExecProgram,
  parseSystemdPathList,
  probeSystemdUserManager,
  programFileProblem,
  readSystemdServicePathDirectories,
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
  /** `UnsetEnvironment=` as `systemctl show` prints it. */
  unsetEnvironment: string;
  /** `PassEnvironment=` as `systemctl show` prints it. */
  passEnvironment: string;
  /** `ExecSearchPath=` as `systemctl show` prints it. */
  execSearchPath: string;
  /** `FragmentPath=` (defaults to the managed unit path). */
  fragmentPath: string | null;
  /** `DropInPaths=` as `systemctl show` prints it. */
  dropInPaths: string;
  /** The manager's `UnitPath=` (null: config and data dirs under the fixture). */
  unitSearchPath: string | null;
  /** Extra `Exec*=` lines (drop-in overrides) the manager reports. */
  extraExecLines: string[];
  /** `systemctl --user show-environment` output. */
  managerEnvironment: string;
  /** The account's home in the password database (`getent passwd`). */
  passwdHome: string | null;
  /**
   * What proving the unit's main process (MainPID) finds: this home's
   * hackd, another home's (its socket elsewhere), or nothing readable.
   */
  mainProcess: "ours" | "foreign" | "unknown";
  /** False: the unit reports no main process (e.g. a pending restart). */
  mainPidReported: boolean;
  /** Namespace settings (`RootDirectory=...` lines) systemd reports. */
  namespaceLines: string[];
};

/**
 * systemd user units are Linux-only, and these tests exercise real file
 * ownership and modes (PATH, unit and program checks): a macOS host's own
 * layout (a group-writable /usr/local/bin, /private/var/folders) is not
 * the system they describe.
 */
const linuxTest = process.platform === "linux" ? test : test.skip;

const EXEC_START_RAW = /^ExecStart=(.*)$/m;
const QUOTED_FIRST_WORD = /^"([^"]*)"/;

let root: string;
let unitPath: string;
let program: string;
/**
 * The fake service PATH: a directory of this test's own, so the PATH
 * checks never scan the host's /usr (GitHub's runner image leaves
 * directories that /usr/bin links into writable by everyone, HACK-2142).
 */
let sysBin: string;

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
  sysBin = join(root, "sysbin");
  await mkdir(sysBin);
  await chmod(sysBin, 0o755);
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
    unitEnvironment: `PATH=${sysBin} HACK_NO_INTERACTIVE=1`,
    environmentFiles: "",
    unsetEnvironment: "",
    passEnvironment: "",
    execSearchPath: "",
    fragmentPath: null,
    dropInPaths: "",
    unitSearchPath: null,
    extraExecLines: [],
    managerEnvironment: `HOME=${root}\nPATH=${sysBin}\n`,
    passwdHome: root,
    mainProcess: "ours",
    mainPidReported: true,
    namespaceLines: [],
    deps: undefined as unknown as SystemdDeps,
  };
  const ok = (stdout = ""): ServiceCommandResult => ({
    exitCode: 0,
    stdout,
    stderr: "",
  });
  const run: SystemdDeps["run"] = (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "getent") {
      return Promise.resolve(
        state.passwdHome === null
          ? { exitCode: 2, stdout: "", stderr: "" }
          : ok(`user:x:1000:1000::${state.passwdHome}:/bin/sh\n`)
      );
    }
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
    const execQuery = args.find(
      (arg) =>
        arg.startsWith("--property=ExecCondition,") ||
        arg.startsWith("--property=ExecStop,")
    );
    if (verb === "show" && execQuery) {
      // Exec* settings as systemd reports them: ExecStart for the unit file
      // on disk, plus any drop-in lines the test set; only those asked for.
      const wanted = new Set(execQuery.slice("--property=".length).split(","));
      return (async () => {
        const text = await readFile(unitPath, "utf8").catch(() => "");
        const program = extractSystemdExecProgram({ unitText: text });
        // argv as written in the unit: the program unquoted, then the rest.
        const execLine = EXEC_START_RAW.exec(text)?.[1] ?? "";
        const argv = execLine.replace(QUOTED_FIRST_WORD, "$1");
        const lines = [
          ...(program
            ? [
                `ExecStart={ path=${program} ; argv[]=${argv} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`,
              ]
            : []),
          ...state.extraExecLines,
        ].filter((line) => wanted.has(line.slice(0, line.indexOf("="))));
        return ok(`${lines.join("\n")}\n`);
      })();
    }
    if (
      verb === "show" &&
      args.some((arg) => arg.startsWith("--property=RootDirectory,"))
    ) {
      return Promise.resolve(ok(`${state.namespaceLines.join("\n")}\n`));
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
    if (verb === "show" && args.includes("--property=Environment")) {
      return Promise.resolve(ok(`Environment=${state.unitEnvironment}\n`));
    }
    if (
      verb === "show" &&
      args.includes(
        "--property=Environment,EnvironmentFiles,UnsetEnvironment,PassEnvironment,ExecSearchPath"
      )
    ) {
      return Promise.resolve(
        ok(
          [
            `Environment=${state.unitEnvironment}`,
            `EnvironmentFiles=${state.environmentFiles}`,
            `UnsetEnvironment=${state.unsetEnvironment}`,
            `PassEnvironment=${state.passEnvironment}`,
            `ExecSearchPath=${state.execSearchPath}`,
            "",
          ].join("\n")
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
            `MainPID=${state.active && state.mainPidReported ? (opts.mainPid ?? 4242) : 0}`,
            `NeedDaemonReload=${state.needsReload ? "yes" : "no"}`,
            `FragmentPath=${state.fragmentPath ?? unitPath}`,
            `DropInPaths=${state.dropInPaths}`,
          ].join("\n")
        )
      );
    }
    if (verb === "show-environment") {
      return Promise.resolve(ok(state.managerEnvironment));
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

/** The stop path's proof of the unit's main process, as the fake says. */
function proveFor(fake: Fake): (pid: number) => Promise<DaemonProcessProof> {
  return (pid) =>
    Promise.resolve(
      fake.mainProcess === "ours"
        ? ({
            kind: "owned",
            pid,
            birth: "ticks:1",
            image: { executable: program, argv: [program] },
          } as unknown as DaemonProcessProof)
        : {
            kind: "refused",
            reason:
              fake.mainProcess === "foreign"
                ? "foreign-socket"
                : "identity-unknown",
          }
    );
}

function unitText(): string {
  const text = renderSystemdUnit({ hackBinPath: program });
  if (!text) {
    throw new Error("unit did not render");
  }
  return text;
}

linuxTest(
  "unit path follows XDG_CONFIG_HOME and ignores a relative value",
  () => {
    expect(
      resolveSystemdUnitPath({ env: { XDG_CONFIG_HOME: "/x/config" } })
    ).toBe("/x/config/systemd/user/hackd.service");
    expect(
      resolveSystemdUnitPath({ env: { XDG_CONFIG_HOME: "rel" }, home: "/h" })
    ).toBe("/h/.config/systemd/user/hackd.service");
  }
);

linuxTest(
  "access is denied by HACK_SYSTEMD_DISABLE and an isolated HACK_HOME",
  () => {
    expect(resolveSystemdAccess({ env: { HOME: "/h" } }).allowed).toBe(true);
    expect(
      resolveSystemdAccess({ env: { HOME: "/h", HACK_HOME: "/h/.hack" } })
        .allowed
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
  }
);

linuxTest(
  "the unit runs the absolute hack path in the foreground with Restart=on-failure",
  () => {
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
  }
);

linuxTest(
  "the availability probe tells a missing bus, a non-systemd host and no systemctl apart",
  async () => {
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
  }
);

linuxTest(
  "install writes, reloads and enables; a second install is a no-op",
  async () => {
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
      "systemctl --user --no-pager show hackd.service --property=Environment,EnvironmentFiles,UnsetEnvironment,PassEnvironment,ExecSearchPath",
      "systemctl --user show-environment",
      "systemctl --user --no-pager show hackd.service --property=ExecCondition,ExecStartPre,ExecStart,ExecStartPost,ExecReload,ExecStop,ExecStopPost",
      "systemctl --user --no-pager show hackd.service --property=RootDirectory,RootImage,MountImages,ExtensionImages,ExtensionDirectories,BindPaths,BindReadOnlyPaths,TemporaryFileSystem",
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
  }
);

linuxTest(
  "install rewrites a drifted unit and reports the drift first",
  async () => {
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
  }
);

linuxTest("a unit for another existing hack is not drift", async () => {
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

linuxTest(
  "a unit whose program was moved reports program-missing",
  async () => {
    const fake = fakeSystemd();
    await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
    await rm(program);
    const status = await readSystemdServiceStatus({
      unitPath,
      deps: fake.deps,
    });
    expect(status?.drift).toBe("program-missing");
    expect(status?.program).toBe(program);
  }
);

linuxTest("install refuses without a user bus and writes nothing", async () => {
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

linuxTest(
  "uninstall disables --now, removes the unit and reloads",
  async () => {
    const fake = fakeSystemd();
    await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
    fake.active = true;
    fake.calls.length = 0;

    expect(await uninstallSystemdUnit({ unitPath, deps: fake.deps })).toEqual({
      ok: true,
      notInstalled: false,
      managerNotified: true,
      reloadError: null,
    });
    // Read-only checks of what systemd loaded come first; then the trusted
    // unit is disabled and stopped, removed, and systemd reloaded.
    const mutating = fake.calls.filter((call) => !call.includes(" show "));
    expect(mutating).toEqual([
      "systemctl --user disable --now hackd.service",
      "systemctl --user daemon-reload",
    ]);
    expect(await Bun.file(unitPath).exists()).toBe(false);
    expect(fake.active).toBe(false);
  }
);

linuxTest(
  "uninstall without a unit changes nothing; without a bus it still removes the file",
  async () => {
    const fake = fakeSystemd();
    expect(
      await uninstallSystemdUnit({ unitPath, deps: fake.deps })
    ).toMatchObject({
      ok: true,
      notInstalled: true,
    });
    // It only asks the manager whether something still runs (read-only).
    expect(
      fake.calls.filter((call) =>
        / (stop|disable|enable|start|restart|daemon-reload)( |$)/.test(call)
      )
    ).toEqual([]);

    await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
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
  }
);

linuxTest("a denied process never calls the runner", async () => {
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
    stateError: null,
    ...overrides,
  };
}

linuxTest(
  "the summary names one next step in priority order and detects ownership",
  () => {
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
          availability: {
            available: false,
            reason: "not-systemd",
            detail: "x",
          },
        })
      )
    ).toMatchObject({ severity: "ok", nextStep: null });
    expect(
      summarize(
        baseStatus({
          availability: {
            available: false,
            reason: "no-user-bus",
            detail: "x",
          },
        })
      )
    ).toMatchObject({ severity: "warn", nextStep: null });
  }
);

linuxTest(
  "doctor warns about a missing unit with the fix, and --fix only offers install",
  () => {
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
      decideDaemonServiceFix({
        summary: lingerOff,
        autostart: { allowed: true },
      })
    ).toEqual({ kind: "none" });
  }
);

linuxTest("status text and JSON name the same next step", () => {
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
    systemPathDirectories: [sysBin],
  };
}

linuxTest("start leaves a current unit alone and only starts it", async () => {
  const fake = fakeSystemd();
  await installSystemdUnit({ unitPath, unitText: unitText(), deps: fake.deps });
  fake.calls.length = 0;
  expect(await startViaSystemdIfInstalled(startHooks(fake))).toBe(0);
  expect(fake.calls).not.toContain("systemctl --user daemon-reload");
  expect(fake.calls).toContain("systemctl --user start hackd.service");
});

linuxTest("start clears a failed unit before starting it", async () => {
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

linuxTest(
  "start without an installed unit returns null and calls nothing",
  async () => {
    const fake = fakeSystemd();
    expect(await startViaSystemdIfInstalled(startHooks(fake))).toBeNull();
    expect(fake.calls).toEqual([]);
  }
);

linuxTest(
  "cgroup membership identifies hackd under a wrapper MainPID",
  async () => {
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
  }
);

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
linuxTest(
  "start keeps a unit that runs another existing hack and only starts it",
  async () => {
    const fake = fakeSystemd();
    const old = await writeOldUnit(fake, "Nice=5");
    const before = await readFile(unitPath, "utf8");
    expect(await startViaSystemdIfInstalled(startHooks(fake))).toBe(0);
    expect(await readFile(unitPath, "utf8")).toBe(before);
    expect(before).toContain(`"${old}"`);
    expect(fake.calls).not.toContain("systemctl --user daemon-reload");
    expect(fake.calls).toContain("systemctl --user start hackd.service");
  }
);

linuxTest(
  "start retargets only ExecStart when the program is gone and the new one is durable",
  async () => {
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
  }
);

linuxTest(
  "start refuses to retarget a missing program to a non-durable path",
  async () => {
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
  }
);

linuxTest(
  "durability: temp dirs, package caches and checkouts are not durable",
  async () => {
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
    expect((await assess("/srv/app/node_modules/.bin/hack")).durable).toBe(
      false
    );
    expect((await assess("/srv/u/.cache/hack/hack")).durable).toBe(false);
    const checkout = (path: string) =>
      Promise.resolve(path === "/srv/src/hack/.git");
    expect((await assess("/srv/src/hack/dist/hack", checkout)).durable).toBe(
      false
    );
  }
);

linuxTest("retargeting keeps every other line of an edited unit", () => {
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
linuxTest("read-only start neither writes nor reloads the unit", async () => {
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
linuxTest("start completes a pending reload before starting", async () => {
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

linuxTest(
  "a failed reload after a rewrite is recovered by the next install",
  async () => {
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
    const status = await readSystemdServiceStatus({
      unitPath,
      deps: fake.deps,
    });
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
  }
);

// Finding 7: uninstall reports a failed final reload.
linuxTest(
  "uninstall reports a failed final reload and what it already did",
  async () => {
    const fake = fakeSystemd({
      reloadError: "Failed to reload daemon: timeout",
    });
    await writeFile(unitPath, unitText()).catch(async () => {
      await mkdir(join(root, "config", "systemd", "user"), { recursive: true });
      await writeFile(unitPath, unitText());
    });
    // Whatever the runner's umask: these are the user's own directories.
    for (const dir of ["config", "config/systemd", "config/systemd/user"]) {
      await chmod(join(root, dir), 0o755);
    }
    // Stop checks the unit file as start does: not writable by others.
    await chmod(unitPath, 0o644);
    const result = await uninstallSystemdUnit({ unitPath, deps: fake.deps });
    expect(result).toEqual({
      ok: true,
      notInstalled: false,
      managerNotified: true,
      reloadError: "Failed to reload daemon: timeout",
    });
    expect(await Bun.file(unitPath).exists()).toBe(false);

    await mkdir(join(root, "config", "systemd", "user"), { recursive: true });
    await writeFile(unitPath, unitText(), { mode: 0o644 });
    await chmod(unitPath, 0o644);
    expect(await uninstallDaemonSystemdService({ deps: fake.deps })).toBe(1);
  }
);

// Finding 2: stop goes through the manager even without a live pid.
linuxTest(
  "stop cancels a pending restart through systemd without a live pid",
  async () => {
    const fake = fakeSystemd();
    await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
    fake.activeState = "activating";
    fake.calls.length = 0;
    expect(
      await stopViaSystemdIfInstalled({
        proveDaemon: proveFor(fake),
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
        proveDaemon: proveFor(fake),
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
  }
);

linuxTest(
  "an incompatible hackd that systemd runs from another hack is not replaced",
  async () => {
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
  }
);

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
  // Owner-only, whatever the runner's umask (as Hack creates them).
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await chmod(dirname(paths.root), 0o700);
  await chmod(paths.root, 0o700);
  await writeFile(paths.pidPath, `${pid}\n`);
}

// Finding 1: install signals only a proven hackd of this HACK_HOME.
linuxTest(
  "install leaves an unrelated live process named by the pid file alone",
  async () => {
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
  }
);

linuxTest(
  "install treats a pid of 0 as no daemon and signals nothing",
  async () => {
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
  }
);

linuxTest(
  "install hands over only a proven hackd and leaves a systemd-run one alone",
  async () => {
    const fake = fakeSystemd({ active: true, mainPid: 999_999 });
    // The pid file names a live process (this runner); proof is injected.
    await writePidFile(process.pid);
    await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
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
  }
);

linuxTest(
  "install stops when a proven direct hackd could not be confirmed stopped",
  async () => {
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
  }
);

linuxTest(
  "install fails when the ready hackd is not the one systemd runs",
  async () => {
    const fake = fakeSystemd({ mainPid: 999_999 });
    // A directly started hackd (this runner's pid) whose identity cannot be
    // proven is left running; it answers, but systemd does not run it.
    await writePidFile(process.pid);
    const stopped: number[] = [];
    const code = await installDaemonSystemdService({
      ...installHooks(fake, stopped),
      isPidInUnit: () => Promise.resolve(false),
      proveDaemon: () =>
        Promise.resolve({
          kind: "refused",
          reason: "identity-unknown",
        } as const),
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
  }
);

linuxTest(
  "durability: a home directory kept in git is not a checkout",
  async () => {
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
  }
);

linuxTest(
  "durability: a stable path that resolves into a temp dir, cache or build output is not durable",
  async () => {
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
  }
);

linuxTest(
  "durability: a real symlink into a temp dir is caught (real filesystem)",
  async () => {
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
  }
);

linuxTest(
  "an ExecStart prefix or specifier is unknown, never a missing program",
  () => {
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
  }
);

linuxTest(
  "start leaves a unit with an ExecStart prefix or specifier as it is",
  async () => {
    // Review r2 #4: `-/opt/...` and `%h/...` used to read as a missing
    // program, and start rewrote the unit and dropped the prefix.
    const fake = fakeSystemd();
    await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
    // systemd resolves the prefix or specifier itself; here it reports the
    // (trusted) program the unit runs.
    fake.extraExecLines = [
      `ExecStart={ path=${program} ; argv[]=${program} daemon start --foreground ; ignore_errors=no }`,
    ];
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
  }
);

linuxTest("retargeting keeps systemd's $$ in the kept arguments", () => {
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

linuxTest(
  "status and doctor point an incompatible systemd-run old hack at install",
  async () => {
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
      process.platform === "linux"
        ? "hack daemon install"
        : "hack daemon restart"
    );
    expect(
      (
        await withSystemdIncompatibleNextStep({
          report: { ...report, status: "running" },
          deps: fake.deps,
        })
      ).nextStep
    ).toBe("hack daemon restart");
  }
);

linuxTest(
  "an install retry after a failed reload restarts the running service",
  async () => {
    // The file already has the new content (an earlier reload failed), the
    // unit is active with the old config loaded.
    const fake = fakeSystemd({ active: true, mainPid: 4242 });
    await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
    fake.needsReload = true;
    fake.calls.length = 0;
    const stopped: number[] = [];
    await installDaemonSystemdService({
      ...installHooks(fake, stopped),
      isPidInUnit: () => Promise.resolve(true),
    });
    const reload = fake.calls.indexOf("systemctl --user daemon-reload");
    const restart = fake.calls.indexOf(
      "systemctl --user restart hackd.service"
    );
    expect(reload).toBeGreaterThanOrEqual(0);
    expect(restart).toBeGreaterThan(reload);
    expect(fake.calls).not.toContain("systemctl --user start hackd.service");
  }
);

linuxTest("a restart is kept pending across an enable failure", async () => {
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

linuxTest("uninstall clears a leftover restart-pending marker", async () => {
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

linuxTest(
  "stop refuses, with the manual command, when the unit cannot be read",
  async () => {
    // Review r2 decision: an unreadable unit environment may belong to another
    // Hack home, so stop does not touch it and says how to stop it by hand.
    const fake = fakeSystemd();
    await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
    fake.activeState = "activating";
    fake.showFails = true;
    fake.calls.length = 0;
    const result = await stopViaSystemdIfInstalled({
      proveDaemon: proveFor(fake),
      pid: null,
      hackHome: join(root, ".hack"),
      deps: fake.deps,
    });
    expect(result.handled).toBe(false);
    expect(result.refused).toContain("could not be read");
    expect(result.refused).toContain("systemctl --user stop hackd.service");
    expect(fake.calls).not.toContain("systemctl --user stop hackd.service");
  }
);

linuxTest(
  "stop refuses a unit whose effective Hack home is another one",
  async () => {
    const fake = fakeSystemd({ active: true });
    // No live main process (as during a pending restart): the loaded
    // configuration is all that says whose the unit is.
    fake.mainPidReported = false;
    await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
    const stop = () =>
      stopViaSystemdIfInstalled({
        proveDaemon: proveFor(fake),
        pid: null,
        hackHome: join(root, ".hack"),
        deps: fake.deps,
      });
    // A drop-in set HACK_HOME for the unit.
    fake.unitEnvironment = `"PATH=/usr/bin:/bin" HACK_HOME=/srv/other-home HACK_NO_INTERACTIVE=1`;
    fake.calls.length = 0;
    // Another home's unit is left alone, not refused: this shell's own
    // direct hackd is still stopped through the proven-ownership path.
    const foreign = await stop();
    expect(foreign).toMatchObject({ handled: false, refused: null });
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
  }
);

linuxTest(
  "install creates the unit directories without group write under a shared umask",
  async () => {
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
  }
);

linuxTest(
  "install removes group write from an existing unit directory it owns",
  async () => {
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
  }
);

linuxTest(
  "the unit directory check refuses a directory owned by another user",
  async () => {
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
  }
);

linuxTest(
  "drop-ins another account could have written are refused before use",
  async () => {
    // Codex security review: a pre-created hackd.service.d/override.conf
    // would replace ExecStart and run as this user.
    const userDir = join(root, "config", "systemd", "user");
    const dropInDir = join(userDir, "hackd.service.d");
    await mkdir(dropInDir, { recursive: true });
    // Whatever the runner's umask, only what each case sets is shared.
    for (const dir of [
      "config",
      "config/systemd",
      "config/systemd/user",
      "config/systemd/user/hackd.service.d",
    ]) {
      await chmod(join(root, dir), 0o755);
    }
    const override = join(dropInDir, "override.conf");
    await writeFile(override, "[Service]\nExecStart=\nExecStart=/bin/true\n");
    const own = process.getuid?.() ?? 0;
    // Owned by another user (modelled with the uid the check compares to).
    const foreign = await checkSystemdUnitDropIns({ unitPath, uid: own + 1 });
    expect(foreign).toContain("owned by another user");
    // This user's drop-in that others could write: its contents may be
    // someone else's, so it is refused, not repaired (Codex security review).
    await chmod(override, 0o666);
    expect(await checkSystemdUnitDropIns({ unitPath })).toContain(
      "contents cannot be trusted"
    );
    expect((await stat(override)).mode & 0o777).toBe(0o666);
    await chmod(override, 0o644);
    expect(await checkSystemdUnitDropIns({ unitPath })).toBeNull();
    // The generic service.d is checked too.
    const generic = join(userDir, "service.d");
    await mkdir(generic);
    await writeFile(join(generic, "x.conf"), "");
    expect(await checkSystemdUnitDropIns({ unitPath, uid: own + 1 })).toContain(
      "owned by another user"
    );
  }
);

linuxTest(
  "install and start refuse a drop-in they cannot vouch for",
  async () => {
    const fake = fakeSystemd();
    await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
    // A `.conf` entry that is not a regular file: refused like a foreign one.
    await mkdir(
      join(root, "config", "systemd", "user", "hackd.service.d", "odd.conf"),
      { recursive: true }
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
  }
);

linuxTest("start runs only a unit file this user controls", async () => {
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

  // A unit file others could write: start refuses it (its contents may be
  // someone else's); install replaces it with a fresh file.
  await chmod(unitPath, 0o664);
  fake.calls.length = 0;
  expect(await startViaSystemdIfInstalled(startHooks(fake))).toBe(1);
  expect(fake.calls).not.toContain("systemctl --user start hackd.service");
  expect(
    (
      await installSystemdUnit({
        unitPath,
        unitText: unitText(),
        deps: fake.deps,
      })
    ).ok
  ).toBe(true);
  expect((await stat(unitPath)).mode & 0o777).toBe(0o644);
  expect(await readFile(unitPath, "utf8")).toBe(unitText());

  // This user's unit directory, writable by the group: repaired, started
  // (the files inside are checked separately).
  await chmod(userDir, 0o775);
  fake.calls.length = 0;
  expect(await startViaSystemdIfInstalled(startHooks(fake))).toBe(0);
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

linuxTest(
  "start checks the files systemd actually loads, in every load path",
  async () => {
    // Codex security review: systemd merges drop-ins from every user-unit load
    // path ($XDG_DATA_HOME too); only the manager's own list is complete.
    const fake = fakeSystemd();
    await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
    const own = process.getuid?.() ?? 0;
    const dataDropIns = join(
      root,
      "data",
      "systemd",
      "user",
      "hackd.service.d"
    );
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
  }
);

linuxTest(
  "the service program and every directory above it must be this user's or root's",
  async () => {
    // Codex security review: a group member who can replace `hack` gets the
    // enabled unit to run their program as this user.
    const hackHome = join(root, ".hack");
    const check = (path: string, uid?: number) =>
      checkServiceExecutableTrusted({ path, uid });
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

    // Inside the Hack home too (an installer under umask 0002): refused, not
    // repaired, since a program may already have been replaced there (Codex
    // security review).
    const hackBin = join(hackHome, "bin");
    await mkdir(hackBin, { recursive: true });
    await chmod(hackHome, 0o755);
    await chmod(hackBin, 0o775);
    const installed = join(hackBin, "hack");
    await writeFile(installed, "#!/bin/sh\n");
    await chmod(installed, 0o755);
    expect(await check(installed)).toContain("chmod go-w");
    expect((await stat(hackBin)).mode & 0o777).toBe(0o775);
    await chmod(hackBin, 0o755);
    expect(await check(installed)).toBeNull();
    // A program file others could write is refused, never chmod-ed.
    await chmod(installed, 0o775);
    expect(await check(installed)).toContain("writable by other users");
    expect((await stat(installed)).mode & 0o777).toBe(0o775);
    await chmod(installed, 0o755);

    // Another account's program (modelled with the uid the check compares to).
    const own = process.getuid?.() ?? 0;
    expect(await check(installed, own + 1)).toContain("owned by another user");
  }
);

linuxTest(
  "install refuses a program in a directory others can write and writes no unit",
  async () => {
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
  }
);

linuxTest(
  "every symlink hop of the service program is checked, not just the ends",
  async () => {
    // Codex review: stable/hack -> shared/hack -> <program>, with `shared`
    // world-writable, passed because neither end's chain included it.
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
      })
    ).toContain(sharedDirs);

    // The same chain through protected directories passes.
    await chmod(shared, 0o755);
    expect(
      await checkServiceExecutableTrusted({
        path: join(stable, "hack"),
      })
    ).toBeNull();
  }
);

linuxTest(
  "a writable directory above the config home stops install and start",
  async () => {
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
      expect(await checkSystemdUnitDirectoryChain({ unitPath })).toContain(
        root
      );
    } finally {
      await chmod(root, 0o700);
    }
    expect(await checkSystemdUnitDirectoryChain({ unitPath })).toBeNull();
  }
);

linuxTest(
  "every user-unit load directory is checked, including empty and missing ones",
  async () => {
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
  }
);

linuxTest("a loaded drop-in's whole ancestor chain is checked", async () => {
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

linuxTest("a symlink hop owned by another account is refused", async () => {
  // Codex review: another account's link in a sticky directory can be
  // replaced by that account, redirecting the service.
  const link = join(root, "stable-link");
  await symlink(program, link);
  const own = process.getuid?.() ?? 0;
  // Modelled with the uid the check compares to: the link (and everything
  // else this user owns) then counts as another account's.
  expect(
    await checkServiceExecutableTrusted({ path: link, uid: own + 1 })
  ).toContain("owned by another user");
  expect(await checkServiceExecutableTrusted({ path: link })).toBeNull();
});

linuxTest(
  "a missing load directory under a sticky shared parent is refused",
  async () => {
    // Codex review: sticky protects existing entries, not the creation of the
    // missing load directory.
    const fake = fakeSystemd();
    await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
    const sticky = join(root, "sticky");
    await mkdir(sticky);
    await chmod(sticky, 0o1777);
    fake.unitSearchPath = `${join(root, "config", "systemd", "user")} ${join(sticky, "missing", "systemd", "user")}`;
    expect(await checkSystemdUnitLoadPaths({ deps: fake.deps })).toContain(
      "lets other users create"
    );
    // An existing load directory in a sticky parent is fine (its own mode is
    // what matters).
    const present = join(sticky, "present");
    await mkdir(present);
    await chmod(present, 0o755);
    fake.unitSearchPath = `${join(root, "config", "systemd", "user")} ${present}`;
    expect(await checkSystemdUnitLoadPaths({ deps: fake.deps })).toBeNull();
  }
);

linuxTest("an existing sticky shared load directory is refused", async () => {
  // Codex review: sticky stops replacing existing entries, not adding a new
  // hackd.service.d/override.conf.
  const fake = fakeSystemd();
  await installSystemdUnit({ unitPath, unitText: unitText(), deps: fake.deps });
  const shared = join(root, "shared-units");
  await mkdir(shared);
  await chmod(shared, 0o1777);
  fake.unitSearchPath = `${join(root, "config", "systemd", "user")} ${shared}`;
  expect(await checkSystemdUnitLoadPaths({ deps: fake.deps })).toContain(
    "lets other users add drop-ins"
  );
  // A sticky shared drop-in directory inside a protected load directory too.
  await chmod(shared, 0o755);
  await mkdir(join(shared, "service.d"));
  await chmod(join(shared, "service.d"), 0o1777);
  expect(await checkSystemdUnitLoadPaths({ deps: fake.deps })).toContain(
    "service.d lets other users add drop-ins"
  );
  await chmod(join(shared, "service.d"), 0o755);
  expect(await checkSystemdUnitLoadPaths({ deps: fake.deps })).toBeNull();
});

linuxTest(
  "symlink hops are followed in filesystem order, not normalized first",
  async () => {
    // Codex review: hack -> safe/link/../hack with safe/link -> shared/subdir
    // runs shared/hack; lexical normalization checked safe/hack instead.
    const safe = join(root, "safe");
    const shared = join(root, "shared");
    await mkdir(join(shared, "subdir"), { recursive: true });
    await mkdir(safe);
    await chmod(safe, 0o755);
    await chmod(join(shared, "subdir"), 0o755);
    await writeFile(join(safe, "hack"), "#!/bin/sh\n");
    await chmod(join(safe, "hack"), 0o755);
    await writeFile(join(shared, "hack"), "#!/bin/sh\n");
    await chmod(join(shared, "hack"), 0o755);
    await chmod(shared, 0o777);
    await symlink(join(shared, "subdir"), join(safe, "link"));
    const entry = join(root, "entry-hack");
    await symlink("safe/link/../hack", entry);
    expect(await checkServiceExecutableTrusted({ path: entry })).toContain(
      shared
    );
    await chmod(shared, 0o755);
    expect(await checkServiceExecutableTrusted({ path: entry })).toBeNull();
  }
);

linuxTest(
  "a symlinked drop-in routed through a writable directory stops install before enable",
  async () => {
    // Codex review: the install preflight checked only the resolved file.
    const fake = fakeSystemd();
    const dropInDir = join(
      root,
      "config",
      "systemd",
      "user",
      "hackd.service.d"
    );
    await mkdir(dropInDir, { recursive: true });
    for (const dir of ["config", "config/systemd", "config/systemd/user"]) {
      await chmod(join(root, dir), 0o755);
    }
    await chmod(dropInDir, 0o755);
    const shared = join(root, "shared-dropins");
    await mkdir(join(shared, "inner"), { recursive: true });
    await chmod(join(shared, "inner"), 0o755);
    const target = join(shared, "inner", "override.conf");
    await writeFile(target, "");
    await chmod(target, 0o644);
    await chmod(shared, 0o777);
    await symlink(target, join(dropInDir, "override.conf"));
    const result = await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(shared);
    }
    expect(fake.calls).not.toContain("systemctl --user daemon-reload");
    expect(fake.calls).not.toContain("systemctl --user enable hackd.service");
  }
);

linuxTest("a drop-in masked with a link to /dev/null is accepted", async () => {
  // Codex review: systemd masks a drop-in with a symlink to /dev/null.
  const dropInDir = join(root, "config", "systemd", "user", "hackd.service.d");
  await mkdir(dropInDir, { recursive: true });
  for (const dir of [
    "config",
    "config/systemd",
    "config/systemd/user",
    "config/systemd/user/hackd.service.d",
  ]) {
    await chmod(join(root, dir), 0o755);
  }
  await symlink("/dev/null", join(dropInDir, "override.conf"));
  expect(await checkSystemdUnitDropIns({ unitPath })).toBeNull();
  // The mask's own directory is still checked (this one is the user's, so
  // group/other write is removed).
  await chmod(dropInDir, 0o777);
  expect(await checkSystemdUnitDropIns({ unitPath })).toBeNull();
  expect((await stat(dropInDir)).mode & 0o777).toBe(0o755);
  // A link elsewhere is not a mask: its target must be a trusted file.
  const other = join(root, "elsewhere.conf");
  await writeFile(other, "");
  await chmod(other, 0o666);
  await symlink(other, join(dropInDir, "other.conf"));
  expect(await checkSystemdUnitDropIns({ unitPath })).toContain(
    "contents cannot be trusted"
  );
});

linuxTest(
  "a unit path list split by a space in a path is refused, not half-checked",
  async () => {
    // Codex security review: `.../data share/systemd/user` was read as a
    // fake prefix plus a dropped relative suffix.
    const spaced = join(root, "data share", "systemd", "user");
    await mkdir(spaced, { recursive: true });
    await chmod(spaced, 0o777);
    const fake = fakeSystemd();
    await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
    fake.unitSearchPath = `${join(root, "config", "systemd", "user")} ${spaced}`;
    expect(await checkSystemdUnitLoadPaths({ deps: fake.deps })).toContain(
      "cannot be read unambiguously"
    );
    // Both forms of ambiguity, directly.
    expect(await parseSystemdPathList("/a b/c")).toHaveProperty("error");
    expect(
      await parseSystemdPathList(`${join(root, "x")} /y`, (path) =>
        Promise.resolve(path === `${join(root, "x")} /y`)
      )
    ).toHaveProperty("error");
    expect(await parseSystemdPathList("/a /b")).toEqual({
      paths: ["/a", "/b"],
    });
    // Loaded drop-in paths use the same parser.
    fake.unitSearchPath = null;
    fake.dropInPaths = `${join(root, "data")} share/x.conf`;
    expect(
      await checkSystemdLoadedUnitPaths({ unitPath, deps: fake.deps })
    ).toContain("cannot be read unambiguously");
  }
);

linuxTest("drop-in checks skip entries systemd does not load", async () => {
  // Codex review: systemd loads only *.conf; a backup directory or a .bak
  // file must not block install or start.
  const dropInDir = join(root, "config", "systemd", "user", "hackd.service.d");
  await mkdir(join(dropInDir, "backup"), { recursive: true });
  for (const dir of [
    "config",
    "config/systemd",
    "config/systemd/user",
    "config/systemd/user/hackd.service.d",
  ]) {
    await chmod(join(root, dir), 0o755);
  }
  await writeFile(join(dropInDir, "override.conf.bak"), "");
  await chmod(join(dropInDir, "override.conf.bak"), 0o666);
  expect(await checkSystemdUnitDropIns({ unitPath })).toBeNull();
  // A .conf that others can write is still refused.
  await writeFile(join(dropInDir, "real.conf"), "");
  await chmod(join(dropInDir, "real.conf"), 0o666);
  expect(await checkSystemdUnitDropIns({ unitPath })).toContain("real.conf");
});

linuxTest(
  "a dangling symlink load directory is followed to where it points",
  async () => {
    // Codex review: data/systemd/user -> <shared>/not-created-yet was treated
    // as missing and its lexical parent checked instead of the target's.
    const fake = fakeSystemd();
    await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
    const shared = join(root, "shared-target");
    await mkdir(shared);
    await chmod(shared, 0o1777);
    const linkParent = join(root, "data", "systemd");
    await mkdir(linkParent, { recursive: true });
    for (const dir of ["data", "data/systemd"]) {
      await chmod(join(root, dir), 0o755);
    }
    const link = join(linkParent, "user");
    await symlink(join(shared, "not-created-yet"), link);
    fake.unitSearchPath = `${join(root, "config", "systemd", "user")} ${link}`;
    expect(await checkSystemdUnitLoadPaths({ deps: fake.deps })).toContain(
      `${shared} lets other users create`
    );
    // Pointing into a protected directory instead: accepted.
    await chmod(shared, 0o755);
    expect(await checkSystemdUnitLoadPaths({ deps: fake.deps })).toBeNull();
  }
);

linuxTest(
  "a dangling drop-in directory link is followed, not treated as absent",
  async () => {
    // Codex review: hackd.service.d -> <shared>/missing passed both checks;
    // another account could create the target and plant an override.
    const fake = fakeSystemd();
    await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
    const userDir = join(root, "config", "systemd", "user");
    const shared = join(root, "shared-dropins-target");
    await mkdir(shared);
    await chmod(shared, 0o1777);
    await symlink(join(shared, "missing"), join(userDir, "hackd.service.d"));
    expect(await checkSystemdUnitDropIns({ unitPath })).toContain(
      "does not exist yet"
    );
    expect(await checkSystemdUnitLoadPaths({ deps: fake.deps })).toContain(
      "does not exist yet"
    );
    // Pointing into a protected directory: nothing can appear there.
    await chmod(shared, 0o755);
    expect(await checkSystemdUnitDropIns({ unitPath })).toBeNull();
    expect(await checkSystemdUnitLoadPaths({ deps: fake.deps })).toBeNull();
  }
);

linuxTest(
  "every directory on the service PATH is checked at install and start",
  async () => {
    // Codex security review: hackd runs `docker` and other helpers through
    // PATH; a writable ~/.local/bin let another account plant one.
    const hackHome = join(root, ".hack");
    const own = join(root, "home-bin");
    await mkdir(own);
    await chmod(own, 0o755);
    expect(
      await checkServicePathDirectories({ dirs: [own, sysBin] })
    ).toBeNull();

    // A writable PATH directory, sticky or not: refused, unchanged.
    const shared = join(root, "shared-bin");
    await mkdir(shared);
    await chmod(shared, 0o1777);
    expect(
      await checkServicePathDirectories({ dirs: [own, shared] })
    ).toContain("add programs to");
    expect((await stat(shared)).mode & 0o7777).toBe(0o1777);

    // A missing PATH directory others could create: refused.
    expect(
      await checkServicePathDirectories({
        dirs: [join(shared, "later")],
      })
    ).toContain("create");

    // Inside HACK_HOME too: refused, not repaired (helpers may already have
    // been planted there).
    const hackBin = join(hackHome, "bin");
    await mkdir(hackBin, { recursive: true });
    await chmod(hackHome, 0o755);
    await chmod(hackBin, 0o775);
    expect(await checkServicePathDirectories({ dirs: [hackBin] })).toContain(
      "chmod go-w"
    );
    expect((await stat(hackBin)).mode & 0o777).toBe(0o775);

    // A relative entry is refused.
    expect(await checkServicePathDirectories({ dirs: ["bin"] })).toContain(
      "not absolute"
    );

    // Start reads the effective PATH from systemd and refuses a writable one.
    const fake = fakeSystemd();
    await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
    fake.unitEnvironment = `"PATH=${shared}:/usr/bin" HACK_NO_INTERACTIVE=1`;
    fake.calls.length = 0;
    expect(await startViaSystemdIfInstalled(startHooks(fake))).toBe(1);
    expect(fake.calls).not.toContain("systemctl --user start hackd.service");

    // Install refuses before writing when the rendered PATH is unsafe
    // ($HOME/.local/bin under a writable home).
    await rm(unitPath);
    await chmod(root, 0o777);
    try {
      const code = await installDaemonSystemdService({
        ...installHooks(fake, []),
        ignoredOptions: [],
      });
      expect(code).toBe(1);
      expect(await Bun.file(unitPath).exists()).toBe(false);
    } finally {
      await chmod(root, 0o700);
    }
  }
);

linuxTest(
  "a drop-in PATH with a shared directory stops install before enable",
  async () => {
    // Codex review: the effective PATH (drop-ins included) was checked only
    // before start, after the unit was already enabled for login.
    const fake = fakeSystemd();
    const shared = join(root, "shared-path");
    await mkdir(shared);
    await chmod(shared, 0o1777);
    fake.unitEnvironment = `"PATH=${shared}:/usr/bin"`;
    const result = await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Not enabling");
    }
    expect(fake.calls).not.toContain("systemctl --user enable hackd.service");
  }
);

linuxTest(
  "systemctl found on a PATH directory others can write is not run",
  async () => {
    // Codex security review: a first-on-PATH systemctl in a writable directory
    // ran as the user from status, doctor, start and install.
    const planted = join(root, "planted-bin");
    await mkdir(planted);
    const marker = join(root, "planted-ran");
    await writeFile(
      join(planted, "systemctl"),
      `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\necho Version=255\n`
    );
    await chmod(join(planted, "systemctl"), 0o755);
    await chmod(planted, 0o777);
    const deps = defaultSystemdDeps({ env: { PATH: planted, HOME: root } });
    const refused = await deps.run("systemctl", ["--user", "show"]);
    expect(refused.exitCode).toBe(126);
    expect(refused.stderr).toContain("refusing to run");
    expect(await Bun.file(marker).exists()).toBe(false);
    // The same tool in a protected directory runs.
    await chmod(planted, 0o755);
    const ran = await deps.run("systemctl", ["--user", "show"]);
    expect(ran.exitCode).toBe(0);
    expect(await Bun.file(marker).exists()).toBe(true);
  }
);

linuxTest(
  "an EnvironmentFile on the unit stops install before enable and start",
  async () => {
    // Codex review: an EnvironmentFile= can set PATH, which the Environment=
    // query did not see.
    const fake = fakeSystemd();
    fake.environmentFiles = "/srv/hackd.env (ignore_errors=no)";
    const install = await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
    expect(install.ok).toBe(false);
    if (!install.ok) {
      expect(install.error).toContain("EnvironmentFile");
    }
    expect(fake.calls).not.toContain("systemctl --user enable hackd.service");
    expect(
      await checkSystemdLoadedUnitPaths({ unitPath, deps: fake.deps })
    ).toContain("EnvironmentFile");
  }
);

linuxTest(
  "the programs systemd will run (drop-in Exec* overrides) are checked",
  async () => {
    // Codex review: a drop-in can override ExecStart (or add ExecStartPre=)
    // with a program others can replace; only the unit file's was checked.
    const fake = fakeSystemd();
    await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
    expect(await checkSystemdServicePrograms({ deps: fake.deps })).toBeNull();
    const shared = join(root, "shared-exec");
    await mkdir(shared);
    await chmod(shared, 0o777);
    const planted = join(shared, "payload");
    await writeFile(planted, "#!/bin/sh\n");
    await chmod(planted, 0o755);
    fake.extraExecLines = [
      `ExecStartPre={ path=${planted} ; argv[]=${planted} ; ignore_errors=no }`,
    ];
    // Allowlist: any Exec* entry besides Hack's own ExecStart is refused.
    expect(await checkSystemdServicePrograms({ deps: fake.deps })).toContain(
      "ExecStartPre"
    );
    fake.calls.length = 0;
    expect(await startViaSystemdIfInstalled(startHooks(fake))).toBe(1);
    expect(fake.calls).not.toContain("systemctl --user start hackd.service");
    // Install refuses before enable too.
    const install = await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
    expect(install.ok).toBe(false);
    // A second ExecStart (an override that did not reset it) is refused.
    fake.extraExecLines = [
      `ExecStart={ path=${program} ; argv[]=${program} daemon start --foreground ; ignore_errors=no }`,
    ];
    expect(await checkSystemdServicePrograms({ deps: fake.deps })).toContain(
      "exactly one"
    );
    // An interpreter wrapper (`/bin/sh script`) is not Hack's ExecStart.
    fake.extraExecLines = [];
    const wrapper = join(shared, "hook.sh");
    await writeFile(wrapper, "true\n");
    await writeFile(
      unitPath,
      unitText().replace(
        /^ExecStart=.*$/m,
        () => `ExecStart=/bin/sh ${wrapper}`
      )
    );
    expect(await checkSystemdServicePrograms({ deps: fake.deps })).toContain(
      "does not run or vouch for"
    );
    await writeFile(unitPath, unitText());
    // An entry that cannot be read is refused.
    fake.extraExecLines = ["ExecStop={ something odd }"];
    expect(await checkSystemdServicePrograms({ deps: fake.deps })).toContain(
      "cannot read"
    );
  }
);

linuxTest(
  "stop and uninstall never run stop hooks Hack cannot vouch for",
  async () => {
    // Codex security review: `systemctl stop` and `disable --now` run ExecStop
    // hooks; `systemctl kill` does not avoid them either (systemd runs stop
    // hooks whenever the service stops), so nothing that stops it may run.
    const fake = fakeSystemd({ active: true });
    await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
    const shared = join(root, "shared-hooks");
    await mkdir(shared);
    await chmod(shared, 0o777);
    const hook = join(shared, "on-stop");
    await writeFile(hook, "#!/bin/sh\n");
    await chmod(hook, 0o755);
    fake.extraExecLines = [
      `ExecStopPost={ path=${hook} ; argv[]=${hook} ; ignore_errors=no }`,
    ];
    fake.active = true;
    const stopping = ["stop", "kill", "disable", "restart"].map(
      (verb) => `systemctl --user ${verb}`
    );
    const stopCalls = () =>
      fake.calls.filter((call) =>
        stopping.some((prefix) => call.startsWith(prefix))
      );

    fake.calls.length = 0;
    const stop = await stopViaSystemdIfInstalled({
      proveDaemon: proveFor(fake),
      pid: null,
      hackHome: join(root, ".hack"),
      deps: fake.deps,
    });
    expect(stop.handled).toBe(false);
    expect(stop.refused).toContain("daemon-reload");
    expect(stop.refused).not.toContain("systemctl --user kill");
    expect(stopCalls()).toEqual([]);

    fake.calls.length = 0;
    const removed = await uninstallSystemdUnit({ unitPath, deps: fake.deps });
    expect(removed.ok).toBe(false);
    expect(stopCalls()).toEqual([]);
    expect(await Bun.file(unitPath).exists()).toBe(true);
    expect(fake.active).toBe(true);
  }
);

linuxTest(
  "programs already in a service PATH directory are checked too",
  async () => {
    // Codex security review: a protected PATH directory can still hold a
    // group-writable `docker` that hackd runs at every start.
    const bin = join(root, "path-bin");
    await mkdir(bin);
    await chmod(bin, 0o755);
    const docker = join(bin, "docker");
    await writeFile(docker, "#!/bin/sh\n");
    await chmod(docker, 0o775);
    expect(await checkServicePathDirectories({ dirs: [bin] })).toContain(
      "contents cannot be trusted"
    );
    expect((await stat(docker)).mode & 0o777).toBe(0o775);
    await chmod(docker, 0o755);
    expect(await checkServicePathDirectories({ dirs: [bin] })).toBeNull();

    // A helper that links into a directory others can write.
    const shared = join(root, "shared-helpers");
    await mkdir(shared);
    await chmod(shared, 0o777);
    const real = join(shared, "git");
    await writeFile(real, "#!/bin/sh\n");
    await chmod(real, 0o755);
    await symlink(real, join(bin, "git"));
    expect(await checkServicePathDirectories({ dirs: [bin] })).toContain(
      shared
    );
    await chmod(shared, 0o755);
    expect(await checkServicePathDirectories({ dirs: [bin] })).toBeNull();
    // Subdirectories are not programs.
    await mkdir(join(bin, "lib"));
    await chmod(join(bin, "lib"), 0o777);
    expect(await checkServicePathDirectories({ dirs: [bin] })).toBeNull();
  }
);

linuxTest(
  "a unit whose program was removed can still be stopped and uninstalled",
  async () => {
    // Codex review: stop and uninstall ran the start-time checks, so a
    // missing ExecStart program (an upgrade or cleanup) blocked both. A stop
    // runs only ExecStop/ExecStopPost.
    const fake = fakeSystemd({ active: true });
    const old = await writeOldUnit(fake);
    await rm(old);
    fake.active = true;
    fake.calls.length = 0;
    const stop = await stopViaSystemdIfInstalled({
      proveDaemon: proveFor(fake),
      pid: null,
      hackHome: join(root, ".hack"),
      deps: fake.deps,
    });
    expect(stop.refused).toBeNull();
    expect(stop.handled).toBe(true);
    expect(fake.calls).toContain("systemctl --user stop hackd.service");

    fake.active = true;
    fake.calls.length = 0;
    const removed = await uninstallSystemdUnit({ unitPath, deps: fake.deps });
    expect(removed.ok).toBe(true);
    expect(fake.calls).toContain(
      "systemctl --user disable --now hackd.service"
    );
    expect(await Bun.file(unitPath).exists()).toBe(false);
  }
);

linuxTest(
  "another account's program in a sticky root-owned directory is not trusted",
  async () => {
    // Codex review: the package-manager owner exception also accepted a
    // foreign-owned file in /tmp (root-owned, 1777), whose owner controls it.
    // Real cross-user files cannot be made here; /tmp itself is the
    // root-owned sticky directory, and the uid the check compares to models
    // the other account.
    const own = process.getuid?.() ?? 0;
    const tmpProgram = join(tmpdir(), `hack-sticky-${process.pid}`);
    await writeFile(tmpProgram, "#!/bin/sh\n");
    await chmod(tmpProgram, 0o755);
    try {
      const tmpInfo = await stat(tmpdir());
      if (tmpInfo.uid === 0 && (tmpInfo.mode & 0o1000) !== 0) {
        expect(
          await checkServiceExecutableTrusted({
            path: tmpProgram,
            uid: own + 1,
          })
        ).toContain("owned by another user");
      }
      // In a protected root-owned directory the exception still applies.
      expect(
        await checkServiceExecutableTrusted({ path: "/bin/sh", uid: own + 1 })
      ).toBeNull();
    } finally {
      await rm(tmpProgram, { force: true });
    }
  }
);

linuxTest(
  "a stale symlink in a service PATH directory does not block hackd",
  async () => {
    // Codex review: a dangling link left by an uninstalled tool refused
    // install and start, although nobody else can create its target.
    const bin = join(root, "stale-bin");
    await mkdir(bin);
    await chmod(bin, 0o755);
    await symlink("../removed-tool", join(bin, "old-tool"));
    expect(await checkServicePathDirectories({ dirs: [bin] })).toBeNull();
    // A dangling link into a directory others can write is still refused.
    const shared = join(root, "shared-later");
    await mkdir(shared);
    await chmod(shared, 0o777);
    await symlink(join(shared, "not-yet"), join(bin, "later"));
    expect(await checkServicePathDirectories({ dirs: [bin] })).toContain(
      shared
    );
  }
);

linuxTest(
  "install does not enable a unit a drop-in points at another Hack home",
  async () => {
    // Codex review: install restarted (and handed over to) a unit whose
    // drop-in sets HACK_HOME to another home.
    const fake = fakeSystemd();
    fake.unitEnvironment = "HACK_HOME=/srv/other-home HACK_NO_INTERACTIVE=1";
    const result = await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
      hackHome: join(root, ".hack"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("/srv/other-home");
    }
    expect(fake.calls).not.toContain("systemctl --user enable hackd.service");
    // The full install command stops there: no handover, no start/restart.
    fake.calls.length = 0;
    expect(await installDaemonSystemdService(installHooks(fake, []))).toBe(1);
    expect(fake.calls).not.toContain("systemctl --user start hackd.service");
    expect(fake.calls).not.toContain("systemctl --user restart hackd.service");
  }
);

linuxTest(
  "another regular user's program is never trusted, even in a protected root directory",
  async () => {
    // Codex security review: the owner of a 0755 file can chmod and rewrite it
    // whatever its directory. Only system accounts (below UID_MIN) get the
    // package-manager exception. Modelled with the uid the check compares to.
    const { isSystemAccount } = await import("../src/lib/path-trust.ts");
    expect(isSystemAccount(1)).toBe(true);
    expect(isSystemAccount(0)).toBe(false);
    expect(isSystemAccount(60_000)).toBe(false);
    // /usr/bin/at-like case: a system account's file in /usr/bin stays fine.
    // A regular user's file: refused (this test's own file, attributed to a
    // regular uid that is not the checker's).
    const own = process.getuid?.() ?? 0;
    const bin = join(root, "regular-bin");
    await mkdir(bin);
    await chmod(bin, 0o755);
    const tool = join(bin, "tool");
    await writeFile(tool, "#!/bin/sh\n");
    await chmod(tool, 0o755);
    expect(
      await checkServicePathDirectories({ dirs: [bin], uid: own + 60_000 })
    ).toContain("owned by another user");
  }
);

linuxTest(
  "uninstall does not stop or remove another Hack home's unit",
  async () => {
    // Codex review: `disable --now` from the default home stopped a unit a
    // drop-in points at another HACK_HOME.
    const fake = fakeSystemd({ active: true });
    await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
    fake.active = true;
    fake.unitEnvironment = "HACK_HOME=/srv/other-home";
    fake.calls.length = 0;
    const result = await uninstallSystemdUnit({
      unitPath,
      deps: fake.deps,
      hackHome: join(root, ".hack"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("/srv/other-home");
    }
    expect(fake.calls.some((call) => call.includes(" disable"))).toBe(false);
    expect(await Bun.file(unitPath).exists()).toBe(true);
    expect(fake.active).toBe(true);
    // The command passes the CLI's own Hack home.
    expect(
      await uninstallDaemonSystemdService({
        deps: fake.deps,
        daemonRoot: join(root, ".hack", "daemon"),
      })
    ).toBe(1);
    expect(await Bun.file(unitPath).exists()).toBe(true);
  }
);

linuxTest(
  "an ExecStart with arguments before `daemon start --foreground` is refused",
  async () => {
    // Codex review: `/bin/bash /shared/script daemon start --foreground`
    // ended with the expected words, and bash runs the script.
    const fake = fakeSystemd();
    await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
    expect(await checkSystemdServicePrograms({ deps: fake.deps })).toBeNull();
    await writeFile(
      unitPath,
      unitText().replace(
        /^ExecStart=.*$/m,
        () => "ExecStart=/bin/bash /srv/shared/script daemon start --foreground"
      )
    );
    expect(await checkSystemdServicePrograms({ deps: fake.deps })).toContain(
      "does not run or vouch for"
    );
  }
);

linuxTest(
  "a HACK_HOME in the user manager's environment counts as the unit's home",
  async () => {
    // Codex review: the unit inherits the user manager's environment; a
    // HACK_HOME set there (not in the unit) made stop and uninstall think the
    // unit served this shell's home.
    const fake = fakeSystemd({ active: true });
    // No live main process (as during a pending restart): the loaded
    // configuration is all that says whose the unit is.
    fake.mainPidReported = false;
    await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
    fake.active = true;
    fake.managerEnvironment = `HOME=${root}\nHACK_HOME=/srv/other-home\n`;
    fake.calls.length = 0;
    const stop = await stopViaSystemdIfInstalled({
      proveDaemon: proveFor(fake),
      pid: null,
      hackHome: join(root, ".hack"),
      deps: fake.deps,
    });
    expect(stop).toMatchObject({ handled: false, refused: null });
    expect(fake.calls).not.toContain("systemctl --user stop hackd.service");
    const removed = await uninstallSystemdUnit({
      unitPath,
      deps: fake.deps,
      hackHome: join(root, ".hack"),
    });
    expect(removed.ok).toBe(false);
    // The unit's own Environment= still wins over the manager's.
    fake.unitEnvironment = `HACK_HOME=${join(root, ".hack")}`;
    expect(
      (
        await stopViaSystemdIfInstalled({
          proveDaemon: proveFor(fake),
          pid: null,
          hackHome: join(root, ".hack"),
          deps: fake.deps,
        })
      ).refused
    ).toBeNull();
  }
);

linuxTest(
  "install checks what holds the config home before creating anything",
  async () => {
    // Codex security review: between mkdir and chmod another account could
    // swap the new directory for a link when its parent is writable by them.
    const shared = join(root, "shared-config-parent");
    await mkdir(shared);
    await chmod(shared, 0o777);
    const configHome = join(shared, "config");
    const fake = fakeSystemd();
    const result = await ensureOwnerWritableOnlyDirectories({
      dirs: [configHome, join(configHome, "systemd")],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(shared);
    }
    // Nothing was created.
    expect(await Bun.file(join(configHome, "systemd")).exists()).toBe(false);
    expect(fake.calls).toEqual([]);
  }
);

linuxTest(
  "the service PATH is the effective one, inherited from the user manager",
  async () => {
    // Second-family review: with no PATH in the unit, the manager's PATH
    // (which the service inherits) was replaced by systemd's fixed default.
    const fake = fakeSystemd();
    await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
    const shared = join(root, "shared-helpers");
    await mkdir(shared);
    await chmod(shared, 0o777);
    fake.unitEnvironment = "HACK_NO_INTERACTIVE=1";
    fake.managerEnvironment = `HOME=${root}\nPATH=${shared}:/usr/bin\n`;
    expect(
      await readSystemdServicePathDirectories({ deps: fake.deps })
    ).toEqual({ dirs: [shared, "/usr/bin"] });
    expect(
      await checkSystemdLoadedUnitPaths({ unitPath, deps: fake.deps })
    ).toContain(shared);
    // The unit's own PATH wins over the manager's.
    fake.unitEnvironment = '"PATH=/usr/bin:/bin"';
    expect(
      await readSystemdServicePathDirectories({ deps: fake.deps })
    ).toEqual({ dirs: ["/usr/bin", "/bin"] });
    // UnsetEnvironment=PATH applies last: nothing sets PATH, so the lookup
    // fallbacks are what hackd uses.
    fake.unsetEnvironment = "PATH";
    const unset = await readSystemdServicePathDirectories({ deps: fake.deps });
    expect("dirs" in unset && unset.dirs).toContain("/usr/local/sbin");
    expect("dirs" in unset && unset.dirs).not.toContain(shared);
    // PassEnvironment=PATH copies a value not visible here: refused.
    fake.unsetEnvironment = "";
    fake.passEnvironment = "PATH";
    expect(
      await readSystemdServicePathDirectories({ deps: fake.deps })
    ).toMatchObject({ error: expect.stringContaining("PassEnvironment") });
    // A manager PATH printed with escapes is not guessed at.
    fake.passEnvironment = "";
    fake.unitEnvironment = "HACK_NO_INTERACTIVE=1";
    fake.managerEnvironment = `HOME=${root}\nPATH=$'/usr/bin:\\n/x'\n`;
    expect(
      await readSystemdServicePathDirectories({ deps: fake.deps })
    ).toMatchObject({ error: expect.stringContaining("quoting") });
  }
);

linuxTest(
  "an interpreter as the ExecStart program is refused, the unit left alone",
  async () => {
    // Second-family review: `ExecStart=/bin/bash daemon start --foreground`
    // passed the exact-argv check, and bash runs a script named `daemon`.
    const fake = fakeSystemd();
    await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
    // The rendered unit (a hack-named `#!` shim) is accepted.
    expect(await checkSystemdServicePrograms({ deps: fake.deps })).toBeNull();
    const bash = Bun.which("bash") ?? "/bin/bash";
    const withProgram = async (path: string) => {
      await writeFile(
        unitPath,
        unitText().replace(
          /^ExecStart=.*$/m,
          () => `ExecStart=${path} daemon start --foreground`
        )
      );
    };
    await withProgram(bash);
    const before = await readFile(unitPath, "utf8");
    expect(await checkSystemdServicePrograms({ deps: fake.deps })).toContain(
      "does not recognize as a hack executable"
    );
    expect(await readFile(unitPath, "utf8")).toBe(before);
    // Naming a link `hack` does not make the interpreter a hack executable.
    const disguised = join(root, "bin", "hack-disguised");
    await symlink(bash, disguised);
    await withProgram(disguised);
    expect(await checkSystemdServicePrograms({ deps: fake.deps })).toContain(
      "does not recognize as a hack executable"
    );
    // A hack-named link to a `#!` launcher (a package manager's) is the
    // launcher itself, whose chain is checked.
    const launcher = join(root, "bin", "cli.js");
    await writeFile(launcher, "#!/usr/bin/env bun\n");
    await chmod(launcher, 0o755);
    const linked = join(root, "bin", "hack-linked");
    await symlink(launcher, linked);
    await withProgram(linked);
    expect(await checkSystemdServicePrograms({ deps: fake.deps })).toBeNull();
  }
);

linuxTest(
  "stop reads the unit's Hack home after UnsetEnvironment",
  async () => {
    // Second-family review: `UnsetEnvironment=HACK_HOME` removed a HACK_HOME
    // naming this shell's home, so hackd used `$HOME/.hack` of another HOME.
    const fake = fakeSystemd({ active: true });
    // No live main process (as during a pending restart): the loaded
    // configuration is all that says whose the unit is.
    fake.mainPidReported = false;
    await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
    const stop = () =>
      stopViaSystemdIfInstalled({
        proveDaemon: proveFor(fake),
        pid: null,
        hackHome: join(root, ".hack"),
        deps: fake.deps,
      });
    fake.active = true;
    fake.unitEnvironment = `HACK_HOME=${join(root, ".hack")} HOME=/srv/other`;
    fake.unsetEnvironment = "HACK_HOME";
    fake.calls.length = 0;
    // The unit serves /srv/other/.hack: left alone.
    const refused = await stop();
    expect(refused).toMatchObject({ handled: false, refused: null });
    expect(fake.calls).not.toContain("systemctl --user stop hackd.service");
    // `NAME=VALUE` unsets only that exact assignment.
    fake.unsetEnvironment = "HACK_HOME=/srv/elsewhere";
    expect((await stop()).handled).toBe(true);
    // PassEnvironment=HOME cannot be read with certainty: refused, with
    // the manual command.
    fake.active = true;
    fake.unitEnvironment = "HACK_NO_INTERACTIVE=1";
    fake.unsetEnvironment = "";
    fake.passEnvironment = "HOME";
    const unknown = await stop();
    expect(unknown.refused).toContain("could not be read");
    expect(unknown.refused).toContain("systemctl --user stop hackd.service");
    expect(fake.active).toBe(true);
  }
);

linuxTest(
  "escapes in the unit environment and ExecSearchPath= are refused",
  async () => {
    // Reviewer: `Environment="X=a\" PATH=/usr/bin"` is one variable X, but
    // a quote-only word split read a PATH out of it.
    const fake = fakeSystemd();
    fake.unitEnvironment = '"X=a\\" PATH=/usr/bin"';
    expect(
      await readSystemdServicePathDirectories({ deps: fake.deps })
    ).toMatchObject({ error: expect.stringContaining("escape") });
    fake.unitEnvironment = "HACK_NO_INTERACTIVE=1";
    fake.unsetEnvironment = '"X=a\\" HACK_HOME"';
    expect(
      await readSystemdServicePathDirectories({ deps: fake.deps })
    ).toMatchObject({ error: expect.stringContaining("UnsetEnvironment") });
    // ExecSearchPath= (systemd 250+) sets the service PATH: not checked
    // here, so refused.
    fake.unsetEnvironment = "";
    fake.execSearchPath = join(root, "shared-bin");
    expect(
      await readSystemdServicePathDirectories({ deps: fake.deps })
    ).toMatchObject({ error: expect.stringContaining("ExecSearchPath") });
  }
);

linuxTest("a #! launcher's interpreter line is checked", async () => {
  // Reviewer: the kernel runs `<interpreter> [arg] <launcher> ...`; an
  // extra script argument or a replaceable interpreter was not checked.
  const fake = fakeSystemd();
  await installSystemdUnit({
    unitPath,
    unitText: unitText(),
    deps: fake.deps,
  });
  const setLauncher = (text: string) => writeFile(program, text);
  // Plain absolute interpreter and `env <name>`: accepted.
  await setLauncher("#!/bin/sh\n");
  expect(await checkSystemdServicePrograms({ deps: fake.deps })).toBeNull();
  await setLauncher("#!/usr/bin/env bash\nexec true\n");
  expect(await checkSystemdServicePrograms({ deps: fake.deps })).toBeNull();
  // An extra script on the #! line runs code Hack has not checked.
  await setLauncher("#!/bin/sh /srv/other/script.sh\n");
  expect(await checkSystemdServicePrograms({ deps: fake.deps })).toContain(
    "does not vouch for"
  );
  await setLauncher("#!/usr/bin/env -S bash /srv/other/script.sh\n");
  expect(await checkSystemdServicePrograms({ deps: fake.deps })).toContain(
    "does not vouch for"
  );
  // An interpreter in a directory others can write is refused.
  const shared = join(root, "shared-tools");
  await mkdir(shared);
  const interpreter = join(shared, "runner");
  await writeFile(interpreter, "binary");
  await chmod(interpreter, 0o755);
  await chmod(shared, 0o777);
  await setLauncher(`#!${interpreter}\n`);
  expect(await checkSystemdServicePrograms({ deps: fake.deps })).toContain(
    shared
  );
  // A #! interpreter that is itself a script is not followed.
  await chmod(shared, 0o755);
  await writeFile(interpreter, "#!/bin/sh\n");
  expect(await checkSystemdServicePrograms({ deps: fake.deps })).toContain(
    "itself a script"
  );
});

linuxTest(
  "install does not replace or restart a running unit of another Hack home",
  async () => {
    // Codex review: install rewrote the unit (dropping another home's
    // HACK_HOME) before checking its home, then restarted that home's hackd.
    const fake = fakeSystemd({ active: true });
    const foreignUnit = unitText().replace(
      "Environment=HACK_NO_INTERACTIVE=1",
      "Environment=HACK_NO_INTERACTIVE=1\nEnvironment=HACK_HOME=/srv/other-home"
    );
    await mkdir(dirname(unitPath), { recursive: true, mode: 0o700 });
    await writeFile(unitPath, foreignUnit, { mode: 0o600 });
    fake.active = true;
    fake.unitEnvironment = "HACK_NO_INTERACTIVE=1 HACK_HOME=/srv/other-home";
    fake.calls.length = 0;
    expect(await installDaemonSystemdService(installHooks(fake, []))).toBe(1);
    expect(await readFile(unitPath, "utf8")).toBe(foreignUnit);
    expect(fake.calls).not.toContain("systemctl --user daemon-reload");
    expect(fake.calls).not.toContain("systemctl --user restart hackd.service");
    expect(fake.active).toBe(true);
    // An environment that cannot be read is refused the same way.
    fake.unitEnvironment = "HACK_NO_INTERACTIVE=1";
    fake.passEnvironment = "HACK_HOME";
    expect(await installDaemonSystemdService(installHooks(fake, []))).toBe(1);
    expect(await readFile(unitPath, "utf8")).toBe(foreignUnit);
    // This home's running unit is updated as before.
    fake.passEnvironment = "";
    fake.calls.length = 0;
    await installDaemonSystemdService(installHooks(fake, []));
    expect(await readFile(unitPath, "utf8")).toBe(unitText());
    expect(fake.calls).toContain("systemctl --user restart hackd.service");
  }
);

linuxTest(
  "stop and uninstall check the loaded drop-ins, not only Exec* hooks",
  async () => {
    // Codex security review: a planted drop-in with OnSuccess= runs its
    // unit when hackd stops; stop and uninstall checked only Exec* hooks.
    const fake = fakeSystemd({ active: true });
    await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
    const dropInDir = `${unitPath}.d`;
    await mkdir(dropInDir, { mode: 0o700 });
    await chmod(dropInDir, 0o700);
    const dropIn = join(dropInDir, "override.conf");
    await writeFile(dropIn, "[Unit]\nOnSuccess=payload.service\n");
    // Writable by others: its contents cannot be vouched for.
    await chmod(dropIn, 0o666);
    fake.dropInPaths = dropIn;
    fake.active = true;
    fake.calls.length = 0;
    const stop = await stopViaSystemdIfInstalled({
      proveDaemon: proveFor(fake),
      pid: null,
      hackHome: join(root, ".hack"),
      deps: fake.deps,
    });
    expect(stop.refused).toContain(dropIn);
    expect(fake.calls).not.toContain("systemctl --user stop hackd.service");
    const removed = await uninstallSystemdUnit({
      unitPath,
      deps: fake.deps,
      hackHome: join(root, ".hack"),
    });
    expect(removed.ok).toBe(false);
    expect(fake.calls.some((call) => call.includes(" disable"))).toBe(false);
    expect(fake.active).toBe(true);
    // The user's own protected drop-in is fine.
    await chmod(dropIn, 0o600);
    expect(
      (
        await stopViaSystemdIfInstalled({
          proveDaemon: proveFor(fake),
          pid: null,
          hackHome: join(root, ".hack"),
          deps: fake.deps,
        })
      ).handled
    ).toBe(true);
  }
);

linuxTest(
  "install checks systemd's running unit even with no unit file at this path",
  async () => {
    // Reviewer: another home's running unit loaded from another directory
    // (no file at this shell's unit path) slipped past the guard, then was
    // shadowed by the new file and restarted.
    const fake = fakeSystemd({ active: true });
    fake.active = true;
    fake.unitEnvironment = "HACK_NO_INTERACTIVE=1 HACK_HOME=/srv/other-home";
    expect(await Bun.file(unitPath).exists()).toBe(false);
    expect(await installDaemonSystemdService(installHooks(fake, []))).toBe(1);
    expect(await Bun.file(unitPath).exists()).toBe(false);
    expect(fake.calls).not.toContain("systemctl --user restart hackd.service");
    // A state systemd cannot report: refused, pointing at systemctl status.
    fake.unitEnvironment = "HACK_NO_INTERACTIVE=1";
    fake.showFails = true;
    expect(await installDaemonSystemdService(installHooks(fake, []))).toBe(1);
    expect(await Bun.file(unitPath).exists()).toBe(false);
  }
);

linuxTest(
  "stop and uninstall refuse a unit file others could have edited",
  async () => {
    // Reviewer: stop checked the drop-ins but not the unit file, where
    // OnSuccess= could be added the same way.
    const fake = fakeSystemd({ active: true });
    await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
    await chmod(unitPath, 0o666);
    fake.active = true;
    fake.calls.length = 0;
    const stop = await stopViaSystemdIfInstalled({
      proveDaemon: proveFor(fake),
      pid: null,
      hackHome: join(root, ".hack"),
      deps: fake.deps,
    });
    expect(stop.refused).toContain("Not stopping hackd.service");
    expect(stop.refused).toContain(unitPath);
    expect(fake.calls).not.toContain("systemctl --user stop hackd.service");
    const removed = await uninstallSystemdUnit({
      unitPath,
      deps: fake.deps,
      hackHome: join(root, ".hack"),
    });
    expect(removed.ok).toBe(false);
    expect(fake.calls.some((call) => call.includes(" disable"))).toBe(false);
    expect(fake.active).toBe(true);
  }
);

linuxTest(
  "stop asks systemd even when the managed unit file is gone",
  async () => {
    // Codex review: with the unit file removed (or loaded from another
    // directory) while systemd still had it running or waiting to restart,
    // stop returned early and reported hackd as not running.
    const fake = fakeSystemd();
    const stop = () =>
      stopViaSystemdIfInstalled({
        proveDaemon: proveFor(fake),
        pid: null,
        hackHome: join(root, ".hack"),
        deps: fake.deps,
      });
    expect(await Bun.file(unitPath).exists()).toBe(false);
    // Waiting for its automatic restart: refused explicitly, not "stopped".
    fake.activeState = "activating";
    fake.calls.length = 0;
    const pending = await stop();
    expect(pending.handled).toBe(false);
    expect(pending.refused).toContain("systemctl --user stop hackd.service");
    expect(pending.refused).toContain(unitPath);
    expect(fake.calls).not.toContain("systemctl --user stop hackd.service");
    // Another home's unit (loaded from its own directory) is left to that
    // home: no refusal, so this shell's own direct hackd is still stopped.
    fake.unitEnvironment = "HACK_NO_INTERACTIVE=1 HACK_HOME=/srv/other-home";
    expect((await stop()).refused).toBeNull();
    expect(fake.calls).not.toContain("systemctl --user stop hackd.service");
    fake.unitEnvironment = "HACK_NO_INTERACTIVE=1";
    // Not running and no file: nothing to do, as before.
    fake.activeState = "inactive";
    expect(await stop()).toEqual({
      handled: false,
      ownedPid: false,
      failed: null,
      refused: null,
    });
  }
);

linuxTest(
  "a service without HOME belongs to the account's home, not the shell's",
  async () => {
    // Codex review: with UnsetEnvironment=HOME and no HACK_HOME, the unit's
    // home fell back to the invoking shell's HOME; hackd uses the account's
    // home from the password database.
    const fake = fakeSystemd({ active: true });
    // No live main process (as during a pending restart): the loaded
    // configuration is all that says whose the unit is.
    fake.mainPidReported = false;
    await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
    fake.active = true;
    fake.unsetEnvironment = "HOME";
    const stop = () =>
      stopViaSystemdIfInstalled({
        proveDaemon: proveFor(fake),
        pid: null,
        hackHome: join(root, ".hack"),
        deps: fake.deps,
      });
    // The shell's HOME (deps.env.HOME) is root; the account's is not.
    fake.passwdHome = "/srv/account";
    fake.calls.length = 0;
    // The unit serves /srv/account/.hack: left alone.
    const other = await stop();
    expect(other).toMatchObject({ handled: false, refused: null });
    expect(fake.calls).toContain("getent passwd 1000");
    expect(fake.calls).not.toContain("systemctl --user stop hackd.service");
    // An account home that cannot be read: unknown, refused.
    fake.passwdHome = null;
    expect((await stop()).refused).toContain("could not be read");
    // A relative HOME in the service: hackd serves no home; unknown.
    fake.unsetEnvironment = "";
    fake.unitEnvironment = "HOME=rel";
    expect((await stop()).refused).toContain("relative");
    // The account's home is this shell's: stopped.
    fake.unitEnvironment = "HACK_NO_INTERACTIVE=1";
    fake.unsetEnvironment = "HOME";
    fake.passwdHome = root;
    expect((await stop()).handled).toBe(true);
  }
);

linuxTest("start leaves another Hack home's unit alone", async () => {
  // Codex review: start checked PATH, programs and unit files, but not
  // the effective Hack home, so it started another home's daemon.
  const fake = fakeSystemd();
  await installSystemdUnit({
    unitPath,
    unitText: unitText(),
    deps: fake.deps,
  });
  fake.unitEnvironment = "HACK_NO_INTERACTIVE=1 HACK_HOME=/srv/other-home";
  fake.calls.length = 0;
  // Null: the caller starts this home's hackd directly.
  expect(await startViaSystemdIfInstalled(startHooks(fake))).toBeNull();
  expect(fake.calls).not.toContain("systemctl --user start hackd.service");
  expect(fake.calls).not.toContain("systemctl --user daemon-reload");
  expect(fake.active).toBe(false);
  // An unreadable home is refused.
  fake.unitEnvironment = "HACK_NO_INTERACTIVE=1";
  fake.passEnvironment = "HACK_HOME";
  expect(await startViaSystemdIfInstalled(startHooks(fake))).toBe(1);
  expect(fake.active).toBe(false);
  // This shell's home: started.
  fake.passEnvironment = "";
  expect(await startViaSystemdIfInstalled(startHooks(fake))).toBe(0);
  expect(fake.active).toBe(true);
});

linuxTest(
  "start checks the Hack home again after completing a pending reload",
  async () => {
    // Codex review: the home was read from the old loaded config; the
    // pending reload then loaded another home's setting, which was started.
    const fake = fakeSystemd();
    await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
    fake.needsReload = true;
    const run = fake.deps.run;
    // What is on disk names another home; systemd sees it after reloading.
    const deps: SystemdDeps = {
      ...fake.deps,
      run: async (command, args) => {
        const result = await run(command, args);
        if (command === "systemctl" && args.includes("daemon-reload")) {
          fake.unitEnvironment =
            "HACK_NO_INTERACTIVE=1 HACK_HOME=/srv/other-home";
        }
        return result;
      },
    };
    fake.calls.length = 0;
    expect(
      await startViaSystemdIfInstalled({ ...startHooks(fake), deps })
    ).toBeNull();
    expect(fake.calls).toContain("systemctl --user daemon-reload");
    expect(fake.calls).not.toContain("systemctl --user start hackd.service");
    expect(fake.active).toBe(false);
  }
);

linuxTest(
  "a service environment that loads code is refused before enable and start",
  async () => {
    // Codex security review: LD_PRELOAD from a drop-in or the user manager's
    // environment runs a library before Hack's checked program.
    const fake = fakeSystemd();
    fake.unitEnvironment = "HACK_NO_INTERACTIVE=1 LD_PRELOAD=/srv/shared/x.so";
    const install = await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
    expect(install.ok).toBe(false);
    if (!install.ok) {
      expect(install.error).toContain("LD_PRELOAD");
    }
    expect(fake.calls).not.toContain("systemctl --user enable hackd.service");
    // From the user manager's environment: refused before start.
    fake.unitEnvironment = "HACK_NO_INTERACTIVE=1";
    fake.managerEnvironment = `HOME=${root}\nPATH=/usr/bin:/bin\nNODE_OPTIONS=--require=/srv/x.js\n`;
    expect(
      await checkSystemdLoadedUnitPaths({ unitPath, deps: fake.deps })
    ).toContain("NODE_OPTIONS");
    // UnsetEnvironment= in a drop-in removes it: accepted.
    fake.unsetEnvironment = "NODE_OPTIONS";
    expect(
      await readSystemdServicePathDirectories({ deps: fake.deps })
    ).toEqual({ dirs: ["/usr/bin", "/bin"] });
    // bash runs PS4 under SHELLOPTS=xtrace: refused as well (a drop-in
    // that drops the rendered UnsetEnvironment= and sets it again).
    fake.unsetEnvironment = "";
    fake.managerEnvironment = `HOME=${root}\nPATH=/usr/bin:/bin\nSHELLOPTS=xtrace\n`;
    expect(
      await readSystemdServicePathDirectories({ deps: fake.deps })
    ).toMatchObject({ error: expect.stringContaining("SHELLOPTS") });
    // The rendered unit strips them all itself, login starts included.
    const unset = unitText()
      .split("\n")
      .find((line) => line.startsWith("UnsetEnvironment="));
    for (const key of ["LD_PRELOAD", "NODE_OPTIONS", "SHELLOPTS", "PS4"]) {
      expect(unset?.split(/[= ]/)).toContain(key);
    }
    // PassEnvironment= of one cannot be read here: refused.
    fake.managerEnvironment = `HOME=${root}\nPATH=/usr/bin:/bin\n`;
    fake.passEnvironment = "LD_PRELOAD";
    expect(
      await readSystemdServicePathDirectories({ deps: fake.deps })
    ).toMatchObject({ error: expect.stringContaining("PassEnvironment") });
  }
);

linuxTest("a unit that runs in another file namespace is refused", async () => {
  // Codex security review: RootDirectory= (or a bind mount) makes systemd
  // run another file than the host path `systemctl show` reports.
  const fake = fakeSystemd();
  await installSystemdUnit({
    unitPath,
    unitText: unitText(),
    deps: fake.deps,
  });
  expect(await checkSystemdServicePrograms({ deps: fake.deps })).toBeNull();
  fake.namespaceLines = ["RootDirectory=/srv/shared/root"];
  expect(await checkSystemdServicePrograms({ deps: fake.deps })).toContain(
    "RootDirectory=/srv/shared/root"
  );
  expect(
    await checkSystemdLoadedUnitPaths({ unitPath, deps: fake.deps })
  ).toContain("RootDirectory");
  fake.namespaceLines = [
    "RootDirectory=",
    `BindReadOnlyPaths=/srv/shared/hack:${program}`,
  ];
  expect(await checkSystemdServicePrograms({ deps: fake.deps })).toContain(
    "BindReadOnlyPaths"
  );
});

linuxTest(
  "uninstall asks systemd even when the managed unit file is gone",
  async () => {
    // Codex review: with the unit file removed while systemd still ran it
    // (or waited to restart it), uninstall reported success without asking.
    const fake = fakeSystemd();
    const uninstall = () =>
      uninstallSystemdUnit({
        unitPath,
        deps: fake.deps,
        hackHome: join(root, ".hack"),
      });
    expect(await Bun.file(unitPath).exists()).toBe(false);
    fake.activeState = "activating";
    fake.calls.length = 0;
    const pending = await uninstall();
    expect(pending.ok).toBe(false);
    if (!pending.ok) {
      expect(pending.error).toContain("systemctl --user stop hackd.service");
      expect(pending.error).toContain(unitPath);
    }
    expect(fake.calls.some((call) => call.includes(" disable"))).toBe(false);
    // Another home's unit: left to that home.
    fake.unitEnvironment = "HACK_NO_INTERACTIVE=1 HACK_HOME=/srv/other-home";
    expect(await uninstall()).toMatchObject({ ok: true, notInstalled: true });
    // Not running and no file: nothing to do, as before.
    fake.unitEnvironment = "HACK_NO_INTERACTIVE=1";
    fake.activeState = "inactive";
    expect(await uninstall()).toMatchObject({ ok: true, notInstalled: true });
  }
);

linuxTest(
  "a failed unit-state read is refused by file-less stop and uninstall",
  async () => {
    // Second-family review: with the managed file gone, a failed or timed
    // out `systemctl show` became "nothing to do": stop exited 0 with
    // hackd "not running" while a Restart=on-failure was pending, and
    // uninstall reported "not installed".
    const fake = fakeSystemd();
    expect(await Bun.file(unitPath).exists()).toBe(false);
    // Waiting for its automatic restart, but the unit query fails (the
    // manager probe itself succeeds).
    fake.activeState = "activating";
    fake.showFails = true;
    fake.calls.length = 0;
    const stop = await stopViaSystemdIfInstalled({
      proveDaemon: proveFor(fake),
      pid: null,
      hackHome: join(root, ".hack"),
      deps: fake.deps,
    });
    expect(stop.handled).toBe(false);
    expect(stop.refused).toContain("could not report");
    expect(stop.refused).toContain("timed out");
    expect(stop.refused).toContain("systemctl --user stop hackd.service");
    const removed = await uninstallSystemdUnit({
      unitPath,
      deps: fake.deps,
      hackHome: join(root, ".hack"),
    });
    expect(removed.ok).toBe(false);
    if (!removed.ok) {
      expect(removed.error).toContain("could not report");
      expect(removed.error).toContain("systemctl --user stop hackd.service");
    }
    expect(
      fake.calls.filter((call) =>
        / (stop|disable|daemon-reload)( |$)/.test(call)
      )
    ).toEqual([]);
    // "Not found" from the query is an observed absence: nothing to do.
    const run = fake.deps.run;
    const notFound: SystemdDeps = {
      ...fake.deps,
      run: (command, args) =>
        command === "systemctl" &&
        args.some((arg) => arg.startsWith("--property=LoadState,"))
          ? Promise.resolve({
              exitCode: 1,
              stdout: "",
              stderr: "Unit hackd.service could not be found.",
            })
          : run(command, args),
    };
    fake.showFails = false;
    expect(
      await stopViaSystemdIfInstalled({
        proveDaemon: proveFor(fake),
        pid: null,
        hackHome: join(root, ".hack"),
        deps: notFound,
      })
    ).toEqual({ handled: false, ownedPid: false, failed: null, refused: null });
    expect(
      await uninstallSystemdUnit({
        unitPath,
        deps: notFound,
        hackHome: join(root, ".hack"),
      })
    ).toMatchObject({ ok: true, notInstalled: true });
  }
);

linuxTest(
  "only a diagnostic naming hackd.service as absent counts as no unit (HACK-2142)",
  async () => {
    // Second-family review: the broad "not found" / "No such file" match
    // read a lost bus or a missing systemctl as "the unit does not exist",
    // so file-less stop and uninstall reported nothing to do.
    const fake = fakeSystemd();
    fake.activeState = "activating";
    expect(await Bun.file(unitPath).exists()).toBe(false);
    const withQuery = (result: ServiceCommandResult): SystemdDeps => ({
      ...fake.deps,
      run: (command, args) =>
        command === "systemctl" &&
        args.some((arg) => arg.startsWith("--property=LoadState,"))
          ? Promise.resolve(result)
          : fake.deps.run(command, args),
    });
    const stop = (deps: SystemdDeps) =>
      stopViaSystemdIfInstalled({
        proveDaemon: proveFor(fake),
        pid: null,
        hackHome: join(root, ".hack"),
        deps,
      });
    const uninstall = (deps: SystemdDeps) =>
      uninstallSystemdUnit({ unitPath, deps, hackHome: join(root, ".hack") });
    for (const failure of [
      {
        exitCode: 1,
        stdout: "",
        stderr: "Failed to connect to bus: No such file or directory",
      },
      // The runner's own report when systemctl vanished between calls.
      { exitCode: 127, stdout: "", stderr: "systemctl not found" },
      // A named-unit line next to another error proves nothing either.
      {
        exitCode: 1,
        stdout: "",
        stderr:
          "Unit hackd.service could not be found.\nFailed to connect to bus: No such file or directory",
      },
    ]) {
      const deps = withQuery(failure);
      fake.calls.length = 0;
      const stopped = await stop(deps);
      expect(stopped.refused).toContain("could not report");
      expect(stopped.refused).toContain("systemctl --user stop hackd.service");
      const removed = await uninstall(deps);
      expect(removed.ok).toBe(false);
      if (!removed.ok) {
        expect(removed.error).toContain("could not report");
      }
      expect(
        fake.calls.filter((call) =>
          / (stop|disable|daemon-reload)( |$)/.test(call)
        )
      ).toEqual([]);
    }
    // The real missing-unit diagnostic (with or without the prefix) stays a
    // successful no-op.
    for (const stderr of [
      "Unit hackd.service could not be found.",
      "Failed to get properties: Unit hackd.service not found.",
    ]) {
      const deps = withQuery({ exitCode: 1, stdout: "", stderr });
      expect(await stop(deps)).toEqual({
        handled: false,
        ownedPid: false,
        failed: null,
        refused: null,
      });
      expect(await uninstall(deps)).toMatchObject({
        ok: true,
        notInstalled: true,
      });
    }
  }
);

linuxTest(
  "the system-directory rule for PATH programs, without the host (HACK-2142)",
  () => {
    // Reviewer: with every in-process test on a temp PATH directory, the
    // root-owned system directory branch (setuid helpers owned by system
    // accounts) had no test; it is exercised here with fixed file details.
    const file = (fields: { readonly uid: number; readonly mode: number }) =>
      fields as unknown as Stats;
    const check = (opts: {
      readonly owner: number;
      readonly mode: number;
      readonly systemDir: boolean;
    }) =>
      programFileProblem({
        path: "/usr/bin/tool",
        info: file({ uid: opts.owner, mode: 0o10_0000 | opts.mode }),
        uid: 4321,
        systemDir: opts.systemDir,
      });
    // Root's and this user's programs are fine anywhere.
    expect(check({ owner: 0, mode: 0o755, systemDir: true })).toBeNull();
    expect(check({ owner: 4321, mode: 0o755, systemDir: false })).toBeNull();
    // A system account's setuid helper only in a protected system directory.
    expect(check({ owner: 1, mode: 0o4755, systemDir: true })).toBeNull();
    expect(check({ owner: 1, mode: 0o4755, systemDir: false })).toContain(
      "owned by another user"
    );
    // Another regular user's program is never trusted.
    expect(check({ owner: 54_321, mode: 0o755, systemDir: true })).toContain(
      "owned by another user"
    );
    // A program others can write is refused even in a system directory.
    expect(check({ owner: 0, mode: 0o775, systemDir: true })).toContain(
      "writable by other users"
    );
  }
);

linuxTest(
  "stop proves the running daemon's home from its process, not the loaded configuration",
  async () => {
    // Second-family review: after a drop-in that set another Hack home is
    // removed and the manager reloaded without a restart, the loaded
    // configuration says "this home" while the running daemon still serves
    // the other one; stop decided from the configuration and stopped it.
    const fake = fakeSystemd({ active: true });
    await installSystemdUnit({
      unitPath,
      unitText: unitText(),
      deps: fake.deps,
    });
    const stop = () =>
      stopViaSystemdIfInstalled({
        proveDaemon: proveFor(fake),
        pid: null,
        hackHome: join(root, ".hack"),
        deps: fake.deps,
      });
    // The loaded configuration is this home's (the drop-in is gone), but
    // the live main process holds its socket elsewhere.
    fake.active = true;
    fake.mainProcess = "foreign";
    fake.calls.length = 0;
    const foreign = await stop();
    expect(foreign.handled).toBe(false);
    expect(foreign.refused).toContain("pid 4242");
    expect(foreign.refused).toContain(
      "not proven to be the hackd of this Hack home"
    );
    expect(foreign.refused).toContain("systemctl --user status hackd.service");
    expect(foreign.refused).toContain("systemctl --user stop hackd.service");
    expect(fake.calls).not.toContain("systemctl --user stop hackd.service");
    expect(fake.active).toBe(true);
    // Process evidence that cannot be read: refused the same way.
    fake.mainProcess = "unknown";
    const unknown = await stop();
    expect(unknown.refused).toContain("not proven");
    expect(fake.calls).not.toContain("systemctl --user stop hackd.service");
    // This home's own daemon: stopped.
    fake.mainProcess = "ours";
    expect((await stop()).handled).toBe(true);
    expect(fake.calls).toContain("systemctl --user stop hackd.service");
    // No live daemon, a restart pending: the configuration decides, and a
    // stop still cancels the restart.
    fake.active = true;
    fake.mainPidReported = false;
    fake.activeState = "activating";
    fake.mainProcess = "foreign";
    fake.calls.length = 0;
    expect((await stop()).handled).toBe(true);
    expect(fake.calls).toContain("systemctl --user stop hackd.service");
  }
);
