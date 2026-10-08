import { join } from "node:path";
import { DEFAULT_INGRESS_NETWORK } from "../constants.ts";
import { resolveGlobalHackDir } from "./config-paths.ts";
import { isRecord } from "./guards.ts";
import {
  type NativeComposeIngressBinding,
  observeNativeComposeIngress,
} from "./native-compose-ingress.ts";
import {
  assertNativeComposeProxyAccess,
  assertNativeComposeProxyRoutes,
} from "./native-compose-proxy-routes.ts";
import {
  type NativeComposeRouteAttempt,
  type NativeComposeRouteClaims,
  type NativeComposeRouteReference,
  openNativeComposeRouteClaims,
} from "./native-compose-route-claims.ts";
import { assertNativeComposeRouteInventory } from "./native-compose-route-inventory.ts";
import {
  NativeComposeRoutingError,
  planNativeComposeRouting,
} from "./native-compose-routing.ts";
import type { NativeDeclaredWorkloads } from "./native-env-plan-protocol.ts";
import {
  type NativeRoutingResolution,
  parseNativeRoutingResolution,
} from "./native-routing-plan-protocol.ts";

const EXTENSION = "x-hack-native-routing";
const TOKEN = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const NAME = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const ENGINE = /^[A-Za-z0-9:-]{1,128}$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const CADDY_GROUP = /^caddy_\d+(?:\.|$)/;

type Document = Readonly<Record<string, unknown>>;
export type NativeComposeOwnedRoute = {
  readonly hostnames: readonly string[];
  readonly origins: readonly string[];
  readonly service: string;
  readonly port: number;
  readonly protocol: "http" | "https";
};
type Owner = { readonly composeProject: string; readonly ownerToken: string };
export type NativeComposeRouteMetadata = {
  readonly version: 1;
  readonly binding: NativeComposeIngressBinding;
  readonly reference: NativeComposeRouteReference;
  readonly hostnames: readonly string[];
  readonly routes: readonly NativeComposeOwnedRoute[];
  /** Compiler-selected browser origin, retained with the immutable generation. */
  readonly resolution: NativeRoutingResolution | null;
};
export type NativeComposeSavedRouteDocument = {
  readonly generationId: string;
  readonly document: Document;
};

