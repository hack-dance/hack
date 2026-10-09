import { createHash } from "node:crypto";
import { isRecord } from "../lib/guards.ts";
import {
  type NativePersistentMount,
  type NativePersistentReference,
  type NativePersistentTool,
  parseNativePersistentData,
  parseNativePersistentTool,
} from "./native-authored-persistent-data-protocol.ts";

const HEX32 = /^[a-f0-9]{32}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const BOOT = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const CONTROL = /\p{Cc}/u;
const SERVICE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;
const NETWORK = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
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
  readonly networks?: readonly string[];
  readonly outbound: boolean;
};
type Terminal = {
  readonly id: string;
  readonly exit_code: number;
  readonly oom_killed: boolean;
  readonly stop_requested: boolean;
};
type NativeSourceAnchor = {
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly kind: "file" | "directory";
};
type NativeSourceBinding = {
  readonly version: 1;
  readonly policy: "host-mounted";
  readonly share: {
    readonly project: string;
    readonly guest_path: string;
    readonly device: number;
    readonly inode: number;
    readonly unfiltered_source: true;
  };
  readonly mounts: Readonly<
    Record<string, { readonly source: string; readonly target: string }>
  >;
  readonly anchors: Readonly<Record<string, NativeSourceAnchor>>;
};
type NativeTopology = {
  readonly networks: Readonly<Record<string, boolean>>;
  readonly attachments: Readonly<
    Record<string, Readonly<Record<string, readonly string[]>>>
  >;
};
type NativeAuthoredInventory = {
  readonly kind: "native-graph-runtime";
  readonly owner: string;
  readonly boot: string;
  readonly review: NativeAuthoredReview;
  readonly phase: Phase;
  readonly readiness: Readonly<Record<string, Condition>>;
  readonly resources: Readonly<Record<string, Resource>>;
  readonly topology?: NativeTopology;
  readonly data_tool?: NativePersistentTool;
  readonly data?: Readonly<Record<string, NativePersistentReference>>;
  readonly data_mounts?: Readonly<
    Record<string, readonly NativePersistentMount[]>
  >;
  readonly failure?: {
    readonly service: string;
    readonly observation: Observation;
  };
  readonly terminal?: Readonly<Record<string, Terminal>>;
};
export type NativeAuthoredReceipt = NativeAuthoredInventory &
  (
    | { readonly version: 2; readonly source?: never }
    | { readonly version: 3; readonly source: NativeSourceBinding }
    | { readonly version: 4; readonly source?: never }
    | {
        readonly version: 5;
        readonly source?: never;
        readonly topology: NativeTopology;
      }
  );
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
function unsigned(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function relativeSource(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.isWellFormed() &&
    Buffer.byteLength(value) <= 4096 &&
    !CONTROL.test(value) &&
    (value === "." ||
      (value.length > 0 &&
        value
          .split("/")
          .every((part) => part.length > 0 && part !== "." && part !== "..")))
  );
}
function absoluteSource(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.isWellFormed() &&
    value.startsWith("/") &&
    Buffer.byteLength(value) <= 4096 &&
    !CONTROL.test(value) &&
    (value === "/" ||
      value
        .slice(1)
        .split("/")
        .every((part) => part.length > 0 && part !== "." && part !== ".."))
  );
}
function sourceAnchor(value: unknown): NativeSourceAnchor {
  if (
    !(
      fields(value, ["device", "inode", "mode", "uid", "gid", "kind"]) &&
      unsigned(value.device) &&
      unsigned(value.inode)
    ) ||
    value.inode === 0 ||
    !unsigned(value.mode) ||
    value.mode > 0xff_ff ||
    !unsigned(value.uid) ||
    value.uid > 0xff_ff_ff_ff ||
    !unsigned(value.gid) ||
    value.gid > 0xff_ff_ff_ff ||
    (value.mode & 0o022) !== 0 ||
    !(
      (value.kind === "file" &&
        (value.mode & 0o17_0000) === 0o10_0000 &&
        (value.mode & 0o400) !== 0) ||
      (value.kind === "directory" &&
        (value.mode & 0o17_0000) === 0o04_0000 &&
        (value.mode & 0o500) === 0o500)
    )
  ) {
    return refused();
  }
  return {
    device: value.device,
    inode: value.inode,
    mode: value.mode,
    uid: value.uid,
    gid: value.gid,
    kind: value.kind,
  };
}
function sourceBinding(
  value: unknown,
  services: readonly string[]
): NativeSourceBinding {
  if (
    !fields(value, ["version", "policy", "share", "mounts", "anchors"]) ||
    value.version !== 1 ||
    value.policy !== "host-mounted" ||
    !fields(value.share, [
      "project",
      "guest_path",
      "device",
      "inode",
      "unfiltered_source",
    ]) ||
    !absoluteSource(value.share.project) ||
    value.share.project.includes(":") ||
    !unsigned(value.share.device) ||
    !unsigned(value.share.inode) ||
    value.share.inode === 0 ||
    value.share.unfiltered_source !== true ||
    value.share.guest_path !==
      `/mnt/hack-projects/${createHash("sha256").update(value.share.project).digest("hex")}` ||
    !isRecord(value.mounts) ||
    !isRecord(value.anchors)
  ) {
    return refused();
  }
  const declared = Object.keys(value.mounts).sort(utf8Order);
  const declaredMounts = value.mounts;
  const declaredAnchors = value.anchors;
  if (
    declared.length === 0 ||
    declared.length > services.length ||
    declared.some((name) => !services.includes(name))
  ) {
    return refused();
  }
  const required = new Set(["."]);
  const mounts = Object.fromEntries(
    declared.map((name) => {
      const mount = declaredMounts[name];
      if (
        !(
          fields(mount, ["source", "target"]) &&
          relativeSource(mount.source) &&
          absoluteSource(mount.target)
        )
      ) {
        return refused();
      }
      if (mount.source !== ".") {
        const parts = mount.source.split("/");
        for (let length = 1; length <= parts.length; length += 1) {
          required.add(parts.slice(0, length).join("/"));
        }
      }
      return [name, { source: mount.source, target: mount.target }];
    })
  );
  const anchors = Object.fromEntries(
    Object.keys(declaredAnchors)
      .sort(utf8Order)
      .map((name) => {
        if (!required.has(name)) {
          return refused();
        }
        return [name, sourceAnchor(declaredAnchors[name])];
      })
  );
  const root = anchors["."];
  if (
    Object.keys(anchors).length !== required.size ||
    root === undefined ||
    root.kind !== "directory" ||
    root.device !== value.share.device ||
    root.inode !== value.share.inode ||
    Object.values(anchors).some((anchor) => anchor.uid !== root.uid) ||
    [...required].some(
      (path) =>
        path !== "." &&
        Object.values(mounts).some((mount) =>
          mount.source.startsWith(`${path}/`)
        ) &&
        anchors[path]?.kind !== "directory"
    )
  ) {
    return refused();
  }
  return {
    version: 1,
    policy: "host-mounted",
    share: {
      project: value.share.project,
      guest_path: value.share.guest_path,
      device: value.share.device,
      inode: value.share.inode,
      unfiltered_source: true,
    },
    mounts,
    anchors,
  };
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
  service?: {
    readonly name: string;
    readonly index: number;
    readonly networks: readonly string[];
  },
  network: {
    readonly name: string;
    readonly index: number;
    readonly internal: boolean;
  } = { name: "default", index: 0, internal: false }
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
      value.networks.length !== service.networks.length ||
      !service.networks.every(
        (name, index) => (value.networks as unknown[])[index] === name
      ) ||
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
      networks: [...service.networks],
      outbound: false,
    };
  }
  if (
    value.kind !== "network" ||
    value.key !== network.name ||
    value.name !== `hkn-${run}-network-${network.index}` ||
    value.image !== null ||
    (value.networks !== undefined && value.networks !== null) ||
    // Rust omits false on serialization; an omitted internal policy is false.
    (value.outbound === undefined ? false : value.outbound) !==
      !network.internal ||
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
    key: network.name,
    name: value.name,
    id: value.id,
    image: null,
    phase: value.phase,
    outbound: !network.internal,
  };
}

