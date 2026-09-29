import { expect, test } from "bun:test";
import {
  type NativeDnsOwnedFile,
  NativeDnsUncertainEffectError,
} from "../src/lib/native-domain-dns-activate.ts";
import {
  deactivateNativeDomainDns,
  type NativeDnsDeactivationDependencies,
  NativeDnsDeactivationError,
} from "../src/lib/native-domain-dns-deactivate.ts";
import {
  type NativeDnsPlan,
  type NativeDnsReceipt,
  planNativeDomainDns,
} from "../src/lib/native-domain-dns-plan.ts";

const INCLUDE_DIR = "/opt/homebrew/etc/dnsmasq.d";
const RESOLVER_DIR = "/etc/resolver";
const RECEIPT_PATH = "/private/hack/native-dns/v5.hack.gy.json";

function activePlan(): NativeDnsPlan {
  const shared = {
    domain: "v5.hack.gy",
    mainConfig: {
      path: "/opt/homebrew/etc/dnsmasq.conf",
      content: `conf-dir=${INCLUDE_DIR},*.conf\naddress=/.hack.gy/172.30.0.2\n`,
    },
    includeDir: INCLUDE_DIR,
    resolverDir: RESOLVER_DIR,
    hosts: { path: "/etc/hosts", content: "127.0.0.1 localhost\n" },
    dnsmasqArgs: ["dnsmasq", "-7", `${INCLUDE_DIR},*.conf`],
    builtInParentClaim: "hack.gy" as const,
  };
  const available = planNativeDomainDns({
    ...shared,
    includeFiles: [],
    resolverFiles: [
      { path: `${RESOLVER_DIR}/hack.gy`, content: "nameserver 127.0.0.1\n" },
    ],
    receipt: null,
  });
  return planNativeDomainDns({
    ...shared,
    includeFiles: [
      { path: available.dnsmasqPath, content: available.dnsmasqContent },
    ],
    resolverFiles: [
      { path: `${RESOLVER_DIR}/hack.gy`, content: "nameserver 127.0.0.1\n" },
      { path: available.resolverPath, content: available.resolverContent },
    ],
    receipt: available.activeReceipt,
  });
}

interface Fixture {
  readonly plan: NativeDnsPlan;
  readonly events: string[];
  readonly files: Map<string, NativeDnsOwnedFile>;
  readonly dependencies: NativeDnsDeactivationDependencies;
  readonly receipt: () => NativeDnsReceipt;
}

function fixture(
  overrides: Partial<NativeDnsDeactivationDependencies> = {}
): Fixture {
  const plan = activePlan();
  const events: string[] = [];
  const files = new Map<string, NativeDnsOwnedFile>([
    [
      RECEIPT_PATH,
      {
        path: RECEIPT_PATH,
        content: `${JSON.stringify(plan.activeReceipt)}\n`,
        identity: "receipt-1",
      },
    ],
    [
      plan.dnsmasqPath,
      {
        path: plan.dnsmasqPath,
        content: plan.dnsmasqContent,
        identity: "dnsmasq-1",
      },
    ],
    [
      plan.resolverPath,
      {
        path: plan.resolverPath,
        content: plan.resolverContent,
        identity: "resolver-1",
      },
    ],
  ]);
  let receipt = plan.activeReceipt;
  let nextIdentity = 1;
  const dependencies: NativeDnsDeactivationDependencies = {
    inspectPlan: async () => {
      events.push("inspect");
      return { plan, fingerprint: "snapshot-1" };
    },
    adoptReceipt: async () => {
      events.push("adopt");
      const owned = files.get(RECEIPT_PATH);
      if (!owned) {
        throw new Error("missing receipt");
      }
      return owned;
    },
    inspectOwnedFile: async (path) => files.get(path) ?? null,
    authorize: async () => {
      events.push("authorize");
      return true;
    },
    writeReceipt: async (next) => {
      events.push(`receipt:${next.state}`);
      receipt = next;
      files.set(RECEIPT_PATH, {
        path: RECEIPT_PATH,
        content: `${JSON.stringify(next)}\n`,
        identity: `receipt-${++nextIdentity}`,
      });
    },
    removeIfOwned: async (file) => {
      events.push(`remove:${file.path}`);
      if (files.get(file.path) !== file) {
        return false;
      }
      files.delete(file.path);
      return true;
    },
    createExclusive: async (file) => {
      events.push(`create:${file.path}`);
      if (files.has(file.path)) {
        throw new Error("file exists");
      }
      const owned = { ...file, identity: `restored-${++nextIdentity}` };
      files.set(file.path, owned);
      return owned;
    },
    testConfig: async () => {
      events.push("test-config");
    },
    restartDnsmasq: async () => {
      events.push("restart");
    },
    flushDnsCache: async () => {
      events.push("flush");
    },
    verifyLiveDns: async () => {
      events.push("verify-native");
    },
    verifyDeactivatedDns: async () => {
      events.push("verify-parent");
    },
    ...overrides,
  };
  return { plan, events, files, dependencies, receipt: () => receipt };
}

