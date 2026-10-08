import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { YAML } from "bun";
import type {
  HostHook,
  Project,
} from "../../../packages/config-compiler/generated/native-config.ts";
import { isRecord } from "../../../src/lib/guards.ts";
import {
  type NativeComposeIdentity,
  openNativeComposeGenerationStore,
} from "../../../src/lib/native-compose-generation.ts";
import { assertNativeComposeProxyRoutes } from "../../../src/lib/native-compose-proxy-routes.ts";
import {
  readNativeComposeRouteMetadata,
  verifyNativeComposeSavedRoutesAbsent,
} from "../../../src/lib/native-compose-route-owner.ts";
import { type CliResult, expect, expectExit } from "../harness.ts";
import { createNativeRoutedDownProofWindow } from "../native-routed-down-proof-window.ts";

const ID = /^[a-f0-9]{64}$/;
const TOKEN = /^[a-f0-9]{32}$/;
const CLAIM = /^[a-f0-9]{64}\.json:[a-f0-9]{64}$/;
const PROJECT = "com.docker.compose.project";
const OWNER = "io.hack.native-config.owner";
const GENERATION = "io.hack.native-config.generation";
const INSTANCE = "io.hack.native-config.instance";
const MARKER_PATH = "/state/routed-down-marker";
const ENV_KEY = "ROUTED_DOWN_TOKEN";
const HOST_VALUE = "synthetic-routed-down-host-$literal";
const REFRESHED_HOST_VALUE = "synthetic-routed-down-host-$literal-refreshed";
const GUEST_VALUE = "synthetic-routed-down-guest";
const PROOF_WINDOW = 30_000;
type Checkout = { readonly root: string; readonly marker: string };
type Docker = (args: readonly string[]) => Promise<string>;
type Pin = Checkout & {
  readonly composeProject: string;
  readonly ownerToken: string;
  readonly generationId: string;
  readonly containers: readonly string[];
  readonly networks: readonly string[];
  readonly volume: { readonly name: string; readonly createdAt: string };
  readonly origins: readonly string[];
};
type Observation = {
  readonly pin: Pin;
  readonly pending: {
    readonly operation: string;
    readonly generationId: string;
  } | null;
  readonly stopped: boolean;
  readonly hostHookPhase: string | null;
  readonly beforeHooksPending: boolean;
  readonly marker: string | null;
};
type Capsule = {
  readonly mode: "success" | "after17";
  readonly order: string;
  readonly claimsRoot: string;
  readonly claims: string;
  readonly own: Pin;
  readonly siblings: readonly Pin[];
};
type Acceptance = {
  readonly primary: Checkout;
  readonly siblings: readonly Checkout[];
  readonly tempRoot: string;
  readonly claimsRoot: string;
  readonly docker: Docker;
  readonly raw: (root: string, args: readonly string[]) => Promise<CliResult>;
  readonly configure: (host: Project["host"]) => Promise<void>;
  readonly up: (root: string) => Promise<void>;
  readonly check: (checkout: Checkout) => Promise<unknown>;
  readonly absent: (hostnames: readonly string[]) => Promise<void>;
};

function object(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error(
      "Routed down fixture requires a complete object; values omitted"
    );
  }
  return parsed;
}
function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function ids(text: string): string[] {
  const result = text.split(/\s+/).filter(Boolean).sort();
  if (
    result.some((id) => !ID.test(id)) ||
    new Set(result).size !== result.length
  ) {
    throw new Error("Routed down fixture requires distinct full resource IDs");
  }
  return result;
}
function stringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}
function origin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.origin === value &&
      parsed.port === "" &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}
function pinValid(value: unknown): value is Pin {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join() ===
      "composeProject,containers,generationId,marker,networks,origins,ownerToken,root,volume" &&
    typeof value.root === "string" &&
    isAbsolute(value.root) &&
    typeof value.marker === "string" &&
    value.marker.length > 0 &&
    value.marker.length < 256 &&
    typeof value.composeProject === "string" &&
    /^[a-z0-9][a-z0-9_-]+$/.test(value.composeProject) &&
    typeof value.ownerToken === "string" &&
    TOKEN.test(value.ownerToken) &&
    typeof value.generationId === "string" &&
    TOKEN.test(value.generationId) &&
    stringArray(value.containers) &&
    value.containers.length <= 1 &&
    value.containers.every((id) => ID.test(id)) &&
    stringArray(value.networks) &&
    value.networks.length <= 1 &&
    value.networks.every((id) => ID.test(id)) &&
    stringArray(value.origins) &&
    value.origins.length === 2 &&
    new Set(value.origins).size === 2 &&
    value.origins.every(origin) &&
    isRecord(value.volume) &&
    Object.keys(value.volume).sort().join() === "createdAt,name" &&
    typeof value.volume.name === "string" &&
    value.volume.name.length > 0 &&
    typeof value.volume.createdAt === "string" &&
    Number.isFinite(Date.parse(value.volume.createdAt))
  );
}