function refused(): never {
  throw new NativeComposeRoutingError();
}
function exact(value: Record<string, unknown>, keys: string): boolean {
  return Object.keys(value).sort().join() === keys;
}
function frozenDocument(document: Document): Document {
  try {
    const result: unknown = structuredClone(document);
    if (!isRecord(result)) {
      return refused();
    }
    freezePrivate(result);
    return result;
  } catch {
    return refused();
  }
}
function freezePrivate(value: unknown): void {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      freezePrivate(child);
    }
    Object.freeze(value);
  }
}
function snapshotSaved(values: readonly NativeComposeSavedRouteDocument[]) {
  return Object.freeze(
    values.map((value) =>
      Object.freeze({
        generationId: value.generationId,
        document: frozenDocument(value.document),
      })
    )
  );
}
function names(value: unknown): readonly string[] {
  if (
    !(
      Array.isArray(value) &&
      value.every(
        (name) =>
          typeof name === "string" &&
          name.length <= 253 &&
          name.includes(".") &&
          name.split(".").every((label) => DNS_LABEL.test(label))
      )
    ) ||
    [...new Set(value)].sort().join() !== value.join()
  ) {
    return refused();
  }
  return Object.freeze([...value] as string[]);
}
function anchor(value: unknown) {
  if (
    !(
      isRecord(value) &&
      exact(value, "dev,hash,ino") &&
      Number.isSafeInteger(value.dev) &&
      Number.isSafeInteger(value.ino)
    ) ||
    typeof value.dev !== "number" ||
    typeof value.ino !== "number" ||
    value.dev < 0 ||
    value.ino < 0 ||
    typeof value.hash !== "string" ||
    !HASH.test(value.hash)
  ) {
    return refused();
  }
  return Object.freeze({ dev: value.dev, ino: value.ino, hash: value.hash });
}
function reference(value: unknown, generationId: string) {
  if (
    !(
      isRecord(value) &&
      exact(value, "attemptId,generationIdentity,intent,reservation")
    ) ||
    typeof value.attemptId !== "string" ||
    !TOKEN.test(value.attemptId) ||
    value.generationIdentity !== generationId ||
    !TOKEN.test(generationId)
  ) {
    return refused();
  }
  return Object.freeze({
    attemptId: value.attemptId,
    generationIdentity: generationId,
    intent: anchor(value.intent),
    reservation: anchor(value.reservation),
  });
}
function binding(value: unknown): NativeComposeIngressBinding {
  if (
    !(isRecord(value) && exact(value, "engineId,networkId,proxyId,proxyIp")) ||
    typeof value.engineId !== "string" ||
    !ENGINE.test(value.engineId) ||
    typeof value.networkId !== "string" ||
    !HASH.test(value.networkId) ||
    typeof value.proxyId !== "string" ||
    !HASH.test(value.proxyId) ||
    typeof value.proxyIp !== "string" ||
    !IPV4.test(value.proxyIp) ||
    value.proxyIp.split(".").some((part) => Number(part) > 255)
  ) {
    return refused();
  }
  return Object.freeze({
    engineId: value.engineId,
    networkId: value.networkId,
    proxyId: value.proxyId,
    proxyIp: value.proxyIp,
  });
}
function sameBinding(
  left: NativeComposeIngressBinding,
  right: NativeComposeIngressBinding
) {
  return (
    left.engineId === right.engineId &&
    left.proxyId === right.proxyId &&
    left.networkId === right.networkId &&
    left.proxyIp === right.proxyIp
  );
}
function routes(value: unknown): readonly NativeComposeOwnedRoute[] {
  if (!Array.isArray(value)) {
    return refused();
  }
  return Object.freeze(
    value.map((route) => {
      if (
        !(
          isRecord(route) &&
          exact(route, "hostnames,origins,port,protocol,service")
        ) ||
        typeof route.service !== "string" ||
        !NAME.test(route.service) ||
        typeof route.port !== "number" ||
        !Number.isInteger(route.port) ||
        route.port < 1 ||
        route.port > 65_535 ||
        (route.protocol !== "http" && route.protocol !== "https")
      ) {
        return refused();
      }
      const hostnames = names(route.hostnames);
      const origins = siteOrigins(route.origins);
      if (
        hostnames.length === 0 ||
        [...new Set(origins.map(siteHostname))].sort().join() !==
          hostnames.join()
      ) {
        return refused();
      }
      return Object.freeze({
        hostnames,
        origins,
        service: route.service,
        port: route.port,
        protocol: route.protocol,
      });
    })
  );
}
function activeHostnames(selected: readonly NativeComposeOwnedRoute[]) {
  return [...new Set(selected.flatMap((route) => route.hostnames))].sort();
}

function siteHostname(origin: string): string {
  const url = new URL(origin);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    return refused();
  }
  return url.hostname;
}

function siteOrigins(value: unknown): readonly string[] {
  if (
    !(
      Array.isArray(value) &&
      value.length &&
      value.every((origin) => typeof origin === "string")
    ) ||
    [...new Set(value)].sort().join() !== value.join()
  ) {
    return refused();
  }
  for (const origin of value) {
    siteHostname(origin);
  }
  return Object.freeze([...value] as string[]);
}

function expectedSiteLabels(
  labels: Record<string, unknown>,
  selected: readonly NativeComposeOwnedRoute[]
) {
  const expected: Record<string, string> = {};
  for (const [index, route] of selected.entries()) {
    const prefix = `caddy_${index}`;
    const sites = labels[prefix];
    if (typeof sites !== "string") {
      return refused();
    }
    const origins = sites.split(", ");
    if (
      origins.join() !== route.origins.join() ||
      [...new Set(origins.map(siteHostname))].sort().join() !==
        route.hostnames.join()
    ) {
      return refused();
    }
    expected[prefix] = sites;
    expected[`${prefix}.reverse_proxy`] =
      `{{upstreams ${route.protocol} ${route.port}}}`;
    if (origins.some((origin) => origin.startsWith("https://"))) {
      expected[`${prefix}.tls`] = "internal";
    }
    expected.caddy_ingress_network = DEFAULT_INGRESS_NETWORK;
  }
  return expected;
}

