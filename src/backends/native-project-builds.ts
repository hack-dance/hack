import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { childEnvironment } from "../lib/child-environment.ts";
import { ClosedCliError, HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import {
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
 * service. Restore and restart never build: they use the retained content ID or
 * refuse before any graph effect.
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
    throw refused(
      service,
      "only build context, dockerfile, target and literal args are supported."
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
  return {
    imageId: value.image_id,
    buildKey: value.build_key,
    reused: value.reused,
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

function failureCode(line: string | undefined): string | undefined {
  if (line === undefined) {
    return;
  }
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) &&
      typeof value.code === "string" &&
      ERROR_CODE.test(value.code)
      ? value.code
      : undefined;
  } catch {
    return;
  }
}

function failureMessage(line: string | undefined): string | undefined {
  try {
    const value: unknown = line === undefined ? undefined : JSON.parse(line);
    return isRecord(value) && typeof value.message === "string"
      ? value.message.slice(0, 512)
      : undefined;
  } catch {
    return;
  }
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
      const nativeCode = failureCode(held);
      throw new NativeRuntimeRequestError({
        message:
          failureMessage(held) ??
          "Native image build failed; its output is shown above.",
        nativeCode,
      });
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
 * secret value Hack manages for this project and environment (see below).
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

/** A refusal when a retained run's built image is gone: restore never builds. */
function retainedMissing(service: string): ClosedCliError {
  return new ClosedCliError(
    `The retained built image for ${service} was removed; start fresh instead of restoring. Nothing was built.`
  );
}

/**
 * Build (or reuse) every admitted build service in the selected profiles and pin it to
 * its content ID. As with Compose `up`, a build service outside the selected profiles
 * is neither built nor pinned: it keeps its `build` declaration, which review accepts
 * for inactive services, so restore and restart never need an image for it. Identical
 * declarations build once. Retained content IDs always win, and a restore with a
 * missing retained image refuses instead of building.
 */
export async function buildNativeProjectImages(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly branch: string | null | undefined;
  readonly profiles: readonly string[];
  readonly builds: ReadonlyMap<string, NativeBuildRequest>;
  readonly specs: Record<string, Record<string, unknown>>;
  readonly retainedImages: ReadonlyMap<string, string>;
  readonly restore: boolean;
  readonly rebuild: boolean;
  readonly signal: AbortSignal;
  readonly invoke?: typeof invokeNativeBuild;
}): Promise<void> {
  const pending = pendingBuilds(opts);
  if (pending.size === 0) {
    return;
  }
  await runPendingBuilds({ ...opts, pending });
}

type PendingBuild = { request: NativeBuildRequest; services: string[] };

/** Pin retained images, refuse a restore without one, and group identical builds. */
function pendingBuilds(opts: {
  readonly profiles: readonly string[];
  readonly builds: ReadonlyMap<string, NativeBuildRequest>;
  readonly specs: Record<string, Record<string, unknown>>;
  readonly retainedImages: ReadonlyMap<string, string>;
  readonly restore: boolean;
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
    const retained = opts.retainedImages.get(service);
    if (retained !== undefined) {
      pin(spec, retained);
      continue;
    }
    // A retained run selects retained images only while its configuration is
    // unchanged; then a build service without one refuses instead of building.
    if (opts.restore && opts.retainedImages.size > 0) {
      throw retainedMissing(service);
    }
    const identity = JSON.stringify([
      request.context,
      request.dockerfile,
      request.target,
      Object.entries(request.args).sort(([a], [b]) => (a < b ? -1 : 1)),
    ]);
    const entry = pending.get(identity) ?? { request, services: [] };
    entry.services.push(service);
    pending.set(identity, entry);
  }
  return pending;
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
}): Promise<void> {
  const invoke = opts.invoke ?? invokeNativeBuild;
  // The runtime requires the exact canonical root; it also derives the namespace.
  const projectRoot = await realpath(opts.projectRoot);
  const directory = await mkdtemp(join(tmpdir(), "hack-native-build-"));
  try {
    let index = 0;
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
      // The request carries argument values; remove it as soon as it is consumed.
      await rm(requestFile, { force: true });
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
 * source policy says so and what to change; any other runtime failure keeps its
 * message. The native code is kept for callers that classify failures.
 * Cancellation and closed client errors carry no service-specific cause and pass
 * through unchanged.
 */
function nameBuildFailure(
  services: readonly string[],
  error: unknown
): unknown {
  if (!(error instanceof NativeRuntimeRequestError)) {
    return error;
  }
  const which = serviceList(services);
  const code = error.nativeCode;
  const change =
    code !== undefined && Object.hasOwn(BUILD_SOURCE_POLICY, code)
      ? BUILD_SOURCE_POLICY[code]
      : undefined;
  const message =
    change === undefined
      ? `Native foreground up could not build ${which}: ${error.message}`
      : `Native foreground up cannot build ${which}: the native build source policy refused it. ${error.message} ${change} No image was adopted.`;
  return new NativeRuntimeRequestError({
    message,
    nativeCode: error.nativeCode,
    nativeCauseCode: error.nativeCauseCode,
    nativeStopFailures: error.nativeStopFailures,
  });
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
