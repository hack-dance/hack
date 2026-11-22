import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { childEnvironment } from "../lib/child-environment.ts";
import { ClosedCliError, HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import {
  NATIVE_BUILDER_MISSING,
  NATIVE_BUILDER_NOT_PREPARED,
  type NativeBuilderCommandOptions,
  nativeBuilderRemedy,
} from "../lib/native-image-builder.ts";
import {
  nativeImagePolicyArgs,
  nativeImageRegistryReason,
} from "./native-image-policy.ts";
import {
  type invokeNativeRuntime,
  NativeRuntimeRequestError,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

/**
 * Native Compose `build:` services (feature-gated by `HACK_NATIVE_BUILDS=1`).
 *
 * Admission is pure and runs before any hook or VM effect: it accepts the Compose
 * forms the native runtime builds (`build: <context>` or a mapping of `context`,
 * `dockerfile`, `target` and literal `args`) and refuses everything else with a
 * closed, coded refusal. After the runtime is up, each distinct build runs once
 * through `runtime build-image`; the service is then pinned to the returned content
 * ID, so review, graph admission, receipts and restore treat it as an image
 * service. Every `up`, including one that restores a stopped run, asks the runtime
 * for each build: an unchanged build key reuses its image without building, a changed
 * one builds (HACK-2533). Restart resolves its builds the same way before it stops the
 * old graph, and its replacement start runs the resolved images.
 */

const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const BUILD_KEY = /^[a-f0-9]{64}$/;
const ARGUMENT = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const TARGET = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
/**
 * The Compose `build` fields native builds implement. The Compose-backend feature
 * gate admits exactly these fields when builds are enabled, so a build it lets
 * through reaches this module's own admission and secret check.
 */
export const NATIVE_BUILD_FIELDS = [
  "context",
  "dockerfile",
  "target",
  "args",
] as const;
const BUILD_KEYS: ReadonlySet<string> = new Set(NATIVE_BUILD_FIELDS);

/**
 * Compose build fields native builds do not implement, in the order a refusal
 * names them: the three users meet most, with what to change, then the rest of
 * the Compose specification's build fields. A refusal names a field only from
 * this list; any other key is authored text and is never printed.
 */
export const UNSUPPORTED_NATIVE_BUILD_FIELDS: ReadonlyMap<
  string,
  string | undefined
> = new Map([
  ["additional_contexts", "native builds read one context directory"],
  ["ssh", "SSH agent forwarding into a native build is not supported"],
  [
    "dockerfile_inline",
    "put the Dockerfile in a file inside the context and set build.dockerfile",
  ],
  ...[
    "cache_from",
    "cache_to",
    "entitlements",
    "extra_hosts",
    "isolation",
    "labels",
    "network",
    "no_cache",
    "platforms",
    "privileged",
    "pull",
    "secrets",
    "shm_size",
    "tags",
    "ulimits",
  ].map((field) => [field, undefined] as const),
]);

/**
 * The first field of a build mapping that native builds do not implement, as
 * `build.<field>` from {@link UNSUPPORTED_NATIVE_BUILD_FIELDS}, with its reason;
 * `undefined` when every key is implemented or only unknown keys remain.
 */
export function unsupportedNativeBuildField(
  build: Readonly<Record<string, unknown>>
): { readonly field: string; readonly reason?: string } | undefined {
  for (const [field, reason] of UNSUPPORTED_NATIVE_BUILD_FIELDS) {
    if (Object.hasOwn(build, field)) {
      return { field: `build.${field}`, ...(reason ? { reason } : {}) };
    }
  }
  return undefined;
}
const MAX_ARGS = 64;
/** The runtime's own budget is 30 minutes; the client waits a little longer. */
const BUILD_TIMEOUT_SECONDS = 30 * 60;
/** After SIGTERM the runtime stops its build client within ten seconds. */
const CANCEL_GRACE_MS = 20_000;
const MAX_STDOUT = 64 * 1024;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** Whether native `up` may build Compose `build:` services. */
export function nativeBuildsEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  return env.HACK_NATIVE_BUILDS === "1";
}

/** Whether `HACK_NATIVE_REBUILD=1` asks every build to run again. */
export function nativeRebuildRequested(
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  return env.HACK_NATIVE_REBUILD === "1";
}

/** One admitted build: paths relative to the project root and the context. */
export interface NativeBuildRequest {
  readonly context: string;
  readonly dockerfile: string;
  readonly target: string | null;
  /** Literal values. Never log, print or persist outside the private request file. */
  readonly args: Readonly<Record<string, string>>;
}

/** The refusal for the first `build:` service while native builds are not enabled. */
export function nativeBuildsDisabledRefusal(service: string): string {
  return `Native foreground up cannot build service ${service}: it builds Compose build services only with HACK_NATIVE_BUILDS=1; set it to build them in the native runtime. No hook, VM or build was started.`;
}

/** "service a", or "services a and b", for build refusals. */
function serviceList(services: readonly string[]): string {
  if (services.length <= 1) {
    return `service ${services[0] ?? ""}`;
  }
  return `services ${services.slice(0, -1).join(", ")} and ${services.at(-1)}`;
}

/** The admission refusal for one service. Authored values are never included. */
function refused(service: string, detail: string): HackCliError {
  return new HackCliError({
    code: "E_NATIVE_PROJECT_UNSUPPORTED",
    message: `Native foreground up cannot build service ${service}: ${detail} Values were omitted; no hook, VM or build was started.`,
  });
}

function literal(service: string, value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("$")) {
    throw refused(
      service,
      `${what} must be a literal non-empty string without Compose interpolation.`
    );
  }
  return value;
}