function assertServiceRoutes(
  service: unknown,
  selected: readonly NativeComposeOwnedRoute[]
) {
  if (!(isRecord(service) && isRecord(service.labels))) {
    return refused();
  }
  const expected = expectedSiteLabels(service.labels, selected);
  const actual = Object.fromEntries(
    Object.entries(service.labels).filter(
      ([key]) =>
        key === "caddy" ||
        key === "caddy_ingress_network" ||
        CADDY_GROUP.test(key)
    )
  );
  if (
    Object.keys(actual).sort().join() !== Object.keys(expected).sort().join() ||
    Object.entries(expected).some(([key, value]) => actual[key] !== value) ||
    (selected.length > 0 &&
      JSON.stringify(service.networks) !== '["default","ingress"]')
  ) {
    return refused();
  }
}

/** Saved proof targets must describe the actual immutable Compose site labels. */
function assertRouteDocument(
  document: Document,
  selected: readonly NativeComposeOwnedRoute[]
) {
  if (!isRecord(document.services)) {
    return refused();
  }
  const grouped = new Map<string, NativeComposeOwnedRoute[]>();
  for (const route of selected) {
    const values = grouped.get(route.service) ?? [];
    values.push(route);
    grouped.set(route.service, values);
  }
  if (
    activeHostnames(selected).length !==
    selected.flatMap((route) => route.hostnames).length
  ) {
    return refused();
  }
  for (const service of grouped.keys()) {
    if (!Object.hasOwn(document.services, service)) {
      return refused();
    }
  }
  for (const [name, service] of Object.entries(document.services)) {
    assertServiceRoutes(service, grouped.get(name) ?? []);
  }
  if (
    selected.length > 0 &&
    !(
      isRecord(document.networks) &&
      isRecord(document.networks.ingress) &&
      exact(document.networks.ingress, "external,name") &&
      document.networks.ingress.external === true &&
      document.networks.ingress.name === DEFAULT_INGRESS_NETWORK
    )
  ) {
    return refused();
  }
}

/** Parse only private saved metadata; this never observes ingress or authored inputs. */
export function readNativeComposeRouteMetadata(
  opts: NativeComposeSavedRouteDocument
): NativeComposeRouteMetadata | null {
  try {
    const value = opts.document[EXTENSION];
    if (value === undefined) {
      assertRouteDocument(opts.document, []);
      return null;
    }
    if (
      !(
        isRecord(value) &&
        exact(value, "binding,hostnames,reference,resolution,routes,version")
      ) ||
      value.version !== 1
    ) {
      return refused();
    }
    const selected = routes(value.routes);
    const hostnames = names(value.hostnames);
    const resolution =
      value.resolution === null
        ? null
        : parseNativeRoutingResolution(value.resolution);
    if (value.resolution !== null && !resolution) {
      return refused();
    }
    if (resolution) {
      if (
        !selected.some((route) =>
          route.origins.includes(resolution.open_origin)
        )
      ) {
        return refused();
      }
      const resolved = Object.keys(resolution.routes)
        .sort()
        .map((name) => {
          const route = resolution.routes[name];
          if (!route) {
            return refused();
          }
          return {
            service: route.service,
            port: route.port,
            protocol: route.protocol,
            origins: [route.origin, ...Object.values(route.aliases)].sort(),
          };
        });
      if (
        JSON.stringify(resolved) !==
        JSON.stringify(
          selected.map((route) => ({
            service: route.service,
            port: route.port,
            protocol: route.protocol,
            origins: route.origins,
          }))
        )
      ) {
        return refused();
      }
      freezePrivate(resolution);
    } else if (selected.length > 0) {
      return refused();
    }
    if (
      activeHostnames(selected).some(
        (hostname) => !hostnames.includes(hostname)
      )
    ) {
      return refused();
    }
    assertRouteDocument(opts.document, selected);
    return Object.freeze({
      version: 1,
      binding: binding(value.binding),
      reference: reference(value.reference, opts.generationId),
      hostnames,
      routes: selected,
      resolution,
    });
  } catch {
    return refused();
  }
}

