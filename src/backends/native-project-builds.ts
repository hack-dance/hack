import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
const BUILD_KEYS = new Set(["context", "dockerfile", "target", "args"]);
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

/** Fixed refusal for a `build:` service while native builds are not enabled. */
export const NATIVE_BUILDS_DISABLED_REFUSAL =
  "Native foreground up builds Compose build services only with HACK_NATIVE_BUILDS=1; set it to build them in the native runtime. No hook, VM or build was started.";

function refused(detail: string): HackCliError {
  return new HackCliError({
    code: "E_NATIVE_PROJECT_UNSUPPORTED",
    message: `Native foreground up cannot build this service: ${detail} Values were omitted; no hook, VM or build was started.`,
  });
}

function literal(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("$")) {
    throw refused(
      `${what} must be a literal non-empty string without Compose interpolation.`
    );
  }
  return value;
}

function argumentEntries(value: unknown): [string, unknown][] {
  if (isRecord(value)) {
    return Object.entries(value);
  }
  if (!Array.isArray(value)) {
    throw refused("build args must be a mapping or a list.");
  }
  return value.map((item: unknown): [string, unknown] => {
    if (typeof item !== "string" || !item.includes("=")) {
      throw refused(
        "list-form build args must be KEY=VALUE literals; inheriting a host variable is not supported."
      );
    }
    const equal = item.indexOf("=");
    return [item.slice(0, equal), item.slice(equal + 1)];
  });
}

function buildArguments(value: unknown): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  const entries = argumentEntries(value);
  if (entries.length > MAX_ARGS) {
    throw refused("a native build accepts at most 64 build args.");
  }
  const result: Record<string, string> = {};
  for (const [name, raw] of entries) {
    if (!ARGUMENT.test(name) || Object.hasOwn(result, name)) {
      throw refused("build arg names must be unique identifiers.");
    }
    const text =
      typeof raw === "number" && Number.isFinite(raw) ? String(raw) : raw;
    if (typeof text !== "string" || text.includes("$")) {
      // Env-derived values would be baked into image history.
      throw refused(
        "build arg values must be literal strings or numbers; interpolation and null values are not supported."
      );
    }
    result[name] = text;
  }
  return result;
}

/** The declared build fields with Compose defaults, before path checks. */
function buildFields(build: unknown): NativeBuildRequest {
  if (typeof build === "string") {
    return {
      context: literal(build, "the build context"),
      dockerfile: "Dockerfile",
      target: null,
      args: {},
    };
  }
  if (!isRecord(build)) {
    throw refused("build must be a context path or a mapping.");
  }
  if (Object.keys(build).some((key) => !BUILD_KEYS.has(key))) {
    throw refused(
      "only build context, dockerfile, target and literal args are supported."
    );
  }
  const target =
    build.target === undefined
      ? null
      : literal(build.target, "the build target");
  if (target !== null && !TARGET.test(target)) {
    throw refused("the build target must be a stage name.");
  }
  return {
    context:
      build.context === undefined
        ? "."
        : literal(build.context, "the build context"),
    dockerfile:
      build.dockerfile === undefined
        ? "Dockerfile"
        : literal(build.dockerfile, "the Dockerfile path"),
    target,
    args: buildArguments(build.args),
  };
}

/**
 * Admit one service's `build` declaration, or return `undefined` when it has none.
 * Paths follow Compose: the context is relative to the Compose file's directory and
 * the Dockerfile is relative to the context. The result is project-relative; the
 * runtime resolves it again without following symlinks.
 */
export function admitNativeProjectBuild(opts: {
  readonly service: Readonly<Record<string, unknown>>;
  readonly projectRoot: string;
  readonly composeFile: string;
}): NativeBuildRequest | undefined {
  const build = opts.service.build;
  if (build === undefined) {
    return;
  }
  if (Object.hasOwn(opts.service, "image")) {
    throw refused("a service may not declare both image and build.");
  }
  const { context, dockerfile, target, args } = buildFields(build);
  if (context.includes("://") || context.startsWith("git@")) {
    throw refused("remote build contexts are not supported.");
  }
  if (isAbsolute(dockerfile)) {
    throw refused("the Dockerfile must be relative to the build context.");
  }
  const absolute = resolve(dirname(opts.composeFile), context);
  const root = resolve(opts.projectRoot);
  const inside = relative(root, absolute);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw refused("the build context must be inside the project.");
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
    const request = admitNativeProjectBuild({ ...opts, service });
    if (request === undefined) {
      continue;
    }
    if (!opts.enabled) {
      throw new HackCliError({
        code: "E_NATIVE_PROJECT_UNSUPPORTED",
        message: NATIVE_BUILDS_DISABLED_REFUSAL,
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
      env: systemEnvironment(),
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

/** A refusal when a retained run's built image is gone: restore never builds. */
function retainedMissing(service: string): ClosedCliError {
  return new ClosedCliError(
    `The retained built image for ${service} was removed; start fresh instead of restoring. Nothing was built.`
  );
}

/**
 * Build (or reuse) every admitted build service and pin it to its content ID.
 * Identical declarations build once. Retained content IDs always win, and a
 * restore with a missing retained image refuses instead of building.
 */
export async function buildNativeProjectImages(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly branch: string | null | undefined;
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

function pin(spec: Record<string, unknown>, image: string): void {
  if (!IMAGE_ID.test(image)) {
    throw new ClosedCliError(
      "Native build image selection is invalid; values omitted."
    );
  }
  spec.image = image;
  Reflect.deleteProperty(spec, "build");
}
