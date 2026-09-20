import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { isRecord } from "../lib/guards.ts";
import type { NativeProjectInput } from "./native-project-input.ts";
import {
  invokeNativeRuntime,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const DIGEST = /^[a-f0-9]{64}$/;

export interface NativeProjectReview {
  readonly planId: string;
  readonly namespace: string;
  readonly report: Readonly<Record<string, unknown>>;
  /** Reuse unchanged for source publication and admission within the callback. */
  readonly projectArgs: readonly string[];
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
  readonly input: NativeProjectInput;
  readonly run: (review: NativeProjectReview) => Promise<T>;
}): Promise<T> {
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
  const projectArgs = [
    "--project",
    opts.projectRoot,
    "--file",
    file,
    ...(opts.profiles ?? []).flatMap((profile) => ["--profile", profile]),
  ];
  const original = await invokeNativeRuntime({
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
  const namespace = original.plan.namespace;
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
    const report = await invokeNativeRuntime({
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
      projectArgs: normalizedArgs,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