const defaultIO = {
  ingress: async (
    opts: Parameters<typeof observeNativeComposeIngress>[0] = {}
  ) => {
    const selected = await observeNativeComposeIngress(opts);
    await assertNativeComposeProxyAccess({
      binding: selected,
      signal: opts.signal,
    });
    return selected;
  },
  inventory: assertNativeComposeRouteInventory,
  proxy: assertNativeComposeProxyRoutes,
  claims: openNativeComposeRouteClaims,
};
type IO = typeof defaultIO;

function claimScope(owner: Owner, ingress: NativeComposeIngressBinding) {
  return {
    root: join(resolveGlobalHackDir(), "compose-routing"),
    binding: {
      engineId: ingress.engineId,
      proxyId: ingress.proxyId,
      networkId: ingress.networkId,
    },
    owner: {
      composeProject: owner.composeProject,
      ownerToken: owner.ownerToken,
    },
  };
}

export type NativeComposeRoutingOwner = {
  readonly document: Document;
  assertBeforeEffects(): Promise<void>;
  markEffectsPossible(): Promise<void>;
  verifyTransition(opts: { readonly deadline: number }): Promise<void>;
  complete(opts?: { readonly deadline: number }): Promise<void>;
  close(): Promise<void>;
};

export type NativeComposeSavedRunRouting = {
  assertContinuity(opts: { readonly deadline: number }): Promise<void>;
  close(): Promise<void>;
};

/** Reopen completed references for observation only; no claim or attempt mutation. */
export async function prepareNativeComposeSavedRunRouting(input: {
  readonly owner: Owner;
  readonly generationId: string;
  readonly document: Document;
  readonly signal?: AbortSignal;
  readonly io?: IO;
}): Promise<NativeComposeSavedRunRouting | null> {
  const owner = Object.freeze({ ...input.owner });
  const metadata = readNativeComposeRouteMetadata({
    generationId: input.generationId,
    document: frozenDocument(input.document),
  });
  if (!metadata) {
    return null;
  }
  const io = Object.freeze({ ...(input.io ?? defaultIO) });
  const claims = await io.claims(claimScope(owner, metadata.binding));
  const assertContinuity = async ({
    deadline,
  }: {
    readonly deadline: number;
  }) => {
    const attempt = await claims.reopen(metadata.reference);
    if (
      attempt.phase !== "complete" ||
      attempt.hostnames.join() !== metadata.hostnames.join()
    ) {
      return refused();
    }
    await io.ingress({ expected: metadata.binding, signal: input.signal });
    await io.inventory({
      ...owner,
      hostnames: metadata.hostnames,
      requireGenerationId: input.generationId,
      signal: input.signal,
    });
    await io.proxy({
      binding: metadata.binding,
      ...owner,
      generationId: input.generationId,
      routes: metadata.routes,
      absentHostnames: metadata.hostnames.filter(
        (hostname) => !activeHostnames(metadata.routes).includes(hostname)
      ),
      signal: input.signal,
      deadline,
    });
    const after = await claims.reopen(metadata.reference);
    if (
      after.phase !== "complete" ||
      after.hostnames.join() !== metadata.hostnames.join()
    ) {
      return refused();
    }
  };
  return {
    assertContinuity,
    close: () => claims.close(),
  };
}

/**
 * Own admission under the caller's instance mutation lock. Only this live attempt
 * can complete after a reaped engine child and verified workload readiness. Closing
 * before arming rolls back new claims; closing after arming retains uncertainty.
 */
