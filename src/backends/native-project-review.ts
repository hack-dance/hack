import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { isRecord } from "../lib/guards.ts";
import {
  nativeProjectBranchArgs,
  prepareNativeProjectBranch,
} from "./native-project-branch.ts";
import type { NativeProjectInput } from "./native-project-input.ts";
import { validateNativeRestoreSelection } from "./native-project-restore.ts";
import type {
  NativeProjectRun,
  NativeProjectRunScope,
} from "./native-project-run.ts";
import {
  invokeNativeRuntime,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const DIGEST = /^[a-f0-9]{64}$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const SERVICE = /^[a-zA-Z0-9_.-]{1,128}$/;

export interface NativeProjectReview {
  readonly planId: string;
  readonly namespace: string;
  readonly report: Readonly<Record<string, unknown>>;
  /** Exact legacy fallback selection; restore must observe it again after review. */
  readonly retainedGeneration?: string;
  /** Reuse unchanged for source publication and admission within the callback. */
  readonly projectArgs: readonly string[];
}

/** Authenticated active service selection; never a stopped restore generation. */
export interface NativeActiveReviewProof {
  readonly run: string;
  readonly owner: string;
  readonly namespace: string;
  readonly plan: string;
  readonly service: string;
  readonly container: string;
  readonly boot: string;
  readonly generation: string;
}

async function selectActiveReview(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly retained: NativeProjectRun;
  readonly service: string;
  readonly invoke: typeof invokeNativeRuntime;
}): Promise<NativeActiveReviewProof> {
  const selected = await opts.invoke({
    runtime: opts.runtime,
    cwd: opts.projectRoot,
    args: [
      "graph",
      "run-selection",
      "--run-id",
      opts.retained.run,
      "--service",
      opts.service,
      "--json",
    ],
  });
  const { generation } = validateNativeRestoreSelection({
    selected,
    saved: opts.retained,
    namespace: opts.retained.namespace,
  });
  if (
    !isRecord(selected) ||
    selected.ok !== true ||
    selected.service !== opts.service ||
    typeof selected.container !== "string" ||
    !DIGEST.test(selected.container) ||
    typeof selected.boot !== "string" ||
    selected.boot.length < 1 ||
    selected.boot.length > 128 ||
    CONTROL.test(selected.boot)
  ) {
    throw new Error(
      "Native active review identity changed; the current graph was not stopped."
    );
  }
  return {
    run: opts.retained.run,
    owner: opts.retained.owner,
    namespace: opts.retained.namespace,
    plan: opts.retained.planId,
    service: opts.service,
    container: selected.container,
    boot: selected.boot,
    generation,
  };
}

function activeReviewService(plan: Readonly<Record<string, unknown>>): string {
  // `active` means profile-enabled. Native run-selection also verifies admitted
  // completed initializers; selecting their identity never executes them again.
  const services = isRecord(plan.services) ? plan.services : {};
  const service = Object.keys(services)
    .sort()
    .find(
      (key) =>
        SERVICE.test(key) &&
        isRecord(services[key]) &&
        services[key].active === true
    );
  if (!service) {
    throw new Error(
      "Native active review has no supported service authority; the current graph was not stopped."
    );
  }
  return service;
}

/** Repeat the exact active selection after compatibility review, before cleanup eligibility. */
export async function verifyNativeActiveReview(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly retained: NativeProjectRun;
  readonly proof?: NativeActiveReviewProof;
  readonly invoke?: typeof invokeNativeRuntime;
}): Promise<void> {
  if (!opts.proof) {
    return;
  }
  const current = await selectActiveReview({
    ...opts,
    service: opts.proof.service,
    invoke: opts.invoke ?? invokeNativeRuntime,
  });
  if (JSON.stringify(current) !== JSON.stringify(opts.proof)) {
    throw new Error(
      "Native active review identity changed; the current graph was not stopped."
    );
  }
}

