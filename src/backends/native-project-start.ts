import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { isRecord } from "../lib/guards.ts";
import { adaptNativeAwsEnvironment } from "./native-aws-environment.ts";
import { prepareNativeProjectAdaptation } from "./native-project-adaptation.ts";
import {
  nativeSharedSourceFlags,
  publishNativeCacheSource,
} from "./native-project-cache.ts";
import {
  prepareNativeDependencyServices,
  readNativeHostDependencies,
} from "./native-project-dependencies.ts";
import { startNativeProjectHttps } from "./native-project-https.ts";
import {
  type NativeProjectInput,
  prepareNativeProjectInput,
} from "./native-project-input.ts";
import { validateNativeAllowedHosts } from "./native-project-network.ts";
import { serveNativeProjectGraph } from "./native-project-process.ts";
import { withNativeProjectReview } from "./native-project-review.ts";
import {
  hasOnlyNativeSupportedLabels,
  nativeBridgeCapacity,
  reviewedNativeRoutes,
} from "./native-project-routing.ts";
import {
  loadNativeProjectRun,
  type NativeProjectRun,
  type NativeProjectRunScope,
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
export type NativeHttpsSelection = {
  readonly caddyBinary: string;
  readonly caddySha256: string;
  readonly httpsPort: number;
};
function validateHttpsSelection(
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
function routeHostnames(
  plan: unknown,
  services: ReadonlySet<string>
): readonly string[] {
  if (!(isRecord(plan) && isRecord(plan.services))) {
    throw refused();
  }
  const names = new Set<string>();
  for (const name of services) {
    const service = plan.services[name];
    if (
      !(
        isRecord(service) &&
        isRecord(service.routing) &&
        Array.isArray(service.routing.hostnames)
      )
    ) {
      throw refused();
    }
    for (const hostname of service.routing.hostnames) {
      if (typeof hostname !== "string") {
        throw refused();
      }
      names.add(hostname);
    }
  }
  return [...names].sort();
}
type Hooks = {
  readonly cleanup: () => Promise<void>;
  readonly ready?: () => Promise<void>;
};
type Dependencies = {
  prepare: typeof prepareNativeProjectInput;
  adaptAws: typeof adaptNativeAwsEnvironment;
  review: typeof withNativeProjectReview;
  serve: typeof serveNativeProjectGraph;
  https: typeof startNativeProjectHttps;
  invoke: typeof invokeNativeRuntime;
  load: typeof loadNativeProjectRun;
  save: typeof saveNativeProjectRun;
  remove: typeof removeNativeProjectRun;
};
const DEFAULTS: Dependencies = {
  prepare: prepareNativeProjectInput,
  adaptAws: adaptNativeAwsEnvironment,
  review: withNativeProjectReview,
  serve: serveNativeProjectGraph,
  https: startNativeProjectHttps,
  invoke: invokeNativeRuntime,
  load: loadNativeProjectRun,
  save: saveNativeProjectRun,
  remove: removeNativeProjectRun,
};
function refused(): Error {
  return new Error(
    "Native foreground up cannot admit this configuration: routing, host dependencies, builds or unsupported runtime settings require explicit native support; configuration was not dropped."
  );
}
function services(
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
async function verifyHttpsRoutes(
  frontend: Awaited<ReturnType<typeof startNativeProjectHttps>> | undefined,
  plan: unknown,
  services: ReadonlySet<string>
): Promise<void> {
  if (!frontend) {
    return;
  }
  for (const hostname of routeHostnames(plan, services)) {
    await frontend.verifyHostname(hostname);
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
function cleanupUnconfirmed(startupFailure?: unknown): Error {
  const message = startupFailure instanceof Error ? startupFailure.message : "";
  const diagnostic = SAFE_STARTUP_DIAGNOSTIC.exec(message);
  const startup =
    startupFailure === undefined
      ? ""
      : ` Startup diagnostic: ${diagnostic ? `${diagnostic[1]} (${diagnostic[2]})` : "STARTUP_FAILURE (details omitted)"}.`;
  return new Error(
    `Native foreground exit cleanup is unconfirmed; runtime and bridge state may be retained. Any published run mapping is retained; inspect owned state before retrying.${startup}`
  );
}
function requireConfirmedCleanup(
  final: unknown,
  startupFailure?: unknown
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
    throw cleanupUnconfirmed(startupFailure);
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
  readonly dependencyFile?: string;
  readonly adaptationFile?: string;
  readonly allowedHosts?: readonly string[];
  readonly https?: NativeHttpsSelection;
  readonly aws?: { readonly profile: string; readonly region?: string };
  readonly before: (input: NativeProjectInput) => Promise<Hooks>;
  readonly signal?: AbortSignal;
  readonly dependencies?: Partial<Dependencies>;
}): Promise<number> {
  const allowedHosts = validateNativeAllowedHosts(opts.allowedHosts);
  validateHttpsSelection(opts.https);
  if (!opts.sharedSource) {
    throw new Error(
      "Native foreground up requires HACK_NATIVE_SHARED_SOURCE=1 to share this exact project, including ignored files."
    );
  }
  const deps = { ...DEFAULTS, ...opts.dependencies };
  if (await deps.load(opts.scope)) {
    throw new Error(
      "Native project already has an owned run mapping; inspect it before starting another run."
    );
  }
  let input = await deps.prepare({
    ...opts.scope,
    composeFile: opts.composeFile,
    envName: opts.envName,
  });
  input = await prepareNativeProjectAdaptation({
    input,
    path: opts.adaptationFile,
  });
  let specs = services(input, opts.dependencyFile !== undefined);
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
  try {
    if (opts.signal?.aborted) {
      cancel();
    }
    if (controller.signal.aborted) {
      throw refused();
    }
    hooks = await opts.before(input);
    if (opts.aws) {
      input = (await deps.adaptAws({ input, ...opts.aws })).input;
      specs = services(input, opts.dependencyFile !== undefined);
    }
    const hostDependencies = await readNativeHostDependencies({
      path: opts.dependencyFile,
      services: Object.keys(specs),
    });
    prepareNativeDependencyServices({
      dependencies: hostDependencies,
      services: specs,
    });
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
        ...allowedHosts.flatMap((host) => ["--allow-host", host]),
        "--json",
      ],
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
    return await deps.review({
      runtime: opts.runtime,
      projectRoot: opts.scope.projectRoot,
      composeFile: opts.composeFile,
      profiles: opts.profiles,
      input: pinned,
      run: async (review) => {
        requireEnrollmentCompatible(review.report.plan);
        const routes = reviewedNativeRoutes({
          plan: review.report.plan,
          specs,
          capacity: bridgeCapacity,
        });
        const cache = await publishNativeCacheSource({
          runtime: opts.runtime,
          projectRoot: opts.scope.projectRoot,
          review,
          invoke: deps.invoke,
        });
        const directory = await mkdtemp(join(tmpdir(), "hack-native-start-"));
        const run = randomBytes(16).toString("hex");
        let mapping: NativeProjectRun | undefined;
        let https:
          | Awaited<ReturnType<typeof startNativeProjectHttps>>
          | undefined;
        let httpsClosing = false;
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
            deps.invoke({
              runtime: opts.runtime,
              cwd: opts.scope.projectRoot,
              args: ["graph", "inspect", "--run-id", run, "--json"],
            });
          if (opts.https && routes.services.size > 0) {
            https = await deps.https({ runtime: opts.runtime, ...opts.https });
            void https.exited.then(() => {
              if (!httpsClosing) {
                httpsFailure = new Error(
                  "Native HTTPS owner exited unexpectedly; graph shutdown requested."
                );
                controller.abort();
              }
            });
          }
          const delivery = environmentDelivery(input, review.planId, run);
          let code = 1;
          let serveFailure: unknown;
          try {
            code = await deps.serve({
              runtime: opts.runtime,
              projectRoot: opts.scope.projectRoot,
              run,
              args: [
                ...review.projectArgs,
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
              onReady: async () => {
                const readyMapping = authoritative(
                  await invokeInspect(),
                  run,
                  review.namespace,
                  review.planId
                );
                if (controller.signal.aborted) {
                  throw new Error(
                    "Native startup canceled before mapping publication."
                  );
                }
                await verifyHttpsRoutes(
                  https,
                  review.report.plan,
                  routes.services
                );
                if (httpsFailure) {
                  throw httpsFailure;
                }
                await deps.save({ ...opts.scope, run: readyMapping });
                mapping = readyMapping;
                await hooks?.ready?.();
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
            throw cleanupUnconfirmed(serveFailure ?? inspectionFailure);
          }
          const owned = authoritative(
            final,
            run,
            review.namespace,
            review.planId
          );
          requireConfirmedCleanup(final, serveFailure);
          if (mapping) {
            if (mapping.owner !== owned.owner) {
              throw refused();
            }
            await deps.remove({ ...opts.scope, expected: mapping });
          }
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
            await https?.close();
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
  }
}
