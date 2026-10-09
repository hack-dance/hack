import { posix } from "node:path";
import type {
  EnvironmentBinding,
  Plan,
  PullPolicy,
  Workload,
} from "../../packages/config-compiler/generated/native-config.ts";
import { isRecord } from "./guards.ts";
import {
  type NativeComposeFileProjection,
  nativeComposeFileProjectionMatches,
} from "./native-compose-file-owner.ts";
import { NATIVE_COMPOSE_FILES_EXTENSION } from "./native-compose-file-state.ts";
import { selectNativeComposeBeforeHooks } from "./native-compose-host-contract.ts";
import {
  NativeComposeNetworkError,
  type NativeComposeNetworks,
  nativeComposeWorkloadsShareNetwork,
  prepareNativeComposeNetworks,
} from "./native-compose-networks.ts";
import {
  type NativeComposeRouting,
  planNativeComposeRouting,
} from "./native-compose-routing.ts";
import type { NativeConfigDiagnostic } from "./native-config-compiler.ts";
import {
  parseNativeEndpointReference,
  parseNativeHostBindingTarget,
} from "./native-endpoint-plan-protocol.ts";
import {
  type NativeDeclaredWorkloads,
  type NativeEnvironmentPlan,
  parseNativeEnvironmentPlan,
} from "./native-env-plan-protocol.ts";
import {
  type NativeFilePlan,
  nativeFilePlanIsValid,
  nativeFilePlanningRequired,
} from "./native-file-plan-protocol.ts";
import { nativeProcessPlanIsValid } from "./native-process-plan-protocol.ts";

const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;

/** The renderer and pre-hook admission select the same physical storage name. */
export function nativeComposeStorageVolumeName(opts: {
  readonly runtimeIdentity: string;
  readonly storage: string;
}): string {
  return `hack-${opts.runtimeIdentity.length}-${opts.runtimeIdentity}-${opts.storage.length}-${opts.storage}`;
}
const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]*$/;
const OWNER_TOKEN = /^[0-9a-f]{32}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MANAGED_KEY = /^[A-Z_][A-Z0-9_]*$/;
const OVERLAY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MILLISECONDS = /^[1-9]\d*ms$/;
const WHITESPACE = /\s/;
const PLAN_FIELDS = {
  plan_version: true,
  name: true,
  source: true,
  environment: true,
  worktree: true,
  host: true,
  routes: true,
  open: true,
  host_bindings: true,
  selected_profiles: true,
  storage: true,
  networks: true,
  configs: true,
  secrets: true,
  services: true,
  jobs: true,
} satisfies Record<keyof Plan, true>;
const WORKLOAD_FIELDS = {
  image: true,
  build: true,
  pull_policy: true,
  command: true,
  entrypoint: true,
  init: true,
  shutdown: true,
  restart: true,
  working_directory: true,
  mounts: true,
  networks: true,
  environment: true,
  depends_on: true,
  profiles: true,
  readiness: true,
} satisfies Record<keyof Workload, true>;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
type Workloads = Record<string, Record<string, unknown>>;
type RenderContext = {
  readonly root: string;
  readonly labels: JsonObject;
  readonly services: Workloads;
  readonly jobs: Workloads;
  readonly storage: Record<string, unknown>;
  readonly networks: NativeComposeNetworks;
  readonly profiles: readonly string[];
  readonly routing: NativeComposeRouting | null;
  readonly files?: NativeFilePlan;
};
type PreparedCompose = {
  readonly context: RenderContext;
  readonly env: NativeEnvironmentPlan;
  readonly names: readonly string[];
  readonly sourceRoot: string;
};

/** Fixed failures never include authored strings, supplied values, or a partial private document. */
export class NativeComposeRenderError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("Native Compose rendering refused; no document was produced.");
    this.name = "NativeComposeRenderError";
    this.code = code;
  }
}

export type PrivateNativeComposeDocument = {
  readonly name: string;
  readonly services: Readonly<Record<string, JsonObject>>;
  readonly volumes: Readonly<Record<string, JsonObject>>;
  readonly networks: Readonly<Record<string, JsonObject>>;
};

export type PrivateNativeComposeRender = {
  readonly renderVersion: 1;
  /** Contains private runtime values. Never log, hash into a public plan, or publish it. */
  readonly document: PrivateNativeComposeDocument;
  readonly json: string;
  /** The execution owner must pass these profiles explicitly, never inherit COMPOSE_PROFILES. */
  readonly profiles: readonly string[];
  readonly sourceRoot: string;
};

