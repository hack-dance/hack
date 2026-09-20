import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isRecord } from "../lib/guards.ts";
import {
  type NativeProjectInput,
  prepareNativeProjectInput,
} from "./native-project-input.ts";
import { serveNativeProjectGraph } from "./native-project-process.ts";
import { withNativeProjectReview } from "./native-project-review.ts";
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
type Hooks = {
  readonly cleanup: () => Promise<void>;
  readonly ready?: () => Promise<void>;
};
type Dependencies = {
  prepare: typeof prepareNativeProjectInput;
  review: typeof withNativeProjectReview;
  serve: typeof serveNativeProjectGraph;
  invoke: typeof invokeNativeRuntime;
  load: typeof loadNativeProjectRun;
  save: typeof saveNativeProjectRun;
  remove: typeof removeNativeProjectRun;
};
const DEFAULTS: Dependencies = {
  prepare: prepareNativeProjectInput,
  review: withNativeProjectReview,
  serve: serveNativeProjectGraph,
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
  input: NativeProjectInput
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
      value.extra_hosts !== undefined ||
      value.ports !== undefined ||
      value.logging !== undefined ||
      (value.restart !== undefined && value.restart !== "no") ||
      value.labels !== undefined
    ) {
      throw refused();
    }
    result[name] = value;
  }
  return result;
}
function readiness(specs: Record<string, Record<string, unknown>>): string[] {
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
function foregroundExitCode(opts: {
  aborted: boolean;
  interruptedExit: number;
  failure: unknown;
  code: number;
}): number {
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
function requireConfirmedCleanup(final: unknown): void {
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
    throw new Error(
      "Native foreground exit cleanup is unconfirmed; run mapping retained."
    );
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
  readonly before: (input: NativeProjectInput) => Promise<Hooks>;
  readonly signal?: AbortSignal;
  readonly dependencies?: Partial<Dependencies>;
}): Promise<number> {
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
  const input = await deps.prepare({
    ...opts.scope,
    composeFile: opts.composeFile,
    envName: opts.envName,
  });
  const specs = services(input);
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
        if (
          !isRecord(review.report.plan) ||
          review.report.plan.enrollment_compatible !== true
        ) {
          throw refused();
        }
        const directory = await mkdtemp(join(tmpdir(), "hack-native-start-"));
        const run = randomBytes(16).toString("hex");
        let mapping: NativeProjectRun | undefined;
        try {
          const dependencyFile = join(directory, "dependencies.json");
          await writeFile(
            dependencyFile,
            JSON.stringify({
              version: 1,
              plan: review.planId,
              artifact,
              artifact_sha256: artifactHash,
              dependencies: [],
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
                "--shared-source",
                ...readiness(specs),
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
                mapping = authoritative(
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
                await deps.save({ ...opts.scope, run: mapping });
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
            throw serveFailure ?? inspectionFailure;
          }
          const owned = authoritative(
            final,
            run,
            review.namespace,
            review.planId
          );
          requireConfirmedCleanup(final);
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
            code,
          });
        } finally {
          await rm(directory, { recursive: true, force: true });
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
