import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdministratorAuthorization } from "../src/lib/admin-authorization.ts";
import { resetNoInteractiveFlagForTests } from "../src/lib/interactivity.ts";
import {
  activateNativeDomainDns,
  NativeDnsActivationError,
} from "../src/lib/native-domain-dns-activate.ts";
import {
  createNativeDnsAuthorizer,
  NativeDnsAdministratorAuthorizationError,
  type NativeDnsAuthorizationAction,
  requireNativeAdministratorAuthorization,
} from "../src/lib/native-domain-dns-authorization.ts";
import {
  deactivateNativeDomainDns,
  NativeDnsDeactivationError,
} from "../src/lib/native-domain-dns-deactivate.ts";
import {
  createNativeDnsHostDependencies,
  type NativeDnsCommandRunner,
  type NativeDnsHostDependencies,
} from "../src/lib/native-domain-dns-host.ts";
import {
  type NativeDnsPlan,
  planNativeDomainDns,
} from "../src/lib/native-domain-dns-plan.ts";

/*
 * `hack global dns activate|deactivate` authorizer wired into the real
 * activation/deactivation flows and host effect boundary. Every effect is
 * recorded in one ordered log; sudo, dnsmasq and system DNS are fakes and all
 * files live in a private temporary directory.
 */

const DOMAIN = "project.example.test";
const SUDO_V = "sudo -v";
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const AUTHORIZED: AdministratorAuthorization = { status: "authorized" };
const REJECTED: AdministratorAuthorization = {
  status: "failed",
  failure: "rejected",
  exitCode: 1,
};

function recordingAuthorizer(opts: {
  readonly action: NativeDnsAuthorizationAction;
  readonly log: string[];
  readonly interactive?: boolean;
  readonly accept?: boolean;
  readonly administrator?: AdministratorAuthorization;
}) {
  const prompts: string[] = [];
  const authorize = createNativeDnsAuthorizer({
    action: opts.action,
    domain: DOMAIN,
    dependencies: {
      isInteractive: () => opts.interactive ?? true,
      confirm: async (message) => {
        prompts.push(message);
        opts.log.push("confirm");
        return opts.accept ?? true;
      },
      requestAdministrator: async () => {
        opts.log.push(SUDO_V);
        return opts.administrator ?? AUTHORIZED;
      },
    },
  });
  return { authorize, prompts };
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "native-dns-authorization-"));
  roots.push(root);
  const includeDir = join(root, "dnsmasq.d");
  const resolverDir = join(root, "resolver");
  const privateDir = join(root, "private");
  await Promise.all([
    mkdir(includeDir),
    mkdir(resolverDir),
    mkdir(privateDir, { mode: 0o700 }),
  ]);
  return {
    root,
    includeDir,
    resolverDir,
    mainPath: join(root, "dnsmasq.conf"),
    hostsPath: join(root, "hosts"),
    receiptPath: join(privateDir, "native-dns.json"),
  };
}

type Workspace = Awaited<ReturnType<typeof workspace>>;

function planFor(
  ws: Workspace,
  active?: { readonly plan: NativeDnsPlan }
): NativeDnsPlan {
  return planNativeDomainDns({
    domain: DOMAIN,
    mainConfig: {
      path: ws.mainPath,
      content: `conf-dir=${ws.includeDir},*.conf\n`,
    },
    includeDir: ws.includeDir,
    includeFiles: active
      ? [
          {
            path: active.plan.dnsmasqPath,
            content: active.plan.dnsmasqContent,
          },
        ]
      : [],
    resolverDir: ws.resolverDir,
    resolverFiles: active
      ? [
          {
            path: active.plan.resolverPath,
            content: active.plan.resolverContent,
          },
        ]
      : [],
    hosts: { path: ws.hostsPath, content: "127.0.0.1 localhost\n" },
    dnsmasqArgs: ["dnsmasq", "-7", `${ws.includeDir},*.conf`],
    receipt: active ? active.plan.activeReceipt : null,
  });
}

/**
 * Host effect boundary whose privileged runner, service restart and cache
 * flush (all `sudo -n` in production) and file effects append to `log`.
 */
