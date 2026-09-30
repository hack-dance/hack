import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isRecord } from "../lib/guards.ts";
import { adaptNativeAwsEnvironment } from "./native-aws-environment.ts";
import { prepareNativeProjectAdaptation } from "./native-project-adaptation.ts";
import {
  discoverNativeHostDependency,
  type NativeHostDependency,
  parseNativeHostDependencies,
  prepareNativeDependencyServices,
  readNativeHostDependencies,
} from "./native-project-dependencies.ts";
import { prepareNativeProjectInput } from "./native-project-input.ts";
import { inspectNativeProjectGraph } from "./native-project-inspect.ts";
import { validateNativeAllowedHosts } from "./native-project-network.ts";
import {
  nativeReviewNeedsCompatibility,
  verifyNativeSourceCompatibility,
} from "./native-project-restore.ts";
import { confirmedNativeRetainedGraph } from "./native-project-retained.ts";
import {
  prepareNativeReviewBranch,
  selectNativeProjectReviewIdentity,
  verifyNativeActiveReview,
  withNativeProjectReview,
} from "./native-project-review.ts";
import {
  type NativeProjectRun,
  type NativeProjectRunScope,
  normalizeNativeProfiles,
} from "./native-project-run.ts";
import { readNativeSelection } from "./native-project-selection.ts";
import { prepareNativeProjectServices } from "./native-project-start.ts";
import {
  invokeNativeRuntime,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const DEFAULTS = {
  prepare: prepareNativeProjectInput,
  adapt: prepareNativeProjectAdaptation,
  aws: adaptNativeAwsEnvironment,
  dependencies: readNativeHostDependencies,
  invoke: invokeNativeRuntime,
  review: withNativeProjectReview,
  selectReview: selectNativeProjectReviewIdentity,
};
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{64}$/;

/** Review the relay artifact and, for an active graph, its selected live listeners. */
async function verifyNativeRestartListeners(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly planId: string;
  readonly dependencies: readonly NativeHostDependency[];
  readonly invoke: typeof invokeNativeRuntime;
  readonly cleanedRetry: boolean;
}): Promise<void> {
  if (opts.dependencies.length === 0) {
    return;
  }
  const artifact = join(dirname(opts.runtime.binary), "hack-relay-guest");
  const file = Bun.file(artifact);
  if (
    !(await file.exists()) ||
    file.size === 0 ||
    file.size > 16 * 1024 * 1024
  ) {
    throw new Error(
      "Native restart needs its bundled dependency relay before cleanup; the current graph was not stopped."
    );
  }
  const artifactHash = createHash("sha256")
    .update(new Uint8Array(await file.arrayBuffer()))
    .digest("hex");
  if (opts.cleanedRetry) {
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "hack-native-restart-deps-"));
  try {
    const path = join(directory, "dependencies.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        plan: opts.planId,
        artifact,
        artifact_sha256: artifactHash,
        dependencies: opts.dependencies,
      }),
      { mode: 0o600, flag: "wx" }
    );
    let result: unknown;
    try {
      result = await opts.invoke({
        runtime: opts.runtime,
        cwd: opts.projectRoot,
        args: ["graph", "dependency-plan", "--dependencies", path, "--json"],
      });
    } catch {
      throw new Error(
        "Native restart host dependency listener is unavailable or changed; refresh its private selection before restart. The current graph was not stopped."
      );
    }
    if (
      !isRecord(result) ||
      result.plan_id !== opts.planId ||
      typeof result.dependency_plan_id !== "string" ||
      !SHA.test(result.dependency_plan_id)
    ) {
      throw new Error(
        "Native restart host dependency selection was not confirmed; the current graph was not stopped."
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * A confirmed cleaned retry has no listener authority to capture yet. Validate
 * only the complete public intent; normal startup captures it after before hooks.
 * The provisional PID never reaches native dependency-plan or graph admission.
 */
async function readNativeRestartDependencyIntent(opts: {
  readonly path?: string;
  readonly services: readonly string[];
}): Promise<NativeHostDependency[]> {
  if (opts.path === undefined) {
    return [];
  }
  try {
    const value = await readNativeSelection(opts.path);
    if (!(isRecord(value) && Array.isArray(value.dependencies))) {
      throw new Error("Invalid dependency intent");
    }
    return parseNativeHostDependencies({
      services: opts.services,
      value: {
        ...value,
        dependencies: value.dependencies.map((entry) =>
          isRecord(entry) && entry.host_executable !== undefined
            ? { ...entry, host_pid: entry.host_pid ?? 2 }
            : entry
        ),
      },
    });
  } catch {
    throw new Error(
      "Native restart dependency intent is invalid; values omitted."
    );
  }
}

export function requireNativeRestartNetwork(
  status: unknown,
  hosts: readonly string[] = []
): void {
  const selected = validateNativeAllowedHosts(hosts).slice().sort();
  const network = isRecord(status) ? status.network : undefined;
  const approved = isRecord(network) ? network["approved-hosts"] : undefined;
  if (selected.length === 0 && network === "internet") {
    return;
  }
  if (
    selected.length > 0 &&
    isRecord(approved) &&
    Array.isArray(approved.hosts) &&
    approved.hosts.every((host) => typeof host === "string") &&
    JSON.stringify([...approved.hosts].sort()) === JSON.stringify(selected)
  ) {
    return;
  }
  throw new Error(
    "Native restart network selection differs from the owned pool; migrate its network policy explicitly before restart. The current graph was not stopped."
  );
}

/** Restart keeps the startup selection; omitted flags never select a new default. */
export function nativeRestartSelection(opts: {
  readonly run: NativeProjectRun;
  readonly envName?: string | null;
  readonly profiles?: readonly string[];
}) {
  const { run } = opts;
  if (
    run.effectiveEnvName === undefined ||
    run.profiles === undefined ||
    run.aws === undefined
  ) {
    throw new Error(
      "Native restart requires recorded startup selectors; legacy state needs explicit recovery."
    );
  }
  if (
    (opts.envName !== undefined && opts.envName !== run.effectiveEnvName) ||
    (opts.profiles !== undefined &&
      JSON.stringify(normalizeNativeProfiles(opts.profiles)) !==
        JSON.stringify(run.profiles))
  ) {
    throw new Error(
      "Native restart cannot change the startup environment or profiles; the current graph was not stopped."
    );
  }
  return {
    envName: run.effectiveEnvName,
    profiles: run.profiles,
    aws: run.aws ?? undefined,
  };
}

async function inspectRestartGraph(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeProjectRunScope;
  readonly run: NativeProjectRun;
  readonly invoke: typeof invokeNativeRuntime;
}): Promise<unknown> {
  try {
    return await inspectNativeProjectGraph({
      runtime: opts.runtime,
      projectRoot: opts.scope.projectRoot,
      run: opts.run.run,
      invoke: opts.invoke,
    });
  } catch {
    throw new Error(
      "Native restart cannot confirm the stopped retained graph; no listener discovery or cleanup was requested."
    );
  }
}

async function stoppedRestartMode(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeProjectRunScope;
  readonly run: NativeProjectRun;
  readonly cleanedRetry?: boolean;
  readonly recoverStopped?: boolean;
  readonly invoke: typeof invokeNativeRuntime;
}): Promise<boolean> {
  if (!(opts.cleanedRetry || opts.recoverStopped)) {
    return false;
  }
  const observed = await inspectRestartGraph(opts);
  const confirmed = confirmedNativeRetainedGraph(observed, opts.run);
  if (
    !confirmed &&
    (opts.cleanedRetry ||
      (isRecord(observed) &&
        isRecord(observed.receipt) &&
        observed.receipt.phase === "stopped-data-retained"))
  ) {
    throw new Error(
      "Native restart cannot confirm the stopped retained graph; no listener discovery or cleanup was requested."
    );
  }
  // Unconfirmed graphs retain active selection and live-listener checks.
  return confirmed;
}