function argumentEntries(service: string, value: unknown): [string, unknown][] {
  if (isRecord(value)) {
    return Object.entries(value);
  }
  if (!Array.isArray(value)) {
    throw refused(service, "build args must be a mapping or a list.");
  }
  return value.map((item: unknown): [string, unknown] => {
    if (typeof item !== "string" || !item.includes("=")) {
      throw refused(
        service,
        "list-form build args must be KEY=VALUE literals; inheriting a host variable is not supported."
      );
    }
    const equal = item.indexOf("=");
    return [item.slice(0, equal), item.slice(equal + 1)];
  });
}

function buildArguments(
  service: string,
  value: unknown
): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  const entries = argumentEntries(service, value);
  if (entries.length > MAX_ARGS) {
    throw refused(service, "a native build accepts at most 64 build args.");
  }
  // A null prototype keeps every admitted name an own property, `__proto__` included.
  const result: Record<string, string> = Object.create(null);
  for (const [name, raw] of entries) {
    if (!ARGUMENT.test(name) || Object.hasOwn(result, name)) {
      throw refused(service, "build arg names must be unique identifiers.");
    }
    const text =
      typeof raw === "number" && Number.isFinite(raw) ? String(raw) : raw;
    if (typeof text !== "string" || text.includes("$")) {
      // Env-derived values would be baked into image history.
      throw refused(
        service,
        "build arg values must be literal strings or numbers; interpolation and null values are not supported."
      );
    }
    result[name] = text;
  }
  return result;
}

/** The declared build fields with Compose defaults, before path checks. */
function buildFields(service: string, build: unknown): NativeBuildRequest {
  if (typeof build === "string") {
    return {
      context: literal(service, build, "the build context"),
      dockerfile: "Dockerfile",
      target: null,
      args: {},
    };
  }
  if (!isRecord(build)) {
    throw refused(service, "build must be a context path or a mapping.");
  }
  if (Object.keys(build).some((key) => !BUILD_KEYS.has(key))) {
    const named = unsupportedNativeBuildField(build);
    throw refused(
      service,
      named
        ? `${named.field} is not supported by native builds${named.reason ? ` (${named.reason})` : ""}; only build context, dockerfile, target and literal args are supported.`
        : "only build context, dockerfile, target and literal args are supported."
    );
  }
  const target =
    build.target === undefined
      ? null
      : literal(service, build.target, "the build target");
  if (target !== null && !TARGET.test(target)) {
    throw refused(service, "the build target must be a stage name.");
  }
  return {
    context:
      build.context === undefined
        ? "."
        : literal(service, build.context, "the build context"),
    dockerfile:
      build.dockerfile === undefined
        ? "Dockerfile"
        : literal(service, build.dockerfile, "the Dockerfile path"),
    target,
    args: buildArguments(service, build.args),
  };
}

/**
 * Admit one service's `build` declaration, or return `undefined` when it has none.
 * Paths follow Compose: the context is relative to the Compose file's directory and
 * the Dockerfile is relative to the context. The result is project-relative; the
 * runtime resolves it again without following symlinks.
 */
