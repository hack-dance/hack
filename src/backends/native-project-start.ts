import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { isRecord } from "../lib/guards.ts";
import { adaptNativeAwsEnvironment } from "./native-aws-environment.ts";
import {
  acquireNativeHttpsLease,
  type NativeHttpsLeaseIdentity,
  recoverNativeHttpsLease,
} from "./native-https-owner.ts";
import { prepareNativeProjectAdaptation } from "./native-project-adaptation.ts";
import { prepareNativeProjectBranch } from "./native-project-branch.ts";
import {
  nativeSharedSourceFlags,
  nativeStartCacheSource,
} from "./native-project-cache.ts";
import {
  discoverNativeHostDependency,
  prepareNativeDependencyServices,
  readNativeHostDependencies,
} from "./native-project-dependencies.ts";
import { beginNativeProjectFinalization } from "./native-project-finalization.ts";
import { isNativeHttpsProbePath } from "./native-project-https.ts";
import {
  type NativeProjectInput,
  prepareNativeProjectInput,
} from "./native-project-input.ts";
import { inspectNativeProjectGraph } from "./native-project-inspect.ts";
import { validateNativeAllowedHosts } from "./native-project-network.ts";
import { serveNativeProjectGraph } from "./native-project-process.ts";
import { selectNativeProjectRestore } from "./native-project-restore.ts";
import { confirmedNativeRetainedGraph } from "./native-project-retained.ts";
import {
  preflightNativeRetainedStartup,
  verifyNativeResumedRetainedGraph,
  verifyNativeRetainedMapping,
} from "./native-project-retained-startup.ts";
import { withNativeProjectReview } from "./native-project-review.ts";
import {
  hasOnlyNativeSupportedLabels,
  nativeBridgeCapacity,
  reviewedNativeRoutes,
} from "./native-project-routing.ts";
import {
  loadNativeProjectRun,
  loadNativeRestartIntent,
  type NativeProjectRun,
  type NativeProjectRunScope,
  normalizeNativeProfiles,
  prepareNativeProjectRunStorage,
  removeNativeProjectRun,
  saveNativeProjectRun,
} from "./native-project-run.ts";
import {
  invokeNativeRuntime,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const SHA = /^[a-f0-9]{64}$/;
const OWNER = /^[a-f0-9]{32}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const BOOT_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export type NativeHttpsSelection = {
  readonly caddyBinary: string;
  readonly caddySha256: string;
  readonly httpsPort: number;
};
export function validateHttpsSelection(
  selection: NativeHttpsSelection | undefined
): void {
  if (
    selection &&
    (!(
      isAbsolute(selection.caddyBinary) &&
      SHA.test(selection.caddySha256) &&
      Number.isInteger(selection.httpsPort)
    ) ||
      selection.httpsPort < 1 ||
      selection.httpsPort > 65_535)
  ) {
    throw new Error(
      "Native HTTPS requires an absolute HACK_NATIVE_CADDY_BINARY, SHA256 pin and explicit HTTPS port; values omitted."
    );
  }
}
export function parseNativeHttpsSelection(
  env: Readonly<Record<string, string | undefined>>
): NativeHttpsSelection | undefined {
  const binary = env.HACK_NATIVE_CADDY_BINARY,
    hash = env.HACK_NATIVE_CADDY_SHA256,
    port = env.HACK_NATIVE_HTTPS_PORT;
  if (binary === undefined && hash === undefined && port === undefined) {
    return undefined;
  }
  if (
    binary === undefined ||
    hash === undefined ||
    port === undefined ||
    String(Number(port)) !== port
  ) {
    throw new Error(
      "Native HTTPS selection requires binary, SHA256 and port together; values omitted."
    );
  }
  const selection = {
    caddyBinary: binary,
    caddySha256: hash,
    httpsPort: Number(port),
  };
  validateHttpsSelection(selection);
  return selection;
}
/** Bind shared ingress only after the native graph has an authoritative owner. */
async function acquireReadyHttps(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly selection: NativeHttpsSelection;
  readonly run: NativeProjectRun;
  readonly signal: AbortSignal;
  readonly invoke: typeof invokeNativeRuntime;
  readonly acquire: typeof acquireNativeHttpsLease;
  readonly onIntent: (identity: NativeHttpsLeaseIdentity) => Promise<void>;
}): Promise<Awaited<ReturnType<typeof acquireNativeHttpsLease>>> {
  const pool = await opts.invoke({
    runtime: opts.runtime,
    cwd: opts.runtime.home,
    args: ["runtime", "status", "--json"],
    timeoutMs: 5000,
    signal: opts.signal,
  });
  if (
    !(
      isRecord(pool) &&
      pool.phase === "running" &&
      pool.process_alive === true &&
      typeof pool.guest_boot_id === "string" &&
      BOOT_ID.test(pool.guest_boot_id)
    )
  ) {
    throw new Error(
      "Native HTTPS requires a verified running pool incarnation."
    );
  }
  requireActiveStartup(opts.signal);
  return await opts.acquire({
    runtime: opts.runtime,
    ...opts.selection,
    pool: { owner: opts.run.owner, bootId: pool.guest_boot_id },
    lease: {
      run: opts.run.run,
      attempt: randomBytes(16).toString("hex"),
      namespace: opts.run.namespace,
      planId: opts.run.planId,
    },
    onIntent: opts.onIntent,
  });
}
export function reviewedNativeHttpsRoutes(
  plan: unknown,
  services: ReadonlySet<string>
): readonly { hostname: string; path: string; service: string }[] {
  if (!(isRecord(plan) && isRecord(plan.services))) {
    throw refused();
  }
  const names = new Map<string, { path: string; service: string }>();
  for (const name of services) {
    const service = plan.services[name];
    if (
      !(
        isRecord(service) &&
        isRecord(service.routing) &&
        Array.isArray(service.routing.hostnames) &&
        isRecord(service.healthcheck) &&
        service.healthcheck.disabled !== true &&
        isRecord(service.healthcheck.native_http) &&
        isNativeHttpsProbePath(service.healthcheck.native_http.path)
      )
    ) {
      throw refused();
    }
    for (const hostname of service.routing.hostnames) {
      if (typeof hostname !== "string") {
        throw refused();
      }
      const path = service.healthcheck.native_http.path;
      if (
        names.has(hostname) &&
        (names.get(hostname)?.path !== path ||
          names.get(hostname)?.service !== name)
      ) {
        throw refused();
      }
      names.set(hostname, { path, service: name });
    }
  }
  return [...names]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hostname, route]) => ({ hostname, ...route }));
}
type Hooks = {
  readonly cleanup: () => Promise<void>;
  readonly ready?: () => Promise<void>;
};
type Dependencies = {
  prepare: typeof prepareNativeProjectInput;
  prepareStorage: typeof prepareNativeProjectRunStorage;
  adaptAws: typeof adaptNativeAwsEnvironment;
  review: typeof withNativeProjectReview;
  serve: typeof serveNativeProjectGraph;
  https: typeof acquireNativeHttpsLease;
  recoverHttps: typeof recoverNativeHttpsLease;
  invoke: typeof invokeNativeRuntime;
  load: typeof loadNativeProjectRun;
  loadRestart: typeof loadNativeRestartIntent;
  save: typeof saveNativeProjectRun;
  remove: typeof removeNativeProjectRun;
  finalization: typeof beginNativeProjectFinalization;
};
const DEFAULTS: Dependencies = {
  prepare: prepareNativeProjectInput,
  prepareStorage: prepareNativeProjectRunStorage,
  adaptAws: adaptNativeAwsEnvironment,
  review: withNativeProjectReview,
  serve: serveNativeProjectGraph,
  https: acquireNativeHttpsLease,
  recoverHttps: recoverNativeHttpsLease,
  invoke: invokeNativeRuntime,
  load: loadNativeProjectRun,
  loadRestart: loadNativeRestartIntent,
  save: saveNativeProjectRun,
  remove: removeNativeProjectRun,
  finalization: beginNativeProjectFinalization,
};
function refused(): Error {
  return new Error(
    "Native foreground up cannot admit this configuration: routing, host dependencies, builds or unsupported runtime settings require explicit native support; configuration was not dropped."
  );
}

