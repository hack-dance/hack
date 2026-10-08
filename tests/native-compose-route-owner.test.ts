import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  lstat,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeComposeIngressBinding } from "../src/lib/native-compose-ingress.ts";
import { renderNativeCompose } from "../src/lib/native-compose-renderer.ts";
import {
  type NativeComposeRouteClaims,
  openNativeComposeRouteClaims,
} from "../src/lib/native-compose-route-claims.ts";
import {
  type NativeComposeRoutingOwner,
  prepareNativeComposeRouteOwner,
  prepareNativeComposeSavedRunRouting,
  readNativeComposeRouteMetadata,
  releaseNativeComposeSavedRoutes,
} from "../src/lib/native-compose-route-owner.ts";
import { NativeComposeRoutingError } from "../src/lib/native-compose-routing.ts";
import type { NativeRoutingResolution } from "../src/lib/native-routing-plan-protocol.ts";
import { restoreEnv } from "./helpers/env.ts";
import { composeFixture } from "./helpers/native-compose.ts";

const BINDING: NativeComposeIngressBinding = Object.freeze({
  engineId: "fixture-engine:1",
  proxyId: "a".repeat(64),
  networkId: "b".repeat(64),
  proxyIp: "172.29.0.2",
});
const OWNER = {
  composeProject: "hack-fixture-one",
  ownerToken: "1".repeat(32),
};
const OTHER = {
  composeProject: "hack-fixture-two",
  ownerToken: "2".repeat(32),
};
const GENERATION = "c".repeat(32);
const NEXT = "d".repeat(32);
const owners: NativeComposeRoutingOwner[] = [];
const stores: NativeComposeRouteClaims[] = [];
let root: string;
let home: string | undefined;
beforeEach(async () => {
  home = process.env.HACK_HOME;
  root = await realpath(await mkdtemp(join(tmpdir(), "native-route-owner-")));
  process.env.HACK_HOME = root;
});
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.close()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  restoreEnv("HACK_HOME", home);
  await rm(root, { recursive: true, force: true });
});

function fixture(domain = "dev.test", generationId = GENERATION) {
  const input = composeFixture();
  input.plan.routes = {
    domain,
    aliases: {},
    http: {
      app: {
        service: "web",
        port: 3000,
        protocol: "http",
        hostname: "project",
      },
    },
  };
  const origin = `https://fixture.${domain}`;
  const resolution: NativeRoutingResolution = {
    domain,
    domain_origin: "project",
    project_origin: origin,
    aliases: {},
    oauth_alias: null,
    open_preference: "auto",
    open_preference_origin: "default",
    open_origin: origin,
    routes: {
      app: {
        service: "web",
        port: 3000,
        protocol: "http",
        origin,
        aliases: {},
      },
    },
  };
  const declared = { web: "service" } as const;
  const rendered = renderNativeCompose({
    ...input,
    runtimeIdentity: OWNER.composeProject,
    ownerToken: OWNER.ownerToken,
    generationIdentity: generationId,
    routingResolution: resolution,
    declaredWorkloads: declared,
  });
  return {
    plan: input.plan,
    resolution,
    declared,
    generationId,
    document: rendered.document,
  };
}

