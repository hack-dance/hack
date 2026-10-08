import { createHash } from "node:crypto";
import { isRecord } from "../lib/guards.ts";

const HEX32 = /^[a-f0-9]{32}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const BOOT = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const CONTROL = /\p{Cc}/u;
const SERVICE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;
const PHASES = [
  "preparing",
  "ready-observed",
  "failed-retained",
  "stop-intent",
  "stopped",
  "removal-intent",
  "removed",
] as const;
type Phase = (typeof PHASES)[number];
type Condition = "started" | "healthy" | "completed";
type Observation =
  | { readonly state: "created" | "dead" }
  | {
      readonly state: "running";
      readonly health: "none" | "starting" | "healthy" | "unhealthy";
    }
  | { readonly state: "exited"; readonly code: number };

export type NativeAuthoredReview = {
  readonly provenance: {
    readonly version: 1;
    readonly kind: "native";
    readonly namespace: string;
    readonly run: string;
    readonly input: {
      readonly semantic_hash: string;
      readonly local_resolution_hash: string;
      readonly environment_policy_hash: string;
      readonly selected_profiles: readonly string[];
    };
  };
  readonly review_id: string;
};
type Resource = {
  readonly kind: "container" | "network";
  readonly key: string;
  readonly name: string;
  readonly id: string | null;
  readonly image: string | null;
  readonly phase: string;
  readonly networks?: readonly ["default"];
  readonly outbound: boolean;
};
type Terminal = {
  readonly id: string;
  readonly exit_code: number;
  readonly oom_killed: boolean;
  readonly stop_requested: boolean;
};
export type NativeAuthoredReceipt = {
  readonly version: 2;
  readonly kind: "native-graph-runtime";
  readonly owner: string;
  readonly boot: string;
  readonly review: NativeAuthoredReview;
  readonly phase: Phase;
  readonly readiness: Readonly<Record<string, Condition>>;
  readonly resources: Readonly<Record<string, Resource>>;
  readonly failure?: {
    readonly service: string;
    readonly observation: Observation;
  };
  readonly terminal?: Readonly<Record<string, Terminal>>;
};
function refused(): never {
  throw new Error(
    "Native authored graph response is invalid or changed; values omitted."
  );
}
function fields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every(
      (key) => required.includes(key) || optional.includes(key)
    )
  );
}
function hash(value: unknown): value is string {
  return typeof value === "string" && HEX64.test(value);
}
function utf8Order(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
function profiles(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= 64 &&
    Buffer.byteLength(JSON.stringify(value)) <= 4096 &&
    value.every(
      (name, index) =>
        typeof name === "string" &&
        name.isWellFormed() &&
        name.length > 0 &&
        Buffer.byteLength(name) <= 256 &&
        !CONTROL.test(name) &&
        (index === 0 || utf8Order(value[index - 1], name) < 0)
    )
  );
}