function requireActiveStartup(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw refused();
  }
}
export function prepareNativeProjectServices(
  input: NativeProjectInput,
  hasHostDependencies = false
): Record<string, Record<string, unknown>> {
  const compose: unknown = JSON.parse(input.normalizedComposeJson);
  if (!(isRecord(compose) && isRecord(compose.services))) {
    throw refused();
  }
  const result: Record<string, Record<string, unknown>> = {};
  for (const [name, value] of Object.entries(compose.services)) {
    if (
      !isRecord(value) ||
      typeof value.image !== "string" ||
      value.build !== undefined ||
      (value.extra_hosts !== undefined && !hasHostDependencies) ||
      value.ports !== undefined ||
      value.logging !== undefined ||
      (value.restart !== undefined && value.restart !== "no") ||
      !hasOnlyNativeSupportedLabels(value.labels)
    ) {
      throw refused();
    }
    result[name] = value;
  }
  return result;
}
function readiness(
  specs: Record<string, Record<string, unknown>>,
  initializers: ReadonlySet<string>,
  routed: ReadonlySet<string>
): string[] {
  const ready: Record<string, string> = Object.fromEntries(
    Object.entries(specs).map(([name, spec]) => [
      name,
      spec.healthcheck ? "healthy" : "started",
    ])
  );
  for (const spec of Object.values(specs)) {
    if (!isRecord(spec.depends_on)) {
      continue;
    }
    for (const [name, edge] of Object.entries(spec.depends_on)) {
      if (
        isRecord(edge) &&
        edge.condition === "service_completed_successfully"
      ) {
        ready[name] = "completed";
      }
      if (isRecord(edge) && edge.condition === "service_healthy") {
        ready[name] = "healthy";
      }
    }
  }
  for (const name of initializers) {
    ready[name] = "completed";
  }
  for (const name of routed) {
    ready[name] = "healthy";
  }
  return Object.entries(ready).flatMap(([name, condition]) => [
    "--ready",
    `${name}=${condition}`,
  ]);
}
function authoritative(
  value: unknown,
  run: string,
  namespace: string,
  planId: string
): NativeProjectRun {
  if (
    !isRecord(value) ||
    value.journal_incomplete !== false ||
    !isRecord(value.receipt)
  ) {
    throw refused();
  }
  const receipt = value.receipt;
  if (
    receipt.run !== run ||
    receipt.namespace !== namespace ||
    receipt.plan_id !== planId ||
    typeof receipt.owner !== "string" ||
    !OWNER.test(receipt.owner)
  ) {
    throw refused();
  }
  return { run, owner: receipt.owner, namespace, planId };
}
function requireEnrollmentCompatible(plan: unknown): void {
  if (!isRecord(plan) || plan.enrollment_compatible !== true) {
    throw refused();
  }
}
const HTTPS_REDIRECTS = new Set([301, 302, 303, 307, 308]);
type HttpsRoute = ReturnType<typeof reviewedNativeHttpsRoutes>[number];
function redirectHostname(
  location: string,
  hostname: string,
  port: number,
  route: HttpsRoute,
  routes: readonly HttpsRoute[]
): string {
  let target: URL;
  try {
    target = new URL(location, `https://${hostname}:${port}${route.path}`);
  } catch {
    throw refused();
  }
  const reviewed = routes.find((entry) => entry.hostname === target.hostname);
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    (target.port && target.port !== "443" && target.port !== String(port)) ||
    !reviewed ||
    reviewed.service !== route.service ||
    reviewed.path !== route.path ||
    target.pathname !== route.path
  ) {
    throw new Error(
      "Native HTTPS verification failed (REDIRECT_TARGET_REFUSED); peer values omitted."
    );
  }
  return target.hostname;
}
export async function verifyHttpsRoutes(
  frontend:
    | Pick<
        Awaited<ReturnType<typeof acquireNativeHttpsLease>>,
        "httpsPort" | "verifyHostname"
      >
    | undefined,
  plan: unknown,
  services: ReadonlySet<string>
): Promise<void> {
  if (!frontend) {
    return;
  }
  const routes = reviewedNativeHttpsRoutes(plan, services);
  const results = new Map<
    string,
    Awaited<ReturnType<typeof frontend.verifyHostname>>
  >();
  for (const route of routes) {
    results.set(
      route.hostname,
      await frontend.verifyHostname(route.hostname, route.path)
    );
  }
  for (const route of routes) {
    const visited = new Set<string>();
    let hostname = route.hostname;
    while (true) {
      if (visited.has(hostname)) {
        throw new Error(
          "Native HTTPS verification failed (REDIRECT_CYCLE); peer values omitted."
        );
      }
      visited.add(hostname);
      const response = results.get(hostname);
      if (!(response && Number.isInteger(response.statusCode))) {
        throw refused();
      }
      if (response.statusCode >= 200 && response.statusCode < 300) {
        break;
      }
      if (!(HTTPS_REDIRECTS.has(response.statusCode) && response.location)) {
        throw new Error(
          `Native HTTPS verification failed (HTTP_STATUS_${response.statusCode}); peer values omitted.`
        );
      }
      hostname = redirectHostname(
        response.location,
        hostname,
        frontend.httpsPort,
        route,
        routes
      );
    }
  }
}