export async function prepareNativeComposeRouteOwner(input: {
  readonly owner: Owner;
  readonly generationId: string;
  readonly document: Document;
  readonly plan: Readonly<Record<string, unknown>>;
  readonly resolution: unknown;
  readonly declared?: NativeDeclaredWorkloads;
  readonly previous: readonly NativeComposeSavedRouteDocument[];
  readonly signal?: AbortSignal;
  readonly io?: IO;
}): Promise<NativeComposeRoutingOwner | null> {
  const opts = Object.freeze({
    ...input,
    owner: Object.freeze({
      composeProject: input.owner.composeProject,
      ownerToken: input.owner.ownerToken,
    }),
    document: frozenDocument(input.document),
    plan: frozenDocument(input.plan),
    resolution: structuredClone(input.resolution),
    declared:
      input.declared === undefined
        ? undefined
        : Object.freeze({ ...input.declared }),
    previous: snapshotSaved(input.previous),
  });
  const io = Object.freeze({ ...(input.io ?? defaultIO) });
  const planned = planNativeComposeRouting({
    plan: opts.plan,
    resolution: opts.resolution,
    declared: opts.declared,
  });
  const saved = opts.previous
    .map(readNativeComposeRouteMetadata)
    .filter((value): value is NativeComposeRouteMetadata => value !== null);
  if (!planned && saved.length === 0) {
    return null;
  }
  const ingress = binding(
    await io.ingress({
      ...(saved[0] ? { expected: saved[0].binding } : {}),
      signal: opts.signal,
    })
  );
  if (saved.some((value) => !sameBinding(value.binding, ingress))) {
    return refused();
  }
  const resolution = planned
    ? parseNativeRoutingResolution(opts.resolution)
    : null;
  if (resolution) {
    freezePrivate(resolution);
  }
  const selected = resolution
    ? Object.keys(resolution.routes)
        .sort()
        .map((name) => {
          const route = resolution.routes[name];
          if (!route) {
            return refused();
          }
          return Object.freeze({
            service: route.service,
            port: route.port,
            protocol: route.protocol,
            origins: Object.freeze(
              [route.origin, ...Object.values(route.aliases)].sort()
            ),
            hostnames: Object.freeze(
              [
                ...new Set(
                  [route.origin, ...Object.values(route.aliases)].map(
                    (origin) => new URL(origin).hostname
                  )
                ),
              ].sort()
            ),
          });
        })
    : [];
  assertRouteDocument(opts.document, selected);
  const hostnames = [
    ...new Set([
      ...activeHostnames(selected),
      ...saved.flatMap((value) => activeHostnames(value.routes)),
    ]),
  ].sort();
  const claims = await io.claims(claimScope(opts.owner, ingress));
  let attempt: NativeComposeRouteAttempt | null = null;
  let armed = false;
  let completed = false;
  let closed = false;
  const assertInventory = (requireGenerationId?: string) =>
    io.inventory({
      ...opts.owner,
      hostnames,
      signal: opts.signal,
      ...(requireGenerationId === undefined ? {} : { requireGenerationId }),
    });
  try {
    for (const value of saved) {
      const prior = await claims.reopen(value.reference);
      if (
        prior.phase !== "complete" ||
        prior.hostnames.join() !== value.hostnames.join()
      ) {
        return refused();
      }
    }
    await assertInventory();
    attempt = await claims.acquire({
      hostnames,
      generationIdentity: opts.generationId,
    });
    const liveAttempt = attempt;
    const metadata: NativeComposeRouteMetadata = Object.freeze({
      version: 1,
      binding: ingress,
      reference: liveAttempt.reference,
      hostnames: liveAttempt.hostnames,
      routes: Object.freeze(selected),
      resolution,
    });
    let verifiedDeadline: number | undefined;
    const keepHostnames = activeHostnames(selected);
    const absentHostnames = hostnames.filter(
      (name) => !keepHostnames.includes(name)
    );
    const assertBeforeEffects = async () => {
      await io.ingress({ expected: ingress, signal: opts.signal });
      await assertInventory();
    };
    const assertTransition = async (deadline: number) => {
      await io.ingress({ expected: ingress, signal: opts.signal });
      await assertInventory(opts.generationId);
      await io.proxy({
        binding: ingress,
        ...opts.owner,
        generationId: opts.generationId,
        routes: selected,
        absentHostnames,
        signal: opts.signal,
        deadline,
      });
    };
    return {
      document: Object.freeze({ ...opts.document, [EXTENSION]: metadata }),
      assertBeforeEffects,
      markEffectsPossible: async () => {
        await assertBeforeEffects();
        await claims.markEffectsPossible(liveAttempt);
        armed = true;
      },
      verifyTransition: async ({ deadline }) => {
        await assertTransition(deadline);
        verifiedDeadline = deadline;
      },
      complete: async (options) => {
        const deadline = options?.deadline ?? verifiedDeadline;
        if (deadline === undefined) {
          return refused();
        }
        const verify = () => assertTransition(deadline);
        await claims.complete({
          attempt: liveAttempt,
          assertTransition: verify,
        });
        completed = true;
        await claims.release({ keepHostnames, assertAbsent: verify });
      },
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        try {
          if (!completed) {
            if (armed) {
              await claims.retain(liveAttempt);
            } else {
              await claims.rollback(liveAttempt);
            }
          }
        } finally {
          await claims.close();
        }
      },
    };
  } catch (error) {
    try {
      if (attempt) {
        await claims.rollback(attempt);
      }
    } finally {
      await claims.close();
    }
    throw error;
  }
}