export function admitNativeProjectBuild(opts: {
  /** The Compose service name; every refusal names it. */
  readonly name: string;
  readonly service: Readonly<Record<string, unknown>>;
  readonly projectRoot: string;
  readonly composeFile: string;
}): NativeBuildRequest | undefined {
  const build = opts.service.build;
  if (build === undefined) {
    return;
  }
  const name = opts.name;
  if (Object.hasOwn(opts.service, "image")) {
    throw refused(name, "a service may not declare both image and build.");
  }
  const { context, dockerfile, target, args } = buildFields(name, build);
  if (context.includes("://") || context.startsWith("git@")) {
    throw refused(name, "remote build contexts are not supported.");
  }
  if (isAbsolute(dockerfile)) {
    throw refused(
      name,
      "the Dockerfile must be relative to the build context."
    );
  }
  const absolute = resolve(dirname(opts.composeFile), context);
  const root = resolve(opts.projectRoot);
  const inside = relative(root, absolute);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw refused(name, "the build context must be inside the project.");
  }
  return { context: inside === "" ? "." : inside, dockerfile, target, args };
}

/**
 * Admit every build service of a normalized Compose document. Throws the closed
 * refusal for any unsupported form, and when builds are not enabled.
 */
export function admitNativeProjectBuilds(opts: {
  readonly services: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
  readonly projectRoot: string;
  readonly composeFile: string;
  readonly enabled: boolean;
}): ReadonlyMap<string, NativeBuildRequest> {
  const builds = new Map<string, NativeBuildRequest>();
  for (const [name, service] of Object.entries(opts.services)) {
    const request = admitNativeProjectBuild({ ...opts, name, service });
    if (request === undefined) {
      continue;
    }
    if (!opts.enabled) {
      throw new HackCliError({
        code: "E_NATIVE_PROJECT_UNSUPPORTED",
        message: nativeBuildsDisabledRefusal(name),
      });
    }
    builds.set(name, request);
  }
  return builds;
}

/** The result of one `runtime build-image`, checked against its closed shape. */
export interface NativeBuiltImage {
  readonly imageId: string;
  readonly buildKey: string;
  readonly reused: boolean;
  readonly baseFallbacks?: readonly string[];
  readonly baseSelections?: Readonly<Record<string, string>>;
}

function parseBuilt(value: unknown): NativeBuiltImage {
  if (
    !(
      isRecord(value) &&
      typeof value.image_id === "string" &&
      IMAGE_ID.test(value.image_id) &&
      typeof value.build_key === "string" &&
      BUILD_KEY.test(value.build_key) &&
      typeof value.reused === "boolean"
    )
  ) {
    throw new ClosedCliError(
      "Native runtime returned an invalid image build result; values omitted."
    );
  }
  const fallbacks = Array.isArray(value.base_fallbacks)
    ? value.base_fallbacks.flatMap((entry: unknown) => {
        if (
          !(
            isRecord(entry) &&
            typeof entry.reference === "string" &&
            BUILD_BASE_REFERENCE.test(entry.reference) &&
            typeof entry.resolved_at_unix_seconds === "number"
          )
        ) {
          return [];
        }
        const time = new Date(entry.resolved_at_unix_seconds * 1000);
        const reason =
          nativeImageRegistryReason(entry.fallback_reason) ??
          "registry refresh failed";
        return Number.isFinite(time.getTime())
          ? [
              `${reason}, using the loaded build base ${entry.reference} resolved ${time.toISOString()}`,
            ]
          : [];
      })
    : [];
  const selections = isRecord(value.base_selections)
    ? (Object.fromEntries(
        Object.entries(value.base_selections).filter(
          ([reference, pin]) =>
            BUILD_BASE_REFERENCE.test(reference) &&
            typeof pin === "string" &&
            BUILD_BASE_REFERENCE.test(pin) &&
            BUILD_BASE_PIN.test(pin)
        )
      ) as Record<string, string>)
    : undefined;
  return {
    imageId: value.image_id,
    buildKey: value.build_key,
    reused: value.reused,
    ...(fallbacks.length ? { baseFallbacks: fallbacks } : {}),
    ...(selections ? { baseSelections: selections } : {}),
  };
}

/**
 * Forward build output to stderr as it arrives, holding back a final structured
 * runtime error line so it can be returned instead of printed.
 */