export type NativeComposeInputs = {
  readonly plan: Readonly<Plan> | Readonly<Record<string, unknown>>;
  readonly environmentPlan: unknown;
  readonly projectRoot: string;
  readonly runtimeIdentity: string;
  /** Persisted private-store owner token, never a content hash or credential. */
  readonly ownerToken: string;
  /** Owner-generated random token, never a hash derived from secret values or input contents. */
  readonly generationIdentity: string;
  readonly routingResolution?: unknown;
  readonly declaredWorkloads?: NativeDeclaredWorkloads;
  readonly filePlan?: NativeFilePlan;
  /** Actual private owner projection, already encoded once for literal Compose delivery. */
  readonly fileProjection?: NativeComposeFileProjection;
  /** The command owner journals and executes the supported finite before-hook sequence. */
  readonly beforeHooksOwned?: boolean;
};

/**
 * Refuse unsupported plans before private value delivery. This uses the final renderer's shared
 * validators but returns no document and substitutes no values. Baseline-presence checks still
 * require actual owner-supplied values during final rendering. This is not a freshness receipt.
 */
export function assertNativeComposeSupported(opts: NativeComposeInputs): void {
  renderSelected(prepare(opts));
}

/**
 * Lower an already successful Rust plan with complete metadata binding into one private document.
 * The caller owns verified checkout identity, baseline value delivery and all runtime effects.
 * Runtime shape checks protect this effect-free boundary; Rust remains authored acceptance owner.
 * Dollars are escaped once for normal Compose interpolation. Use the returned JSON as exactly one
 * generated file without authored overrides, includes, env files or ambient profile selection.
 */
export function renderNativeCompose(
  opts: NativeComposeInputs & {
    readonly managedValues: unknown;
  }
): PrivateNativeComposeRender {
  const prepared = prepare(opts);
  if (prepared.context.files) {
    assert(
      opts.fileProjection &&
        nativeComposeFileProjectionMatches({
          ...opts,
          projection: opts.fileProjection,
          filePlan: opts.filePlan,
        }),
      "E_COMPOSE_FILE_OWNER"
    );
  } else {
    assert(opts.fileProjection === undefined, "E_COMPOSE_FILE_OWNER");
  }
  const privateValues = managedValues(opts.managedValues, prepared.names);
  const rendered = renderSelected(prepared, privateValues);
  const resourceLabels = {
    "io.hack.native-config.version": "1",
    "io.hack.native-config.instance": opts.runtimeIdentity,
    "io.hack.native-config.owner": opts.ownerToken,
  };
  const volumes = Object.fromEntries(
    Object.keys(prepared.context.storage)
      .sort()
      .map((name) => [
        name,
        {
          name: nativeComposeStorageVolumeName({ runtimeIdentity: opts.runtimeIdentity, storage: name }),
          labels: {
            ...resourceLabels,
            "io.hack.native-config.storage": name,
          },
        },
      ])
  );
  const document = {
    name: opts.runtimeIdentity,
    services: Object.fromEntries(
      Object.entries(rendered).map(([name, fields]) => {
        const selected = escapedObject(fields);
        const binds = opts.fileProjection?.workloads[name];
        if (binds?.length) {
          assert(
            selected.volumes === undefined || Array.isArray(selected.volumes),
            "E_COMPOSE_MOUNT"
          );
          selected.volumes = [
            ...(selected.volumes ?? []),
            ...binds.map((bind) => ({ ...bind, bind: { ...bind.bind } })),
          ];
        }
        return [name, selected];
      })
    ),
    volumes,
    networks: {
      ...prepared.context.networks.definitions,
      ...(prepared.context.routing
        ? {
            ingress: { name: prepared.context.routing.network, external: true },
          }
        : {}),
    },
    ...(opts.fileProjection
      ? { [NATIVE_COMPOSE_FILES_EXTENSION]: opts.fileProjection.reference }
      : {}),
  };
  return {
    renderVersion: 1,
    document,
    json: `${JSON.stringify(document, null, 2)}\n`,
    profiles: prepared.context.profiles,
    sourceRoot: prepared.sourceRoot,
  };
}