function foregroundExitCode(opts: {
  aborted: boolean;
  interruptedExit: number;
  failure: unknown;
  infrastructureFailure?: Error;
  code: number;
}): number {
  if (opts.infrastructureFailure) {
    throw opts.infrastructureFailure;
  }
  if (opts.aborted) {
    return opts.interruptedExit;
  }
  if (opts.failure) {
    throw opts.failure;
  }
  return opts.code;
}
function environmentDelivery(
  input: NativeProjectInput,
  plan: string,
  run: string
): { flags: string[]; payload?: Buffer } {
  if (Object.keys(input.managedEnvironment).length === 0) {
    return { flags: [] };
  }
  return {
    flags: ["--environment-stdin"],
    payload: Buffer.from(
      JSON.stringify({
        version: 1,
        plan,
        run,
        lifetime_seconds: 300,
        services: input.managedEnvironment,
      })
    ),
  };
}
const SAFE_STARTUP_DIAGNOSTIC =
  /^(Native (?:graph startup (?:failed|was interrupted or failed)|HTTPS verification failed)) \(([A-Za-z0-9_]{1,80})\); (?:inspect owned state before retrying\.|peer values omitted\.)$/;
/** Preserve only the fixed diagnostic envelope emitted by the native clients. */
function cleanupUnconfirmed(
  startupFailure?: unknown,
  nativeCode?: string
): Error {
  const message = startupFailure instanceof Error ? startupFailure.message : "";
  const diagnostic = SAFE_STARTUP_DIAGNOSTIC.exec(message);
  const startup =
    startupFailure === undefined
      ? ""
      : ` Startup diagnostic: ${diagnostic ? `${diagnostic[1]} (${diagnostic[2]})` : "STARTUP_FAILURE (details omitted)"}.`;
  return new Error(
    `Native foreground exit cleanup is unconfirmed; runtime and bridge state may be retained. Any published run mapping is retained; inspect owned state before retrying.${startup}${nativeCode ? ` Native exit diagnostic: ${nativeCode}.` : ""}`
  );
}
function requireConfirmedCleanup(
  final: unknown,
  startupFailure?: unknown,
  nativeCode?: string
): void {
  if (
    !(
      isRecord(final) &&
      isRecord(final.receipt) &&
      ["stopped-data-retained", "removed"].includes(
        String(final.receipt.phase)
      ) &&
      isRecord(final.observations)
    ) ||
    Object.entries(final.observations).some(
      ([key, value]) =>
        key.startsWith("container:") &&
        (!isRecord(value) || value.state !== "absent")
    )
  ) {
    throw cleanupUnconfirmed(startupFailure, nativeCode);
  }
}
async function refusePendingFreshStart(
  restore: NativeProjectRun | undefined,
  scope: NativeProjectRunScope,
  load: typeof loadNativeRestartIntent
): Promise<void> {
  if (!restore && (await load(scope))) {
    throw new Error(
      "Native project has a pending restart; use hack restart to resume retained data."
    );
  }
}
function retainedStartupSelection(opts: {
  readonly run: NativeProjectRun;
  readonly envName?: string | null;
  readonly profiles?: readonly string[];
  readonly aws?: { readonly profile: string; readonly region?: string };
}) {
  const { run } = opts;
  if (
    run.effectiveEnvName === undefined ||
    run.profiles === undefined ||
    run.aws === undefined ||
    (opts.envName !== undefined && opts.envName !== run.effectiveEnvName) ||
    (opts.profiles !== undefined &&
      JSON.stringify(normalizeNativeProfiles(opts.profiles)) !==
        JSON.stringify(run.profiles)) ||
    (opts.aws !== undefined &&
      (opts.aws.profile !== run.aws?.profile ||
        opts.aws.region !== run.aws?.region))
  ) {
    throw new Error(
      "Native up cannot change the retained run's environment, profiles or AWS profile; data was not replaced."
    );
  }
  return {
    envName: run.effectiveEnvName,
    profiles: run.profiles,
    aws: run.aws ?? undefined,
  };
}
async function selectNativeStartup(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeProjectRunScope;
  readonly restore?: NativeProjectRun;
  readonly envName?: string | null;
  readonly profiles?: readonly string[];
  readonly requestedProfiles: readonly string[];
  readonly aws?: { readonly profile: string; readonly region?: string };
  readonly load: typeof loadNativeProjectRun;
  readonly invoke: typeof invokeNativeRuntime;
  readonly signal?: AbortSignal;
}) {
  const retained = await opts.load(opts.scope);
  const selection =
    retained && !opts.restore
      ? retainedStartupSelection({
          run: retained,
          envName: opts.envName,
          profiles: opts.profiles,
          aws: opts.aws,
        })
      : {
          envName: opts.envName,
          profiles: opts.requestedProfiles,
          aws: opts.aws,
        };
  let retainedFlags: string[] = [];
  if (retained) {
    if (
      opts.restore &&
      JSON.stringify(opts.restore) !== JSON.stringify(retained)
    ) {
      throw new Error("Native retained run mapping changed before restore.");
    }
    const preflight = await preflightNativeRetainedStartup({
      runtime: opts.runtime,
      projectRoot: opts.scope.projectRoot,
      run: retained,
      invoke: opts.invoke,
      signal: opts.signal,
    });
    retainedFlags = preflight.flags;
    const observed =
      preflight.runtimePhase === "running"
        ? await inspectNativeProjectGraph({
            runtime: opts.runtime,
            projectRoot: opts.scope.projectRoot,
            run: retained.run,
            invoke: opts.invoke,
          })
        : undefined;
    if (
      preflight.runtimePhase === "running" &&
      !confirmedNativeRetainedGraph(observed, retained)
    ) {
      throw new Error(
        "Native project already has an owned run mapping that is not safely stopped; inspect it before starting another run."
      );
    }
  }
  const restore = opts.restore ?? retained ?? undefined;
  return { retained, restore, selection, retainedFlags };
}
function selectedMapping(opts: {
  readonly ready: NativeProjectRun;
  readonly effectiveEnvName: string | null;
  readonly profiles: readonly string[];
  readonly aws?: { readonly profile: string; readonly region?: string };
}): NativeProjectRun {
  return {
    ...opts.ready,
    effectiveEnvName: opts.effectiveEnvName,
    profiles: opts.profiles,
    aws: opts.aws
      ? {
          profile: opts.aws.profile,
          ...(opts.aws.region ? { region: opts.aws.region } : {}),
        }
      : null,
  };
}
async function retireRemovedMapping(opts: {
  readonly final: unknown;
  readonly mapping: NativeProjectRun | undefined;
  readonly owned: NativeProjectRun;
  readonly scope: NativeProjectRunScope;
  readonly remove: typeof removeNativeProjectRun;
}): Promise<void> {
  if (!opts.mapping) {
    return;
  }
  if (opts.mapping.owner !== opts.owned.owner) {
    throw refused();
  }
  if (
    isRecord(opts.final) &&
    isRecord(opts.final.receipt) &&
    opts.final.receipt.phase === "removed"
  ) {
    await opts.remove({ ...opts.scope, expected: opts.mapping });
  }
}
async function acknowledgeFinalization(
  finalization:
    | Awaited<ReturnType<typeof beginNativeProjectFinalization>>
    | undefined,
  graph: boolean,
  https: boolean
): Promise<void> {
  if (graph && https) {
    await finalization?.complete();
  }
}
/** Explicit unfiltered project sharing; foreground only. Native refusal never falls back to Compose. */
export async function startNativeProject(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeProjectRunScope;
  readonly composeFile: string;
  readonly envName?: string | null;
  readonly profiles?: readonly string[];
  readonly sharedSource: boolean;
  readonly restore?: NativeProjectRun;
  readonly onReady?: () => Promise<void>;
  readonly dependencyFile?: string;
  readonly adaptationFile?: string;
  readonly allowedHosts?: readonly string[];
  readonly https?: NativeHttpsSelection;
  readonly aws?: { readonly profile: string; readonly region?: string };
  readonly before: (input: NativeProjectInput) => Promise<Hooks>;
  readonly signal?: AbortSignal;
  readonly dependencies?: Partial<Dependencies>;
}): Promise<number> {
  const requestedProfiles = normalizeNativeProfiles(opts.profiles);
  requireActiveStartup(opts.signal);
  const allowedHosts = validateNativeAllowedHosts(opts.allowedHosts);
  validateHttpsSelection(opts.https);
  if (!opts.sharedSource) {
    throw new Error(
      "Native foreground up requires HACK_NATIVE_SHARED_SOURCE=1 to share this exact project, including ignored files."
    );
  }
  const deps = { ...DEFAULTS, ...opts.dependencies };
  await refusePendingFreshStart(opts.restore, opts.scope, deps.loadRestart);
  const { retained, restore, selection, retainedFlags } =
    await selectNativeStartup({
      runtime: opts.runtime,
      scope: opts.scope,
      restore: opts.restore,
      envName: opts.envName,
      profiles: opts.profiles,
      requestedProfiles,
      aws: opts.aws,
      load: deps.load,
      invoke: deps.invoke,
      signal: opts.signal,
    });
  requireActiveStartup(opts.signal);
  const profiles = selection.profiles;
  await deps.prepareStorage(opts.scope);
  let input = await deps.prepare({
    ...opts.scope,
    composeFile: opts.composeFile,
    envName: selection.envName,
  });
  if (
    retained &&
    !opts.restore &&
    input.effectiveEnvName !== selection.envName
  ) {
    throw new Error(
      "Native retained environment selection changed; data was not replaced."
    );
  }
  input = await prepareNativeProjectAdaptation({
    input,
    path: opts.adaptationFile,
  });
  input = await prepareNativeProjectBranch({
    input,
    scope: opts.scope,
    composeFile: opts.composeFile,
  });
  let specs = prepareNativeProjectServices(
    input,
    opts.dependencyFile !== undefined
  );
  const bridgeCapacity = nativeBridgeCapacity(specs);
  const artifact = join(dirname(opts.runtime.binary), "hack-relay-guest");
  const artifactFile = Bun.file(artifact);
  if (
    !(await artifactFile.exists()) ||
    artifactFile.size > 16 * 1024 * 1024 ||
    artifactFile.size === 0
  ) {
    throw new Error(
      "Native foreground up requires the bundled hack-relay-guest artifact."
    );
  }
  const artifactHash = createHash("sha256")
    .update(new Uint8Array(await artifactFile.arrayBuffer()))
    .digest("hex");
  const controller = new AbortController();
  let interruptedExit = 130;
  const cancel = () => controller.abort();
  const terminate = () => {
    interruptedExit = 143;
    cancel();
  };
  process.on("SIGINT", cancel);
  process.on("SIGTERM", terminate);
  opts.signal?.addEventListener("abort", cancel, { once: true });
  let hooks: Hooks | undefined;
  let finalization:
    | Awaited<ReturnType<typeof beginNativeProjectFinalization>>
    | undefined;
  let graphCleanupConfirmed = false;
  let httpsCleanupConfirmed = false;
  try {
    if (opts.signal?.aborted) {
      cancel();
    }
    requireActiveStartup(controller.signal);
    hooks = await opts.before(input);
    if (selection.aws) {
      input = (await deps.adaptAws({ input, ...selection.aws })).input;
      specs = prepareNativeProjectServices(
        input,
        opts.dependencyFile !== undefined
      );
    }
    const dependencyDiscoveryDeadline = performance.now() + 60_000;
    const hostDependencies = await readNativeHostDependencies({
      path: opts.dependencyFile,
      services: Object.keys(specs),
      discover: (selection) =>
        discoverNativeHostDependency({
          runtime: opts.runtime,
          projectRoot: opts.scope.projectRoot,
          hostPort: selection.hostPort,
          executable: selection.executable,
          invoke: deps.invoke,
          wait: {
            deadlineMs: dependencyDiscoveryDeadline,
            signal: controller.signal,
          },
        }),
    });
    requireActiveStartup(controller.signal);
    prepareNativeDependencyServices({
      dependencies: hostDependencies,
      services: specs,
    });
    await verifyNativeRetainedMapping({
      run: retained,
      scope: opts.scope,
      load: deps.load,
    });
    requireActiveStartup(controller.signal);
    await deps.invoke({
      runtime: opts.runtime,
      cwd: opts.scope.projectRoot,
      args: [
        "runtime",
        "up",
        "--profile",
        "development",
        "--project-share",
        opts.scope.projectRoot,
        "--unfiltered-source",
        ...retainedFlags,
        ...(hostDependencies.length > 0
          ? [
              "--dependency-sockets",
              String(
                new Set(hostDependencies.map((binding) => binding.slot)).size
              ),
            ]
          : []),
        ...(bridgeCapacity > 0
          ? ["--bridge-sockets", String(bridgeCapacity)]
          : []),
        ...(allowedHosts.length > 0
          ? allowedHosts.flatMap((host) => ["--allow-host", host])
          : ["--internet"]),
        "--json",
      ],
      signal: controller.signal,
    });
    requireActiveStartup(controller.signal);
    await verifyNativeResumedRetainedGraph({
      runtime: opts.runtime,
      projectRoot: opts.scope.projectRoot,
      run: retained,
      invoke: deps.invoke,
    });
    for (const spec of Object.values(specs)) {
      if (controller.signal.aborted) {
        throw refused();
      }
      const image = String(spec.image);
      if (IMAGE.test(image)) {
        continue;
      }
      const ensured = await deps.invoke({
        runtime: opts.runtime,
        cwd: opts.scope.projectRoot,
        args: ["runtime", "ensure-image", "--reference", image, "--json"],
      });
      if (
        !isRecord(ensured) ||
        typeof ensured.image_id !== "string" ||
        !IMAGE.test(ensured.image_id)
      ) {
        throw refused();
      }
      spec.image = ensured.image_id;
    }
    const compose = JSON.parse(input.normalizedComposeJson);
    compose.services = specs;
    const pinned = { ...input, normalizedComposeJson: JSON.stringify(compose) };
    const expectedMapping = retained ?? undefined;
    return await deps.review({
      runtime: opts.runtime,
      projectRoot: opts.scope.projectRoot,
      composeFile: opts.composeFile,
      profiles,
      branch: opts.scope.branch,
      input: pinned,
      run: async (review) => {
        requireEnrollmentCompatible(review.report.plan);
        const routes = reviewedNativeRoutes({
          plan: review.report.plan,
          specs,
          capacity: bridgeCapacity,
        });
        const runSelection = await selectNativeProjectRestore({
          runtime: opts.runtime,
          projectRoot: opts.scope.projectRoot,
          restore,
          review,
          invoke: deps.invoke,
        });
        const cache = await nativeStartCacheSource({
          runtime: opts.runtime,
          projectRoot: opts.scope.projectRoot,
          review,
          restoreRevision: runSelection.sourceRevision,
          invoke: deps.invoke,
        });
        const directory = await mkdtemp(join(tmpdir(), "hack-native-start-"));
        const run = runSelection.run;
        let mapping: NativeProjectRun | undefined;
        let https:
          | Awaited<ReturnType<typeof acquireNativeHttpsLease>>
          | undefined;
        let httpsClosing = false;
        let httpsIntent: NativeHttpsLeaseIdentity | undefined;
        let httpsFailure: Error | undefined;
        try {
          const dependencyFile = join(directory, "dependencies.json");
          await writeFile(
            dependencyFile,
            JSON.stringify({
              version: 1,
              plan: review.planId,
              artifact,
              artifact_sha256: artifactHash,
              dependencies: hostDependencies,
            }),
            { mode: 0o600, flag: "wx" }
          );
          const plan = await deps.invoke({
            runtime: opts.runtime,
            cwd: opts.scope.projectRoot,
            args: [
              "graph",
              "dependency-plan",
              "--dependencies",
              dependencyFile,
              "--json",
            ],
          });
          if (
            !isRecord(plan) ||
            typeof plan.dependency_plan_id !== "string" ||
            !SHA.test(plan.dependency_plan_id)
          ) {
            throw refused();
          }
          const invokeInspect = () =>
            inspectNativeProjectGraph({
              runtime: opts.runtime,
              projectRoot: opts.scope.projectRoot,
              run,
              invoke: deps.invoke,
            });
          const delivery = environmentDelivery(input, review.planId, run);
          let code = 1;
          let serveFailure: unknown;
          let nativeExitCode: string | undefined;
          try {
            code = await deps.serve({
              runtime: opts.runtime,
              projectRoot: opts.scope.projectRoot,
              run,
              restore: runSelection.restoring,
              args: [
                ...review.projectArgs,
                ...runSelection.flags,
                "--expect-plan",
                review.planId,
                ...nativeSharedSourceFlags(review.report.plan),
                ...cache.flags,
                ...readiness(specs, cache.initializers, routes.services),
                ...routes.flags,
                "--dependencies",
                dependencyFile,
                "--expect-dependencies",
                plan.dependency_plan_id,
                ...delivery.flags,
                "--timeout-seconds",
                "300",
              ],
              privateInput: delivery.payload,
              startupTimeoutMs: 300_000,
              signal: controller.signal,
              onExitDiagnostic: (diagnostic) => {
                nativeExitCode = diagnostic.nativeCode;
              },
              onReady: async () => {
                const readyMapping = authoritative(
                  await invokeInspect(),
                  run,
                  review.namespace,
                  restore?.planId ?? review.planId
                );
                if (controller.signal.aborted) {
                  throw new Error(
                    "Native startup canceled before mapping publication."
                  );
                }
                const persistedMapping = selectedMapping({
                  ready: readyMapping,
                  effectiveEnvName: input.effectiveEnvName,
                  profiles,
                  aws: selection.aws,
                });
                // Enrollment must exist before taking a shared lease: release
                // requires independent proof of this exact graph's cleanup.
                if (opts.https && routes.services.size > 0) {
                  https = await acquireReadyHttps({
                    runtime: opts.runtime,
                    selection: opts.https,
                    run: readyMapping,
                    signal: controller.signal,
                    invoke: deps.invoke,
                    acquire: deps.https,
                    onIntent: async (identity) => {
                      finalization = await deps.finalization({
                        scope: opts.scope,
                        run: persistedMapping,
                        httpsPort: opts.https?.httpsPort ?? null,
                        httpsLease: identity,
                      });
                      httpsIntent = identity;
                      // This is an ownership mapping, not a readiness signal.
                      // Recovery must be able to select the run after a lost reply.
                      await deps.save({
                        ...opts.scope,
                        run: persistedMapping,
                        expected: expectedMapping,
                      });
                      mapping = persistedMapping;
                    },
                  });
                  void https.exited.then(() => {
                    if (!httpsClosing) {
                      httpsFailure = new Error(
                        "Native HTTPS owner exited unexpectedly; graph shutdown requested."
                      );
                      controller.abort();
                    }
                  });
                }
                // Injectable frontends may return a lease without publishing intent;
                // production publishes this marker before sending its acquire frame.
                finalization ??= await deps.finalization({
                  scope: opts.scope,
                  run: persistedMapping,
                  httpsPort: https ? opts.https?.httpsPort : null,
                  httpsLease: https?.identity,
                });
                requireActiveStartup(controller.signal);
                await verifyHttpsRoutes(
                  https,
                  review.report.plan,
                  routes.services
                );
                if (httpsFailure) {
                  throw httpsFailure;
                }
                if (!mapping) {
                  await deps.save({
                    ...opts.scope,
                    run: persistedMapping,
                    expected: expectedMapping,
                  });
                  mapping = persistedMapping;
                }
                await hooks?.ready?.();
                await opts.onReady?.();
              },
            });
          } catch (error) {
            serveFailure = error;
          } finally {
            delivery.payload?.fill(0);
          }
          let final: unknown;
          try {
            final = await invokeInspect();
          } catch (inspectionFailure) {
            throw cleanupUnconfirmed(
              serveFailure ?? inspectionFailure,
              nativeExitCode
            );
          }
          const owned = authoritative(
            final,
            run,
            review.namespace,
            restore?.planId ?? review.planId
          );
          requireConfirmedCleanup(final, serveFailure, nativeExitCode);
          graphCleanupConfirmed = true;
          await retireRemovedMapping({
            final,
            mapping,
            owned,
            scope: opts.scope,
            remove: deps.remove,
          });
          return foregroundExitCode({
            aborted: controller.signal.aborted,
            interruptedExit,
            failure: serveFailure,
            infrastructureFailure: httpsFailure,
            code,
          });
        } finally {
          httpsClosing = true;
          try {
            if (https) {
              await https.releaseAfterCleanup();
            } else if (httpsIntent) {
              await deps.recoverHttps({
                runtime: opts.runtime,
                identity: httpsIntent,
              });
            }
            httpsCleanupConfirmed = true;
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        }
      },
    });
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", terminate);
    opts.signal?.removeEventListener("abort", cancel);
    await hooks?.cleanup();
    await acknowledgeFinalization(
      finalization,
      graphCleanupConfirmed,
      httpsCleanupConfirmed
    );
  }
}