function probes() {
  const events: string[] = [];
  let ingressFails = false;
  let inventoryFails = false;
  let proxyFails = false;
  const io = {
    ingress: async (
      opts: { readonly expected?: NativeComposeIngressBinding } = {}
    ) => {
      events.push(opts.expected ? "ingress-recheck" : "ingress-select");
      if (ingressFails) {
        throw new NativeComposeRoutingError();
      }
      expect(opts.expected ?? BINDING).toEqual(BINDING);
      return BINDING;
    },
    inventory: async (opts: {
      readonly requireGenerationId?: string;
      readonly requireAbsent?: boolean;
    }) => {
      events.push(
        opts.requireAbsent
          ? "inventory-absent"
          : `inventory-${opts.requireGenerationId ?? "admission"}`
      );
      if (inventoryFails) {
        throw new NativeComposeRoutingError();
      }
    },
    proxy: async (opts: {
      readonly generationId?: string;
      readonly absentHostnames?: readonly string[];
    }) => {
      events.push(
        `proxy-${opts.generationId ?? "absent"}-${opts.absentHostnames?.join() ?? ""}`
      );
      if (proxyFails) {
        throw new NativeComposeRoutingError();
      }
    },
    claims: openNativeComposeRouteClaims,
  };
  return {
    events,
    io,
    loseIngress: () => {
      ingressFails = true;
    },
    collideInventory: () => {
      inventoryFails = true;
    },
    staleProxy: () => {
      proxyFails = true;
    },
  };
}
async function prepare(
  opts: ReturnType<typeof fixture>,
  checks = probes(),
  previous: readonly {
    readonly generationId: string;
    readonly document: Readonly<Record<string, unknown>>;
  }[] = []
) {
  const owner = await prepareNativeComposeRouteOwner({
    ...opts,
    owner: OWNER,
    previous,
    io: checks.io,
  });
  if (!owner) {
    throw new Error("Expected routing owner");
  }
  owners.push(owner);
  return owner;
}
async function claims(owner = OWNER) {
  const result = await openNativeComposeRouteClaims({
    root: join(root, "compose-routing"),
    owner,
    binding: {
      engineId: BINDING.engineId,
      proxyId: BINDING.proxyId,
      networkId: BINDING.networkId,
    },
  });
  stores.push(result);
  return result;
}
async function complete(owner: NativeComposeRoutingOwner) {
  await owner.assertBeforeEffects();
  await owner.markEffectsPossible();
  await owner.complete({ deadline: Date.now() + 5000 });
  await owner.close();
}

async function claimFiles() {
  const paths = await readdir(join(root, "compose-routing"), {
    recursive: true,
  });
  const files = await Promise.all(
    paths.sort().map(async (path) => {
      const full = join(root, "compose-routing", path);
      const info = await lstat(full);
      return info.isFile()
        ? [path, info.dev, info.ino, await readFile(full, "utf8")]
        : null;
    })
  );
  return files.filter((value) => value !== null);
}

test("warm run observes completed saved claims and active routes without mutating ownership", async () => {
  const input = fixture();
  const checks = probes();
  const prepared = await prepare(input, checks);
  await complete(prepared);
  const before = await claimFiles();
  const warm = await prepareNativeComposeSavedRunRouting({
    owner: OWNER,
    generationId: GENERATION,
    document: prepared.document,
    io: checks.io,
  });
  expect(warm).not.toBeNull();
  try {
    await warm?.assertContinuity({ deadline: Date.now() + 5000 });
    await warm?.assertContinuity({ deadline: Date.now() + 5000 });
    expect(await claimFiles()).toEqual(before);
    expect(checks.events.slice(-3)).toEqual([
      "ingress-recheck",
      `inventory-${GENERATION}`,
      `proxy-${GENERATION}-`,
    ]);
  } finally {
    await warm?.close();
  }
});

test.each([
  "ingress",
  "inventory",
  "proxy",
] as const)("warm run refuses %s drift on saved route continuity", async (kind) => {
  const input = fixture();
  const checks = probes();
  const prepared = await prepare(input, checks);
  await complete(prepared);
  const warm = await prepareNativeComposeSavedRunRouting({
    owner: OWNER,
    generationId: GENERATION,
    document: prepared.document,
    io: checks.io,
  });
  try {
    await warm?.assertContinuity({ deadline: Date.now() + 5000 });
    if (kind === "ingress") {
      checks.loseIngress();
    } else if (kind === "inventory") {
      checks.collideInventory();
    } else {
      checks.staleProxy();
    }
    await expect(
      warm?.assertContinuity({ deadline: Date.now() + 5000 })
    ).rejects.toBeInstanceOf(NativeComposeRoutingError);
  } finally {
    await warm?.close();
  }
});