function prepare(opts: NativeComposeInputs): PreparedCompose {
  const plan: unknown = opts.plan;
  assert(isRecord(plan), "E_COMPOSE_PLAN");
  closed(plan, Object.keys(PLAN_FIELDS));
  assert(plan.plan_version === 1 && named(plan.name), "E_COMPOSE_PLAN");
  assert(canonicalAbsolute(opts.projectRoot), "E_COMPOSE_ROOT");
  assert(PROJECT_NAME.test(opts.runtimeIdentity), "E_COMPOSE_IDENTITY");
  assert(OWNER_TOKEN.test(opts.ownerToken), "E_COMPOSE_IDENTITY");
  assert(OWNER_TOKEN.test(opts.generationIdentity), "E_COMPOSE_IDENTITY");
  const source = record(plan.source);
  closed(source, ["root", "mode"]);
  assert(source.mode === "host-mounted", "E_COMPOSE_SOURCE");
  const sourceRoot = anchor(opts.projectRoot, source.root);
  settings(plan);
  assert(
    !(Object.hasOwn(plan, "routes") || Object.hasOwn(plan, "open")) ||
      opts.routingResolution !== undefined,
    "E_COMPOSE_ROUTING_OWNER"
  );
  const routing = planNativeComposeRouting({
    plan,
    resolution: opts.routingResolution,
    declared: opts.declaredWorkloads,
  });
  const files = filePlanning(opts, plan);
  unsupportedOwners(plan, opts.beforeHooksOwned === true, files !== undefined);
  const services = workloadMap(plan.services);
  const jobs = workloadMap(plan.jobs);
  assert(
    Object.keys(services).every((name) => !Object.hasOwn(jobs, name)),
    "E_COMPOSE_NAMESPACE"
  );
  const declared = Object.fromEntries([
    ...Object.keys(services).map((name) => [name, "service"] as const),
    ...Object.keys(jobs).map((name) => [name, "job"] as const),
  ]);
  assert(nativeProcessPlanIsValid({ plan, declared }), "E_COMPOSE_PROCESS");
  const profiles = names(plan.selected_profiles);
  const storage = record(plan.storage);
  validateStorage(storage);
  let networks: NativeComposeNetworks;
  try {
    networks = prepareNativeComposeNetworks({
      plan,
      workloads: { ...services, ...jobs },
      runtimeIdentity: opts.runtimeIdentity,
      labels: {
        "io.hack.native-config.version": "1",
        "io.hack.native-config.instance": opts.runtimeIdentity,
        "io.hack.native-config.owner": opts.ownerToken,
      },
    });
  } catch (error: unknown) {
    if (error instanceof NativeComposeNetworkError) {
      throw new NativeComposeRenderError("E_COMPOSE_NETWORK");
    }
    throw error;
  }
  const env = environmentPlan(
    opts.environmentPlan,
    opts.beforeHooksOwned === true
  );
  const allNames = [...Object.keys(services), ...Object.keys(jobs)].sort();
  assert(sameKeys(env.workloads, allNames), "E_COMPOSE_ENV_NAMESPACE");
  const context = {
    root: opts.projectRoot,
    labels: {
      "io.hack.native-config.version": "1",
      "io.hack.native-config.instance": opts.runtimeIdentity,
      "io.hack.native-config.owner": opts.ownerToken,
      "io.hack.native-config.generation": opts.generationIdentity,
    },
    services,
    jobs,
    storage,
    networks,
    profiles,
    routing,
    files,
  };
  return { context, env, names: allNames, sourceRoot };
}

function renderSelected(
  prepared: PreparedCompose,
  privateValues?: Readonly<Record<string, Readonly<Record<string, string>>>>
): Record<string, JsonObject> {
  const { context, env } = prepared;
  return Object.fromEntries(
    prepared.names.map((name) => {
      const { services, jobs } = context;
      const workload = Object.hasOwn(services, name)
        ? services[name]
        : jobs[name];
      assert(workload !== undefined, "E_COMPOSE_NAMESPACE");
      const bindings = env.workloads[name];
      const values = privateValues?.[name];
      assert(bindings !== undefined, "E_COMPOSE_ENV_NAMESPACE");
      if (privateValues !== undefined) {
        assert(values !== undefined, "E_COMPOSE_ENV_NAMESPACE");
      }
      return [
        name,
        renderWorkload({
          workload,
          name,
          kind: Object.hasOwn(services, name) ? "service" : "job",
          context,
          bindings,
          values,
        }),
      ];
    })
  );
}

function assert(value: unknown, code: string): asserts value {
  if (!value) {
    throw new NativeComposeRenderError(code);
  }
}

function record(value: unknown): Record<string, unknown> {
  assert(isRecord(value), "E_COMPOSE_SHAPE");
  return value;
}

function closed(
  value: Record<string, unknown>,
  fields: readonly string[]
): void {
  assert(
    Object.keys(value).every((key) => fields.includes(key)),
    "E_COMPOSE_UNKNOWN_FIELD"
  );
}

function text(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0");
}

function named(value: unknown): value is string {
  return typeof value === "string" && NAME.test(value);
}

function names(value: unknown): string[] {
  assert(Array.isArray(value) && value.every(named), "E_COMPOSE_NAMES");
  assert(new Set(value).size === value.length, "E_COMPOSE_NAMES");
  return [...value].sort();
}

function sameKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function canonicalAbsolute(value: unknown): value is string {
  return (
    text(value) &&
    value.startsWith("/") &&
    (value === "/" || !value.endsWith("/")) &&
    !value.includes("\\") &&
    posix.normalize(value) === value &&
    !value.split("/").includes("..")
  );
}

