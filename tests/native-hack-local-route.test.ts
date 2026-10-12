import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { CliUsageError } from "../src/cli/command.ts";
import type { NativeDnsCommandRunner } from "../src/lib/native-domain-dns-host.ts";
import {
  analyzeHackLocalDnsmasq,
  describeHackLocalRollback,
  describeHackLocalRoute,
  HACK_LOCAL_REPAIR_COMMAND,
  HACK_LOCAL_RESOLVER_CONTENT,
  HACK_LOCAL_ROLLBACK_COMMAND,
  type HackLocalRouteDependencies,
  type HackLocalRoutePlan,
  type HackLocalRouteReceipt,
  inspectHackLocalRoute,
  parseHackLocalRouteReceipt,
  repairHackLocalRoute,
  reportHackLocalRoute,
  rollbackHackLocalRoute,
  selectNativeDnsCommandDomain,
  sha256,
} from "../src/lib/native-hack-local-route.ts";
import { createHackLocalRouteFileDependencies } from "../src/lib/native-hack-local-route-host.ts";

const ORIGINAL = [
  "# Managed by hack",
  "port=53",
  "listen-address=127.0.0.1",
  "address=/.hack/172.30.0.2",
  "address=/.hack.local/172.30.0.2",
  "address=/.hack.gy/172.30.0.2",
  "",
  "# trailing user comment",
  "",
].join("\n");

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

interface Calls {
  readonly authorize: string[];
  readonly confirm: string[];
  restart: number;
  flush: number;
  verify: number;
  readDnsmasq: number;
  probes: string[];
}

/** Emulates the privileged resolver script inside the temp root only. */
function fakePrivileged(resolverDir: string): NativeDnsCommandRunner {
  return async (command) => {
    expect(command.slice(0, 3)).toEqual(["sudo", "-n", "/usr/bin/python3"]);
    const [action, path, content, identity] = command.slice(7);
    if (!(path?.startsWith(`${resolverDir}/`) && content !== undefined)) {
      return { exitCode: 1, stdout: "", stderr: "outside root" };
    }
    if (action === "create") {
      const handle = await open(path, "wx", 0o644);
      await handle.writeFile(content);
      const details = await handle.stat();
      await handle.close();
      return {
        exitCode: 0,
        stdout: `${details.dev}:${details.ino}\n`,
        stderr: "",
      };
    }
    try {
      const details = await stat(path);
      const actual = await readFile(path, "utf8");
      if (`${details.dev}:${details.ino}` !== identity || actual !== content) {
        return { exitCode: 0, stdout: "0\n", stderr: "" };
      }
      await unlink(path);
      return { exitCode: 0, stdout: "1\n", stderr: "" };
    } catch {
      return { exitCode: 0, stdout: "0\n", stderr: "" };
    }
  };
}

async function fixture(
  opts: {
    readonly dnsmasq?: string | null;
    readonly resolver?: string | null;
    readonly includeFiles?: Readonly<Record<string, string>>;
    readonly relay?: { readonly port: number } | null;
    readonly oldTargetLive?: boolean;
    readonly prompt?: boolean;
    readonly approve?: boolean;
    readonly ownerUid?: number;
    readonly overrides?: Partial<HackLocalRouteDependencies>;
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), "hack-local-route-"));
  roots.push(root);
  const etc = join(root, "etc");
  const includeDir = join(etc, "dnsmasq.d");
  const resolverDir = join(root, "resolver");
  const home = join(root, "native-home");
  await Promise.all([
    mkdir(includeDir, { recursive: true }),
    mkdir(resolverDir),
    mkdir(home, { mode: 0o700 }),
  ]);
  const dnsmasqPath = join(etc, "dnsmasq.conf");
  const content = opts.dnsmasq === undefined ? ORIGINAL : opts.dnsmasq;
  if (content !== null) {
    await writeFile(dnsmasqPath, content, { mode: 0o644 });
    await chmod(dnsmasqPath, 0o644);
  }
  for (const [name, text] of Object.entries(opts.includeFiles ?? {})) {
    await writeFile(join(includeDir, name), text);
  }
  // Sibling roots that must never change.
  await writeFile(join(resolverDir, "hack"), "nameserver 127.0.0.1\n");
  await writeFile(join(resolverDir, "hack.gy"), "nameserver 127.0.0.1\n");
  const resolverPath = join(resolverDir, "hack.local");
  if (opts.resolver !== undefined && opts.resolver !== null) {
    await writeFile(resolverPath, opts.resolver);
  }
  const calls: Calls = {
    authorize: [],
    confirm: [],
    restart: 0,
    flush: 0,
    verify: 0,
    readDnsmasq: 0,
    probes: [],
  };
  const files = createHackLocalRouteFileDependencies({
    dnsmasqPath,
    includeDir,
    resolverPath,
    receiptPath: join(home, "native-dns", "hack-local-route.json"),
    runPrivileged: fakePrivileged(resolverDir),
    ...(opts.ownerUid === undefined ? {} : { ownerUid: opts.ownerUid }),
  });
  let clock = Date.parse("2026-10-12T12:00:00.000Z");
  const deps: HackLocalRouteDependencies = {
    ...files,
    readDnsmasq: async () => {
      calls.readDnsmasq += 1;
      return await files.readDnsmasq();
    },
    verifyRelay: async () =>
      opts.relay === undefined ? { port: 8443 } : opts.relay,
    probeTarget: async (target) => {
      calls.probes.push(target);
      return opts.oldTargetLive === true;
    },
    canPrompt: () => opts.prompt ?? true,
    authorize: async (message) => {
      calls.authorize.push(message);
      return opts.approve ?? true;
    },
    confirm: async (message) => {
      calls.confirm.push(message);
      return opts.approve ?? true;
    },
    prepareRestart: async () => async () => {
      calls.restart += 1;
    },
    flushDnsCache: async () => {
      calls.flush += 1;
    },
    verifyLiveDns: async () => {
      calls.verify += 1;
    },
    now: () => {
      clock += 1000;
      return new Date(clock);
    },
    ...opts.overrides,
  };
  return { root, deps, calls, dnsmasqPath, resolverPath, resolverDir, home };
}