async function forwardBuildOutput(
  stream: ReadableStream<Uint8Array>,
  write: (text: string) => void
): Promise<string | undefined> {
  const decoder = new TextDecoder();
  let pending = "";
  let held: string | undefined;
  const emit = (line: string) => {
    if (held !== undefined) {
      write(`${held}\n`);
      held = undefined;
    }
    if (line.startsWith('{"code":')) {
      held = line;
    } else {
      write(`${line}\n`);
    }
  };
  const reader = stream.getReader();
  while (true) {
    const { done, value: chunk } = await reader.read();
    if (done) {
      break;
    }
    pending += decoder.decode(chunk, { stream: true });
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      emit(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
  }
  pending += decoder.decode();
  if (pending.length > 0) {
    emit(pending);
  }
  return held;
}

const BUILD_BASE_PIN = /@sha256:[a-f0-9]{64}$/;
const BUILD_BASE_REFERENCE = /^[A-Za-z0-9._:/@-]{1,512}$/;

export class NativeBuildRegistryError extends NativeRuntimeRequestError {
  readonly reference: string;

  constructor(reference: string, causeCode: string, code = "registry_image") {
    super({
      message: `Build base ${reference} is unavailable (${nativeImageRegistryReason(causeCode)}). Retry hack up when the registry is reachable.`,
      nativeCode: code,
      nativeCauseCode: causeCode,
    });
    this.reference = reference;
  }
}

function buildFailure(line: string | undefined): NativeRuntimeRequestError {
  let value: unknown;
  if (line !== undefined) {
    try {
      value = JSON.parse(line);
    } catch {
      value = undefined;
    }
  }
  const detail = isRecord(value) ? value : {};
  const code =
    typeof detail.code === "string" && ERROR_CODE.test(detail.code)
      ? detail.code
      : undefined;
  if (
    (code?.startsWith("registry_") || code === "image_tag_offline_missing") &&
    typeof detail.cause_code === "string" &&
    nativeImageRegistryReason(detail.cause_code) &&
    typeof detail.build_base_reference === "string" &&
    BUILD_BASE_REFERENCE.test(detail.build_base_reference)
  ) {
    return new NativeBuildRegistryError(
      detail.build_base_reference,
      detail.cause_code,
      code
    );
  }
  return new NativeRuntimeRequestError({
    message:
      typeof detail.message === "string"
        ? detail.message.slice(0, 512)
        : "Native image build failed; its output is shown above.",
    nativeCode: code,
  });
}

/**
 * Run `runtime build-image` with build output streamed to stderr. Cancellation sends
 * SIGTERM so the runtime can stop its build client's process group, then SIGKILL
 * after a grace period. The request file path is the only argument; it carries the
 * argument values and is private to this invocation.
 */
export async function invokeNativeBuild(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly cwd: string;
  readonly requestFile: string;
  readonly signal?: AbortSignal;
  readonly write?: (text: string) => void;
}): Promise<NativeBuiltImage> {
  if (opts.signal?.aborted) {
    throw new ClosedCliError(
      "Native foreground up was canceled; values omitted."
    );
  }
  const child = Bun.spawn(
    [
      opts.runtime.binary,
      "--candidate-root",
      opts.runtime.home,
      "runtime",
      "build-image",
      "--request",
      opts.requestFile,
      "--json",
    ],
    {
      cwd: opts.cwd,
      env: childEnvironment(systemEnvironment()),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let canceled = false;
  const cancel = () => {
    canceled = true;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), CANCEL_GRACE_MS);
  };
  opts.signal?.addEventListener("abort", cancel, { once: true });
  const outer = setTimeout(cancel, (BUILD_TIMEOUT_SECONDS + 60) * 1000);
  try {
    const [stdout, held, code] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      forwardBuildOutput(
        child.stderr,
        opts.write ?? ((text) => process.stderr.write(text))
      ),
      child.exited,
    ]);
    if (canceled) {
      throw new ClosedCliError(
        "Native foreground up was canceled during an image build; no image was adopted."
      );
    }
    if (code !== 0) {
      throw buildFailure(held);
    }
    if (stdout.byteLength > MAX_STDOUT) {
      throw new ClosedCliError(
        "Native runtime returned an oversized image build result; values omitted."
      );
    }
    return parseBuilt(JSON.parse(new TextDecoder().decode(stdout)));
  } finally {
    opts.signal?.removeEventListener("abort", cancel);
    clearTimeout(outer);
    clearTimeout(killTimer);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
}