/** Refuse premature finalization, altered sibling membership/data, or a malformed phase observation. */
export function nativeRoutedDownPhaseMatches(opts: {
  readonly expected: Pin;
  readonly observed: unknown;
  readonly phase: "before" | "after" | "sibling";
}): boolean {
  const value = opts.observed;
  if (
    !(
      pinValid(opts.expected) &&
      opts.expected.containers.length === 1 &&
      opts.expected.networks.length === 1 &&
      isRecord(value) &&
      pinValid(value.pin) &&
      value.stopped === false
    )
  ) {
    return false;
  }
  const { containers, networks, ...identity } = value.pin;
  const {
    containers: expectedContainers,
    networks: expectedNetworks,
    ...expectedIdentity
  } = opts.expected;
  if (!equal(identity, expectedIdentity)) {
    return false;
  }
  if (opts.phase === "sibling") {
    return (
      equal(containers, expectedContainers) &&
      equal(networks, expectedNetworks) &&
      value.marker === opts.expected.marker &&
      value.pending === null &&
      value.hostHookPhase === null &&
      value.beforeHooksPending === false
    );
  }
  return (
    isRecord(value.pending) &&
    value.pending.operation === "down" &&
    value.pending.generationId === opts.expected.generationId &&
    value.hostHookPhase === `down.${opts.phase}` &&
    value.beforeHooksPending === true &&
    (opts.phase === "before"
      ? equal(containers, expectedContainers) &&
        equal(networks, expectedNetworks) &&
        value.marker === opts.expected.marker
      : containers.length === 0 &&
        networks.length === 0 &&
        value.marker === null)
  );
}