/** Every file under root except the given paths, as exact bytes. */
async function snapshotTree(
  root: string,
  except: readonly string[]
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (!except.includes(path)) {
        out[relative(root, path)] = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
      }
    }
  };
  await walk(root);
  return out;
}

async function readReceipt(
  deps: HackLocalRouteDependencies
): Promise<HackLocalRouteReceipt> {
  return parseHackLocalRouteReceipt(
    await readFile(deps.paths.receiptPath, "utf8")
  );
}

/** The receipt a crash right after its publication leaves behind. */
function pendingReceipt(
  f: { readonly dnsmasqPath: string; readonly resolverPath: string },
  plan: HackLocalRoutePlan
): HackLocalRouteReceipt {
  return {
    version: 1,
    kind: "hack-local-route-repair",
    state: "pending",
    domain: "hack.local",
    dnsmasqPath: f.dnsmasqPath,
    resolverPath: f.resolverPath,
    oldLine: plan.oldLine,
    newLine: plan.newLine,
    beforeSha256: plan.beforeSha256,
    afterSha256: plan.afterSha256,
    resolverAction: "keep",
    resolverSha256: sha256(HACK_LOCAL_RESOLVER_CONTENT),
    resolverIdentity: null,
    relayPort: 8443,
    createdAt: "2026-10-12T12:00:00.000Z",
    updatedAt: "2026-10-12T12:00:00.000Z",
  };
}

async function editReceipt(
  deps: HackLocalRouteDependencies,
  patch: Record<string, unknown>
): Promise<void> {
  const value: unknown = JSON.parse(
    await readFile(deps.paths.receiptPath, "utf8")
  );
  await writeFile(
    deps.paths.receiptPath,
    JSON.stringify({ ...(value as object), ...patch })
  );
}

const REWRITTEN = ORIGINAL.replace(
  "address=/.hack.local/172.30.0.2",
  "address=/.hack.local/127.0.0.1"
);

test("happy path rewrites only the managed line in place and records a receipt", async () => {
  const f = await fixture();
  const others = await snapshotTree(f.root, [
    f.dnsmasqPath,
    f.resolverPath,
    f.deps.paths.receiptPath,
  ]);

  const before = reportHackLocalRoute(await inspectHackLocalRoute(f.deps));
  expect(before).toMatchObject({
    status: "repairable",
    oldLine: "address=/.hack.local/172.30.0.2",
    newLine: "address=/.hack.local/127.0.0.1",
    resolverAction: "create",
    relayPort: 8443,
    command: HACK_LOCAL_REPAIR_COMMAND,
  });

  const result = await repairHackLocalRoute(f.deps);
  expect(result.outcome).toBe("repaired");

  const after = await readFile(f.dnsmasqPath, "utf8");
  expect(after).toBe(REWRITTEN);
  expect(after.match(/hack\.local/g)).toHaveLength(1);
  expect(after).toContain("address=/.hack/172.30.0.2\n");
  expect(after).toContain("address=/.hack.gy/172.30.0.2\n");
  expect((await stat(f.dnsmasqPath)).mode & 0o777).toBe(0o644);
  expect(await readFile(f.resolverPath, "utf8")).toBe(
    HACK_LOCAL_RESOLVER_CONTENT
  );
  expect(
    await snapshotTree(f.root, [
      f.dnsmasqPath,
      f.resolverPath,
      f.deps.paths.receiptPath,
    ])
  ).toEqual(others);
  expect((await readdir(join(f.root, "etc"))).sort()).toEqual([
    "dnsmasq.conf",
    "dnsmasq.d",
  ]);

  const receipt = await readReceipt(f.deps);
  expect(receipt).toMatchObject({
    state: "applied",
    oldLine: "address=/.hack.local/172.30.0.2",
    newLine: "address=/.hack.local/127.0.0.1",
    beforeSha256: sha256(ORIGINAL),
    afterSha256: sha256(REWRITTEN),
    resolverAction: "create",
    relayPort: 8443,
  });
  expect(receipt.resolverIdentity).toMatch(/^\d+:\d+$/);
  expect(Date.parse(receipt.createdAt)).toBeGreaterThan(0);
  expect((await stat(f.deps.paths.receiptPath)).mode & 0o777).toBe(0o600);
  expect(f.calls.authorize).toHaveLength(1);
  expect(f.calls.authorize[0]).toContain(HACK_LOCAL_ROLLBACK_COMMAND);
  expect(f.calls.probes).toContain("172.30.0.2");
  expect([f.calls.restart, f.calls.flush, f.calls.verify]).toEqual([1, 1, 1]);

  const now = reportHackLocalRoute(await inspectHackLocalRoute(f.deps));
  expect(now).toMatchObject({
    status: "current",
    receiptState: "applied",
    command: HACK_LOCAL_ROLLBACK_COMMAND,
  });
  expect((await repairHackLocalRoute(f.deps)).outcome).toBe("current");
});