/** The same minimal process environment ordinary runtime requests receive. */
function systemEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "USER", "LOGNAME"]) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Whether a service runs for the selected profiles, as in Compose `up`: a service with
 * no `profiles` always runs; otherwise one of its profiles must be selected. A
 * malformed `profiles` field counts as active, so it is built and reviewed.
 */
export function nativeServiceActive(
  service: Readonly<Record<string, unknown>>,
  profiles: readonly string[]
): boolean {
  const declared = service.profiles;
  if (declared === undefined) {
    return true;
  }
  if (!Array.isArray(declared) || declared.length === 0) {
    return true;
  }
  return declared.some(
    (profile) => typeof profile === "string" && profiles.includes(profile)
  );
}

/**
 * Refuse, before any hook, VM or build effect, a build argument whose value equals a
 * secret value Hack manages for this project and environment. Build arguments are
 * not secrets (an image records them in its history), so a managed secret must not
 * travel as one. The comparison is in memory; no value is ever shown.
 */
export function refuseEmulatedBuilds(opts: {
  readonly builds: ReadonlyMap<string, NativeBuildRequest>;
  readonly amd64Emulation?: Readonly<Record<string, string>>;
}): void {
  for (const service of opts.builds.keys()) {
    if (opts.amd64Emulation?.[service] === "amd64") {
      throw refused(
        service,
        "native builds are linux/arm64 only, and the native adaptation selects amd64 emulation for it. Use prefer-native or remove it from amd64Emulation."
      );
    }
  }
}

/**
 * Refuse, before any hook, VM or build effect, a build argument whose value equals a
 * nonempty value explicitly marked secret in this project's managed env. Plain
 * env-file and shell values have no secret metadata and do not widen this guard.
 */
export function refuseManagedSecretBuildArguments(opts: {
  readonly builds: ReadonlyMap<string, NativeBuildRequest>;
  readonly managedSecretValues: readonly string[];
}): void {
  if (opts.managedSecretValues.length === 0) {
    return;
  }
  const secrets = new Set(opts.managedSecretValues.filter((v) => v !== ""));
  for (const [service, request] of opts.builds) {
    for (const [name, value] of Object.entries(request.args)) {
      if (secrets.has(value)) {
        throw new HackCliError({
          code: "E_NATIVE_PROJECT_UNSUPPORTED",
          message: `Native foreground up cannot build service ${service}: build arg ${name} equals a hack env secret value. Build args are not secrets (images record them); pass secrets with BuildKit build secrets instead, which native builds do not support yet. Values were omitted; no hook, VM or build was started.`,
        });
      }
    }
  }
}

/**
 * Build (or reuse) every admitted build service in the selected profiles and pin it to
 * its content ID; returns the pinned services. As with Compose `up`, a build service
 * outside the selected profiles is neither built nor pinned: it keeps its `build`
 * declaration, which review accepts for inactive services. Identical declarations build
 * once. A retained run's image never stands in for a build: the runtime reuses it only
 * while its build key is unchanged, so an edited Dockerfile is built after `down` too.
 */
export async function buildNativeProjectImages(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly branch: string | null | undefined;
  readonly profiles: readonly string[];
  readonly builds: ReadonlyMap<string, NativeBuildRequest>;
  readonly specs: Record<string, Record<string, unknown>>;
  readonly rebuild: boolean;
  readonly signal: AbortSignal;
  readonly invoke?: typeof invokeNativeBuild;
  /** Called once for each build the runtime actually ran (not a reused image). */
  readonly onBuilt?: () => void;
  /** One line per distinct base-image fallback; stderr when the caller gives none. */
  readonly onNotice?: (line: string) => void;
}): Promise<ReadonlySet<string>> {
  const pending = pendingBuilds(opts);
  if (pending.size > 0) {
    await runPendingBuilds({ ...opts, pending });
  }
  return new Set([...pending.values()].flatMap((entry) => entry.services));
}

/**
 * Resolve a restart's builds before anything is stopped: refuse a build argument equal
 * to a managed secret (as startup does), then ask the runtime for each active build of
 * a running service (an unchanged build key reuses its image without building; a
 * changed one builds, so a failed build refuses while the old graph still runs).
 * Returns the resolved images; the replacement start pins exactly these, so nothing is
 * built after the old graph stopped and a rebuilt image is what the new graph runs.
 */
