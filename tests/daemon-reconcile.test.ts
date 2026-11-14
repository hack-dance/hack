import { expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkRunningLaunchdDaemon } from "../src/commands/daemon-launchd.ts";
import {
  observePostUpdateDaemon,
  parseStartEnvelope,
  reconcileDaemonAfterUpdate,
} from "../src/commands/daemon-upgrade.ts";
import {
  isHackManagedPlist,
  isLaunchdPlistCurrent,
  isSameExecutableFile,
  renderLaunchdPlist,
} from "../src/daemon/launchd.ts";
import { resolveDaemonPaths } from "../src/daemon/paths.ts";
import { hasAncestorProcess } from "../src/daemon/process-ancestry.ts";
import {
  buildDaemonCommandData,
  createDaemonCommandTrace,
  type DaemonReconcileInput,
  planDaemonReconcile,
  reconcileAction,
} from "../src/daemon/reconcile.ts";
import {
  findDroppedHomeBinding,
  isHackManagedUnit,
  readInvokerInSystemdUnit,
  renderSystemdUnit,
  type SystemdDeps,
} from "../src/daemon/systemd.ts";

/** HACK-2216: the reconcile decision and its `--json` contract, no I/O. */

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
    schema: "hack.daemon-start/v1",
    manager: "systemd",
    action: "reinstalled",
    stale: true,
    stale_reasons: ["content", "version-mismatch"],
    blocked: null,
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
    schema: "hack.daemon-stop/v1",
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
    observe: () =>
      Promise.resolve({ serviceInstalled: true, daemonRunning: true }),
    runCli: (argv) => {
      ran.push([...argv]);
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          data: {
            schema: "hack.daemon-start/v1",
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
  expect(await read("", unit)).toBe("outside");
  expect(await read(null, unit)).toBe("unknown");
  expect(await read(unit, null)).toBe("unknown");
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
    paths: resolveDaemonPaths({ home: "/nonexistent-home" }),
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
  expect(
    isHackManagedPlist({ plistText: "<plist><dict></dict></plist>\n" })
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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
    observe: () =>
      Promise.resolve({ serviceInstalled: true, daemonRunning: true }),
    runCli: () => {
      ran.push({});
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          data: {
            schema: "hack.daemon-start/v1",
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