test("a live old target refuses so Docker Caddy is never broken", async () => {
  const f = await fixture({ oldTargetLive: true });
  const result = await repairHackLocalRoute(f.deps);
  expect(result).toMatchObject({
    outcome: "refused",
    reason: "old-target-live",
  });
  expect(await readFile(f.dnsmasqPath, "utf8")).toBe(ORIGINAL);
  expect(f.calls.authorize).toHaveLength(0);
  await expect(stat(f.deps.paths.receiptPath)).rejects.toThrow();
});

test("unmanaged hack.local lines refuse without changes", async () => {
  const variants = [
    ORIGINAL.replace(
      "address=/.hack.local/172.30.0.2",
      "address=/.hack.local/172.30.0.2 # mine"
    ),
    ORIGINAL.replace(
      "address=/.hack.local/172.30.0.2",
      "  address=/.hack.local/172.30.0.2"
    ),
    ORIGINAL.replace(
      "address=/.hack.local/172.30.0.2",
      "address=/.hack.local/172.30.0.2\naddress=/.hack.local/127.0.0.1"
    ),
    ORIGINAL.replace(
      "address=/.hack.local/172.30.0.2",
      "server=/hack.local/10.0.0.53"
    ),
  ];
  for (const dnsmasq of variants) {
    const f = await fixture({ dnsmasq });
    const result = await repairHackLocalRoute(f.deps);
    expect(result).toMatchObject({
      outcome: "refused",
      reason: "unmanaged-line",
    });
    expect(await readFile(f.dnsmasqPath, "utf8")).toBe(dnsmasq);
  }
  const included = await fixture({
    includeFiles: { "other.conf": "address=/.api.hack.local/10.0.0.9\n" },
  });
  expect(await repairHackLocalRoute(included.deps)).toMatchObject({
    outcome: "refused",
    reason: "unmanaged-line",
  });
  const missing = await fixture({
    dnsmasq: ORIGINAL.replace("address=/.hack.local/172.30.0.2\n", ""),
  });
  expect(await repairHackLocalRoute(missing.deps)).toMatchObject({
    outcome: "refused",
    reason: "no-managed-line",
  });
});

test("a foreign target refuses", async () => {
  const dnsmasq = ORIGINAL.replace(
    "address=/.hack.local/172.30.0.2",
    "address=/.hack.local/10.1.2.3"
  );
  const f = await fixture({ dnsmasq });
  expect(await repairHackLocalRoute(f.deps)).toMatchObject({
    outcome: "refused",
    reason: "foreign-target",
  });
  expect(f.calls.probes).toEqual([]);
  expect(await readFile(f.dnsmasqPath, "utf8")).toBe(dnsmasq);
  expect(
    analyzeHackLocalDnsmasq({ content: dnsmasq, includeFiles: [] })
  ).toMatchObject({ kind: "refused", reason: "foreign-target" });
});

test("a foreign resolver refuses", async () => {
  const f = await fixture({ resolver: "nameserver 10.0.0.53\n" });
  expect(await repairHackLocalRoute(f.deps)).toMatchObject({
    outcome: "refused",
    reason: "foreign-resolver",
  });
  expect(await readFile(f.resolverPath, "utf8")).toBe("nameserver 10.0.0.53\n");
});

test("an unverified relay refuses before reading host DNS files", async () => {
  const f = await fixture({ relay: null });
  const report = reportHackLocalRoute(await inspectHackLocalRoute(f.deps));
  expect(report).toMatchObject({
    status: "refused",
    reason: "relay-not-verified",
  });
  expect(await repairHackLocalRoute(f.deps)).toMatchObject({
    outcome: "refused",
    reason: "relay-not-verified",
  });
  expect(f.calls.readDnsmasq).toBe(0);
  expect(f.calls.authorize).toHaveLength(0);
});

test("non-interactive and declined runs refuse with an exact command", async () => {
  const quiet = await fixture({ prompt: false });
  expect(await repairHackLocalRoute(quiet.deps)).toEqual({
    outcome: "refused",
    reason: "non-interactive",
    detail: expect.stringContaining(HACK_LOCAL_REPAIR_COMMAND),
    command: HACK_LOCAL_REPAIR_COMMAND,
  });
  const declined = await fixture({ approve: false });
  expect(await repairHackLocalRoute(declined.deps)).toMatchObject({
    outcome: "refused",
    reason: "declined",
  });
  for (const f of [quiet, declined]) {
    expect(await readFile(f.dnsmasqPath, "utf8")).toBe(ORIGINAL);
    await expect(stat(f.deps.paths.receiptPath)).rejects.toThrow();
  }
});

test("a change during authorization refuses before any effect", async () => {
  const f = await fixture();
  const deps: HackLocalRouteDependencies = {
    ...f.deps,
    authorize: async () => {
      await writeFile(f.dnsmasqPath, `${ORIGINAL}# edited\n`);
      return true;
    },
  };
  expect(await repairHackLocalRoute(deps)).toMatchObject({
    outcome: "refused",
    reason: "inputs-changed",
  });
  expect(await readFile(f.dnsmasqPath, "utf8")).toBe(`${ORIGINAL}# edited\n`);
  await expect(stat(f.deps.paths.receiptPath)).rejects.toThrow();
});

