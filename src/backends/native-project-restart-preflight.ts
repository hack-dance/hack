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
  prepareNativeDependencyServices,
  readNativeHostDependencies,
} from "./native-project-dependencies.ts";
import { prepareNativeProjectInput } from "./native-project-input.ts";
import { validateNativeAllowedHosts } from "./native-project-network.ts";
import { verifyNativeSourceCompatibility } from "./native-project-restore.ts";
import { withNativeProjectReview } from "./native-project-review.ts";
import {
  type NativeProjectRun,
  type NativeProjectRunScope,
  normalizeNativeProfiles,
} from "./native-project-run.ts";
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
};
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{64}$/;

/** Check each currently selected host listener before restart can stop the graph. */
async function verifyNativeRestartListeners(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly planId: string;
  readonly dependencies: readonly NativeHostDependency[];
  readonly invoke: typeof invokeNativeRuntime;
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

/** Review the same public graph before stopping anything; never run startup hooks here. */
export async function preflightNativeRestart(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeProjectRunScope;
  readonly composeFile: string;
  readonly run: NativeProjectRun;
  readonly adaptationFile?: string;
  readonly dependencyFile?: string;
  readonly allowedHosts?: readonly string[];
  readonly dependencies?: Partial<typeof DEFAULTS>;
}) {
  const deps = { ...DEFAULTS, ...opts.dependencies };
  const selected = nativeRestartSelection({ run: opts.run });
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
  if (selected.aws) {
    input = (await deps.aws({ input, ...selected.aws })).input;
  }
  const specs = prepareNativeProjectServices(
    input,
    opts.dependencyFile !== undefined
  );
  const dependencies = await deps.dependencies({
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
    input: { ...input, normalizedComposeJson: JSON.stringify(compose) },
    run: async (review) => {
      if (review.namespace !== opts.run.namespace) {
        throw new Error(
          "Native restart configuration changed; the current graph was not stopped."
        );
      }
      if (review.planId !== opts.run.planId) {
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
      });
    },
  });
}