function canonicalRelative(value: unknown): value is string {
  return (
    text(value) &&
    value.length > 0 &&
    !value.endsWith("/") &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes(":") &&
    !value.split("/").includes("..") &&
    posix.normalize(value) === value
  );
}

function anchor(root: string, relative: unknown): string {
  assert(canonicalRelative(relative), "E_COMPOSE_PATH");
  return posix.join(root, relative);
}

function settings(plan: Record<string, unknown>): void {
  const selection = record(plan.environment);
  closed(selection, ["default_overlay"]);
  if (Object.hasOwn(selection, "default_overlay")) {
    assert(
      typeof selection.default_overlay === "string" &&
        OVERLAY.test(selection.default_overlay),
      "E_COMPOSE_PLAN"
    );
  }
  const policy = record(plan.worktree);
  closed(policy, ["auto_branch", "inherit_local"]);
  assert(
    typeof policy.auto_branch === "boolean" &&
      typeof policy.inherit_local === "boolean",
    "E_COMPOSE_PLAN"
  );
}

function filePlanning(
  opts: NativeComposeInputs,
  plan: Record<string, unknown>
): NativeFilePlan | undefined {
  if (!nativeFilePlanningRequired(plan)) {
    assert(opts.filePlan === undefined, "E_COMPOSE_FILE_OWNER");
    return undefined;
  }
  assert(
    nativeFilePlanIsValid({ plan, declared: opts.declaredWorkloads }) &&
      opts.filePlan?.complete === true &&
      opts.filePlan.plan_version === 1,
    "E_COMPOSE_FILE_OWNER"
  );
  for (const workloads of [plan.services, plan.jobs]) {
    assert(isRecord(workloads), "E_COMPOSE_NAMESPACE");
    assert(
      Object.values(workloads).every(
        (workload) => isRecord(workload) && !Object.hasOwn(workload, "build")
      ),
      "E_COMPOSE_FILE_OWNER"
    );
  }
  return opts.filePlan;
}
function unsupportedOwners(
  plan: Record<string, unknown>,
  beforeHooksOwned: boolean,
  filePlanning: boolean
): void {
  assert(
    filePlanning ||
      !(Object.hasOwn(plan, "configs") || Object.hasOwn(plan, "secrets")),
    "E_COMPOSE_FILE_OWNER"
  );
  if (Object.hasOwn(plan, "host")) {
    if (beforeHooksOwned) {
      selectNativeComposeBeforeHooks(plan);
    } else {
      assertNoHostHooks(plan.host);
    }
  }
  if (Object.hasOwn(plan, "host_bindings")) {
    for (const [name, target] of Object.entries(record(plan.host_bindings))) {
      assert(
        named(name) && parseNativeHostBindingTarget(target),
        "E_COMPOSE_ENDPOINT"
      );
    }
  }
}
function assertNoHostHooks(value: unknown): void {
  const host = record(value);
  closed(host, ["up", "down", "processes"]);
  for (const phase of ["up", "down"]) {
    if (Object.hasOwn(host, phase)) {
      const hooks = record(host[phase]);
      closed(hooks, ["before", "after"]);
      for (const entries of Object.values(hooks)) {
        assert(
          Array.isArray(entries) && entries.length === 0,
          "E_COMPOSE_HOST_OWNER"
        );
      }
    }
  }
  if (Object.hasOwn(host, "processes")) {
    assert(
      Object.keys(record(host.processes)).length === 0,
      "E_COMPOSE_HOST_OWNER"
    );
  }
}

function workloadMap(value: unknown): Workloads {
  return Object.fromEntries(
    Object.entries(record(value)).map(([name, workload]) => {
      assert(named(name), "E_COMPOSE_NAMESPACE");
      const fields = record(workload);
      closed(fields, Object.keys(WORKLOAD_FIELDS));
      return [name, fields];
    })
  );
}

function validateStorage(storage: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(storage)) {
    assert(named(name), "E_COMPOSE_STORAGE");
    const declaration = record(value);
    closed(declaration, ["kind", "scope"]);
    assert(
      declaration.kind === "persistent" && declaration.scope === "worktree",
      "E_COMPOSE_STORAGE"
    );
  }
}

function environmentPlan(
  value: unknown,
  beforeHooksOwned: boolean
): NativeEnvironmentPlan {
  const env = parseNativeEnvironmentPlan({
    value,
    parseDiagnostic,
  });
  assert(
    env?.complete && env.diagnostics.length === 0,
    "E_COMPOSE_ENV_INCOMPLETE"
  );
  assert(
    beforeHooksOwned ||
      env.host === undefined ||
      Object.keys(env.host).length === 0,
    "E_COMPOSE_HOST_OWNER"
  );
  return env;
}