function topology(value: unknown, services: readonly string[]): NativeTopology {
  if (
    !(
      fields(value, ["networks", "attachments"]) &&
      isRecord(value.networks) &&
      isRecord(value.attachments)
    )
  ) {
    return refused();
  }
  const declaredNetworks = value.networks as Record<string, unknown>;
  const declaredAttachments = value.attachments as Record<string, unknown>;
  const logical = Object.keys(declaredNetworks).sort(utf8Order);
  if (
    logical.length !== 2 ||
    logical.some(
      (name) =>
        !NETWORK.test(name) ||
        name === "default" ||
        name === "ingress" ||
        typeof declaredNetworks[name] !== "boolean"
    ) ||
    logical.filter((name) => declaredNetworks[name] === true).length !== 1 ||
    Object.keys(declaredAttachments).length !== services.length ||
    services.some((service) => !Object.hasOwn(declaredAttachments, service))
  ) {
    return refused();
  }
  const used = new Set<string>();
  const aliases = new Set<string>();
  const attachments = Object.fromEntries(
    services.map((service) => {
      const selected = declaredAttachments[service];
      if (
        !isRecord(selected) ||
        Object.keys(selected).length === 0 ||
        Object.keys(selected).some((name) => !logical.includes(name))
      ) {
        return refused();
      }
      return [
        service,
        Object.fromEntries(
          Object.keys(selected)
            .sort(utf8Order)
            .map((name) => {
              const raw = selected[name];
              if (
                !Array.isArray(raw) ||
                raw.some(
                  (alias) =>
                    typeof alias !== "string" ||
                    !NETWORK.test(alias) ||
                    services.includes(alias) ||
                    aliases.has(`${name}\0${alias}`)
                ) ||
                raw.some(
                  (alias, index) =>
                    index > 0 && utf8Order(raw[index - 1], alias) >= 0
                )
              ) {
                return refused();
              }
              used.add(name);
              for (const alias of raw) {
                aliases.add(`${name}\0${alias}`);
              }
              return [name, [...raw]];
            })
        ),
      ];
    })
  );
  if (used.size !== 2) {
    return refused();
  }
  return {
    networks: Object.fromEntries(
      logical.map((name) => [name, declaredNetworks[name] as boolean])
    ),
    attachments,
  };
}