/** Exact authored claim bytes, without exposing hostname records or private journals. */
export async function nativeRoutedDownClaimSnapshot(
  root: string
): Promise<string> {
  const names = await readdir(root).catch((error: unknown) => {
    if (isRecord(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const result: string[] = [];
  for (const name of names.sort()) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) {
      throw new Error("Malformed fixture claim inventory");
    }
    result.push(
      `${name}:${createHash("sha256")
        .update(await Bun.file(join(root, name)).text())
        .digest("hex")}`
    );
  }
  return result.join("\n");
}
/** Both primary claims stay byte-exact until finalization; afterward only those two may disappear. */
export function nativeRoutedDownClaimsMatch(opts: {
  readonly before: string;
  readonly ownOrigins: readonly string[];
  readonly observed: unknown;
  readonly retired: boolean;
}): boolean {
  const lines = opts.before.split("\n");
  if (
    !(
      lines.length === 6 &&
      new Set(lines).size === 6 &&
      lines.every((line) => CLAIM.test(line)) &&
      opts.ownOrigins.length === 2 &&
      new Set(opts.ownOrigins).size === 2 &&
      opts.ownOrigins.every(origin) &&
      typeof opts.observed === "string"
    )
  ) {
    return false;
  }
  const own = new Set(
    opts.ownOrigins.map(
      (url) =>
        `${createHash("sha256").update(new URL(url).hostname).digest("hex")}.json`
    )
  );
  if (lines.filter((line) => own.has(line.split(":")[0] ?? "")).length !== 2) {
    return false;
  }
  const expected = opts.retired
    ? lines.filter((line) => !own.has(line.split(":")[0] ?? "")).join("\n")
    : opts.before;
  return opts.observed === expected;
}
function parseCapsule(text: string): Capsule {
  if (text.length > 32_768) {
    throw new Error("Oversized routed down fixture capsule");
  }
  const value = object(text);
  if (
    !(
      Object.keys(value).sort().join() ===
        "claims,claimsRoot,mode,order,own,siblings" &&
      (value.mode === "success" || value.mode === "after17") &&
      typeof value.order === "string" &&
      isAbsolute(value.order) &&
      typeof value.claimsRoot === "string" &&
      isAbsolute(value.claimsRoot) &&
      typeof value.claims === "string" &&
      value.claims.split("\n").length === 6 &&
      new Set(value.claims.split("\n").map((line) => line.split(":")[0]))
        .size === 6 &&
      value.claims.split("\n").every((line) => CLAIM.test(line)) &&
      pinValid(value.own) &&
      value.own.containers.length === 1 &&
      value.own.networks.length === 1 &&
      Array.isArray(value.siblings) &&
      value.siblings.length === 2 &&
      value.siblings.every(pinValid)
    )
  ) {
    throw new Error("Invalid routed down fixture capsule; values omitted");
  }
  const pins = [value.own, ...value.siblings];
  if (
    new Set(pins.map((pin) => pin.root)).size !== 3 ||
    new Set(pins.map((pin) => pin.ownerToken)).size !== 3 ||
    new Set(pins.flatMap((pin) => pin.origins)).size !== 6 ||
    pins.some((pin) => pin.containers.length !== 1 || pin.networks.length !== 1)
  ) {
    throw new Error("Fixture ownership must remain isolated");
  }
  return {
    mode: value.mode,
    order: value.order,
    claimsRoot: value.claimsRoot,
    claims: value.claims,
    own: value.own,
    siblings: value.siblings,
  };
}
async function observe(
  checkout: Checkout,
  docker: Docker,
  readMarker: boolean
) {
  const store = await openNativeComposeGenerationStore({
    projectRoot: checkout.root,
    instance: null,
    mode: "saved",
  });
  try {
    const state = await store.loadCurrent();
    const generation = state.generation;
    if (!generation) {
      throw new Error(
        "Routed down fixture requires a saved current generation"
      );
    }
    const document = await store.withLease({
      generation,
      run: () => store.readGenerationDocument(generation),
    });
    const metadata = readNativeComposeRouteMetadata({
      generationId: generation.generationId,
      document,
    });
    if (!metadata?.resolution) {
      throw new Error("Routed down fixture requires saved route metadata");
    }
    const owner = store.identity;
    const containers = ids(
      await docker([
        "ps",
        "--no-trunc",
        "-aq",
        "--filter",
        `label=${PROJECT}=${owner.composeProject}`,
      ])
    );
    for (const id of containers) {
      const info = object(
        await docker([
          "container",
          "inspect",
          "--format",
          '{"id":{{json .Id}},"labels":{{json .Config.Labels}},"running":{{json .State.Running}},"health":{{with (index .State "Health")}}{{json .Status}}{{else}}null{{end}}}',
          id,
        ])
      );
      if (
        !workloadOwned({
          info,
          id,
          owner,
          generationId: generation.generationId,
        })
      ) {
        throw new Error(
          "Changed routed fixture workload ownership or readiness"
        );
      }
    }
    const networks = ids(
      await docker([
        "network",
        "ls",
        "--no-trunc",
        "-q",
        "--filter",
        `label=${PROJECT}=${owner.composeProject}`,
      ])
    );
    for (const id of networks) {
      const info = object(
        await docker([
          "network",
          "inspect",
          "--format",
          '{"id":{{json .Id}},"labels":{{json .Labels}}}',
          id,
        ])
      );
      if (
        !(
          info.id === id &&
          isRecord(info.labels) &&
          info.labels[PROJECT] === owner.composeProject &&
          info.labels[OWNER] === owner.ownerToken &&
          info.labels[INSTANCE] === owner.composeProject
        )
      ) {
        throw new Error("Changed routed fixture network ownership");
      }
    }
    if (
      !(
        isRecord(document.volumes) &&
        isRecord(document.volumes.state) &&
        typeof document.volumes.state.name === "string"
      )
    ) {
      throw new Error("Missing saved fixture volume");
    }
    const volumeName = document.volumes.state.name;
    const volumeNames = (
      await docker([
        "volume",
        "ls",
        "-q",
        "--filter",
        `label=${PROJECT}=${owner.composeProject}`,
      ])
    )
      .split(/\s+/)
      .filter(Boolean);
    if (!equal(volumeNames, [volumeName])) {
      throw new Error("Routed fixture volume membership changed");
    }
    const physical = object(
      await docker([
        "volume",
        "inspect",
        "--format",
        '{"name":{{json .Name}},"createdAt":{{json .CreatedAt}},"labels":{{json .Labels}}}',
        volumeName,
      ])
    );
    if (
      !(
        physical.name === volumeName &&
        typeof physical.createdAt === "string" &&
        Number.isFinite(Date.parse(physical.createdAt)) &&
        isRecord(physical.labels) &&
        physical.labels[PROJECT] === owner.composeProject &&
        physical.labels[OWNER] === owner.ownerToken &&
        physical.labels[INSTANCE] === owner.composeProject &&
        physical.labels["io.hack.native-config.storage"] === "state"
      )
    ) {
      throw new Error("Changed routed fixture physical volume");
    }
    const marker =
      readMarker && containers.length === 1
        ? (
            await docker([
              "exec",
              containers[0] ?? "",
              "bun",
              "-e",
              `process.stdout.write(await Bun.file(${JSON.stringify(MARKER_PATH)}).text())`,
            ])
          ).trim()
        : null;
    const pin: Pin = {
      ...checkout,
      composeProject: owner.composeProject,
      ownerToken: owner.ownerToken,
      generationId: generation.generationId,
      containers,
      networks,
      volume: { name: volumeName, createdAt: physical.createdAt },
      origins: [
        metadata.resolution.project_origin,
        metadata.resolution.aliases.oauth ?? "",
      ],
    };
    if (!pinValid(pin)) {
      throw new Error("Invalid routed fixture observation");
    }
    return {
      observation: {
        pin,
        pending: state.pending,
        stopped: state.stopped,
        hostHookPhase: state.hostHookPhase,
        beforeHooksPending: state.beforeHooksPending,
        marker,
      } satisfies Observation,
      source: { owner, generation, document },
      metadata,
    };
  } finally {
    await store.close();
  }
}
function workloadOwned(opts: {
  readonly info: Record<string, unknown>;
  readonly id: string;
  readonly owner: NativeComposeIdentity;
  readonly generationId: string;
}): boolean {
  const { info, id, owner, generationId } = opts;
  return (
    info.id === id &&
    info.running === true &&
    info.health === "healthy" &&
    isRecord(info.labels) &&
    info.labels[PROJECT] === owner.composeProject &&
    info.labels[OWNER] === owner.ownerToken &&
    info.labels[GENERATION] === generationId &&
    info.labels[INSTANCE] === owner.composeProject &&
    info.labels["io.hack.native-config.version"] === "1" &&
    info.labels["io.hack.native-config.workload"] === "service" &&
    info.labels["com.docker.compose.service"] === "web" &&
    info.labels["com.docker.compose.oneoff"] === "False"
  );
}
async function routesLive(
  value: Awaited<ReturnType<typeof observe>>,
  docker: Docker,
  deadline: number
): Promise<void> {
  const { source, metadata, observation } = value;
  const proof = () =>
    assertNativeComposeProxyRoutes({
      binding: metadata.binding,
      composeProject: source.owner.composeProject,
      ownerToken: source.owner.ownerToken,
      generationId: source.generation.generationId,
      routes: metadata.routes,
      deadline,
    });
  await proof();
  for (const url of observation.pin.origins) {
    const host = new URL(url).hostname;
    const output = await docker([
      "exec",
      metadata.binding.proxyId,
      "curl",
      "--disable",
      "--proxy",
      "",
      "--noproxy",
      "*",
      "--proto",
      "=https",
      "--max-redirs",
      "0",
      "--connect-timeout",
      "2",
      "--max-time",
      "5",
      "--silent",
      "--show-error",
      "--cacert",
      "/data/caddy/pki/authorities/local/root.crt",
      "--resolve",
      `${host}:443:127.0.0.1`,
      "--write-out",
      "\n%{http_code}",
      `${url}/`,
    ]);
    if (output !== `${observation.pin.marker}\n200`) {
      throw new Error(
        "Routed hook requires the exact CA-valid TLS checkout marker"
      );
    }
  }
  await proof();
}

/** The actual finite host hook reads the owning journal and exact engine/route observations. */
export async function runNativeRoutedDownHook(
  capsulePath: string,
  phase: "before" | "after"
): Promise<number> {
  const capsule = parseCapsule(await Bun.file(capsulePath).text());
  if (
    !(
      process.cwd() === capsule.own.root &&
      process.env.SEEN === REFRESHED_HOST_VALUE &&
      !Object.hasOwn(process.env, ENV_KEY)
    )
  ) {
    throw new Error(
      "Routed hook target environment or checkout changed; values omitted"
    );
  }
  const window = createNativeRoutedDownProofWindow({ timeoutMs: PROOF_WINDOW });
  const own = await window.capture((docker) =>
    observe(capsule.own, docker, phase === "before")
  );
  if (
    !nativeRoutedDownPhaseMatches({
      expected: capsule.own,
      observed: own.observation,
      phase,
    })
  ) {
    throw new Error("Routed hook phase finalized early or changed ownership");
  }
  if (phase === "before") {
    await window.capture((docker) => routesLive(own, docker, window.deadline));
  } else {
    await verifyNativeComposeSavedRoutesAbsent({
      owner: own.source.owner,
      saved: [
        {
          generationId: own.source.generation.generationId,
          document: own.source.document,
        },
      ],
      deadline: window.deadline,
    });
  }
  for (const sibling of capsule.siblings) {
    const actual = await window.capture((docker) =>
      observe(sibling, docker, true)
    );
    if (
      !nativeRoutedDownPhaseMatches({
        expected: sibling,
        observed: actual.observation,
        phase: "sibling",
      })
    ) {
      throw new Error(
        "Sibling route/data ownership changed during routed stop"
      );
    }
    await window.capture((docker) =>
      routesLive(actual, docker, window.deadline)
    );
  }
  if (
    !nativeRoutedDownClaimsMatch({
      before: capsule.claims,
      ownOrigins: capsule.own.origins,
      observed: await nativeRoutedDownClaimSnapshot(capsule.claimsRoot),
      retired: false,
    })
  ) {
    throw new Error(
      "Routed stop retired or changed claims before after-hook completion"
    );
  }
  const final = await window.capture((docker) =>
    observe(capsule.own, docker, phase === "before")
  );
  if (
    !nativeRoutedDownPhaseMatches({
      expected: capsule.own,
      observed: final.observation,
      phase,
    })
  ) {
    throw new Error("Routed hook owner changed across proof awaits");
  }
  window.assertOpen();
  await appendFile(capsule.order, `${phase}\n`);
  // The private proof contains only synthetic fixture identity and booleans, never env/document values.
  await Bun.write(
    `${capsulePath}.${capsule.mode}.${phase}.proof.json`,
    JSON.stringify({
      phase,
      generationId: capsule.own.generationId,
      ownerToken: capsule.own.ownerToken,
      containers: final.observation.pin.containers,
      networks: final.observation.pin.networks,
      heldClaims: true,
      siblingsUnchanged: true,
      ownerPending: true,
      routeState: phase === "before" ? "live" : "absent",
    })
  );
  window.assertOpen();
  return capsule.mode === "after17" && phase === "after" ? 17 : 0;
}

async function assertKnownStop(
  opts: Acceptance,
  capsule: Capsule
): Promise<void> {
  const { own, mode } = capsule;
  const stopped = (await observe(opts.primary, opts.docker, false)).observation;
  expect({
    that:
      stopped.pin.containers.length === 0 &&
      stopped.pin.networks.length === 0 &&
      equal(stopped.pin.volume, own.volume) &&
      stopped.pin.generationId === own.generationId &&
      !stopped.beforeHooksPending &&
      stopped.hostHookPhase === null &&
      (mode === "after17"
        ? stopped.pending?.operation === "down" &&
          stopped.pending.generationId === own.generationId &&
          !stopped.stopped
        : stopped.pending === null && stopped.stopped),
    message:
      "Known hook outcome must preserve exact stop uncertainty or finish only this generation",
  });
  await opts.absent(own.origins.map((url) => new URL(url).hostname));
}

async function refuseSavedSourceDrift(
  opts: Acceptance,
  capsule: Capsule,
  raw: (args: readonly string[]) => Promise<CliResult>
): Promise<void> {
  const sourcePath = join(opts.primary.root, ".hack", "hack.project.json");
  const original = await Bun.file(sourcePath).text();
  await Bun.write(sourcePath, nativeRoutedDownChangedSource(original));
  try {
    const refused = await raw(["down", "--json"]);
    expectExit({
      result: refused,
      codes: [1],
      message:
        "Changed saved source must refuse routed stop before hook/engine effects",
    });
    const proof = nativeRoutedDownFreshnessEvidence({
      expected: capsule.own,
      observed: (await observe(opts.primary, opts.docker, true)).observation,
      inputErrorMatched: refused.combined.includes("E_CONFIG_INVALID"),
      order: await Bun.file(capsule.order).text(),
      claimsBefore: capsule.claims,
      claimsAfter: await nativeRoutedDownClaimSnapshot(opts.claimsRoot),
    });
    const diagnostic = {
      ...proof,
      refusalCode:
        [
          "E_CONFIG_INVALID",
          "E_COMPOSE_FAILED",
          "E_UNEXPECTED",
          "E_LIFECYCLE_FAILED",
        ].find((code) => refused.combined.includes(code)) ?? "other",
    };
    await Bun.write(
      `${capsule.order}.freshness-proof.json`,
      JSON.stringify(diagnostic)
    );
    console.log(
      `[native-config-routed-down] freshness proof ${JSON.stringify(diagnostic)}`
    );
    expect({
      that:
        proof.inputErrorMatched &&
        proof.hookOrderUnchanged &&
        proof.snapshotUnchanged &&
        proof.claimsUnchanged,
      message: `Saved-source refusal must leave the original route, data, generation and claims unchanged: ${JSON.stringify(diagnostic)}`,
    });
    await opts.check(opts.primary);
  } finally {
    await Bun.write(sourcePath, original);
    expect({
      that: (await Bun.file(sourcePath).text()) === original,
      message: "Saved-source control must restore exact authored bytes",
    });
  }
}

/** Change a declared hook name, preserving its argv/env and every unrelated authored field. */
export function nativeRoutedDownChangedSource(text: string): string {
  const value = object(text);
  const host = value.host;
  const down = isRecord(host) ? host.down : null;
  const before = isRecord(down) ? down.before : null;
  if (
    !(
      isRecord(host) &&
      isRecord(down) &&
      Array.isArray(before) &&
      before.length === 1 &&
      isRecord(before[0]) &&
      before[0].name === "routed-down-before"
    )
  ) {
    throw new Error(
      "Saved-source control requires its exact owned before hook; values omitted"
    );
  }
  return `${JSON.stringify({ ...value, host: { ...host, down: { ...down, before: [{ ...before[0], name: "changed-routed-down-before" }] } } }, null, 2)}\n`;
}

/** Fixed booleans expose the precise refusal boundary without publishing values or private owner records. */
export function nativeRoutedDownFreshnessEvidence(opts: {
  readonly expected: Pin;
  readonly observed: unknown;
  readonly inputErrorMatched: boolean;
  readonly order: string;
  readonly claimsBefore: string;
  readonly claimsAfter: string;
}) {
  return {
    inputErrorMatched: opts.inputErrorMatched,
    hookOrderUnchanged: opts.order === "",
    snapshotUnchanged: equal(opts.observed, {
      pin: opts.expected,
      pending: null,
      stopped: false,
      hostHookPhase: null,
      beforeHooksPending: false,
      marker: opts.expected.marker,
    }),
    structuredSnapshotUnchanged: nativeRoutedDownPhaseMatches({
      expected: opts.expected,
      observed: opts.observed,
      phase: "sibling",
    }),
    claimsUnchanged: opts.claimsBefore === opts.claimsAfter,
  };
}

async function recoverKnownFailure(
  opts: Acceptance,
  capsule: Capsule,
  raw: (args: readonly string[]) => Promise<CliResult>
): Promise<void> {
  expect({
    that:
      (await nativeRoutedDownClaimSnapshot(opts.claimsRoot)) === capsule.claims,
    message: "Known after-hook failure must retain both exact hostname claims",
  });
  const retry = await raw(["down", "--json"]);
  expectExit({
    result: retry,
    codes: [1],
    message: "Normal stop cannot replay a pending routed hook failure",
  });
  expect({
    that: (await Bun.file(capsule.order).text()) === "before\nafter\n",
    message: "Pending refusal must not replay either finite hook",
  });
  const recovered = await raw(["down", "--recover", "--json"]);
  expectExit({
    result: recovered,
    codes: [0],
    message:
      "Explicit saved recovery retires exact known routed stop without replay",
  });
  const payload = object(recovered.stdout);
  expect({
    that:
      isRecord(payload.data) &&
      payload.data.hostHooksSkipped === true &&
      (await Bun.file(capsule.order).text()) === "before\nafter\n",
    message:
      "Recovery must report skipped hooks and never relabel/replay the failed sequence",
  });
}

/** Correlate each private hook proof with the exact source phase, generation and observed engine membership. */
export function nativeRoutedDownHookProofMatches(opts: {
  readonly expected: Pin;
  readonly phase: "before" | "after";
  readonly proof: unknown;
}): boolean {
  const value = opts.proof;
  return (
    pinValid(opts.expected) &&
    isRecord(value) &&
    Object.keys(value).sort().join() ===
      "containers,generationId,heldClaims,networks,ownerPending,ownerToken,phase,routeState,siblingsUnchanged" &&
    value.phase === opts.phase &&
    value.generationId === opts.expected.generationId &&
    value.ownerToken === opts.expected.ownerToken &&
    value.heldClaims === true &&
    value.siblingsUnchanged === true &&
    value.ownerPending === true &&
    value.routeState === (opts.phase === "before" ? "live" : "absent") &&
    equal(
      value.containers,
      opts.phase === "before" ? opts.expected.containers : []
    ) &&
    equal(value.networks, opts.phase === "before" ? opts.expected.networks : [])
  );
}
async function verifyPhaseProofs(
  capsulePath: string,
  capsule: Capsule
): Promise<void> {
  for (const phase of ["before", "after"] as const) {
    const proof: unknown = JSON.parse(
      await Bun.file(
        `${capsulePath}.${capsule.mode}.${phase}.proof.json`
      ).text()
    );
    expect({
      that: nativeRoutedDownHookProofMatches({
        expected: capsule.own,
        phase,
        proof,
      }),
      message:
        "Actual hook proofs must correspond to this exact saved generation, owner and phase",
    });
  }
}

/** Only the initial failed-after mode may seed data; later startup must observe retained bytes. */
export function nativeRoutedDownMarkerProgram(opts: {
  readonly mode: "after17" | "success";
  readonly path: string;
  readonly marker: string;
  readonly primary: boolean;
}): string {
  return `const f=Bun.file(${JSON.stringify(opts.path)});if(await f.exists()){if(await f.text()!==${JSON.stringify(opts.marker)})process.exit(48)}else{${opts.mode === "after17" ? `await Bun.write(f,${JSON.stringify(opts.marker)});` : "process.exit(48);"}}${opts.primary ? `if(process.env.${ENV_KEY}!==${JSON.stringify(GUEST_VALUE)}||Object.hasOwn(process.env,"SEEN"))process.exit(47);` : ""}`;
}

function envFixtureText(mode: "initial" | "refresh"): string {
  const text = YAML.stringify({
    version: 1,
    environment: "default",
    secretsprovider: "project_key",
    values: {
      global: { [ENV_KEY]: GUEST_VALUE },
      host: {
        [ENV_KEY]: mode === "initial" ? HOST_VALUE : REFRESHED_HOST_VALUE,
      },
    },
  });
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** Author only this isolated synthetic input; legacy mutation APIs intentionally refuse native projects. */
export async function writeNativeRoutedDownEnvFixture(opts: {
  readonly root: string;
  readonly mode: "initial" | "refresh" | "reset";
}): Promise<void> {
  const path = join(opts.root, ".hack", "hack.env.default.yaml");
  const file = Bun.file(path);
  const exists = await file.exists();
  expect({
    that:
      opts.mode === "initial"
        ? !exists
        : exists &&
          (await file.text()) ===
            envFixtureText(opts.mode === "refresh" ? "initial" : "refresh"),
    message:
      "Synthetic native env authoring must not overwrite unrelated fixture inputs",
  });
  await Bun.write(
    path,
    envFixtureText(opts.mode === "refresh" ? "refresh" : "initial")
  );
}

/** Combined routing + finite stop proof, inside the required owned routing scenario. */
export async function qualifyNativeComposeRoutedDownHooks(
  opts: Acceptance
): Promise<void> {
  const root = join(opts.tempRoot, "routed-down-hooks");
  await mkdir(root, { mode: 0o700 });
  const capsulePath = join(root, "capsule.json");
  const order = join(root, "order");
  const helper = join(opts.primary.root, "routed-down-hook.ts");
  await Bun.write(
    helper,
    `import {runNativeRoutedDownHook} from ${JSON.stringify(import.meta.url)};const phase=process.argv[2];if(phase!=="before"&&phase!=="after")process.exit(49);process.exit(await runNativeRoutedDownHook(${JSON.stringify(capsulePath)},phase));\n`
  );
  const hook = (phase: "before" | "after"): HostHook => ({
    name: `routed-down-${phase}`,
    command: { exec: [process.execPath, helper, phase] },
    environment: { SEEN: { env_ref: ENV_KEY }, [ENV_KEY]: { unset: true } },
  });
  await writeNativeRoutedDownEnvFixture({
    root: opts.primary.root,
    mode: "initial",
  });
  await opts.configure({
    down: { before: [hook("before")], after: [hook("after")] },
  });
  const raw = async (args: readonly string[]) => {
    const result = await opts.raw(opts.primary.root, args);
    expect({
      that: !(
        result.combined.includes(HOST_VALUE) ||
        result.combined.includes(GUEST_VALUE)
      ),
      message:
        "Managed synthetic routed-hook values must remain absent from CLI output",
    });
    return result;
  };
  for (const mode of ["after17", "success"] as const) {
    await opts.up(opts.primary.root);
    await opts.check(opts.primary);
    for (const checkout of [opts.primary, ...opts.siblings]) {
      const observed = await observe(checkout, opts.docker, false);
      if (observed.observation.pin.containers.length !== 1) {
        throw new Error("Missing ready owned routed fixture workload");
      }
      await opts.docker([
        "exec",
        observed.observation.pin.containers[0] ?? "",
        "bun",
        "-e",
        nativeRoutedDownMarkerProgram({
          mode,
          path: MARKER_PATH,
          marker: checkout.marker,
          primary: checkout.root === opts.primary.root,
        }),
      ]);
    }
    const own = (await observe(opts.primary, opts.docker, true)).observation
      .pin;
    const siblings = await Promise.all(
      opts.siblings.map(
        async (checkout) =>
          (await observe(checkout, opts.docker, true)).observation.pin
      )
    );
    const capsule: Capsule = {
      mode,
      order,
      claimsRoot: opts.claimsRoot,
      claims: await nativeRoutedDownClaimSnapshot(opts.claimsRoot),
      own,
      siblings,
    };
    parseCapsule(JSON.stringify(capsule));
    await Bun.write(capsulePath, JSON.stringify(capsule));
    await Bun.write(
      join(root, `${mode}-capsule.json`),
      JSON.stringify(capsule)
    );
    await Bun.write(order, "");
    if (mode === "after17") {
      await refuseSavedSourceDrift(opts, capsule, raw);
    }
    // New down invocation owns fresh current values; it does not freeze the earlier up acquisition.
    await writeNativeRoutedDownEnvFixture({
      root: opts.primary.root,
      mode: "refresh",
    });
    const result = await raw(["down", "--json"]);
    expectExit({
      result,
      codes: [mode === "after17" ? 17 : 0],
      message: "Actual routed down must preserve the finite hook exit",
    });
    expect({
      that: (await Bun.file(order).text()) === "before\nafter\n",
      message:
        "Both routed hook phases must observe their true engine boundary exactly once",
    });
    await verifyPhaseProofs(capsulePath, capsule);
    await assertKnownStop(opts, capsule);
    if (mode === "after17") {
      await recoverKnownFailure(opts, capsule, raw);
    }
    expect({
      that: nativeRoutedDownClaimsMatch({
        before: capsule.claims,
        ownOrigins: own.origins,
        observed: await nativeRoutedDownClaimSnapshot(opts.claimsRoot),
        retired: true,
      }),
      message:
        "Finalization must retire only the primary claims and preserve exact sibling claim bytes",
    });
    const final = await observe(opts.primary, opts.docker, false);
    expect({
      that:
        final.observation.stopped &&
        final.observation.pending === null &&
        !final.observation.beforeHooksPending &&
        equal(final.observation.pin.volume, own.volume),
      message:
        "Claim retirement must finish the saved stop while preserving the physical volume",
    });
    for (const sibling of siblings) {
      const actual = await observe(sibling, opts.docker, true);
      expect({
        that: nativeRoutedDownPhaseMatches({
          expected: sibling,
          observed: actual.observation,
          phase: "sibling",
        }),
        message:
          "Primary hook failure/recovery must preserve exact sibling IDs, generation, data and volume creation",
      });
      await opts.check(sibling);
    }
    await writeNativeRoutedDownEnvFixture({
      root: opts.primary.root,
      mode: "reset",
    });
  }
  await opts.up(opts.primary.root);
  const restored = await observe(opts.primary, opts.docker, true);
  expect({
    that: restored.observation.marker === opts.primary.marker,
    message:
      "Routed retained data must survive known-failed and completed hook stops",
  });
  await opts.check(opts.primary);
}