test("rollback restores the exact earlier bytes and removes the created resolver", async () => {
  const f = await fixture();
  expect((await repairHackLocalRoute(f.deps)).outcome).toBe("repaired");
  const result = await rollbackHackLocalRoute(f.deps);
  expect(result).toMatchObject({
    outcome: "rolled-back",
    retainedResolver: null,
  });
  const restored = await readFile(f.dnsmasqPath);
  expect(restored.toString("utf8")).toBe(ORIGINAL);
  expect(sha256(restored.toString("utf8"))).toBe(sha256(ORIGINAL));
  await expect(stat(f.resolverPath)).rejects.toThrow();
  expect((await readReceipt(f.deps)).state).toBe("rolled-back");
  expect(f.calls.restart).toBe(2);
  expect(await rollbackHackLocalRoute(f.deps)).toMatchObject({
    outcome: "refused",
    reason: "no-receipt",
  });
});

test("rollback of a changed file never writes it and releases the receipt on confirmation", async () => {
  const f = await fixture();
  expect((await repairHackLocalRoute(f.deps)).outcome).toBe("repaired");
  const edited = `${REWRITTEN}address=/.example.test/127.0.0.1\n`;
  await writeFile(f.dnsmasqPath, edited);
  const restarts = f.calls.restart;

  const declined = await rollbackHackLocalRoute({
    ...f.deps,
    confirm: async () => false,
  });
  expect(declined).toMatchObject({ outcome: "refused", reason: "declined" });
  expect((await readReceipt(f.deps)).state).toBe("applied");

  const result = await rollbackHackLocalRoute(f.deps);
  expect(result).toMatchObject({ outcome: "released" });
  expect(describeHackLocalRollback(result)).toContain(
    "address=/.hack.local/172.30.0.2"
  );
  expect(await readFile(f.dnsmasqPath, "utf8")).toBe(edited);
  // The resolver the repair created is kept; another tool may rely on it.
  expect(await readFile(f.resolverPath, "utf8")).toBe(
    HACK_LOCAL_RESOLVER_CONTENT
  );
  expect((await readReceipt(f.deps)).state).toBe("released");
  expect(f.calls.authorize).toHaveLength(1);
  expect(f.calls.confirm).toHaveLength(1);
  expect(f.calls.restart).toBe(restarts);
  expect(await rollbackHackLocalRoute(f.deps)).toMatchObject({
    outcome: "refused",
    reason: "no-receipt",
  });
});

test("an interrupted repair leaves a pending receipt that rollback recovers", async () => {
  // Simulate a crash after the atomic rewrite: pending receipt plus new bytes.
  const f = await fixture({ resolver: HACK_LOCAL_RESOLVER_CONTENT });
  const plan = await inspectHackLocalRoute(f.deps);
  if (plan.status !== "repairable") {
    throw new Error("expected a repairable plan");
  }
  await f.deps.writeReceipt(pendingReceipt(f, plan.plan));
  await f.deps.replaceDnsmasq({ expected: ORIGINAL, next: REWRITTEN });

  expect(
    reportHackLocalRoute(await inspectHackLocalRoute(f.deps))
  ).toMatchObject({
    status: "refused",
    reason: "pending-receipt",
    command: HACK_LOCAL_ROLLBACK_COMMAND,
  });
  expect(await repairHackLocalRoute(f.deps)).toMatchObject({
    outcome: "refused",
    reason: "pending-receipt",
  });

  expect((await rollbackHackLocalRoute(f.deps)).outcome).toBe("rolled-back");
  expect(await readFile(f.dnsmasqPath, "utf8")).toBe(ORIGINAL);
  expect(await readFile(f.resolverPath, "utf8")).toBe(
    HACK_LOCAL_RESOLVER_CONTENT
  );
  expect((await readReceipt(f.deps)).state).toBe("rolled-back");
  expect((await repairHackLocalRoute(f.deps)).outcome).toBe("repaired");
});

test("a repair that fails before writing reports no change and skips the restart", async () => {
  const f = await fixture({ resolver: HACK_LOCAL_RESOLVER_CONTENT });
  let restarts = 0;
  const failing: HackLocalRouteDependencies = {
    ...f.deps,
    replaceDnsmasq: async () => {
      throw new Error("simulated interruption");
    },
    prepareRestart: async () => async () => {
      restarts += 1;
      throw new Error("restart unavailable");
    },
  };
  await expect(repairHackLocalRoute(failing)).rejects.toThrow(
    "nothing was changed"
  );
  expect(restarts).toBe(0);
  expect(await readFile(f.dnsmasqPath, "utf8")).toBe(ORIGINAL);
  expect((await readReceipt(f.deps)).state).toBe("rolled-back");
  expect((await repairHackLocalRoute(f.deps)).outcome).toBe("repaired");
});

test("an interrupted repair before its write recovers through rollback", async () => {
  const f = await fixture({ resolver: HACK_LOCAL_RESOLVER_CONTENT });
  const plan = await inspectHackLocalRoute(f.deps);
  if (plan.status !== "repairable") {
    throw new Error("expected a repairable plan");
  }
  await f.deps.writeReceipt(pendingReceipt(f, plan.plan));
  const result = await rollbackHackLocalRoute(f.deps);
  expect(result).toMatchObject({
    outcome: "rolled-back",
    restartSkipped: null,
  });
  expect(await readFile(f.dnsmasqPath, "utf8")).toBe(ORIGINAL);
  expect((await readReceipt(f.deps)).state).toBe("rolled-back");
});