export async function resolveNativeRestartBuilds(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly branch: string | null | undefined;
  readonly profiles: readonly string[];
  readonly builds: ReadonlyMap<string, NativeBuildRequest>;
  readonly specs: Record<string, Record<string, unknown>>;
  readonly images: ReadonlyMap<string, string>;
  readonly managedSecretValues: readonly string[];
  /** `HACK_NATIVE_REBUILD=1`: every build runs again, as on `up`. */
  readonly rebuild: boolean;
  readonly signal: AbortSignal;
  readonly invoke?: typeof invokeNativeBuild;
}): Promise<ReadonlyMap<string, NativeVerifiedBuild>> {
  refuseManagedSecretBuildArguments({
    builds: opts.builds,
    managedSecretValues: opts.managedSecretValues,
  });
  const copies: Record<string, Record<string, unknown>> = {};
  for (const service of opts.builds.keys()) {
    const spec = opts.specs[service];
    if (spec && opts.images.has(service)) {
      copies[service] = { ...spec };
    }
  }
  const builds = new Map(
    [...opts.builds].filter(([service]) => service in copies)
  );
  const pinned = await buildNativeProjectImages({
    ...opts,
    builds,
    specs: copies,
  });
  const resolved = new Map<string, NativeVerifiedBuild>();
  for (const service of pinned) {
    const image = copies[service]?.image;
    const request = builds.get(service);
    if (typeof image !== "string" || !IMAGE_ID.test(image) || !request) {
      throw new ClosedCliError(
        "Native restart build selection is invalid; nothing was stopped."
      );
    }
    resolved.set(service, {
      imageId: image,
      identity: nativeBuildIdentity(request),
    });
  }
  return resolved;
}

/**
 * Pin build services to the images a restart preflight resolved, so the replacement
 * start runs exactly those images and builds nothing after the old graph stopped.
 * Every active build service must be covered by an image resolved for the same
 * declaration; a build service added or changed between preflight and start refuses
 * instead of building. Returns the builds that still need the runtime: the inactive
 * ones (never built), or all of them when there is no restart selection.
 */
export function pinVerifiedNativeBuilds(opts: {
  readonly builds: ReadonlyMap<string, NativeBuildRequest>;
  readonly specs: Record<string, Record<string, unknown>>;
  readonly profiles: readonly string[];
  readonly verified: ReadonlyMap<string, NativeVerifiedBuild> | undefined;
}): ReadonlyMap<string, NativeBuildRequest> {
  if (opts.verified === undefined) {
    return opts.builds;
  }
  const remaining = new Map<string, NativeBuildRequest>();
  for (const [service, request] of opts.builds) {
    const spec = opts.specs[service];
    if (!(spec && nativeServiceActive(spec, opts.profiles))) {
      remaining.set(service, request);
      continue;
    }
    const verified = opts.verified.get(service);
    if (verified?.identity !== nativeBuildIdentity(request)) {
      throw new ClosedCliError(
        `The build declaration of ${service} changed during the restart; nothing was built after the old graph stopped. Run hack up to start it.`
      );
    }
    pin(spec, verified.imageId);
  }
  return remaining;
}

type PendingBuild = { request: NativeBuildRequest; services: string[] };

/** The declaration a build request stands for: identical ones build once. */
export function nativeBuildIdentity(request: NativeBuildRequest): string {
  return JSON.stringify([
    request.context,
    request.dockerfile,
    request.target,
    Object.entries(request.args).sort(([a], [b]) => (a < b ? -1 : 1)),
  ]);
}

/** A restart's resolved build image, bound to the declaration it was resolved for. */
export interface NativeVerifiedBuild {
  readonly imageId: string;
  readonly identity: string;
}

/** Group identical builds of the active build services. */
function pendingBuilds(opts: {
  readonly profiles: readonly string[];
  readonly builds: ReadonlyMap<string, NativeBuildRequest>;
  readonly specs: Record<string, Record<string, unknown>>;
}): Map<string, PendingBuild> {
  const pending = new Map<string, PendingBuild>();
  for (const [service, request] of opts.builds) {
    const spec = opts.specs[service];
    if (!spec) {
      throw new ClosedCliError(
        "Native build services changed during startup; values omitted."
      );
    }
    if (!nativeServiceActive(spec, opts.profiles)) {
      continue;
    }
    const identity = nativeBuildIdentity(request);
    const entry = pending.get(identity) ?? { request, services: [] };
    entry.services.push(service);
    pending.set(identity, entry);
  }
  return pending;
}