/** Review the same public graph before stopping anything; never run startup hooks here. */
export async function preflightNativeRestart(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeProjectRunScope;
  readonly composeFile: string;
  readonly run: NativeProjectRun;
  readonly cleanedRetry?: boolean;
  /** Explicit frontend recovery may encounter a graph stopped before an intent was saved. */
  readonly recoverStopped?: boolean;
  readonly adaptationFile?: string;
  readonly dependencyFile?: string;
  readonly allowedHosts?: readonly string[];
  readonly dependencies?: Partial<typeof DEFAULTS>;
}) {
  const deps = { ...DEFAULTS, ...opts.dependencies };
  const selected = nativeRestartSelection({ run: opts.run });
  const stoppedRetry = await stoppedRestartMode({
    ...opts,
    invoke: deps.invoke,
  });
  requireNativeRestartNetwork(
    await deps.invoke({
      runtime: opts.runtime,
      cwd: opts.scope.projectRoot,
      args: ["runtime", "status", "--json"],
    }),
    opts.allowedHosts
  );
  const admission = await deps.invoke({
    runtime: opts.runtime,
    cwd: opts.scope.projectRoot,
    args: ["runtime", "probe", "--profile", "development", "--json"],
  });
  if (!isRecord(admission) || admission.admitted !== true) {
    throw new Error(
      "Native restart admission failed before cleanup; inspect runtime probe --profile development. The current graph was not stopped."
    );
  }
  let input = await deps.prepare({
    ...opts.scope,
    composeFile: opts.composeFile,
    envName: selected.envName,
  });
  input = await deps.adapt({
    input,
    path: opts.adaptationFile,
  });
  const reviewedBranch = await prepareNativeReviewBranch({
    runtime: opts.runtime,
    scope: opts.scope,
    composeFile: opts.composeFile,
    profiles: selected.profiles,
    input,
    retained: opts.run,
    retainedMode: stoppedRetry ? "stopped" : "active",
    invoke: deps.invoke,
    select: deps.selectReview,
  });
  input = reviewedBranch.input;
  const reviewIdentity = reviewedBranch.identity;
  if (selected.aws) {
    input = (await deps.aws({ input, ...selected.aws })).input;
  }
  const specs = prepareNativeProjectServices(
    input,
    opts.dependencyFile !== undefined
  );
  const dependencies = stoppedRetry
    ? await readNativeRestartDependencyIntent({
        path: opts.dependencyFile,
        services: Object.keys(specs),
      })
    : await deps.dependencies({
        path: opts.dependencyFile,
        services: Object.keys(specs),
        discover: (selection) =>
          discoverNativeHostDependency({
            runtime: opts.runtime,
            projectRoot: opts.scope.projectRoot,
            hostPort: selection.hostPort,
            executable: selection.executable,
            invoke: deps.invoke,
          }),
      });
  prepareNativeDependencyServices({ dependencies, services: specs });
  for (const spec of Object.values(specs)) {
    const image = String(spec.image);
    if (IMAGE.test(image)) {
      continue;
    }
    // Image acquisition may populate an owned cache, but cannot stop the current graph.
    const pinned = await deps.invoke({
      runtime: opts.runtime,
      cwd: opts.scope.projectRoot,
      args: ["runtime", "ensure-image", "--reference", image, "--json"],
    });
    if (
      !isRecord(pinned) ||
      typeof pinned.image_id !== "string" ||
      !IMAGE.test(pinned.image_id)
    ) {
      throw new Error("Native restart image selection failed before cleanup.");
    }
    spec.image = pinned.image_id;
  }
  const compose = JSON.parse(input.normalizedComposeJson);
  compose.services = specs;
  await deps.review({
    runtime: opts.runtime,
    projectRoot: opts.scope.projectRoot,
    composeFile: opts.composeFile,
    profiles: selected.profiles,
    branch: opts.scope.branch,
    retained: opts.run,
    retainedMode: stoppedRetry ? "stopped" : "active",
    reviewIdentity,
    invoke: deps.invoke,
    input: { ...input, normalizedComposeJson: JSON.stringify(compose) },
    run: async (review) => {
      if (review.namespace !== opts.run.namespace) {
        throw new Error(
          "Native restart configuration changed; the current graph was not stopped."
        );
      }
      if (nativeReviewNeedsCompatibility({ saved: opts.run, review })) {
        await verifyNativeSourceCompatibility({
          runtime: opts.runtime,
          projectRoot: opts.scope.projectRoot,
          saved: opts.run,
          review,
          invoke: deps.invoke,
        });
      }
      await verifyNativeRestartListeners({
        runtime: opts.runtime,
        projectRoot: opts.scope.projectRoot,
        planId: review.planId,
        dependencies,
        invoke: deps.invoke,
        cleanedRetry: stoppedRetry,
      });
      await verifyNativeActiveReview({
        runtime: opts.runtime,
        projectRoot: opts.scope.projectRoot,
        retained: opts.run,
        proof: reviewIdentity?.activeProof,
        invoke: deps.invoke,
      });
      if (stoppedRetry && opts.recoverStopped && !opts.cleanedRetry) {
        const observed = await inspectRestartGraph({
          ...opts,
          invoke: deps.invoke,
        });
        if (!confirmedNativeRetainedGraph(observed, opts.run)) {
          throw new Error(
            "Native restart stopped recovery changed during review; no cleanup was requested."
          );
        }
      }
    },
  });
}