function parseDiagnostic(value: unknown): NativeConfigDiagnostic {
  const diagnostic = record(value);
  closed(diagnostic, [
    "code",
    "pointer",
    "message",
    "line",
    "column",
    "document",
  ]);
  const { code, pointer, message, line, column, document } = diagnostic;
  assert(
    text(code) &&
      text(pointer) &&
      text(message) &&
      positiveU32(line) &&
      positiveU32(column),
    "E_COMPOSE_ENV_DIAGNOSTIC"
  );
  assert(
    document === "project" ||
      document === "primary_local" ||
      document === "checkout_local" ||
      document === "request",
    "E_COMPOSE_ENV_DIAGNOSTIC"
  );
  return { code, pointer, message, line, column, document };
}

function managedValues(
  value: unknown,
  workloads: readonly string[]
): Record<string, Record<string, string>> {
  const supplied = record(value);
  assert(sameKeys(supplied, workloads), "E_COMPOSE_VALUES_NAMESPACE");
  return Object.fromEntries(
    workloads.map((name) => {
      const values = record(supplied[name]);
      return [
        name,
        Object.fromEntries(
          Object.entries(values).map(([key, entry]) => {
            assert(
              MANAGED_KEY.test(key) && text(entry),
              "E_COMPOSE_PRIVATE_VALUE"
            );
            return [key, entry];
          })
        ),
      ];
    })
  );
}

function renderWorkload(opts: {
  readonly workload: Record<string, unknown>;
  readonly name: string;
  readonly kind: "service" | "job";
  readonly context: RenderContext;
  readonly bindings: Readonly<Record<string, Readonly<EnvironmentBinding>>>;
  readonly values?: Readonly<Record<string, string>>;
}): JsonObject {
  const { workload, context } = opts;
  const routingLabels = context.routing?.labels[opts.name];
  const output: JsonObject = {
    labels: {
      ...context.labels,
      "io.hack.native-config.workload": opts.kind,
      ...(routingLabels ?? {}),
    },
  };
  const attachments = context.networks.workloads[opts.name];
  if (attachments) {
    const selectedNetworks: JsonObject = Object.fromEntries(
      Object.entries(attachments).map(([name, attachment]) => [
        name,
        { ...(attachment.aliases ? { aliases: [...attachment.aliases] } : {}) },
      ])
    );
    if (routingLabels) {
      selectedNetworks.ingress = {};
    }
    output.networks = selectedNetworks;
  } else if (routingLabels) {
    output.networks = ["default", "ingress"];
  }
  acquisition(workload, output, context.root);
  if (Object.hasOwn(workload, "command")) {
    output.command = command(workload.command, false);
  }
  if (Object.hasOwn(workload, "entrypoint")) {
    assert(Object.hasOwn(workload, "command"), "E_COMPOSE_IMAGE_COMMAND_OWNER");
    output.entrypoint = command(workload.entrypoint, true);
  }
  processPolicy(workload, output);
  if (Object.hasOwn(workload, "working_directory")) {
    assert(canonicalAbsolute(workload.working_directory), "E_COMPOSE_PATH");
    output.working_dir = workload.working_directory;
  }
  const profiles = names(optionalField(workload, "profiles", []));
  assert(
    profiles.length === 0 ||
      profiles.some((profile) => context.profiles.includes(profile)),
    "E_COMPOSE_PROFILE"
  );
  if (profiles.length > 0) {
    output.profiles = profiles;
  }
  const mounts = renderMounts({
    value: optionalField(workload, "mounts", []),
    context,
    name: opts.name,
  });
  if (mounts.length > 0) {
    output.volumes = mounts;
  }
  const dependencies = renderDependencies(
    optionalField(workload, "depends_on", []),
    context
  );
  if (Object.keys(dependencies).length > 0) {
    output.depends_on = dependencies;
  }
  if (Object.hasOwn(workload, "readiness")) {
    output.healthcheck = readiness(workload.readiness);
  }
  output.environment = renderEnvironment({
    ...opts,
    directives: optionalField(workload, "environment", {}),
  });
  return output;
}

function optionalField(
  value: Record<string, unknown>,
  name: string,
  fallback: unknown
): unknown {
  return Object.hasOwn(value, name) ? value[name] : fallback;
}