/** Closed native hash-only wire. Parsing does not grant provider or cleanup authority. */
export function parseNativeAuthoredReview(
  value: unknown
): NativeAuthoredReview {
  if (
    !(
      fields(value, ["provenance", "review_id"]) &&
      hash(value.review_id) &&
      fields(value.provenance, ["version", "kind", "namespace", "run", "input"])
    )
  ) {
    return refused();
  }
  const provenance = value.provenance;
  const input = provenance.input;
  if (
    provenance.version !== 1 ||
    provenance.kind !== "native" ||
    !hash(provenance.namespace) ||
    typeof provenance.run !== "string" ||
    !HEX32.test(provenance.run) ||
    !fields(input, [
      "semantic_hash",
      "local_resolution_hash",
      "environment_policy_hash",
      "selected_profiles",
    ]) ||
    !hash(input.semantic_hash) ||
    !hash(input.local_resolution_hash) ||
    !hash(input.environment_policy_hash) ||
    !profiles(input.selected_profiles)
  ) {
    return refused();
  }
  const review: NativeAuthoredReview = {
    provenance: {
      version: 1,
      kind: "native",
      namespace: provenance.namespace,
      run: provenance.run,
      input: {
        semantic_hash: input.semantic_hash,
        local_resolution_hash: input.local_resolution_hash,
        environment_policy_hash: input.environment_policy_hash,
        selected_profiles: [...input.selected_profiles],
      },
    },
    review_id: value.review_id,
  };
  const identity = createHash("sha256")
    .update("hack.native-graph-review/v1\0")
    .update(JSON.stringify(review.provenance))
    .digest("hex");
  if (identity !== review.review_id) {
    return refused();
  }
  return review;
}
function observation(value: unknown): Observation {
  if (
    fields(value, ["state"]) &&
    (value.state === "created" || value.state === "dead")
  ) {
    return { state: value.state };
  }
  if (
    fields(value, ["state", "code"]) &&
    value.state === "exited" &&
    typeof value.code === "number" &&
    Number.isSafeInteger(value.code)
  ) {
    return { state: "exited", code: value.code };
  }
  if (
    fields(value, ["state", "health"]) &&
    value.state === "running" &&
    (value.health === "none" ||
      value.health === "starting" ||
      value.health === "healthy" ||
      value.health === "unhealthy")
  ) {
    return { state: "running", health: value.health };
  }
  return refused();
}
function condition(value: unknown): value is Condition {
  return value === "started" || value === "healthy" || value === "completed";
}
function phase(value: unknown): value is Phase {
  return PHASES.some((allowed) => allowed === value);
}
function resource(
  value: unknown,
  run: string,
  service?: { readonly name: string; readonly index: number }
): Resource {
  if (
    !fields(
      value,
      ["kind", "key", "name", "id", "image", "phase"],
      ["networks", "outbound", "routing", "cache", "cache_provenance"]
    ) ||
    (value.id !== null && !hash(value.id)) ||
    typeof value.phase !== "string" ||
    ["routing", "cache", "cache_provenance"].some(
      (key) => value[key] !== undefined && value[key] !== null
    )
  ) {
    return refused();
  }
  if (service) {
    if (
      value.kind !== "container" ||
      value.key !== service.name ||
      value.name !== `hkn-${run}-container-${service.index}` ||
      typeof value.image !== "string" ||
      !IMAGE.test(value.image) ||
      !Array.isArray(value.networks) ||
      value.networks.length !== 1 ||
      value.networks[0] !== "default" ||
      (value.outbound !== undefined && value.outbound !== false) ||
      ![
        "reserved",
        "create-intent",
        "created",
        "start-intent",
        "started",
        "uncertain",
        "stop-intent",
        "stopped",
        "remove-intent",
        "removed",
      ].includes(value.phase)
    ) {
      return refused();
    }
    if (
      (["created", "start-intent", "started", "stopped"].includes(
        value.phase
      ) &&
        value.id === null) ||
      (value.phase === "reserved" && value.id !== null)
    ) {
      return refused();
    }
    return {
      kind: "container",
      key: service.name,
      name: value.name,
      id: value.id,
      image: value.image,
      phase: value.phase,
      networks: ["default"],
      outbound: false,
    };
  }
  if (
    value.kind !== "network" ||
    value.key !== "default" ||
    value.name !== `hkn-${run}-network-0` ||
    value.image !== null ||
    (value.networks !== undefined && value.networks !== null) ||
    value.outbound !== true ||
    ![
      "reserved",
      "create-intent",
      "created",
      "uncertain",
      "remove-intent",
      "removed",
    ].includes(value.phase) ||
    (value.phase === "created" && value.id === null) ||
    (value.phase === "reserved" && value.id !== null)
  ) {
    return refused();
  }
  return {
    kind: "network",
    key: "default",
    name: value.name,
    id: value.id,
    image: null,
    phase: value.phase,
    outbound: true,
  };
}