/** Original-input identity chosen before any branch route normalization. */
export interface NativeProjectReviewIdentity {
  readonly namespace: string;
  readonly branch: string | null;
  readonly projectArgs: readonly string[];
  readonly retainedGeneration?: string;
  readonly activeProof?: NativeActiveReviewProof;
}

export async function selectNativeProjectReviewIdentity(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly composeFile: string;
  readonly profiles?: readonly string[];
  readonly branch?: string | null;
  readonly input: NativeProjectInput;
  readonly retained?: NativeProjectRun;
  readonly invoke?: typeof invokeNativeRuntime;
  readonly retainedMode?: "stopped" | "active";
}): Promise<NativeProjectReviewIdentity> {
  const file = relative(opts.projectRoot, opts.composeFile);
  if (
    !file ||
    file.startsWith("../") ||
    !DIGEST.test(opts.input.originalSha256)
  ) {
    throw new Error(
      "Native project review requires an owned original Compose file."
    );
  }
  let projectArgs = [
    "--project",
    opts.projectRoot,
    "--file",
    file,
    ...nativeProjectBranchArgs(opts.branch),
    ...(opts.profiles ?? []).flatMap((profile) => ["--profile", profile]),
  ];
  const invoke = opts.invoke ?? invokeNativeRuntime;
  const original = await invoke({
    runtime: opts.runtime,
    cwd: opts.projectRoot,
    args: ["project", "plan", ...projectArgs, "--json"],
  });
  if (
    !(isRecord(original) && isRecord(original.plan)) ||
    typeof original.plan.namespace !== "string" ||
    !DIGEST.test(original.plan.namespace) ||
    original.plan.compose_sha256 !== opts.input.originalSha256
  ) {
    throw new Error(
      "Native project input changed before review; prepare it again."
    );
  }
  let namespace = original.plan.namespace;
  let branch = opts.branch ?? null;
  let retainedGeneration: string | undefined;
  let activeProof: NativeActiveReviewProof | undefined;
  if (opts.branch && opts.retained && namespace !== opts.retained.namespace) {
    if (opts.retainedMode === "active") {
      activeProof = await selectActiveReview({
        runtime: opts.runtime,
        projectRoot: opts.projectRoot,
        retained: opts.retained,
        service: activeReviewService(original.plan),
        invoke,
      });
    } else {
      const selected = await invoke({
        runtime: opts.runtime,
        cwd: opts.projectRoot,
        args: [
          "graph",
          "restore-selection",
          "--run-id",
          opts.retained.run,
          "--json",
        ],
      });
      retainedGeneration = validateNativeRestoreSelection({
        selected,
        saved: opts.retained,
        namespace: opts.retained.namespace,
      }).generation;
    }
    const unbranchedArgs = [
      "--project",
      opts.projectRoot,
      "--file",
      file,
      ...(opts.profiles ?? []).flatMap((profile) => ["--profile", profile]),
    ];
    const unbranched = await invoke({
      runtime: opts.runtime,
      cwd: opts.projectRoot,
      args: ["project", "plan", ...unbranchedArgs, "--json"],
    });
    const canonicalProject = await realpath(opts.projectRoot);
    if (
      !(isRecord(unbranched) && isRecord(unbranched.plan)) ||
      unbranched.plan.namespace !== opts.retained.namespace ||
      original.plan.source !== canonicalProject ||
      unbranched.plan.source !== canonicalProject ||
      unbranched.plan.compose_sha256 !== opts.input.originalSha256
    ) {
      throw new Error(
        "Native retained project review changed; retained data was not adopted."
      );
    }
    projectArgs = unbranchedArgs;
    namespace = opts.retained.namespace;
    branch = null;
  }
  return {
    namespace,
    branch,
    projectArgs,
    ...(retainedGeneration ? { retainedGeneration } : {}),
    ...(activeProof ? { activeProof } : {}),
  };
}