function recordingHost(opts: {
  readonly ws: Workspace;
  readonly plan: NativeDnsPlan;
  readonly authorize: NativeDnsHostDependencies["authorize"];
  readonly log: string[];
  readonly loopbackAnswer: boolean;
}): NativeDnsHostDependencies {
  const runPrivileged: NativeDnsCommandRunner = async (command) => {
    const action = command[7] ?? "";
    opts.log.push(`sudo -n resolver ${action}`);
    if (action === "remove") {
      await rm(command[8] ?? "", { force: true });
      return { exitCode: 0, stdout: "1\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "42:73\n", stderr: "" };
  };
  const runCommand: NativeDnsCommandRunner = async (command) => {
    if (!opts.loopbackAnswer) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const stdout =
      command[0] === "/usr/bin/dscacheutil"
        ? "name: probe\nip_address: 127.0.0.1\n"
        : "127.0.0.1\n";
    return { exitCode: 0, stdout, stderr: "" };
  };
  const host = createNativeDnsHostDependencies({
    receiptPath: opts.ws.receiptPath,
    dnsmasqPath: opts.plan.dnsmasqPath,
    resolverPath: opts.plan.resolverPath,
    dnsmasqBinary: join(opts.ws.root, "dnsmasq"),
    dnsmasqMainConfigPath: opts.ws.mainPath,
    dnsmasqIncludeDir: opts.ws.includeDir,
    inspectPlan: async () => ({ plan: opts.plan, fingerprint: "snapshot" }),
    authorize: opts.authorize,
    restartDnsmasq: async () => {
      opts.log.push("sudo -n restart dnsmasq");
    },
    flushDnsCache: async () => {
      opts.log.push("sudo -n flush dns cache");
    },
    runCommand,
    runPrivileged,
  });
  return {
    ...host,
    async writeReceipt(receipt) {
      opts.log.push(`write receipt ${receipt.state}`);
      await host.writeReceipt(receipt);
    },
    async createExclusive(file) {
      opts.log.push(`create ${file.path}`);
      return await host.createExclusive(file);
    },
    async removeIfOwned(file) {
      opts.log.push(`remove ${file.path}`);
      return await host.removeIfOwned(file);
    },
  };
}

/** Publish an active claim on disk without touching the recorded log. */
async function activeClaim(ws: Workspace) {
  const available = planFor(ws);
  const setup = createNativeDnsHostDependencies({
    receiptPath: ws.receiptPath,
    dnsmasqPath: available.dnsmasqPath,
    resolverPath: available.resolverPath,
    dnsmasqBinary: join(ws.root, "dnsmasq"),
    dnsmasqMainConfigPath: ws.mainPath,
    dnsmasqIncludeDir: ws.includeDir,
    inspectPlan: async () => ({ plan: available, fingerprint: "setup" }),
    authorize: async () => {
      throw new Error("setup never authorizes");
    },
    restartDnsmasq: async () => {},
    flushDnsCache: async () => {},
    runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
    runPrivileged: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
  });
  await setup.writeReceipt(available.pendingReceipt);
  await setup.writeReceipt(available.activeReceipt);
  await writeFile(available.dnsmasqPath, available.dnsmasqContent);
  await writeFile(available.resolverPath, available.resolverContent);
  return planFor(ws, { plan: available });
}

function assertAuthorizedFirst(log: readonly string[]): void {
  expect(log.slice(0, 2)).toEqual(["confirm", SUDO_V]);
  expect(log.filter((entry) => entry === SUDO_V)).toHaveLength(1);
  // Non-vacuous: privileged and file effects did run, all after sudo -v.
  expect(log.some((entry) => entry.startsWith("sudo -n "))).toBe(true);
  expect(log.some((entry) => entry.startsWith("write receipt "))).toBe(true);
}

test("activate: native administrator authorization precedes every privileged and file effect", async () => {
  const ws = await workspace();
  const plan = planFor(ws);
  const log: string[] = [];
  const { authorize, prompts } = recordingAuthorizer({
    action: "activate",
    log,
  });
  const active = await activateNativeDomainDns({
    dependencies: recordingHost({
      ws,
      plan,
      authorize,
      log,
      loopbackAnswer: true,
    }),
  });
  expect(active).toEqual(plan.activeReceipt);
  assertAuthorizedFirst(log);
  expect(prompts).toEqual([
    `Activate only *.${DOMAIN} at 127.0.0.1 via a new dnsmasq claim and /etc/resolver file? This restarts dnsmasq; existing v4 suffixes remain unchanged.`,
  ]);
});

test("activate: a failed administrator prompt is authorization-failed, not denied, and changes nothing", async () => {
  const ws = await workspace();
  const plan = planFor(ws);
  const log: string[] = [];
  const { authorize } = recordingAuthorizer({
    action: "activate",
    log,
    administrator: REJECTED,
  });
  const failure = await activateNativeDomainDns({
    dependencies: recordingHost({
      ws,
      plan,
      authorize,
      log,
      loopbackAnswer: true,
    }),
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(NativeDnsActivationError);
  const error = failure as NativeDnsActivationError;
  expect(error.phase).toBe("authorization");
  expect(error.rollbackUncertain).toBe(false);
  expect(error.originalCause).toBeInstanceOf(
    NativeDnsAdministratorAuthorizationError
  );
  expect(error.originalCause).toMatchObject({
    outcome: "authorization-failed",
    failure: "rejected",
  });
  expect(error.message).toBe(
    'Native DNS activation failed during authorization: macOS administrator authorization did not complete (sudo -v did not accept the administrator password (exit 1)); nothing changed. Run "sudo -v" in this terminal first, then retry.'
  );
  expect(log).toEqual(["confirm", SUDO_V]);
  await expect(readFile(ws.receiptPath)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(readFile(plan.dnsmasqPath)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("activate: a declined confirmation is denied and never reaches sudo", async () => {
  const ws = await workspace();
  const plan = planFor(ws);
  const log: string[] = [];
  const { authorize } = recordingAuthorizer({
    action: "activate",
    log,
    accept: false,
  });
  await expect(
    activateNativeDomainDns({
      dependencies: recordingHost({
        ws,
        plan,
        authorize,
        log,
        loopbackAnswer: true,
      }),
    })
  ).rejects.toMatchObject({
    phase: "authorization",
    message:
      "Native DNS activation failed during authorization: Native DNS activation was denied",
  });
  expect(log).toEqual(["confirm"]);
});

test("deactivate: native administrator authorization precedes every privileged and file effect", async () => {
  const ws = await workspace();
  const plan = await activeClaim(ws);
  const log: string[] = [];
  const { authorize, prompts } = recordingAuthorizer({
    action: "deactivate",
    log,
  });
  const inactive = await deactivateNativeDomainDns({
    dependencies: recordingHost({
      ws,
      plan,
      authorize,
      log,
      loopbackAnswer: false,
    }),
    receiptPath: ws.receiptPath,
  });
  expect(inactive).toEqual(plan.inactiveReceipt);
  assertAuthorizedFirst(log);
  expect(log).toContain("sudo -n resolver remove");
  expect(prompts).toEqual([
    `Deactivate only the owned *.${DOMAIN} DNS claim? This restarts dnsmasq; the existing v4 parent remains unchanged.`,
  ]);
});

test("deactivate: a failed administrator prompt is authorization-failed, not denied, and changes nothing", async () => {
  const ws = await workspace();
  const plan = await activeClaim(ws);
  const log: string[] = [];
  const { authorize } = recordingAuthorizer({
    action: "deactivate",
    log,
    administrator: { status: "failed", failure: "timed-out", exitCode: 124 },
  });
  const failure = await deactivateNativeDomainDns({
    dependencies: recordingHost({
      ws,
      plan,
      authorize,
      log,
      loopbackAnswer: false,
    }),
    receiptPath: ws.receiptPath,
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(NativeDnsDeactivationError);
  const error = failure as NativeDnsDeactivationError;
  expect(error.phase).toBe("authorization");
  expect(error.originalCause).toMatchObject({
    outcome: "authorization-failed",
    failure: "timed-out",
  });
  expect(error.message).not.toContain("denied");
  expect(error.message).toContain(
    "the macOS administrator prompt timed out after 120 seconds"
  );
  expect(log).toEqual(["confirm", SUDO_V]);
  expect(await readFile(ws.receiptPath, "utf8")).toBe(
    `${JSON.stringify(plan.activeReceipt)}\n`
  );
  expect(await readFile(plan.resolverPath, "utf8")).toBe(plan.resolverContent);
  expect(await readFile(plan.dnsmasqPath, "utf8")).toBe(plan.dnsmasqContent);
});

test("deactivate: a declined confirmation is denied and never reaches sudo", async () => {
  const ws = await workspace();
  const plan = await activeClaim(ws);
  const log: string[] = [];
  const { authorize } = recordingAuthorizer({
    action: "deactivate",
    log,
    accept: false,
  });
  await expect(
    deactivateNativeDomainDns({
      dependencies: recordingHost({
        ws,
        plan,
        authorize,
        log,
        loopbackAnswer: false,
      }),
      receiptPath: ws.receiptPath,
    })
  ).rejects.toMatchObject({
    phase: "authorization",
    message:
      "Native DNS deactivation failed during authorization: Native DNS deactivation was denied",
  });
  expect(log).toEqual(["confirm"]);
  expect(await readFile(plan.resolverPath, "utf8")).toBe(plan.resolverContent);
});

test("without an interactive terminal neither action prompts nor reaches sudo", async () => {
  for (const action of ["activate", "deactivate"] as const) {
    const log: string[] = [];
    const { authorize, prompts } = recordingAuthorizer({
      action,
      log,
      interactive: false,
    });
    expect(await authorize(planFor(await workspace()))).toBe(false);
    expect(log).toEqual([]);
    expect(prompts).toEqual([]);
  }
});

test("every administrator failure class throws instead of returning false", async () => {
  const failures = [
    { status: "failed", failure: "not-foreground", exitCode: null },
    { status: "failed", failure: "timed-out", exitCode: 124 },
    { status: "failed", failure: "interrupted", exitCode: 130 },
    { status: "failed", failure: "rejected", exitCode: 1 },
  ] as const;
  for (const result of failures) {
    await expect(
      requireNativeAdministratorAuthorization({
        requestAdministrator: async () => result,
      })
    ).rejects.toMatchObject({
      name: "NativeDnsAdministratorAuthorizationError",
      outcome: "authorization-failed",
      failure: result.failure,
    });
  }
  expect(
    await requireNativeAdministratorAuthorization({
      requestAdministrator: async () => AUTHORIZED,
    })
  ).toBe(true);
});

/*
 * Production defaults. Only `isInteractive` and `confirm` fall back to the
 * defaults here; the administrator prompt stays a fake, so no test reaches
 * the real `sudo -v`.
 */

async function withStdinTty<T>(
  isTTY: boolean | undefined,
  run: () => Promise<T>
): Promise<T> {
  const saved = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", {
    value: isTTY,
    configurable: true,
    writable: true,
  });
  try {
    return await run();
  } finally {
    if (saved) {
      Object.defineProperty(process.stdin, "isTTY", saved);
    } else {
      Reflect.deleteProperty(process.stdin, "isTTY");
    }
  }
}

async function withExplicitNonInteractive<T>(run: () => Promise<T>) {
  const saved = process.env.HACK_NO_INTERACTIVE;
  process.env.HACK_NO_INTERACTIVE = "1";
  resetNoInteractiveFlagForTests();
  try {
    return await run();
  } finally {
    if (saved === undefined) {
      Reflect.deleteProperty(process.env, "HACK_NO_INTERACTIVE");
    } else {
      process.env.HACK_NO_INTERACTIVE = saved;
    }
  }
}

test("default interactivity check requires a stdin TTY before confirming", async () => {
  const plan = planFor(await workspace());
  for (const action of ["activate", "deactivate"] as const) {
    for (const isTTY of [undefined, false, true] as const) {
      const log: string[] = [];
      const authorize = createNativeDnsAuthorizer({
        action,
        domain: DOMAIN,
        dependencies: {
          confirm: async () => {
            log.push("confirm");
            return false;
          },
          requestAdministrator: async () => {
            log.push(SUDO_V);
            return AUTHORIZED;
          },
        },
      });
      expect(await withStdinTty(isTTY, async () => await authorize(plan))).toBe(
        false
      );
      expect(log).toEqual(isTTY === true ? ["confirm"] : []);
    }
  }
});

test("default confirmation declines an explicitly non-interactive run before sudo", async () => {
  const plan = planFor(await workspace());
  for (const action of ["activate", "deactivate"] as const) {
    const log: string[] = [];
    const authorize = createNativeDnsAuthorizer({
      action,
      domain: DOMAIN,
      dependencies: {
        isInteractive: () => true,
        requestAdministrator: async () => {
          log.push(SUDO_V);
          return AUTHORIZED;
        },
      },
    });
    expect(
      await withExplicitNonInteractive(async () => await authorize(plan))
    ).toBe(false);
    expect(log).toEqual([]);
  }
});
