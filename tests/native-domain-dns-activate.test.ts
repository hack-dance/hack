import { expect, test } from "bun:test";
import {
  activateNativeDomainDns,
  type NativeDnsActivationDependencies,
  NativeDnsActivationError,
  type NativeDnsOwnedFile,
  NativeDnsUncertainEffectError,
  nativeDnsFailureMessage,
} from "../src/lib/native-domain-dns-activate.ts";
import {
  type NativeDnsPlan,
  type NativeDnsReceipt,
  planNativeDomainDns,
} from "../src/lib/native-domain-dns-plan.ts";

const INCLUDE_DIR = "/opt/homebrew/etc/dnsmasq.d";
const RESOLVER_DIR = "/etc/resolver";

function availablePlan(): NativeDnsPlan {
  return planNativeDomainDns({
    domain: "project.example.test",
    mainConfig: {
      path: "/opt/homebrew/etc/dnsmasq.conf",
      content: `conf-dir=${INCLUDE_DIR},*.conf\n`,
    },
    includeDir: INCLUDE_DIR,
    includeFiles: [],
    resolverDir: RESOLVER_DIR,
    resolverFiles: [],
    hosts: { path: "/etc/hosts", content: "127.0.0.1 localhost\n" },
    dnsmasqArgs: ["dnsmasq", "-7", `${INCLUDE_DIR},*.conf`],
    receipt: null,
  });
}

interface Fixture {
  readonly plan: NativeDnsPlan;
  readonly events: string[];
  readonly files: Map<string, NativeDnsOwnedFile>;
  readonly dependencies: NativeDnsActivationDependencies;
  readonly receipt: () => NativeDnsReceipt | null;
}

function fixture(
  overrides: {
    readonly authorize?: NativeDnsActivationDependencies["authorize"];
    readonly inspectPlan?: NativeDnsActivationDependencies["inspectPlan"];
    readonly createExclusive?: NativeDnsActivationDependencies["createExclusive"];
    readonly removeIfOwned?: NativeDnsActivationDependencies["removeIfOwned"];
    readonly testConfig?: NativeDnsActivationDependencies["testConfig"];
    readonly verifyLiveDns?: NativeDnsActivationDependencies["verifyLiveDns"];
    readonly writeReceipt?: NativeDnsActivationDependencies["writeReceipt"];
  } = {}
): Fixture {
  const plan = availablePlan();
  const events: string[] = [];
  const files = new Map<string, NativeDnsOwnedFile>();
  let receipt: NativeDnsReceipt | null = null;
  let nextIdentity = 1;
  const dependencies: NativeDnsActivationDependencies = {
    inspectPlan:
      overrides.inspectPlan ??
      (async () => {
        events.push("inspect");
        return { plan, fingerprint: "snapshot-1" };
      }),
    authorize:
      overrides.authorize ??
      (async () => {
        events.push("authorize");
        return true;
      }),
    writeReceipt:
      overrides.writeReceipt ??
      (async (next) => {
        events.push(`receipt:${next.state}`);
        receipt = next;
      }),
    clearPendingReceipt: async (expected) => {
      events.push("receipt:clear");
      if (receipt !== expected) {
        return false;
      }
      receipt = null;
      return true;
    },
    createExclusive:
      overrides.createExclusive ??
      (async ({ path, content }) => {
        events.push(`create:${path}`);
        if (files.has(path)) {
          throw new Error("exists");
        }
        const owned = { path, content, identity: String(nextIdentity++) };
        files.set(path, owned);
        return owned;
      }),
    removeIfOwned:
      overrides.removeIfOwned ??
      (async (owned) => {
        events.push(`remove:${owned.path}`);
        if (files.get(owned.path) !== owned) {
          return false;
        }
        files.delete(owned.path);
        return true;
      }),
    testConfig:
      overrides.testConfig ??
      (async () => {
        events.push("test-config");
      }),
    restartDnsmasq: async () => {
      events.push("restart");
    },
    flushDnsCache: async () => {
      events.push("flush");
    },
    verifyLiveDns:
      overrides.verifyLiveDns ??
      (async () => {
        events.push("verify");
      }),
  };
  return { plan, events, files, dependencies, receipt: () => receipt };
}