async function failure(
  dependencies: NativeDnsDeactivationDependencies
): Promise<NativeDnsDeactivationError> {
  try {
    await deactivateNativeDomainDns({
      dependencies,
      receiptPath: RECEIPT_PATH,
    });
  } catch (error) {
    if (error instanceof NativeDnsDeactivationError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected deactivation failure");
}

test("denied deactivation leaves active receipt and files unchanged", async () => {
  const state = fixture({ authorize: async () => false });
  const error = await failure(state.dependencies);
  expect(error.phase).toBe("authorization");
  expect(state.receipt()).toEqual(state.plan.activeReceipt);
  expect(state.files.size).toBe(3);
  expect(state.events).not.toContain("receipt:removing");
});

test("changed input fingerprint refuses before removing receipt", async () => {
  let read = 0;
  const state = fixture({
    inspectPlan: async () => ({
      plan: state.plan,
      fingerprint: `snapshot-${++read}`,
    }),
  });
  const error = await failure(state.dependencies);
  expect(error.phase).toBe("drift");
  expect(state.files.size).toBe(3);
  expect(state.receipt()).toEqual(state.plan.activeReceipt);
});

test("changed file identity across authorization refuses before effects", async () => {
  const state = fixture({
    authorize: async () => {
      const file = state.files.get(state.plan.resolverPath);
      if (file) {
        state.files.set(file.path, { ...file, identity: "foreign" });
      }
      return true;
    },
  });
  const error = await failure(state.dependencies);
  expect(error.phase).toBe("drift");
  expect(state.receipt()).toEqual(state.plan.activeReceipt);
  expect(state.files.get(state.plan.resolverPath)?.identity).toBe("foreign");
});

test("success verifies parent fallback before inactive receipt", async () => {
  const state = fixture();
  const receipt = await deactivateNativeDomainDns({
    dependencies: state.dependencies,
    receiptPath: RECEIPT_PATH,
  });
  expect(receipt).toEqual(state.plan.inactiveReceipt);
  expect(state.receipt()).toEqual(state.plan.inactiveReceipt);
  expect(state.files.has(state.plan.resolverPath)).toBe(false);
  expect(state.files.has(state.plan.dnsmasqPath)).toBe(false);
  expect(state.events.slice(-8)).toEqual([
    "receipt:removing",
    `remove:${state.plan.resolverPath}`,
    `remove:${state.plan.dnsmasqPath}`,
    "test-config",
    "restart",
    "flush",
    "verify-parent",
    "receipt:inactive",
  ]);
});

test("changed owned resolver is preserved and active claim is reverified", async () => {
  const state = fixture({
    removeIfOwned: async (file) => {
      state.events.push(`remove:${file.path}`);
      if (file.path === state.plan.resolverPath) {
        state.files.set(file.path, { ...file, content: "foreign\n" });
        return false;
      }
      state.files.delete(file.path);
      return true;
    },
  });
  const error = await failure(state.dependencies);
  expect(error.phase).toBe("resolver-remove");
  expect(error.rollbackUncertain).toBe(true);
  expect(state.receipt()).toEqual(state.plan.removingReceipt);
  expect(state.files.get(state.plan.resolverPath)?.content).toBe("foreign\n");
});

test("failure after one removal restores it and revalidates active DNS", async () => {
  const state = fixture({
    removeIfOwned: async (file) => {
      state.events.push(`remove:${file.path}`);
      if (file.path === state.plan.dnsmasqPath) {
        return false;
      }
      state.files.delete(file.path);
      return true;
    },
  });
  const error = await failure(state.dependencies);
  expect(error.phase).toBe("dnsmasq-remove");
  expect(error.rollbackUncertain).toBe(false);
  expect(state.receipt()).toEqual(state.plan.activeReceipt);
  expect(state.files.has(state.plan.resolverPath)).toBe(true);
  expect(state.events.slice(-6)).toEqual([
    `create:${state.plan.resolverPath}`,
    "test-config",
    "restart",
    "flush",
    "verify-native",
    "receipt:active",
  ]);
});

test("lost resolver removal reply retains removing receipt", async () => {
  const commandFailure = new Error("resolver command failed");
  const state = fixture({
    removeIfOwned: async (file) => {
      state.files.delete(file.path);
      throw new NativeDnsUncertainEffectError(
        "remove reply lost",
        commandFailure
      );
    },
  });
  const error = await failure(state.dependencies);
  expect(error.phase).toBe("resolver-remove");
  expect(error.cause).toBe(error.originalCause);
  expect(error.cause).toHaveProperty("cause", commandFailure);
  expect(error.rollbackUncertain).toBe(true);
  expect(state.receipt()).toEqual(state.plan.removingReceipt);
  expect(state.events).not.toContain("receipt:active");
});

test("wrong parent fallback rolls files and active receipt back", async () => {
  const state = fixture({
    verifyDeactivatedDns: async () => {
      state.events.push("verify-parent");
      throw new Error("wrong DNS answer");
    },
  });
  const error = await failure(state.dependencies);
  expect(error.phase).toBe("verification");
  expect(error.rollbackUncertain).toBe(false);
  expect(state.receipt()).toEqual(state.plan.activeReceipt);
  expect(state.files.size).toBe(3);
  expect(state.events.slice(-1)).toEqual(["receipt:active"]);
});

test("failed rollback creation retains removing receipt and does not claim active", async () => {
  const state = fixture({
    verifyDeactivatedDns: async () => {
      throw new Error("wrong DNS answer");
    },
    createExclusive: async () => {
      throw new Error("cannot restore");
    },
  });
  const error = await failure(state.dependencies);
  expect(error.rollbackUncertain).toBe(true);
  expect(error.rollbackFailures).toHaveLength(2);
  expect(state.receipt()).toEqual(state.plan.removingReceipt);
  expect(state.events).not.toContain("receipt:active");
});

test("lost inactive publication reply is uncertain despite immediate readback", async () => {
  const state = fixture();
  const write = state.dependencies.writeReceipt;
  const dependencies = {
    ...state.dependencies,
    writeReceipt: async (receipt: NativeDnsReceipt) => {
      await write(receipt);
      if (receipt.state === "inactive") {
        throw new NativeDnsUncertainEffectError("reply lost");
      }
    },
  };
  const error = await failure(dependencies);
  expect(error.phase).toBe("inactive-receipt");
  expect(error.rollbackUncertain).toBe(true);
  expect(state.receipt()).toEqual(state.plan.inactiveReceipt);
  expect(state.events).not.toContain("receipt:active");
});

test("pending and removing receipts refuse planning without file effects", () => {
  const active = activePlan();
  const shared = {
    domain: active.domain,
    mainConfig: {
      path: "/opt/homebrew/etc/dnsmasq.conf",
      content: `conf-dir=${INCLUDE_DIR},*.conf\naddress=/.hack.gy/172.30.0.2\n`,
    },
    includeDir: INCLUDE_DIR,
    includeFiles: [],
    resolverDir: RESOLVER_DIR,
    resolverFiles: [
      { path: `${RESOLVER_DIR}/hack.gy`, content: "nameserver 127.0.0.1\n" },
    ],
    hosts: { path: "/etc/hosts", content: "127.0.0.1 localhost\n" },
    dnsmasqArgs: ["dnsmasq", "-7", `${INCLUDE_DIR},*.conf`],
    builtInParentClaim: "hack.gy" as const,
  };
  expect(
    planNativeDomainDns({ ...shared, receipt: active.inactiveReceipt }).status
  ).toBe("available");
  for (const receipt of [active.pendingReceipt, active.removingReceipt]) {
    expect(() => planNativeDomainDns({ ...shared, receipt })).toThrow(
      "do not match an active claim"
    );
  }
});