test("a failed live verification restores the earlier line automatically", async () => {
  const f = await fixture({
    overrides: {
      verifyLiveDns: async () => {
        throw new Error("probe did not resolve");
      },
    },
  });
  await expect(repairHackLocalRoute(f.deps)).rejects.toThrow(
    "the earlier dnsmasq line was restored"
  );
  expect(await readFile(f.dnsmasqPath, "utf8")).toBe(ORIGINAL);
  await expect(stat(f.resolverPath)).rejects.toThrow();
  expect((await readReceipt(f.deps)).state).toBe("rolled-back");
});

test("replacement refuses changed bytes and leaves no temporary file", async () => {
  const f = await fixture();
  await expect(
    f.deps.replaceDnsmasq({ expected: "something else", next: REWRITTEN })
  ).rejects.toThrow("changed before replacement");
  expect(await readFile(f.dnsmasqPath, "utf8")).toBe(ORIGINAL);
  expect((await readdir(join(f.root, "etc"))).sort()).toEqual([
    "dnsmasq.conf",
    "dnsmasq.d",
  ]);
});

test("an invalid receipt refuses rather than inferring ownership", async () => {
  const f = await fixture();
  await mkdir(join(f.home, "native-dns"), { mode: 0o700 });
  await writeFile(f.deps.paths.receiptPath, '{"version":2}');
  expect(await repairHackLocalRoute(f.deps)).toMatchObject({
    outcome: "refused",
    reason: "invalid-receipt",
  });
  expect(await rollbackHackLocalRoute(f.deps)).toMatchObject({
    outcome: "refused",
    reason: "invalid-receipt",
  });
});

test("dns commands without --domain never target a built-in default", () => {
  for (const verb of ["preview", "activate", "deactivate"] as const) {
    for (const configuredDefault of ["hack.local", "hack", "hack.gy"]) {
      expect(() =>
        selectNativeDnsCommandDomain({
          verb,
          explicit: undefined,
          configuredDefault,
        })
      ).toThrow(CliUsageError);
    }
  }
  expect(() =>
    selectNativeDnsCommandDomain({
      verb: "preview",
      explicit: undefined,
      configuredDefault: "hack.local",
    })
  ).toThrow(HACK_LOCAL_REPAIR_COMMAND);
  expect(
    selectNativeDnsCommandDomain({
      verb: "activate",
      explicit: undefined,
      configuredDefault: "v5.hack.gy",
    })
  ).toEqual({ kind: "custom", domain: "v5.hack.gy" });
  expect(
    selectNativeDnsCommandDomain({
      verb: "deactivate",
      explicit: "hack.local",
      configuredDefault: "hack.local",
    })
  ).toEqual({ kind: "hack-local" });
  expect(() =>
    selectNativeDnsCommandDomain({
      verb: "activate",
      explicit: "hack.local",
      configuredDefault: "hack.local",
    })
  ).toThrow(HACK_LOCAL_REPAIR_COMMAND);
});

test("doctor --fix applies the repair and JSON reports the route state", async () => {
  const { checkNativeHackLocalRoute, buildDoctorJsonData } = await import(
    "../src/commands/doctor.ts"
  );
  const progress = { start: () => undefined, stop: () => undefined };
  const reportOnly = await fixture();
  const reported = await checkNativeHackLocalRoute({
    progress,
    fix: false,
    dependencies: async () => reportOnly.deps,
  });
  expect(buildDoctorJsonData({ results: reported }).checks).toEqual([
    expect.objectContaining({
      id: "native hack.local route",
      status: "warn",
      hackLocalRoute: expect.objectContaining({
        status: "repairable",
        oldLine: "address=/.hack.local/172.30.0.2",
        command: HACK_LOCAL_REPAIR_COMMAND,
      }),
    }),
  ]);
  expect(await readFile(reportOnly.dnsmasqPath, "utf8")).toBe(ORIGINAL);

  const fixed = await fixture();
  const results = await checkNativeHackLocalRoute({
    progress,
    fix: true,
    dependencies: async () => fixed.deps,
  });
  expect(results.map((result) => [result.name, result.status])).toEqual([
    ["native hack.local repair", "ok"],
    ["native hack.local route", "ok"],
  ]);
  expect(results[0]?.message).toContain(HACK_LOCAL_ROLLBACK_COMMAND);
  expect(await readFile(fixed.dnsmasqPath, "utf8")).toBe(REWRITTEN);

  const quiet = await fixture({ prompt: false });
  const refusedResults = await checkNativeHackLocalRoute({
    progress,
    fix: true,
    dependencies: async () => quiet.deps,
  });
  expect(refusedResults[0]).toMatchObject({
    name: "native hack.local repair",
    status: "warn",
  });
  expect(refusedResults[0]?.message).toContain("non-interactive");
  expect(refusedResults[0]?.message).toContain(HACK_LOCAL_REPAIR_COMMAND);
});