async function activationError(
  dependencies: NativeDnsActivationDependencies
): Promise<NativeDnsActivationError> {
  try {
    await activateNativeDomainDns({ dependencies });
  } catch (error) {
    if (error instanceof NativeDnsActivationError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected native DNS activation to fail");
}

test("denied authorization has no receipt, file, or service effects", async () => {
  const state = fixture({
    authorize: async () => {
      state.events.push("authorize");
      return false;
    },
  });
  const error = await activationError(state.dependencies);
  expect(error.phase).toBe("authorization");
  expect(error.rollbackUncertain).toBe(false);
  expect(state.events).toEqual(["inspect", "authorize"]);
  expect(state.receipt()).toBeNull();
  expect(state.files.size).toBe(0);
});

test("changed input fingerprint after authorization refuses before effects", async () => {
  let reads = 0;
  const state = fixture({
    inspectPlan: async () => {
      reads += 1;
      return { plan: state.plan, fingerprint: `snapshot-${reads}` };
    },
  });
  const error = await activationError(state.dependencies);
  expect(error.phase).toBe("drift");
  expect(reads).toBe(2);
  expect(state.events).toEqual(["authorize"]);
  expect(state.receipt()).toBeNull();
  expect(state.files.size).toBe(0);
});

test("success commits active only after live DNS verification", async () => {
  const state = fixture();
  const receipt = await activateNativeDomainDns({
    dependencies: state.dependencies,
  });
  expect(receipt).toEqual(state.plan.activeReceipt);
  expect(state.receipt()).toEqual(state.plan.activeReceipt);
  expect(state.files.size).toBe(2);
  expect(state.events).toEqual([
    "inspect",
    "authorize",
    "inspect",
    "receipt:pending",
    `create:${state.plan.dnsmasqPath}`,
    `create:${state.plan.resolverPath}`,
    "test-config",
    "restart",
    "flush",
    "verify",
    "receipt:active",
  ]);
});

test("resolver create failure removes only the confirmed dnsmasq file", async () => {
  const state = fixture({
    createExclusive: async ({ path, content }) => {
      state.events.push(`create:${path}`);
      if (path === state.plan.resolverPath) {
        throw new Error("resolver create failed");
      }
      const owned = { path, content, identity: "owned-dnsmasq" };
      state.files.set(path, owned);
      return owned;
    },
  });
  const error = await activationError(state.dependencies);
  expect(error.phase).toBe("resolver-create");
  expect(error.rollbackUncertain).toBe(false);
  expect(state.files.size).toBe(0);
  expect(state.receipt()).toBeNull();
  expect(state.events).toEqual([
    "inspect",
    "authorize",
    "inspect",
    "receipt:pending",
    `create:${state.plan.dnsmasqPath}`,
    `create:${state.plan.resolverPath}`,
    `remove:${state.plan.dnsmasqPath}`,
    "receipt:clear",
  ]);
});

test("lost resolver create reply retains pending receipt for recovery", async () => {
  const commandFailure = new Error("resolver command failed");
  const state = fixture({
    createExclusive: async ({ path, content }) => {
      state.events.push(`create:${path}`);
      const owned = { path, content, identity: `identity:${path}` };
      state.files.set(path, owned);
      if (path === state.plan.resolverPath) {
        throw new NativeDnsUncertainEffectError(
          "resolver create reply was lost",
          commandFailure
        );
      }
      return owned;
    },
  });
  const error = await activationError(state.dependencies);
  expect(error.phase).toBe("resolver-create");
  expect(error.originalCause).toBeInstanceOf(NativeDnsUncertainEffectError);
  expect(error.cause).toBe(error.originalCause);
  expect(error.cause).toHaveProperty("cause", commandFailure);
  expect(error.message).toContain("resolver command failed");
  expect(error.rollbackUncertain).toBe(true);
  expect(error.rollbackFailures).toHaveLength(0);
  expect(state.files.has(state.plan.dnsmasqPath)).toBe(false);
  expect(state.files.has(state.plan.resolverPath)).toBe(true);
  expect(state.receipt()).toEqual(state.plan.pendingReceipt);
  expect(state.events).not.toContain("receipt:clear");
});

test("failed verification rolls files back in reverse order and restarts service", async () => {
  const state = fixture({
    verifyLiveDns: async () => {
      state.events.push("verify");
      throw new Error("wrong live answer");
    },
  });
  const error = await activationError(state.dependencies);
  expect(error.phase).toBe("verification");
  expect(error.rollbackUncertain).toBe(false);
  expect(state.receipt()).toBeNull();
  expect(state.files.size).toBe(0);
  expect(state.events.slice(-5)).toEqual([
    `remove:${state.plan.resolverPath}`,
    `remove:${state.plan.dnsmasqPath}`,
    "restart",
    "flush",
    "receipt:clear",
  ]);
});

test("changed owned file blocks removal and preserves pending receipt", async () => {
  const state = fixture({
    testConfig: async () => {
      state.events.push("test-config");
      throw new Error("invalid config");
    },
    removeIfOwned: async (file) => {
      state.events.push(`remove:${file.path}`);
      if (file.path === state.plan.resolverPath) {
        return false;
      }
      state.files.delete(file.path);
      return true;
    },
  });
  const error = await activationError(state.dependencies);
  expect(error.phase).toBe("config-test");
  expect(error.rollbackUncertain).toBe(true);
  expect(error.rollbackFailures).toHaveLength(1);
  expect(state.receipt()).toEqual(state.plan.pendingReceipt);
  expect(state.files.has(state.plan.resolverPath)).toBe(true);
  expect(state.files.has(state.plan.dnsmasqPath)).toBe(false);
  expect(state.events).not.toContain("receipt:clear");
});

test("ambiguous active receipt write restores pending before rollback", async () => {
  const state = fixture();
  const writeReceipt = state.dependencies.writeReceipt;
  const dependencies: NativeDnsActivationDependencies = {
    ...state.dependencies,
    writeReceipt: async (receipt) => {
      await writeReceipt(receipt);
      if (receipt.state === "active") {
        throw new Error("acknowledgment lost after commit");
      }
    },
  };
  const error = await activationError(dependencies);
  expect(error.phase).toBe("active-receipt");
  expect(error.rollbackUncertain).toBe(false);
  expect(state.receipt()).toBeNull();
  expect(state.files.size).toBe(0);
  expect(state.events.slice(-7)).toEqual([
    "receipt:active",
    "receipt:pending",
    `remove:${state.plan.resolverPath}`,
    `remove:${state.plan.dnsmasqPath}`,
    "restart",
    "flush",
    "receipt:clear",
  ]);
});

test("DNS failure detail bounds nested messages and handles cyclic causes", () => {
  const error = new Error("restart\nfailed", {
    cause: new Error("x".repeat(1000)),
  });
  expect(nativeDnsFailureMessage(error)).toStartWith("restart failed: ");
  expect(nativeDnsFailureMessage(error)).toHaveLength(512);
  error.cause = error;
  expect(nativeDnsFailureMessage(error)).toBe("restart failed");
  expect(nativeDnsFailureMessage({ message: "untrusted" })).toBe("");
});

test("restart and rollback restart failures retain a receipt after removing owned files", async () => {
  const state = fixture();
  let attempts = 0;
  const failure = new Error("service manager refused restart");
  const error = await activationError({
    ...state.dependencies,
    restartDnsmasq: async () => {
      attempts += 1;
      throw failure;
    },
  });
  expect(attempts).toBe(2);
  expect(error.phase).toBe("restart");
  expect(error.message).toContain(failure.message);
  expect(error.rollbackFailures).toEqual([failure]);
  expect(error.rollbackUncertain).toBe(true);
  expect(state.files.size).toBe(0);
  expect(state.receipt()).toEqual(state.plan.pendingReceipt);
  expect(state.events).not.toContain("verify");
  expect(state.events).not.toContain("receipt:clear");
});