function acquisition(
  workload: Record<string, unknown>,
  output: JsonObject,
  root: string
): void {
  assert(
    Object.hasOwn(workload, "image") !== Object.hasOwn(workload, "build"),
    "E_COMPOSE_SOURCE"
  );
  if (Object.hasOwn(workload, "image")) {
    assert(
      text(workload.image) &&
        workload.image.length > 0 &&
        !WHITESPACE.test(workload.image),
      "E_COMPOSE_SOURCE"
    );
    output.image = workload.image;
  } else {
    const build = record(workload.build);
    closed(build, ["context", "dockerfile", "target"]);
    assert(
      canonicalRelative(build.dockerfile) && build.dockerfile !== ".",
      "E_COMPOSE_PATH"
    );
    const rendered: JsonObject = {
      context: anchor(root, build.context),
      dockerfile: build.dockerfile,
    };
    if (Object.hasOwn(build, "target")) {
      assert(named(build.target), "E_COMPOSE_SOURCE");
      rendered.target = build.target;
    }
    output.build = rendered;
  }
  if (Object.hasOwn(workload, "pull_policy")) {
    const policy = workload.pull_policy;
    assert(pullPolicy(policy), "E_COMPOSE_PULL_POLICY");
    assert(
      (policy === "build") === Object.hasOwn(workload, "build"),
      "E_COMPOSE_PULL_POLICY_SOURCE"
    );
    output.pull_policy = policy;
  }
}

function pullPolicy(value: unknown): value is PullPolicy {
  return (
    value === "always" ||
    value === "never" ||
    value === "missing" ||
    value === "build"
  );
}

function command(value: unknown, entrypoint: boolean): string[] {
  const tagged = record(value);
  if (Object.hasOwn(tagged, "exec")) {
    closed(tagged, ["exec"]);
    const args = tagged.exec;
    assert(Array.isArray(args) && args.every(text), "E_COMPOSE_COMMAND");
    assert(
      (entrypoint && args.length === 0) || (args.length > 0 && args[0] !== ""),
      "E_COMPOSE_COMMAND"
    );
    return [...args];
  }
  closed(tagged, ["shell"]);
  assert(text(tagged.shell) && tagged.shell.length > 0, "E_COMPOSE_COMMAND");
  return entrypoint
    ? ["/bin/sh", "-c", tagged.shell, "hack-native-entrypoint"]
    : ["/bin/sh", "-c", tagged.shell];
}

function processPolicy(
  workload: Record<string, unknown>,
  output: JsonObject
): void {
  if (Object.hasOwn(workload, "init")) {
    assert(typeof workload.init === "boolean", "E_COMPOSE_PROCESS");
    output.init = workload.init;
  }
  if (Object.hasOwn(workload, "shutdown")) {
    const shutdown = record(workload.shutdown);
    if (Object.hasOwn(shutdown, "signal")) {
      assert(text(shutdown.signal), "E_COMPOSE_PROCESS");
      output.stop_signal = shutdown.signal;
    }
    if (Object.hasOwn(shutdown, "grace")) {
      assert(text(shutdown.grace), "E_COMPOSE_PROCESS");
      output.stop_grace_period = shutdown.grace;
    }
  }
  if (Object.hasOwn(workload, "restart")) {
    const restart = record(workload.restart);
    assert(text(restart.kind), "E_COMPOSE_PROCESS");
    output.restart =
      restart.kind === "on-failure" && Object.hasOwn(restart, "max_retries")
        ? `on-failure:${restart.max_retries}`
        : restart.kind;
  }
}

function renderMounts(opts: {
  readonly value: unknown;
  readonly context: RenderContext;
  readonly name: string;
}): JsonObject[] {
  const { value, context, name } = opts;
  assert(Array.isArray(value), "E_COMPOSE_MOUNT");
  const targets = new Set<string>();
  return value.flatMap((entry) => {
    const mount = record(entry);
    assert(
      canonicalAbsolute(mount.target) && !targets.has(mount.target),
      "E_COMPOSE_MOUNT"
    );
    targets.add(mount.target);
    if (Object.hasOwn(mount, "config") || Object.hasOwn(mount, "secret")) {
      const kind = Object.hasOwn(mount, "config") ? "config" : "secret";
      closed(mount, [kind, "target", "access", "mode"]);
      assert(
        context.files && mount.access === "read-only" && mount.mode === "0444",
        "E_COMPOSE_FILE_OWNER"
      );
      assert(
        context.files.workloads[name]?.some(
          (file) =>
            file.kind === kind &&
            file.name === mount[kind] &&
            file.target === mount.target &&
            file.mode === "0444" &&
            file.uid === undefined &&
            file.gid === undefined
        ),
        "E_COMPOSE_FILE_OWNER"
      );
      return [];
    }
    assert(
      mount.access === "read-only" || mount.access === "read-write",
      "E_COMPOSE_MOUNT"
    );
    const common = {
      target: mount.target,
      read_only: mount.access === "read-only",
    };
    if (Object.hasOwn(mount, "source")) {
      closed(mount, ["source", "target", "access"]);
      return {
        type: "bind",
        source: anchor(context.root, mount.source),
        ...common,
        bind: { create_host_path: false },
      };
    }
    closed(mount, ["storage", "target", "access"]);
    assert(
      named(mount.storage) && Object.hasOwn(context.storage, mount.storage),
      "E_COMPOSE_STORAGE"
    );
    return { type: "volume", source: mount.storage, ...common };
  });
}