/** Native v2 remains disjoint from legacy Compose receipts and their plan IDs. */
export function parseNativeAuthoredReceipt(
  value: unknown
): NativeAuthoredReceipt {
  if (
    !fields(
      value,
      [
        "version",
        "kind",
        "owner",
        "boot",
        "review",
        "phase",
        "readiness",
        "resources",
      ],
      ["failure", "terminal"]
    ) ||
    value.version !== 2 ||
    value.kind !== "native-graph-runtime" ||
    typeof value.owner !== "string" ||
    !HEX32.test(value.owner) ||
    typeof value.boot !== "string" ||
    !BOOT.test(value.boot) ||
    !phase(value.phase) ||
    !isRecord(value.readiness) ||
    !isRecord(value.resources)
  ) {
    return refused();
  }
  const review = parseNativeAuthoredReview(value.review);
  const declaredReadiness = value.readiness;
  const declaredResources = value.resources;
  const names = Object.keys(declaredReadiness).sort(utf8Order);
  const requiredResources = [
    "network:default",
    ...names.map((name) => `container:${name}`),
  ];
  if (
    names.length === 0 ||
    names.length > 32 ||
    requiredResources.length !== Object.keys(declaredResources).length ||
    !requiredResources.every((key) => Object.hasOwn(declaredResources, key))
  ) {
    return refused();
  }
  const readiness = Object.fromEntries(
    names.map((name): [string, Condition] => {
      const selected = declaredReadiness[name];
      if (!(SERVICE.test(name) && condition(selected))) {
        return refused();
      }
      return [name, selected];
    })
  );
  const resourceEntries: [string, Resource][] = [
    [
      "network:default",
      resource(declaredResources["network:default"], review.provenance.run),
    ],
    ...names.map((name, index): [string, Resource] => [
      `container:${name}`,
      resource(declaredResources[`container:${name}`], review.provenance.run, {
        name,
        index,
      }),
    ]),
  ];
  const resources = Object.fromEntries(resourceEntries);
  const ids = Object.values(resources).flatMap((item) =>
    item.id === null ? [] : [item.id]
  );
  if (
    new Set(ids).size !== ids.length ||
    (value.phase === "ready-observed" &&
      Object.values(resources).some(
        (item) =>
          item.id === null ||
          item.phase !== (item.kind === "network" ? "created" : "started")
      )) ||
    (value.phase === "removed" &&
      Object.values(resources).some((item) => item.phase !== "removed"))
  ) {
    return refused();
  }
  const failure = Object.hasOwn(value, "failure")
    ? parseFailure(value.failure, readiness)
    : undefined;
  const terminal = Object.hasOwn(value, "terminal")
    ? parseTerminal(value.terminal, resources)
    : undefined;
  return {
    version: 2,
    kind: "native-graph-runtime",
    owner: value.owner,
    boot: value.boot,
    review,
    phase: value.phase,
    readiness,
    resources,
    ...(failure ? { failure } : {}),
    ...(terminal ? { terminal } : {}),
  };
}
function parseFailure(
  value: unknown,
  readiness: Readonly<Record<string, Condition>>
): NonNullable<NativeAuthoredReceipt["failure"]> {
  if (
    !fields(value, ["service", "observation"]) ||
    typeof value.service !== "string" ||
    !Object.hasOwn(readiness, value.service)
  ) {
    return refused();
  }
  const observed = observation(value.observation);
  if (
    !(
      observed.state === "dead" ||
      (observed.state === "running" && observed.health === "unhealthy") ||
      (observed.state === "exited" && observed.code !== 0)
    )
  ) {
    return refused();
  }
  return { service: value.service, observation: observed };
}
function parseTerminal(
  value: unknown,
  resources: Readonly<Record<string, Resource>>
): Readonly<Record<string, Terminal>> {
  if (
    !isRecord(value) ||
    Object.keys(value).length > Object.keys(resources).length - 1
  ) {
    return refused();
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]): [string, Terminal] => {
      const bound = Object.hasOwn(resources, key) ? resources[key] : undefined;
      if (
        !bound ||
        bound.kind !== "container" ||
        !fields(item, ["id", "exit_code", "oom_killed", "stop_requested"]) ||
        !hash(item.id) ||
        item.id !== bound.id ||
        typeof item.exit_code !== "number" ||
        !Number.isInteger(item.exit_code) ||
        item.exit_code < 0 ||
        item.exit_code > 255 ||
        typeof item.oom_killed !== "boolean" ||
        typeof item.stop_requested !== "boolean"
      ) {
        return refused();
      }
      return [
        key,
        {
          id: item.id,
          exit_code: item.exit_code,
          oom_killed: item.oom_killed,
          stop_requested: item.stop_requested,
        },
      ];
    })
  );
}