test("a pending receipt whose file was rewritten since is released, never stuck", async () => {
  // A crash after the rewrite, then a Docker-era doctor --fix rewrote the
  // roots: the recorded hashes no longer describe the file.
  const f = await fixture({ resolver: HACK_LOCAL_RESOLVER_CONTENT });
  const plan = await inspectHackLocalRoute(f.deps);
  if (plan.status !== "repairable") {
    throw new Error("expected a repairable plan");
  }
  await f.deps.writeReceipt(pendingReceipt(f, plan.plan));
  const rewritten = ORIGINAL.replaceAll("172.30.0.2", "127.0.0.1");
  await writeFile(f.dnsmasqPath, rewritten);

  const blocked = reportHackLocalRoute(await inspectHackLocalRoute(f.deps));
  expect(blocked).toMatchObject({
    status: "refused",
    reason: "pending-receipt",
    command: HACK_LOCAL_ROLLBACK_COMMAND,
  });
  expect(blocked.detail).toContain("release the receipt");

  const quiet = await rollbackHackLocalRoute({
    ...f.deps,
    canPrompt: () => false,
  });
  expect(quiet).toMatchObject({
    outcome: "refused",
    reason: "non-interactive",
    command: HACK_LOCAL_ROLLBACK_COMMAND,
  });
  expect((await readReceipt(f.deps)).state).toBe("pending");

  expect(await rollbackHackLocalRoute(f.deps)).toMatchObject({
    outcome: "released",
  });
  expect(f.calls.authorize).toHaveLength(0);
  expect(f.calls.restart).toBe(0);
  expect(await readFile(f.dnsmasqPath, "utf8")).toBe(rewritten);
  expect(
    reportHackLocalRoute(await inspectHackLocalRoute(f.deps))
  ).toMatchObject({ status: "current", receiptState: "released" });
  expect(await repairHackLocalRoute(f.deps)).toMatchObject({
    outcome: "current",
  });
});

test("a BOM-prefixed file keeps its exact bytes and receipt hashes match the raw file", async () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const originalBytes = Buffer.concat([bom, Buffer.from(ORIGINAL, "utf8")]);
  const f = await fixture();
  await writeFile(f.dnsmasqPath, originalBytes);
  const rawSha = (bytes: Buffer) =>
    createHash("sha256").update(bytes).digest("hex");

  expect((await repairHackLocalRoute(f.deps)).outcome).toBe("repaired");
  const repairedBytes = await readFile(f.dnsmasqPath);
  expect(
    Buffer.compare(
      repairedBytes,
      Buffer.concat([bom, Buffer.from(REWRITTEN, "utf8")])
    )
  ).toBe(0);
  const receipt = await readReceipt(f.deps);
  expect(receipt.beforeSha256).toBe(rawSha(originalBytes));
  expect(receipt.afterSha256).toBe(rawSha(repairedBytes));

  expect((await rollbackHackLocalRoute(f.deps)).outcome).toBe("rolled-back");
  expect(Buffer.compare(await readFile(f.dnsmasqPath), originalBytes)).toBe(0);
});

test("rollback without a terminal refuses with the exact command and changes nothing", async () => {
  const f = await fixture();
  expect((await repairHackLocalRoute(f.deps)).outcome).toBe("repaired");
  const receiptBefore = await readFile(f.deps.paths.receiptPath, "utf8");
  expect(
    await rollbackHackLocalRoute({ ...f.deps, canPrompt: () => false })
  ).toEqual({
    outcome: "refused",
    reason: "non-interactive",
    detail: expect.stringContaining(HACK_LOCAL_ROLLBACK_COMMAND),
    command: HACK_LOCAL_ROLLBACK_COMMAND,
  });
  expect(await readFile(f.dnsmasqPath, "utf8")).toBe(REWRITTEN);
  expect(await readFile(f.deps.paths.receiptPath, "utf8")).toBe(receiptBefore);
  expect(f.calls.authorize).toHaveLength(1);

  const declined = await rollbackHackLocalRoute({
    ...f.deps,
    authorize: async () => false,
  });
  expect(declined).toMatchObject({ outcome: "refused", reason: "declined" });
  expect(await readFile(f.dnsmasqPath, "utf8")).toBe(REWRITTEN);
});

test("rollback rechecks the file and receipt after authorization", async () => {
  const edited = `${REWRITTEN}# edited during the prompt\n`;
  const fileChanged = await fixture();
  expect((await repairHackLocalRoute(fileChanged.deps)).outcome).toBe(
    "repaired"
  );
  expect(
    await rollbackHackLocalRoute({
      ...fileChanged.deps,
      authorize: async () => {
        await writeFile(fileChanged.dnsmasqPath, edited);
        return true;
      },
    })
  ).toMatchObject({ outcome: "refused", reason: "inputs-changed" });
  expect(await readFile(fileChanged.dnsmasqPath, "utf8")).toBe(edited);
  expect((await readReceipt(fileChanged.deps)).state).toBe("applied");

  const receiptChanged = await fixture();
  expect((await repairHackLocalRoute(receiptChanged.deps)).outcome).toBe(
    "repaired"
  );
  expect(
    await rollbackHackLocalRoute({
      ...receiptChanged.deps,
      authorize: async () => {
        await editReceipt(receiptChanged.deps, {});
        return true;
      },
    })
  ).toMatchObject({ outcome: "refused", reason: "inputs-changed" });
  expect(await readFile(receiptChanged.dnsmasqPath, "utf8")).toBe(REWRITTEN);
});