function renderDependencies(
  value: unknown,
  context: RenderContext
): JsonObject {
  assert(Array.isArray(value), "E_COMPOSE_DEPENDENCY");
  const result: JsonObject = {};
  for (const entry of value) {
    const dep = record(entry);
    const service = Object.hasOwn(dep, "service");
    closed(dep, [service ? "service" : "job", "condition"]);
    const name = service ? dep.service : dep.job;
    assert(named(name) && !Object.hasOwn(result, name), "E_COMPOSE_DEPENDENCY");
    const namespace = service ? context.services : context.jobs;
    assert(Object.hasOwn(namespace, name), "E_COMPOSE_DEPENDENCY");
    const target = namespace[name];
    assert(target !== undefined, "E_COMPOSE_DEPENDENCY");
    if (service) {
      assert(
        dep.condition === "started" || dep.condition === "ready",
        "E_COMPOSE_DEPENDENCY"
      );
      if (dep.condition === "ready") {
        assert(
          Object.hasOwn(target, "readiness"),
          "E_COMPOSE_DEPENDENCY_READINESS"
        );
        readiness(target.readiness);
      }
    } else {
      assert(dep.condition === "completed", "E_COMPOSE_DEPENDENCY");
    }
    const serviceCondition =
      dep.condition === "ready" ? "service_healthy" : "service_started";
    result[name] = {
      condition: service ? serviceCondition : "service_completed_successfully",
    };
  }
  return result;
}

function readiness(value: unknown): JsonObject {
  const check = record(value);
  assert(check.kind === "exec", "E_COMPOSE_READINESS_UNSUPPORTED");
  closed(check, ["kind", "command", "interval", "timeout", "retries"]);
  assert(
    milliseconds(check.interval) &&
      milliseconds(check.timeout) &&
      positiveU32(check.retries),
    "E_COMPOSE_READINESS"
  );
  return {
    test: ["CMD", ...command(check.command, false)],
    interval: check.interval,
    timeout: check.timeout,
    retries: check.retries,
  };
}

function positiveU32(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= 4_294_967_295
  );
}

function milliseconds(value: unknown): value is string {
  return (
    typeof value === "string" &&
    MILLISECONDS.test(value) &&
    positiveU32(Number(value.slice(0, -2)))
  );
}

function renderEnvironment(opts: {
  readonly name: string;
  readonly context: RenderContext;
  readonly bindings: Readonly<Record<string, Readonly<EnvironmentBinding>>>;
  readonly values?: Readonly<Record<string, string>>;
  readonly directives: unknown;
}): JsonObject {
  return resolveNativeComposeEnvironment({
    bindings: opts.bindings,
    values: opts.values,
    directives: opts.directives,
    scopeNames: ["global", opts.name],
    endpointValue: (binding) => endpoint(binding, opts.context, opts.name),
  });
}

/** Shared effective binding checks; owners supply only the selected baseline and endpoint policy. */
export function resolveNativeComposeEnvironment(opts: {
  readonly bindings: Readonly<Record<string, Readonly<EnvironmentBinding>>>;
  readonly values?: Readonly<Record<string, string>>;
  readonly directives: unknown;
  readonly scopeNames: readonly string[];
  readonly endpointValue: (
    binding: Extract<EnvironmentBinding, { kind: "endpoint" }>
  ) => string;
}): Record<string, string> {
  const directives = record(opts.directives);
  for (const [key, directive] of Object.entries(directives)) {
    assert(ENV_KEY.test(key), "E_COMPOSE_ENV");
    const binding = Object.hasOwn(opts.bindings, key)
      ? opts.bindings[key]
      : undefined;
    const fields = record(directive);
    verifyDirective(key, fields, binding);
    if (opts.values !== undefined) {
      verifyBaseline(key, fields, opts.values, binding);
    }
  }
  const entries: [string, string][] = [];
  for (const key of Object.keys(opts.bindings).sort()) {
    const binding = opts.bindings[key];
    assert(binding !== undefined, "E_COMPOSE_ENV");
    if (binding.kind === "managed") {
      if (!Object.hasOwn(directives, key)) {
        assert(binding.key === key, "E_COMPOSE_ENV_MISMATCH");
      }
      assert(opts.scopeNames.includes(binding.scope), "E_COMPOSE_ENV_SCOPE");
      if (opts.values === undefined) {
        continue;
      }
      assert(
        Object.hasOwn(opts.values, binding.key),
        "E_COMPOSE_MISSING_VALUE"
      );
      const value = opts.values[binding.key];
      assert(value !== undefined, "E_COMPOSE_MISSING_VALUE");
      entries.push([key, value]);
    } else if (binding.kind === "endpoint") {
      assert(Object.hasOwn(directives, key), "E_COMPOSE_ENV_MISMATCH");
      entries.push([key, opts.endpointValue(binding)]);
    } else {
      const authored = directives[key];
      assert(
        isRecord(authored) &&
          Object.hasOwn(authored, binding.kind) &&
          authored[binding.kind] === binding.value,
        "E_COMPOSE_ENV_MISMATCH"
      );
      assert(text(binding.value), "E_COMPOSE_ENV");
      entries.push([key, binding.value]);
    }
  }
  return Object.fromEntries(entries);
}