test("warm run refuses an uncertain saved route attempt and does not repair or reacquire it", async () => {
  const input = fixture();
  const prepared = await prepare(input);
  await prepared.markEffectsPossible();
  const before = await claimFiles();
  const warm = await prepareNativeComposeSavedRunRouting({
    owner: OWNER,
    generationId: GENERATION,
    document: prepared.document,
    io: probes().io,
  });
  try {
    await expect(
      warm?.assertContinuity({ deadline: Date.now() + 5000 })
    ).rejects.toBeInstanceOf(NativeComposeRoutingError);
    expect(await claimFiles()).toEqual(before);
  } finally {
    await warm?.close();
  }
});

test("private route metadata binds the generation, proof targets and immutable claim reference", async () => {
  const input = fixture();
  const owner = await prepare(input);
  const saved = readNativeComposeRouteMetadata({
    generationId: GENERATION,
    document: owner.document,
  });
  expect(saved).toMatchObject({
    version: 1,
    binding: BINDING,
    hostnames: ["fixture.dev.test"],
    reference: { generationIdentity: GENERATION },
    routes: [
      {
        service: "web",
        protocol: "http",
        port: 3000,
        hostnames: ["fixture.dev.test"],
        origins: ["https://fixture.dev.test"],
      },
    ],
  });
  expect(Object.isFrozen(saved)).toBe(true);
  expect(Object.isFrozen(saved?.reference.intent)).toBe(true);
  expect(saved?.resolution).toEqual(input.resolution);
  expect(Object.isFrozen(saved?.resolution)).toBe(true);
  expect(Object.isFrozen(saved?.resolution?.routes)).toBe(true);
  const delivered = owner.document["x-hack-native-routing"] as NonNullable<
    typeof saved
  >;
  expect(Object.isFrozen(delivered.resolution)).toBe(true);
  expect(Object.isFrozen(delivered.resolution?.routes.app)).toBe(true);
  if (delivered.resolution?.routes.app) {
    expect(
      Reflect.set(
        delivered.resolution.routes.app,
        "origin",
        "https://foreign.test"
      )
    ).toBe(false);
    expect(delivered.resolution.routes.app.origin).toBe(
      "https://fixture.dev.test"
    );
  }
  expect(JSON.stringify(input.document)).not.toContain("attemptId");
  expect(JSON.stringify(owner.document.services)).not.toContain("attemptId");
  expect(JSON.stringify(owner.document.services)).not.toContain(
    BINDING.proxyId
  );
  await expect(
    (await claims(OTHER)).acquire({
      hostnames: ["fixture.dev.test"],
      generationIdentity: NEXT,
    })
  ).rejects.toThrow();
});

test("saved metadata rejects extra fields, malformed anchors and a different generation", async () => {
  const owner = await prepare(fixture());
  const metadata = readNativeComposeRouteMetadata({
    generationId: GENERATION,
    document: owner.document,
  });
  if (!metadata) {
    throw new Error("Expected metadata");
  }
  for (const changed of [
    { ...metadata, extra: "private-canary" },
    { ...metadata, version: 2 },
    { ...metadata, hostnames: ["fixture..test"] },
    {
      ...metadata,
      reference: {
        ...metadata.reference,
        intent: { ...metadata.reference.intent, ino: -1 },
      },
    },
    { ...metadata, routes: [{ ...metadata.routes[0], port: 3001 }] },
    { ...metadata, routes: [] },
    {
      ...metadata,
      routes: [{ ...metadata.routes[0], origins: ["http://fixture.dev.test"] }],
    },
    { ...metadata, resolution: null },
    {
      ...metadata,
      resolution: {
        ...metadata.resolution,
        open_origin: "https://foreign.test",
      },
    },
    {
      ...metadata,
      resolution: {
        ...metadata.resolution,
        routes: { app: { ...metadata.resolution?.routes.app, port: 3001 } },
      },
    },
    { ...metadata, binding: { ...BINDING, proxyIp: "999.1.1.1" } },
  ]) {
    expect(() =>
      readNativeComposeRouteMetadata({
        generationId: GENERATION,
        document: { ...owner.document, "x-hack-native-routing": changed },
      })
    ).toThrow(NativeComposeRoutingError);
  }
  expect(() =>
    readNativeComposeRouteMetadata({
      generationId: NEXT,
      document: owner.document,
    })
  ).toThrow(NativeComposeRoutingError);
  expect(() =>
    readNativeComposeRouteMetadata({
      generationId: GENERATION,
      document: fixture().document,
    })
  ).toThrow(NativeComposeRoutingError);
});