test("a receipt whose line does not reproduce its hashes is never written", async () => {
  const f = await fixture();
  expect((await repairHackLocalRoute(f.deps)).outcome).toBe("repaired");
  await editReceipt(f.deps, { oldLine: "address=/.hack.local/::1" });
  expect(await rollbackHackLocalRoute(f.deps)).toMatchObject({
    outcome: "refused",
    reason: "invalid-receipt",
  });
  expect(await readFile(f.dnsmasqPath, "utf8")).toBe(REWRITTEN);
  expect(f.calls.authorize).toHaveLength(1);
});

test("a receipt line must be a single managed line", async () => {
  const f = await fixture();
  expect((await repairHackLocalRoute(f.deps)).outcome).toBe("repaired");
  const injected = "address=/.hack.local/172.30.0.2\nserver=8.8.8.8";
  for (const patch of [
    // Hashes edited to match, so only the line format check can refuse.
    {
      oldLine: injected,
      beforeSha256: sha256(
        REWRITTEN.replace("address=/.hack.local/127.0.0.1", injected)
      ),
    },
    { oldLine: "address=/.hack.local/10.0.0.9" },
    { dnsmasqPath: `${f.dnsmasqPath}\u001b[2J` },
    { dnsmasqPath: "relative/dnsmasq.conf" },
    { resolverIdentity: "not-an-identity" },
  ]) {
    const raw = await readFile(f.deps.paths.receiptPath, "utf8");
    await editReceipt(f.deps, patch);
    expect(await rollbackHackLocalRoute(f.deps)).toMatchObject({
      outcome: "refused",
      reason: "invalid-receipt",
    });
    expect(await readFile(f.dnsmasqPath, "utf8")).toBe(REWRITTEN);
    await writeFile(f.deps.paths.receiptPath, raw);
  }
});

test("a receipt for another dnsmasq path is released without writing the current file", async () => {
  const f = await fixture();
  expect((await repairHackLocalRoute(f.deps)).outcome).toBe("repaired");
  await editReceipt(f.deps, { dnsmasqPath: "/elsewhere/etc/dnsmasq.conf" });
  const result = await rollbackHackLocalRoute(f.deps);
  expect(result).toMatchObject({ outcome: "released" });
  expect(f.calls.confirm[0]).toContain("/elsewhere/etc/dnsmasq.conf");
  expect(await readFile(f.dnsmasqPath, "utf8")).toBe(REWRITTEN);
});

test("a release rechecks the receipt after confirmation", async () => {
  const f = await fixture();
  expect((await repairHackLocalRoute(f.deps)).outcome).toBe("repaired");
  await writeFile(f.dnsmasqPath, `${REWRITTEN}# edited\n`);
  expect(
    await rollbackHackLocalRoute({
      ...f.deps,
      confirm: async () => {
        await editReceipt(f.deps, {});
        return true;
      },
    })
  ).toMatchObject({ outcome: "refused", reason: "inputs-changed" });
  expect((await readReceipt(f.deps)).state).toBe("applied");
});

test("a failed restart is retried during cleanup so dnsmasq is not left stopped", async () => {
  // Resolver-only repair: the line already targets the relay.
  const f = await fixture({ dnsmasq: REWRITTEN });
  let restarts = 0;
  await expect(
    repairHackLocalRoute({
      ...f.deps,
      // Nothing for the restore itself to change: only the failed restart
      // makes a second restart necessary.
      removeResolverIfOwned: async () => false,
      prepareRestart: async () => async () => {
        restarts += 1;
        if (restarts === 1) {
          throw new Error("bootstrap failed");
        }
      },
    })
  ).rejects.toThrow("was retained because its ownership is unproven");
  expect(restarts).toBe(2);
  expect(await readFile(f.dnsmasqPath, "utf8")).toBe(REWRITTEN);
  expect((await readReceipt(f.deps)).state).toBe("rolled-back");
});

test("automatic cleanup never overwrites a concurrent edit and keeps the receipt pending", async () => {
  const f = await fixture({ resolver: HACK_LOCAL_RESOLVER_CONTENT });
  const edited = `${REWRITTEN}# concurrent edit\n`;
  await expect(
    repairHackLocalRoute({
      ...f.deps,
      verifyLiveDns: async () => {
        await writeFile(f.dnsmasqPath, edited);
        throw new Error("probe did not resolve");
      },
    })
  ).rejects.toThrow("automatic restore failed");
  expect(await readFile(f.dnsmasqPath, "utf8")).toBe(edited);
  expect((await readReceipt(f.deps)).state).toBe("pending");
  expect((await rollbackHackLocalRoute(f.deps)).outcome).toBe("released");
  expect(await readFile(f.dnsmasqPath, "utf8")).toBe(edited);
});

test("an unavailable dnsmasq service refuses repair and does not block rollback", async () => {
  const unavailable = async (): Promise<() => Promise<void>> => {
    throw new Error("Native DNS activation requires exactly one dnsmasq");
  };
  const repair = await fixture();
  expect(
    await repairHackLocalRoute({ ...repair.deps, prepareRestart: unavailable })
  ).toMatchObject({ outcome: "refused", reason: "restart-unavailable" });
  expect(await readFile(repair.dnsmasqPath, "utf8")).toBe(ORIGINAL);
  await expect(stat(repair.deps.paths.receiptPath)).rejects.toThrow();

  const f = await fixture();
  expect((await repairHackLocalRoute(f.deps)).outcome).toBe("repaired");
  const result = await rollbackHackLocalRoute({
    ...f.deps,
    prepareRestart: unavailable,
  });
  expect(result).toMatchObject({
    outcome: "rolled-back",
    restartSkipped: expect.stringContaining("exactly one dnsmasq"),
  });
  expect(describeHackLocalRollback(result)).toContain(
    "dnsmasq was not restarted"
  );
  expect(await readFile(f.dnsmasqPath, "utf8")).toBe(ORIGINAL);
  await expect(stat(f.resolverPath)).rejects.toThrow();
  expect((await readReceipt(f.deps)).state).toBe("rolled-back");
});