function verifyBaseline(
  key: string,
  directive: Record<string, unknown>,
  values: Readonly<Record<string, string>>,
  binding: Readonly<EnvironmentBinding> | undefined
): void {
  const present = Object.hasOwn(values, key);
  if (Object.hasOwn(directive, "default")) {
    assert(
      binding?.kind === (present ? "managed" : "default"),
      "E_COMPOSE_ENV_MISMATCH"
    );
  }
  if (Object.hasOwn(directive, "env_ref") && directive.env_ref !== key) {
    assert(!present, "E_COMPOSE_ENV_MISMATCH");
  }
  if (Object.hasOwn(directive, "endpoint")) {
    assert(!present, "E_COMPOSE_ENV_MISMATCH");
  }
}

function verifyDirective(
  key: string,
  directive: Record<string, unknown>,
  binding: Readonly<EnvironmentBinding> | undefined
): void {
  assert(Object.keys(directive).length === 1, "E_COMPOSE_ENV");
  if (Object.hasOwn(directive, "unset")) {
    assert(
      directive.unset === true && binding === undefined,
      "E_COMPOSE_ENV_MISMATCH"
    );
  } else if (Object.hasOwn(directive, "env_ref")) {
    assert(
      typeof directive.env_ref === "string" &&
        MANAGED_KEY.test(directive.env_ref) &&
        binding?.kind === "managed" &&
        binding.key === directive.env_ref,
      "E_COMPOSE_ENV_MISMATCH"
    );
  } else if (Object.hasOwn(directive, "endpoint")) {
    const reference = parseNativeEndpointReference(directive.endpoint);
    assert(
      reference &&
        binding?.kind === "endpoint" &&
        JSON.stringify(sortedEscaped(reference)) ===
          JSON.stringify(sortedEscaped(binding.reference)),
      "E_COMPOSE_ENV_MISMATCH"
    );
  } else if (Object.hasOwn(directive, "literal")) {
    assert(
      text(directive.literal) &&
        binding?.kind === "literal" &&
        binding.value === directive.literal,
      "E_COMPOSE_ENV_MISMATCH"
    );
  } else {
    closed(directive, ["default"]);
    assert(
      text(directive.default) &&
        binding !== undefined &&
        ((binding.kind === "managed" && binding.key === key) ||
          (binding.kind === "default" && binding.value === directive.default)),
      "E_COMPOSE_ENV_MISMATCH"
    );
  }
}

function endpoint(
  binding: Extract<EnvironmentBinding, { kind: "endpoint" }>,
  context: RenderContext,
  workload: string
): string {
  const { reference, target } = binding;
  assert(
    target.kind !== "route" && target.kind !== "host",
    "E_COMPOSE_ENDPOINT_OWNER"
  );
  assert(target.protocol !== "tcp", "E_COMPOSE_ENDPOINT_PROTOCOL");
  if (target.kind === "service") {
    assert(
      reference.kind === "service" &&
        Object.hasOwn(context.services, target.name) &&
        reference.name === target.name &&
        reference.port === target.port &&
        reference.protocol === target.protocol,
      "E_COMPOSE_ENDPOINT"
    );
    assert(
      nativeComposeWorkloadsShareNetwork(
        context.networks,
        workload,
        target.name
      ),
      "E_COMPOSE_ENDPOINT_NETWORK"
    );
    return `${target.protocol}://${target.name}:${target.port}`;
  }
  assert(reference.kind === "host_binding", "E_COMPOSE_ENDPOINT");
  return `${target.protocol}://${target.hostname}:${target.port}`;
}

function sortedEscaped(value: Json): Json {
  if (typeof value === "string") {
    return value.replaceAll("$", () => "$$");
  }
  if (Array.isArray(value)) {
    return value.map(sortedEscaped);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortedEscaped(value[key] ?? null)])
    );
  }
  return value;
}

function escapedObject(value: JsonObject): JsonObject {
  const result = sortedEscaped(value);
  assert(
    result !== null && typeof result === "object" && !Array.isArray(result),
    "E_COMPOSE_SHAPE"
  );
  return result;
}