test("foreign cooperative claims refuse before an engine attempt can arm", async () => {
  const foreign = await claims(OTHER);
  const reserved = await foreign.acquire({
    hostnames: ["fixture.dev.test"],
    generationIdentity: NEXT,
  });
  const checks = probes();
  await expect(prepare(fixture(), checks)).rejects.toThrow();
  expect((await foreign.reopen(reserved.reference)).phase).toBe("reserved");
  expect(checks.events.some((value) => value.startsWith("proxy-"))).toBe(false);
  await foreign.rollback(reserved);
});

test.each([
  "ingress",
  "inventory",
] as const)("pre-effect %s drift rolls back only new claims", async (kind) => {
  const checks = probes();
  const owner = await prepare(fixture(), checks);
  if (kind === "ingress") {
    checks.loseIngress();
  } else {
    checks.collideInventory();
  }
  await expect(owner.assertBeforeEffects()).rejects.toThrow();
  await owner.close();
  const foreign = await claims(OTHER);
  const acquired = await foreign.acquire({
    hostnames: ["fixture.dev.test"],
    generationIdentity: NEXT,
  });
  await foreign.rollback(acquired);
  expect(checks.events.some((value) => value.startsWith("proxy-"))).toBe(false);
});

test("completion requires current-generation inventory and actual proxy proof", async () => {
  const checks = probes();
  const owner = await prepare(fixture(), checks);
  await owner.assertBeforeEffects();
  await owner.markEffectsPossible();
  checks.events.push("engine-child-reaped-and-ready");
  await owner.complete({ deadline: Date.now() + 5000 });
  const saved = readNativeComposeRouteMetadata({
    generationId: GENERATION,
    document: owner.document,
  });
  if (!saved) {
    throw new Error("Expected metadata");
  }
  expect((await (await claims()).reopen(saved.reference)).phase).toBe(
    "complete"
  );
  const effect = checks.events.indexOf("engine-child-reaped-and-ready");
  expect(checks.events.indexOf(`inventory-${GENERATION}`)).toBeGreaterThan(
    effect
  );
  expect(checks.events.indexOf(`proxy-${GENERATION}-`)).toBeGreaterThan(effect);
});

test("post-effect proxy failure retains claims and blocks cleanup and another startup", async () => {
  const checks = probes();
  const owner = await prepare(fixture(), checks);
  await owner.markEffectsPossible();
  checks.staleProxy();
  await expect(
    owner.complete({ deadline: Date.now() + 5000 })
  ).rejects.toThrow();
  await owner.close();
  const saved = { generationId: GENERATION, document: owner.document };
  const metadata = readNativeComposeRouteMetadata(saved);
  if (!metadata) {
    throw new Error("Expected metadata");
  }
  expect((await (await claims()).reopen(metadata.reference)).phase).toBe(
    "retained"
  );
  const clean = probes();
  await expect(
    releaseNativeComposeSavedRoutes({
      owner: OWNER,
      saved: [saved],
      deadline: Date.now() + 5000,
      io: clean.io,
    })
  ).rejects.toThrow();
  expect(clean.events).toEqual([]);
  await expect(
    prepare(fixture("next.test", NEXT), clean, [saved])
  ).rejects.toThrow();
  await expect(
    (await claims(OTHER)).acquire({
      hostnames: ["fixture.dev.test"],
      generationIdentity: NEXT,
    })
  ).rejects.toThrow();
});