/** Compare admitted identity only; observations and cleanup phases may advance. */
export function nativeAuthoredReceiptBinding(
  receipt: NativeAuthoredReceipt
): string {
  return JSON.stringify({
    owner: receipt.owner,
    boot: receipt.boot,
    review: receipt.review,
    readiness: receipt.readiness,
    resources: Object.fromEntries(
      Object.entries(receipt.resources).map(([key, item]) => [
        key,
        {
          kind: item.kind,
          key: item.key,
          name: item.name,
          id: item.id,
          image: item.image,
          networks: item.networks,
          outbound: item.outbound,
        },
      ])
    ),
  });
}
export function parseNativeAuthoredReady(
  value: unknown,
  expected: NativeAuthoredReview
): NativeAuthoredReceipt {
  if (
    !fields(value, ["version", "kind", "run", "review", "receipt"]) ||
    value.version !== 2 ||
    value.kind !== "native-graph-foreground-ready" ||
    value.run !== expected.provenance.run ||
    value.review !== expected.review_id
  ) {
    return refused();
  }
  const receipt = parseNativeAuthoredReceipt(value.receipt);
  if (
    receipt.phase !== "ready-observed" ||
    JSON.stringify(receipt.review) !== JSON.stringify(expected)
  ) {
    return refused();
  }
  return receipt;
}

/** Authenticate through Rust first; this codec binds a successful reply to its caller's selection. */
export function parseNativeAuthoredControl(
  value: unknown,
  expected: NativeAuthoredReceipt,
  action: "status" | "cleanup"
): {
  readonly receipt: NativeAuthoredReceipt;
  readonly observations?: Readonly<Record<string, Observation | null>>;
} {
  if (
    !fields(value, ["version", "kind", "run", "review", "result"]) ||
    value.version !== 2 ||
    value.kind !== "native-graph-control-reply" ||
    value.run !== expected.review.provenance.run ||
    value.review !== expected.review.review_id
  ) {
    return refused();
  }
  const result = value.result;
  if (
    action === "cleanup" &&
    fields(result, ["outcome", "receipt"]) &&
    result.outcome === "cleaned"
  ) {
    const receipt = parseNativeAuthoredReceipt(result.receipt);
    if (
      receipt.phase !== "removed" ||
      nativeAuthoredReceiptBinding(receipt) !==
        nativeAuthoredReceiptBinding(expected)
    ) {
      return refused();
    }
    return { receipt };
  }
  if (
    action !== "status" ||
    !fields(result, ["outcome", "snapshot"]) ||
    result.outcome !== "status"
  ) {
    return refused();
  }
  return parseNativeAuthoredSnapshot({
    value: result.snapshot,
    expectedReview: expected.review,
    admitted: expected,
  });
}

/** A direct native inspection remains runtime-authenticated; this parser binds its exact review and optional admitted membership. */
export function parseNativeAuthoredSnapshot(opts: {
  readonly value: unknown;
  readonly expectedReview: NativeAuthoredReview;
  readonly admitted?: NativeAuthoredReceipt;
}): {
  readonly receipt: NativeAuthoredReceipt;
  readonly observations: Readonly<Record<string, Observation | null>>;
} {
  const value = opts.value;
  if (
    !(
      fields(value, ["receipt", "observations"]) && isRecord(value.observations)
    )
  ) {
    return refused();
  }
  const receipt = parseNativeAuthoredReceipt(value.receipt);
  const observations = value.observations;
  if (
    JSON.stringify(receipt.review) !== JSON.stringify(opts.expectedReview) ||
    (opts.admitted !== undefined &&
      nativeAuthoredReceiptBinding(receipt) !==
        nativeAuthoredReceiptBinding(opts.admitted)) ||
    Object.keys(observations).sort(utf8Order).join("\0") !==
      Object.keys(receipt.readiness).sort(utf8Order).join("\0")
  ) {
    return refused();
  }
  return {
    receipt,
    observations: Object.fromEntries(
      Object.entries(observations).map(([name, item]) => [
        name,
        item === null ? null : observation(item),
      ])
    ),
  };
}