/** Bound on the reclamation an `up` runs after a rebuild. */
const RECLAIM_TIMEOUT_MS = 60_000;
/**
 * After a start that built at least one image is ready, remove the build images no
 * longer kept (`runtime reclaim-build-images --best-effort`: per build declaration
 * the current and one previous image, plus every image a container or retained run
 * references). Bounded, and it never fails or delays the start: the runtime reports
 * a refusal instead of failing, and any other error is dropped. Nothing is printed.
 */
export async function reclaimNativeBuildImagesAfterRebuild(opts: {
  /** Whether this start built an image; without one nothing is reclaimed. */
  readonly rebuilt: boolean;
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly invoke: typeof invokeNativeRuntime;
}): Promise<void> {
  if (!opts.rebuilt) {
    return;
  }
  await opts
    .invoke({
      runtime: opts.runtime,
      cwd: opts.projectRoot,
      args: ["runtime", "reclaim-build-images", "--best-effort", "--json"],
      timeoutMs: RECLAIM_TIMEOUT_MS,
    })
    .catch(() => undefined);
}

async function runPendingBuilds(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly branch: string | null | undefined;
  readonly pending: ReadonlyMap<string, PendingBuild>;
  readonly specs: Record<string, Record<string, unknown>>;
  readonly rebuild: boolean;
  readonly signal: AbortSignal;
  readonly invoke?: typeof invokeNativeBuild;
  readonly onBuilt?: () => void;
  readonly onNotice?: (line: string) => void;
}): Promise<void> {
  const invoke = opts.invoke ?? invokeNativeBuild;
  const imagePolicyArgs = nativeImagePolicyArgs();
  // The runtime requires the exact canonical root; it also derives the namespace.
  const projectRoot = await realpath(opts.projectRoot);
  const directory = await mkdtemp(join(tmpdir(), "hack-native-build-"));
  try {
    let index = 0;
    const notices = new Set<string>();
    const selections = new Map<string, string>();
    for (const { request, services } of opts.pending.values()) {
      if (opts.signal.aborted) {
        throw new ClosedCliError(
          "Native foreground up was canceled; values omitted."
        );
      }
      const requestFile = join(directory, `request-${index}.json`);
      index += 1;
      await writeFile(
        requestFile,
        JSON.stringify({
          version: 1,
          project_root: projectRoot,
          branch: opts.branch ?? null,
          context: request.context,
          dockerfile: request.dockerfile,
          target: request.target,
          args: request.args,
          policy: opts.rebuild ? "rebuild" : "missing",
          timeout_seconds: BUILD_TIMEOUT_SECONDS,
          image_policy_args: imagePolicyArgs,
          ...(selections.size
            ? { command_base_pins: Object.fromEntries(selections) }
            : {}),
        }),
        { mode: 0o600, flag: "wx" }
      );
      const built = await invoke({
        runtime: opts.runtime,
        cwd: opts.projectRoot,
        requestFile,
        signal: opts.signal,
      }).catch((error: unknown) => {
        throw nameBuildFailure(services, error);
      });
      for (const [reference, pin] of Object.entries(
        built.baseSelections ?? {}
      )) {
        selections.set(reference, pin);
      }
      for (const notice of built.baseFallbacks ?? []) {
        if (!notices.has(notice)) {
          notices.add(notice);
          if (opts.onNotice) {
            opts.onNotice(notice);
          } else {
            process.stderr.write(`${notice}\n`);
          }
        }
      }
      // The request carries argument values; remove it as soon as it is consumed.
      await rm(requestFile, { force: true });
      if (!built.reused) {
        opts.onBuilt?.();
      }
      for (const service of services) {
        const spec = opts.specs[service];
        if (spec) {
          pin(spec, built.imageId);
        }
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Runtime refusal codes from the native build source policy: what the runtime
 * accepts as build input and as the built image, each with what to change. The
 * runtime checks them before or right after the build; they are not failures of
 * the build itself.
 */
const BUILD_SOURCE_POLICY: Readonly<Record<string, string>> = {
  native_build_source:
    "Keep the build context and Dockerfile inside the project as regular files reached without symlinks.",
  native_build_dockerfile: "Change the Dockerfile line it names.",
  native_build_base_image:
    "Use public Docker Hub images in the Dockerfile's FROM and COPY --from.",
  native_build_argument:
    "Change the build args in the service's Compose build.",
  native_build_reserved_label:
    "Remove reserved ownership labels from the Dockerfile and its base images.",
  native_build_image_volumes:
    "Remove VOLUME from the Dockerfile and its base images; declare volumes in Compose instead.",
};

/**
 * Name the services of a failed `runtime build-image`. A refusal from the build
 * source policy says so and what to change; a home without the image builder
 * says so and how to add it, naming this install's own command; any other
 * runtime failure keeps its message. The native code is kept for callers that
 * classify failures. Cancellation and closed client errors carry no
 * service-specific cause and pass through unchanged.
 */
export async function nativeBuildBases(opts: {
  readonly projectRoot: string;
  readonly runtime: NativeRuntimeSelection;
  readonly builds: ReadonlyMap<string, NativeBuildRequest>;
  readonly invoke: typeof import("./native-runtime-client.ts").invokeNativeRuntime;
}): Promise<readonly string[]> {
  if (opts.builds.size === 0) {
    return [];
  }
  const projectRoot = await realpath(opts.projectRoot);
  const directory = await mkdtemp(join(tmpdir(), "hack-native-build-scan-"));
  const file = join(directory, "request.json");
  const bases = new Set<string>();
  try {
    for (const build of opts.builds.values()) {
      await writeFile(
        file,
        JSON.stringify({
          version: 1,
          project_root: projectRoot,
          context: build.context,
          dockerfile: build.dockerfile,
          target: build.target,
          args: build.args,
          policy: "missing",
        }),
        { mode: 0o600 }
      );
      const result = await opts.invoke({
        runtime: opts.runtime,
        cwd: opts.projectRoot,
        args: [
          "runtime",
          "build-image",
          "--request",
          file,
          "--bases",
          "--json",
        ],
      });
      if (
        !(
          Array.isArray(result) &&
          result.every(
            (item: unknown) =>
              typeof item === "string" && BUILD_BASE_REFERENCE.test(item)
          )
        )
      ) {
        throw new ClosedCliError(
          "Native runtime returned an invalid build base list."
        );
      }
      for (const reference of result) {
        bases.add(reference);
      }
    }
    return [...bases];
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function nameBuildFailure(
  services: readonly string[],
  error: unknown
): unknown {
  if (
    !(error instanceof NativeRuntimeRequestError) ||
    error instanceof NativeBuildRegistryError
  ) {
    return error;
  }
  const which = serviceList(services);
  const code = error.nativeCode;
  const change =
    code !== undefined && Object.hasOwn(BUILD_SOURCE_POLICY, code)
      ? BUILD_SOURCE_POLICY[code]
      : undefined;
  let message: string;
  if (code === NATIVE_BUILDER_NOT_PREPARED) {
    message = nativeBuilderMissingRefusal({ services });
  } else if (change === undefined) {
    message = `Native foreground up could not build ${which}: ${error.message}`;
  } else {
    message = `Native foreground up cannot build ${which}: the native build source policy refused it. ${error.message} ${change} No image was adopted.`;
  }
  return new NativeRuntimeRequestError({
    message,
    nativeCode: error.nativeCode,
    nativeCauseCode: error.nativeCauseCode,
    nativeStopFailures: error.nativeStopFailures,
  });
}

/**
 * The `hack up` refusal for a native home that has no image builder: what is
 * wrong and the one setup command that adds it, as every builder message
 * names it.
 */
export function nativeBuilderMissingRefusal(
  opts: NativeBuilderCommandOptions & { readonly services: readonly string[] }
): string {
  return `Native foreground up cannot build ${serviceList(opts.services)}: ${NATIVE_BUILDER_MISSING}. ${nativeBuilderRemedy(opts)} No image was built.`;
}

function pin(spec: Record<string, unknown>, image: string): void {
  if (!IMAGE_ID.test(image)) {
    throw new ClosedCliError(
      "Native build image selection is invalid; values omitted."
    );
  }
  spec.image = image;
  Reflect.deleteProperty(spec, "build");
}