/**
 * Native code owns namespace and plan identities. Hold only public normalized
 * bytes in a private temporary directory while the caller publishes/starts the
 * exact plan. The native side rechecks original input identity at every effect.
 * Managed values remain in the caller's in-memory input, outside this file.
 */
export async function withNativeProjectReview<T>(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly composeFile: string;
  readonly profiles?: readonly string[];
  readonly branch?: string | null;
  readonly input: NativeProjectInput;
  readonly retained?: NativeProjectRun;
  readonly invoke?: typeof invokeNativeRuntime;
  readonly retainedMode?: "stopped" | "active";
  readonly reviewIdentity?: NativeProjectReviewIdentity;
  readonly run: (review: NativeProjectReview) => Promise<T>;
}): Promise<T> {
  const identity = await selectNativeProjectReviewIdentity(opts);
  if (
    opts.reviewIdentity &&
    JSON.stringify(opts.reviewIdentity) !== JSON.stringify(identity)
  ) {
    throw new Error(
      "Native project review selection changed; retained data was not adopted."
    );
  }
  const { namespace, projectArgs, retainedGeneration } = identity;
  const invoke = opts.invoke ?? invokeNativeRuntime;
  const directory = await mkdtemp(join(tmpdir(), "hack-native-review-"));
  try {
    await chmod(directory, 0o700);
    const normalized = join(directory, "compose.json");
    await writeFile(normalized, opts.input.normalizedComposeJson, {
      mode: 0o600,
      flag: "wx",
    });
    const normalizedArgs = [
      ...projectArgs,
      "--normalized-file",
      normalized,
      "--expect-original",
      opts.input.originalSha256,
      "--expect-namespace",
      namespace,
    ];
    const report = await invoke({
      runtime: opts.runtime,
      cwd: opts.projectRoot,
      args: ["project", "plan", ...normalizedArgs, "--json"],
    });
    if (
      !(isRecord(report) && isRecord(report.plan)) ||
      typeof report.plan_id !== "string" ||
      !DIGEST.test(report.plan_id) ||
      report.plan.namespace !== namespace
    ) {
      throw new Error("Native project returned an invalid reviewed identity.");
    }
    return await opts.run({
      planId: report.plan_id,
      namespace,
      report,
      ...(retainedGeneration ? { retainedGeneration } : {}),
      projectArgs: normalizedArgs,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Choose retained native identity before rewriting any adapted route labels. */
export async function prepareNativeReviewBranch(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly phase?: "before-runtime" | "after-runtime";
  readonly scope: NativeProjectRunScope;
  readonly composeFile: string;
  readonly profiles?: readonly string[];
  readonly input: NativeProjectInput;
  readonly retained?: NativeProjectRun;
  readonly retainedMode?: "stopped" | "active";
  readonly invoke?: typeof invokeNativeRuntime;
  readonly select?: typeof selectNativeProjectReviewIdentity;
}): Promise<{
  input: NativeProjectInput;
  identity?: NativeProjectReviewIdentity;
}> {
  nativeProjectBranchArgs(opts.scope.branch);
  const deferred = Boolean(opts.retained && opts.scope.branch);
  if (
    (opts.phase === "before-runtime" && deferred) ||
    (opts.phase === "after-runtime" && !deferred)
  ) {
    return { input: opts.input };
  }
  const identity =
    opts.retained && opts.scope.branch
      ? await (opts.select ?? selectNativeProjectReviewIdentity)({
          runtime: opts.runtime,
          projectRoot: opts.scope.projectRoot,
          composeFile: opts.composeFile,
          profiles: opts.profiles,
          branch: opts.scope.branch,
          input: opts.input,
          retained: opts.retained,
          retainedMode: opts.retainedMode,
          invoke: opts.invoke,
        })
      : undefined;
  const input = await prepareNativeProjectBranch({
    input: opts.input,
    composeFile: opts.composeFile,
    scope: identity ? { ...opts.scope, branch: identity.branch } : opts.scope,
  });
  return { input, ...(identity ? { identity } : {}) };
}