type ReceiptEnvelope = Record<string, unknown> & {
  readonly version: 2 | 3 | 4 | 5;
  readonly owner: string;
  readonly boot: string;
  readonly phase: Phase;
  readonly readiness: Record<string, unknown>;
  readonly resources: Record<string, unknown>;
};
function receiptEnvelope(value: unknown): value is ReceiptEnvelope {
  return (
    fields(
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
      [
        "failure",
        "terminal",
        "source",
        "data",
        "data_mounts",
        "data_tool",
        "topology",
      ]
    ) &&
    (value.version === 2 ||
      value.version === 3 ||
      value.version === 4 ||
      value.version === 5) &&
    (value.version === 3
      ? Object.hasOwn(value, "source")
      : !Object.hasOwn(value, "source")) &&
    (value.version === 5) === Object.hasOwn(value, "topology") &&
    value.kind === "native-graph-runtime" &&
    typeof value.owner === "string" &&
    HEX32.test(value.owner) &&
    typeof value.boot === "string" &&
    BOOT.test(value.boot) &&
    phase(value.phase) &&
    isRecord(value.readiness) &&
    isRecord(value.resources)
  );
}

function receiptResources(opts: {
  readonly declared: Record<string, unknown>;
  readonly names: readonly string[];
  readonly selectedTopology: NativeTopology | undefined;
  readonly run: string;
  readonly phase: Phase;
}): Readonly<Record<string, Resource>> {
  const {
    declared: declaredResources,
    names,
    selectedTopology,
    run,
    phase,
  } = opts;
  const networkNames = selectedTopology
    ? Object.keys(selectedTopology.networks).sort(utf8Order)
    : ["default"];
  const requiredResources = [
    ...networkNames.map((name) => `network:${name}`),
    ...names.map((name) => `container:${name}`),
  ];
  if (
    requiredResources.length !== Object.keys(declaredResources).length ||
    !requiredResources.every((key) => Object.hasOwn(declaredResources, key))
  ) {
    return refused();
  }
  const resourceEntries: [string, Resource][] = [
    ...networkNames.map((name, index): [string, Resource] => [
      `network:${name}`,
      resource(declaredResources[`network:${name}`], run, undefined, {
        name,
        index,
        internal: selectedTopology?.networks[name] ?? false,
      }),
    ]),
    ...names.map((name, index): [string, Resource] => [
      `container:${name}`,
      resource(declaredResources[`container:${name}`], run, {
        name,
        index,
        networks: selectedTopology
          ? Object.keys(selectedTopology.attachments[name] ?? {}).sort(
              utf8Order
            )
          : ["default"],
      }),
    ]),
  ];
  const resources = Object.fromEntries(resourceEntries);
  const ids = Object.values(resources).flatMap((item) =>
    item.id === null ? [] : [item.id]
  );
  if (
    new Set(ids).size !== ids.length ||
    (phase === "ready-observed" &&
      Object.values(resources).some(
        (item) =>
          item.id === null ||
          item.phase !== (item.kind === "network" ? "created" : "started")
      )) ||
    (phase === "removed" &&
      Object.values(resources).some((item) => item.phase !== "removed"))
  ) {
    return refused();
  }
  return resources;
}

