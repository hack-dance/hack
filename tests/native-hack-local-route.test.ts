import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
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
  HACK_LOCAL_REPAIR_COMMAND,
  HACK_LOCAL_RESOLVER_CONTENT,
  HACK_LOCAL_ROLLBACK_COMMAND,
  type HackLocalRouteDependencies,
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

test("rollback refuses when the file changed after the repair", async () => {
  const f = await fixture({ resolver: HACK_LOCAL_RESOLVER_CONTENT });
  expect((await repairHackLocalRoute(f.deps)).outcome).toBe("repaired");
  const edited = `${REWRITTEN}address=/.example.test/127.0.0.1\n`;
  await writeFile(f.dnsmasqPath, edited);
  expect(await rollbackHackLocalRoute(f.deps)).toMatchObject({
    outcome: "refused",
    reason: "rollback-drift",
  });
  expect(await readFile(f.dnsmasqPath, "utf8")).toBe(edited);
  expect(await readFile(f.resolverPath, "utf8")).toBe(
    HACK_LOCAL_RESOLVER_CONTENT
  );
});

test("an interrupted repair leaves a pending receipt that rollback recovers", async () => {
  // Simulate a crash after the atomic rewrite: pending receipt plus new bytes.
  const f = await fixture({ resolver: HACK_LOCAL_RESOLVER_CONTENT });
  const plan = await inspectHackLocalRoute(f.deps);
  if (plan.status !== "repairable") {
    throw new Error("expected a repairable plan");
  }
  const pending: HackLocalRouteReceipt = {
    version: 1,
    kind: "hack-local-route-repair",
    state: "pending",
    domain: "hack.local",
    dnsmasqPath: f.dnsmasqPath,
    resolverPath: f.resolverPath,
    oldLine: plan.plan.oldLine,
    newLine: plan.plan.newLine,
    beforeSha256: plan.plan.beforeSha256,
    afterSha256: plan.plan.afterSha256,
    resolverAction: "keep",
    resolverSha256: sha256(HACK_LOCAL_RESOLVER_CONTENT),
    resolverIdentity: null,
    relayPort: 8443,
    createdAt: "2026-10-12T12:00:00.000Z",
    updatedAt: "2026-10-12T12:00:00.000Z",
  };
  await f.deps.writeReceipt(pending);
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

test("a pending receipt written before the rewrite recovers without a write", async () => {
  const f = await fixture({ resolver: HACK_LOCAL_RESOLVER_CONTENT });
  const failing: HackLocalRouteDependencies = {
    ...f.deps,
    replaceDnsmasq: async () => {
      throw new Error("simulated interruption");
    },
    // The automatic restore cannot restart, so the pending receipt remains.
    prepareRestart: async () => async () => {
      throw new Error("restart unavailable");
    },
  };
  await expect(repairHackLocalRoute(failing)).rejects.toThrow(
    HACK_LOCAL_ROLLBACK_COMMAND
  );
  expect(await readFile(f.dnsmasqPath, "utf8")).toBe(ORIGINAL);
  expect((await readReceipt(f.deps)).state).toBe("pending");
  expect((await rollbackHackLocalRoute(f.deps)).outcome).toBe("rolled-back");
  expect(await readFile(f.dnsmasqPath, "utf8")).toBe(ORIGINAL);
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