/**
 * Call only after all owned containers and the owned network are freshly absent.
 * Reopening conveys cleanup authority only; it never completes interrupted starts.
 * Proxy loss leaves claims in place after owned stop. Explicit recovery may retire
 * anchored uncertain attempts only after fresh whole-owner and proxy absence proof.
 */
export async function releaseNativeComposeSavedRoutes(input: {
  readonly owner: Owner;
  readonly saved: readonly NativeComposeSavedRouteDocument[];
  readonly signal?: AbortSignal;
  readonly deadline: number;
  readonly recover?: boolean;
  readonly io?: IO;
}): Promise<void> {
  const opts = Object.freeze({
    ...input,
    owner: Object.freeze({
      composeProject: input.owner.composeProject,
      ownerToken: input.owner.ownerToken,
    }),
    saved: snapshotSaved(input.saved),
  });
  const io = Object.freeze({ ...(input.io ?? defaultIO) });
  const saved = opts.saved
    .map(readNativeComposeRouteMetadata)
    .filter((value): value is NativeComposeRouteMetadata => value !== null);
  const byBinding = new Map<string, NativeComposeRouteMetadata[]>();
  for (const value of saved) {
    const key = JSON.stringify(value.binding);
    const group = byBinding.get(key) ?? [];
    group.push(value);
    byBinding.set(key, group);
  }
  for (const group of byBinding.values()) {
    const selected = group[0];
    if (!selected) {
      return refused();
    }
    const claims: NativeComposeRouteClaims = await io.claims(
      claimScope(opts.owner, selected.binding)
    );
    try {
      for (const value of group) {
        const attempt = await claims.reopen(value.reference);
        if (attempt.hostnames.join() !== value.hostnames.join()) {
          return refused();
        }
      }
      const retirement = {
        assertAbsent: async ({ hostnames }) => {
          await io.ingress({ expected: selected.binding, signal: opts.signal });
          await io.inventory({
            ...opts.owner,
            hostnames,
            requireAbsent: true,
            signal: opts.signal,
          });
          await io.proxy({
            binding: selected.binding,
            ...opts.owner,
            absentHostnames: hostnames,
            signal: opts.signal,
            deadline: opts.deadline,
          });
        },
      } satisfies Parameters<NativeComposeRouteClaims["release"]>[0];
      if (opts.recover) {
        await claims.recoverStopped({
          ...retirement,
          references: group.map((value) => value.reference),
        });
      } else {
        await claims.release(retirement);
      }
    } finally {
      await claims.close();
    }
  }
}
