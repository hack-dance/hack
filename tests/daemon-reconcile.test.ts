import { expect, test } from "bun:test";

import {
  parseStartEnvelope,
  reconcileDaemonAfterUpdate,
} from "../src/commands/daemon-upgrade.ts";
import {
  isLaunchdPlistCurrent,
  renderLaunchdPlist,
} from "../src/daemon/launchd.ts";
import {
  buildDaemonCommandData,
  createDaemonCommandTrace,
  type DaemonReconcileInput,
  planDaemonReconcile,
  reconcileAction,
} from "../src/daemon/reconcile.ts";

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