test("repair and rollback refuse while another run holds the lock", async () => {
  const f = await fixture();
  const release = await f.deps.acquireLock();
  if (!release) {
    throw new Error("expected the lock");
  }
  expect(await f.deps.acquireLock()).toBeNull();
  expect(await repairHackLocalRoute(f.deps)).toMatchObject({
    outcome: "refused",
    reason: "busy",
  });
  expect(f.calls.authorize).toHaveLength(0);
  expect(await readFile(f.dnsmasqPath, "utf8")).toBe(ORIGINAL);
  await release();

  expect((await repairHackLocalRoute(f.deps)).outcome).toBe("repaired");
  const held = await f.deps.acquireLock();
  expect(await rollbackHackLocalRoute(f.deps)).toMatchObject({
    outcome: "refused",
    reason: "busy",
  });
  expect(await readFile(f.dnsmasqPath, "utf8")).toBe(REWRITTEN);
  await held?.();
  expect(
    (await readdir(join(f.home, "native-dns"))).filter((name) =>
      name.includes("lock")
    )
  ).toEqual([]);
});

test("a lock left by a process that no longer exists is taken over", async () => {
  const f = await fixture();
  await mkdir(join(f.home, "native-dns"), { mode: 0o700 });
  await writeFile(`${f.deps.paths.receiptPath}.lock`, "2147483646\n");
  expect((await repairHackLocalRoute(f.deps)).outcome).toBe("repaired");
  await expect(stat(`${f.deps.paths.receiptPath}.lock`)).rejects.toThrow();
});

test("dnsmasq replacement refuses a linked or foreign-owned file", async () => {
  const linked = await fixture();
  await link(linked.dnsmasqPath, join(linked.root, "dnsmasq.link"));
  await expect(
    linked.deps.replaceDnsmasq({ expected: ORIGINAL, next: REWRITTEN })
  ).rejects.toThrow("not a regular file owned by the current user");
  expect(await readFile(linked.dnsmasqPath, "utf8")).toBe(ORIGINAL);

  const uid = process.getuid?.() ?? 0;
  const foreign = await fixture({ ownerUid: uid + 1 });
  await expect(
    foreign.deps.replaceDnsmasq({ expected: ORIGINAL, next: REWRITTEN })
  ).rejects.toThrow("not a regular file owned by the current user");
  expect(await readFile(foreign.dnsmasqPath, "utf8")).toBe(ORIGINAL);
  expect((await readdir(join(foreign.root, "etc"))).sort()).toEqual([
    "dnsmasq.conf",
    "dnsmasq.d",
  ]);
});

test("the receipt directory must be private and owned by the current user", async () => {
  const shared = await fixture();
  await mkdir(join(shared.home, "native-dns"), { mode: 0o700 });
  await chmod(join(shared.home, "native-dns"), 0o755);
  await expect(repairHackLocalRoute(shared.deps)).rejects.toThrow(
    "receipt directory is not private"
  );
  expect(await readFile(shared.dnsmasqPath, "utf8")).toBe(ORIGINAL);
  expect(shared.calls.authorize).toHaveLength(0);

  const uid = process.getuid?.() ?? 0;
  const foreign = await fixture({ ownerUid: uid + 1 });
  await expect(foreign.deps.acquireLock()).rejects.toThrow(
    "receipt directory is not private"
  );
});

test("diagnostics never echo raw line contents or control characters", async () => {
  const hostile = ORIGINAL.replace(
    "address=/.hack.local/172.30.0.2",
    "address=/.hack.local/\u001b[31mSECRET-VALUE"
  );
  const f = await fixture({ dnsmasq: hostile });
  const report = reportHackLocalRoute(await inspectHackLocalRoute(f.deps));
  expect(report).toMatchObject({ status: "refused", reason: "unmanaged-line" });
  expect(report.detail).toBe(
    "Line 5 claims .hack.local but is not in the Hack-managed address=/.hack.local/<address> form."
  );
  const message = describeHackLocalRoute(report);
  expect(message).not.toContain("\u001b");
  expect(message).not.toContain("SECRET-VALUE");

  const foreign = analyzeHackLocalDnsmasq({
    content: ORIGINAL.replace(
      "address=/.hack.local/172.30.0.2",
      "address=/.hack.local/10.1.2.3"
    ),
    includeFiles: [],
  });
  expect(foreign).toMatchObject({ kind: "refused", reason: "foreign-target" });
  expect(JSON.stringify(foreign)).not.toContain("10.1.2.3");

  const included = analyzeHackLocalDnsmasq({
    content: ORIGINAL,
    includeFiles: [
      {
        path: "/x/\u001b]0;title\u0007.conf",
        content: "address=/.hack.local/1.2.3.4\n",
      },
    ],
  });
  expect(JSON.stringify(included)).not.toContain("\\u001b");
  expect(JSON.stringify(included)).not.toContain("1.2.3.4");
});
