import { isRecord } from "../lib/guards.ts";
import { adaptNativeAwsEnvironment } from "./native-aws-environment.ts";
import { prepareNativeProjectAdaptation } from "./native-project-adaptation.ts";
import {
  prepareNativeDependencyServices,
  readNativeHostDependencies,
} from "./native-project-dependencies.ts";
import { prepareNativeProjectInput } from "./native-project-input.ts";
import { validateNativeAllowedHosts } from "./native-project-network.ts";
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
    run: (review) => {
      if (
        review.namespace !== opts.run.namespace ||
        review.planId !== opts.run.planId
      ) {
        throw new Error(
          "Native restart configuration changed; the current graph was not stopped."
        );
      }
      return Promise.resolve();
    },
  });
}