test.each([
  "ingress",
  "inventory",
  "proxy",
] as const)("explicit saved stop recovery retains uncertain claims on missing %s proof", async (proof) => {
  const owner = await prepare(fixture());
  await owner.markEffectsPossible();
  await owner.close();
  const saved = [{ generationId: GENERATION, document: owner.document }];
  const checks = probes();
  if (proof === "ingress") {
    checks.loseIngress();
  }
  if (proof === "inventory") {
    checks.collideInventory();
  }
  if (proof === "proxy") {
    checks.staleProxy();
  }
  await expect(
    releaseNativeComposeSavedRoutes({
      owner: OWNER,
      saved,
      recover: true,
      deadline: Date.now() + 5000,
      io: checks.io,
    })
  ).rejects.toThrow();
  await expect(
    (await claims(OTHER)).acquire({
      hostnames: ["fixture.dev.test"],
      generationIdentity: NEXT,
    })
  ).rejects.toThrow();
  const clean = probes();
  await releaseNativeComposeSavedRoutes({
    owner: OWNER,
    saved,
    recover: true,
    deadline: Date.now() + 5000,
    io: clean.io,
  });
  expect(clean.events).toEqual([
    "ingress-recheck",
    "inventory-absent",
    "proxy-absent-fixture.dev.test",
  ]);
  const foreign = await claims(OTHER);
  await foreign.rollback(
    await foreign.acquire({
      hostnames: ["fixture.dev.test"],
      generationIdentity: NEXT,
    })
  );
});

test("verified routes do not complete an armed attempt before generation finalization", async () => {
  const owner = await prepare(fixture());
  await owner.markEffectsPossible();
  await owner.verifyTransition({ deadline: Date.now() + 5000 });
  // A failure to finalize the generation closes the owner before complete.
  await owner.close();
  const metadata = readNativeComposeRouteMetadata({
    generationId: GENERATION,
    document: owner.document,
  });
  if (!metadata) {
    throw new Error("Expected metadata");
  }
  expect((await (await claims()).reopen(metadata.reference)).phase).toBe(
    "retained"
  );
});

test("owner snapshots caller routing, identity and document before asynchronous admission", async () => {
  const input = fixture();
  const identity = { ...OWNER };
  const checks = probes();
  const pending = prepareNativeComposeRouteOwner({
    ...input,
    owner: identity,
    previous: [],
    io: checks.io,
  });
  identity.composeProject = "changed-project";
  identity.ownerToken = "f".repeat(32);
  Reflect.set(input.document.services, "web", {});
  Reflect.set(input.resolution.routes, "app", { service: "changed", port: 1 });
  const owner = await pending;
  if (!owner) {
    throw new Error("Expected routing owner");
  }
  owners.push(owner);
  await complete(owner);
  const metadata = readNativeComposeRouteMetadata({
    generationId: GENERATION,
    document: owner.document,
  });
  expect(metadata?.routes[0]?.service).toBe("web");
  expect(Object.isFrozen(owner.document.services)).toBe(true);
  const result = await claims();
  if (!metadata) {
    throw new Error("Expected metadata");
  }
  expect((await result.reopen(metadata.reference)).phase).toBe("complete");
});

test("route replacement claims old and new hostnames until obsolete routes are absent", async () => {
  const original = await prepare(fixture());
  await complete(original);
  const saved = { generationId: GENERATION, document: original.document };
  const checks = probes();
  const next = await prepare(fixture("next.test", NEXT), checks, [saved]);
  const foreign = await claims(OTHER);
  await expect(
    foreign.acquire({
      hostnames: ["fixture.dev.test"],
      generationIdentity: NEXT,
    })
  ).rejects.toThrow();
  await expect(
    foreign.acquire({
      hostnames: ["fixture.next.test"],
      generationIdentity: NEXT,
    })
  ).rejects.toThrow();
  await complete(next);
  expect(checks.events).toContain(`proxy-${NEXT}-fixture.dev.test`);
  const old = await foreign.acquire({
    hostnames: ["fixture.dev.test"],
    generationIdentity: NEXT,
  });
  await foreign.rollback(old);
  await expect(
    foreign.acquire({
      hostnames: ["fixture.next.test"],
      generationIdentity: NEXT,
    })
  ).rejects.toThrow();
});