function receiptData(opts: {
  readonly value: ReceiptEnvelope;
  readonly review: NativeAuthoredReview;
  readonly names: readonly string[];
  readonly resources: Readonly<Record<string, Resource>>;
}): ReturnType<typeof parseNativePersistentData> | undefined {
  const { value, review, names, resources } = opts;
  const hasData =
    Object.hasOwn(value, "data") || Object.hasOwn(value, "data_mounts");
  if (
    (value.version !== 4 && (hasData || Object.hasOwn(value, "data_tool"))) ||
    (value.version === 4 && !hasData)
  ) {
    return refused();
  }
  if (value.version !== 4) {
    return undefined;
  }
  return parseNativePersistentData({
    data: value.data,
    mounts: value.data_mounts,
    namespace: review.provenance.namespace,
    owner: value.owner,
    boot: value.boot,
    workloads: names,
    enrolled:
      value.phase === "ready-observed" ||
      Object.values(resources).some(
        (resource) => resource.kind === "container" && resource.id !== null
      ),
  });
}

/** Closed image-only v2, live-source v3, persistent-intent v4 and two-bridge v5 remain distinct. */
export function parseNativeAuthoredReceipt(
  value: unknown
): NativeAuthoredReceipt {
  if (!receiptEnvelope(value)) {
    return refused();
  }
  const review = parseNativeAuthoredReview(value.review);
  const names = Object.keys(value.readiness).sort(utf8Order);
  if (names.length === 0 || names.length > 32) {
    return refused();
  }
  const readiness = Object.fromEntries(
    names.map((name): [string, Condition] => {
      const selected = value.readiness[name];
      if (!(SERVICE.test(name) && condition(selected))) {
        return refused();
      }
      return [name, selected];
    })
  );
  const selectedTopology =
    value.version === 5 ? topology(value.topology, names) : undefined;
  const resources = receiptResources({
    declared: value.resources,
    names,
    selectedTopology,
    run: review.provenance.run,
    phase: value.phase,
  });
  const failure = Object.hasOwn(value, "failure")
    ? parseFailure(value.failure, readiness)
    : undefined;
  const terminal = Object.hasOwn(value, "terminal")
    ? parseTerminal(value.terminal, resources)
    : undefined;
  const data = receiptData({ value, review, names, resources });
  const tool = parseReceiptTool({ value, resources });
  const common: NativeAuthoredInventory = {
    kind: "native-graph-runtime",
    owner: value.owner,
    boot: value.boot,
    review,
    phase: value.phase,
    readiness,
    resources,
    ...(selectedTopology ? { topology: selectedTopology } : {}),
    ...data,
    ...(tool ? { data_tool: tool } : {}),
    ...(failure ? { failure } : {}),
    ...(terminal ? { terminal } : {}),
  };
  if (value.version === 3) {
    return {
      version: 3,
      ...common,
      source: sourceBinding(value.source, names),
    };
  }
  if (value.version === 5 && selectedTopology) {
    return { version: 5, ...common, topology: selectedTopology };
  }
  if (value.version === 2) {
    return { version: 2, ...common };
  }
  if (value.version === 4) {
    return { version: 4, ...common };
  }
  return refused();
}
function parseReceiptTool(opts: {
  readonly value: Record<string, unknown>;
  readonly resources: Readonly<Record<string, Resource>>;
}): NativePersistentTool | undefined {
  const tool = Object.hasOwn(opts.value, "data_tool")
    ? parseNativePersistentTool(opts.value.data_tool)
    : undefined;
  if (
    tool &&
    (opts.value.phase === "ready-observed" ||
      Object.values(opts.resources).some(
        (item) => item.kind === "container" && item.id !== null
      )) &&
    tool.helper === null
  ) {
    return refused();
  }
  return tool;
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
    ...(receipt.version === 3 ? { version: 3, source: receipt.source } : {}),
    ...(receipt.version === 4
      ? {
          version: 4,
          data: receipt.data,
          data_mounts: receipt.data_mounts,
          ...(receipt.data_tool ? { data_tool: receipt.data_tool } : {}),
        }
      : {}),
    ...(receipt.version === 5
      ? { version: 5, topology: receipt.topology }
      : {}),
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