test("unarmed replacement failure preserves adopted prior claims and rolls back new ones", async () => {
  const original = await prepare(fixture());
  await complete(original);
  const next = await prepare(fixture("next.test", NEXT), probes(), [
    { generationId: GENERATION, document: original.document },
  ]);
  await next.close();
  const foreign = await claims(OTHER);
  await expect(
    foreign.acquire({
      hostnames: ["fixture.dev.test"],
      generationIdentity: NEXT,
    })
  ).rejects.toThrow();
  const acquired = await foreign.acquire({
    hostnames: ["fixture.next.test"],
    generationIdentity: NEXT,
  });
  await foreign.rollback(acquired);
});

test("removing all routing keeps private cleanup metadata until verified retirement", async () => {
  const original = await prepare(fixture());
  await complete(original);
  const input = composeFixture();
  const rendered = renderNativeCompose({
    ...input,
    runtimeIdentity: OWNER.composeProject,
    ownerToken: OWNER.ownerToken,
    generationIdentity: NEXT,
  });
  const checks = probes();
  const next = await prepareNativeComposeRouteOwner({
    owner: OWNER,
    generationId: NEXT,
    plan: input.plan,
    resolution: undefined,
    document: rendered.document,
    previous: [{ generationId: GENERATION, document: original.document }],
    io: checks.io,
  });
  if (!next) {
    throw new Error("Expected cleanup owner");
  }
  owners.push(next);
  expect(
    readNativeComposeRouteMetadata({
      generationId: NEXT,
      document: next.document,
    })?.routes
  ).toEqual([]);
  await complete(next);
  expect(checks.events).toContain(`proxy-${NEXT}-fixture.dev.test`);
  const foreign = await claims(OTHER);
  const acquired = await foreign.acquire({
    hostnames: ["fixture.dev.test"],
    generationIdentity: NEXT,
  });
  await foreign.rollback(acquired);
});

test("saved retirement requires absent owned containers and exact proxy absence", async () => {
  const owner = await prepare(fixture());
  await complete(owner);
  const saved = [{ generationId: GENERATION, document: owner.document }];
  const missing = probes();
  missing.loseIngress();
  await expect(
    releaseNativeComposeSavedRoutes({
      owner: OWNER,
      saved,
      deadline: Date.now() + 5000,
      io: missing.io,
    })
  ).rejects.toThrow();
  await expect(
    (await claims(OTHER)).acquire({
      hostnames: ["fixture.dev.test"],
      generationIdentity: NEXT,
    })
  ).rejects.toThrow();
  const checks = probes();
  await releaseNativeComposeSavedRoutes({
    owner: OWNER,
    saved,
    deadline: Date.now() + 5000,
    io: checks.io,
  });
  expect(checks.events).toEqual([
    "ingress-recheck",
    "inventory-absent",
    "proxy-absent-fixture.dev.test",
  ]);
  const foreign = await claims(OTHER);
  const acquired = await foreign.acquire({
    hostnames: ["fixture.dev.test"],
    generationIdentity: NEXT,
  });
  await foreign.rollback(acquired);
});

test("ordinary unrouted projects do not select ingress or open route state", async () => {
  const input = composeFixture();
  const checks = probes();
  const result = await prepareNativeComposeRouteOwner({
    owner: OWNER,
    generationId: GENERATION,
    plan: input.plan,
    resolution: undefined,
    document: renderNativeCompose(input).document,
    previous: [],
    io: checks.io,
  });
  expect(result).toBeNull();
  expect(checks.events).toEqual([]);
  expect(await Bun.file(join(root, "compose-routing")).exists()).toBe(false);
});
