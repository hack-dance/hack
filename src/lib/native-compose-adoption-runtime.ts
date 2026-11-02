import { isRecord } from "./guards.ts";
import type { LegacyComposeVerifiedBinding } from "./native-compose-adoption-binding.ts";
import {
  legacyComposeOrderedError,
  legacyComposeOrderedRefusal,
} from "./native-compose-adoption-diagnostics.ts";
import {
  type LegacyComposeJobState,
  legacyComposeJobStates,
} from "./native-compose-adoption-jobs.ts";
import type { LegacyComposeReadinessState } from "./native-compose-adoption-readiness.ts";
import {
  createNativeComposeProbe,
  nativeComposeProbeFailure,
} from "./native-compose-ownership.ts";

const ID = /^[a-f0-9]{64}$/;
const HASH_LINE = /^([a-z0-9]+(?:-[a-z0-9]+)*) ([a-f0-9]{64})$/;
type RuntimeConfig = {
  readonly id: string;
  readonly service: string;
  readonly hash: string;
};
export type LegacyComposeContainerState = {
  readonly id: string;
  readonly running: boolean;
  readonly paused: boolean;
  readonly status: string;
};
function refuse(): never {
  throw new Error(
    "Legacy adoption runtime inspection refused; values omitted."
  );
}
function row(text: string) {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    refuse();
  }
  return parsed;
}

const ENV_OVERRIDE_SUFFIX = "/.hack/.internal/compose.env.override.yml";

/**
 * Private ordered-source fidelity check. The strict importer and generated-source
 * owner have already refused interpolation, env files and unknown
 * options. Source binds require their distinct held-directory owner. Explicit selection
 * and a null env file prevent Compose from discovering alternate inputs. Only
 * configuration hashes and engine-created hash labels are read, never container
 * environment/image values. This read-only observation grants no effect authority.
 *
 * The generated env override keeps only `${HACK_ENV_*}` references at rest
 * (HACK-1273), while each container's config-hash label was computed by Compose
 * with the resolved values. A fresh check therefore needs those values:
 * `privateInterpolationEnv` carries them into the Compose child environment
 * only, and they are never returned, logged or serialized.
 *
 * A saved-generation recheck runs without key or value delivery. When the
 * bound files include the env override and no values are supplied, `saved`
 * (the runtime config proven fresh at preparation) is required instead: each
 * retained container's engine label must still equal its saved hash. The
 * caller's saved owners separately pin the Compose copy, the generated
 * override bytes and the managed env revision, so an unchanged label means the
 * container still runs the configuration proven at preparation.
 */
export async function inspectLegacyComposeRuntimeConfig(opts: {
  readonly binding: LegacyComposeVerifiedBinding;
  readonly composeFile: string;
  readonly composeFiles?: readonly string[];
  readonly privateInterpolationEnv?: Readonly<Record<string, string>>;
  /** Saved manifest proof; validated here, so the raw saved value is accepted. */
  readonly saved?: unknown;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<
  readonly {
    readonly id: string;
    readonly service: string;
    readonly hash: string;
  }[]
> {
  const probe = createNativeComposeProbe({
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    privateInterpolationEnv: opts.privateInterpolationEnv,
  });
  const expectedFiles = [
    opts.composeFile,
    ...(opts.binding.binding_version === 2 ||
    opts.binding.binding_version === 4 ||
    opts.binding.binding_version === 6 ||
    opts.binding.binding_version === 13 ||
    opts.binding.binding_version === 14
      ? opts.binding.composeFiles.slice(1)
      : []),
  ];
  if (
    opts.composeFiles &&
    JSON.stringify(opts.composeFiles) !== JSON.stringify(expectedFiles)
  ) {
    refuse();
  }
  const savedOnly =
    opts.saved !== undefined &&
    opts.privateInterpolationEnv === undefined &&
    expectedFiles.some((file) => file.endsWith(ENV_OVERRIDE_SUFFIX));
  const hashes = savedOnly
    ? savedHashes({ binding: opts.binding, saved: opts.saved })
    : await composeHashes({
        probe,
        binding: opts.binding,
        files: expectedFiles,
      });
  const result: RuntimeConfig[] = [];
  for (const container of opts.binding.containers) {
    if (!ID.test(container.id)) {
      refuse();
    }
    const inspected = row(
      await probe([
        "container",
        "inspect",
        "--format",
        '{"id":{{json .Id}},"hash":{{json (index .Config.Labels "com.docker.compose.config-hash")}}}',
        container.id,
      ])
    );
    const hash = hashes.get(container.service);
    if (
      !hash ||
      Object.keys(inspected).sort().join() !== "hash,id" ||
      inspected.id !== container.id ||
      inspected.hash !== hash
    ) {
      refuse();
    }
    result.push(
      Object.freeze({ id: container.id, service: container.service, hash })
    );
  }
  return Object.freeze(result);
}

/** Compose's own per-service hash of the exact ordered files. */
async function composeHashes(opts: {
  readonly probe: (args: readonly string[]) => Promise<string>;
  readonly binding: LegacyComposeVerifiedBinding;
  readonly files: readonly string[];
}): Promise<Map<string, string>> {
  const output = await opts.probe([
    "compose",
    "--project-name",
    opts.binding.composeProject,
    "--project-directory",
    `${opts.binding.projectRoot}/.hack`,
    "--env-file",
    "/dev/null",
    "--profile",
    "*",
    ...opts.files.flatMap((file) => ["--file", file]),
    "config",
    "--no-env-resolution",
    "--hash",
    "*",
  ]);
  const hashes = new Map<string, string>();
  for (const line of output.trim().split("\n")) {
    const match = HASH_LINE.exec(line);
    const service = match?.[1],
      hash = match?.[2];
    if (!(service && hash) || hashes.has(service)) {
      refuse();
    }
    hashes.set(service, hash);
  }
  if (hashes.size !== opts.binding.containers.length) {
    refuse();
  }
  return hashes;
}

/** The saved per-container proof, exactly aligned with the retained binding. */
function savedHashes(opts: {
  readonly binding: LegacyComposeVerifiedBinding;
  readonly saved: unknown;
}): Map<string, string> {
  if (
    !(
      Array.isArray(opts.saved) &&
      opts.saved.length === opts.binding.containers.length
    )
  ) {
    refuse();
  }
  const hashes = new Map<string, string>();
  for (const [index, container] of opts.binding.containers.entries()) {
    const saved: unknown = opts.saved[index];
    if (
      !(
        saved &&
        isRecord(saved) &&
        Object.keys(saved).sort().join() === "hash,id,service" &&
        saved.id === container.id &&
        saved.service === container.service &&
        typeof saved.hash === "string" &&
        ID.test(saved.hash)
      ) ||
      hashes.has(container.service)
    ) {
      refuse();
    }
    hashes.set(container.service, saved.hash);
  }
  return hashes;
}

/** Minimal state observation for owned stopped adoption and retained-ID lifecycle postconditions. */
export async function inspectLegacyComposeContainerStates(opts: {
  readonly binding: LegacyComposeVerifiedBinding;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<
  readonly {
    readonly id: string;
    readonly running: boolean;
    readonly paused: boolean;
    readonly status: string;
  }[]
> {
  const probe = createNativeComposeProbe(opts);
  const result: LegacyComposeContainerState[] = [];
  for (const container of opts.binding.containers) {
    if (!ID.test(container.id)) {
      refuse();
    }
    const value = row(
      await probe([
        "container",
        "inspect",
        "--format",
        '{"id":{{json .Id}},"running":{{json .State.Running}},"paused":{{json .State.Paused}},"status":{{json .State.Status}}}',
        container.id,
      ])
    );
    if (
      Object.keys(value).sort().join() !== "id,paused,running,status" ||
      value.id !== container.id ||
      typeof value.running !== "boolean" ||
      typeof value.paused !== "boolean" ||
      typeof value.status !== "string" ||
      ![
        "created",
        "running",
        "paused",
        "restarting",
        "removing",
        "exited",
        "dead",
      ].includes(value.status)
    ) {
      refuse();
    }
    result.push(
      Object.freeze({
        id: container.id,
        running: value.running,
        paused: value.paused,
        status: value.status,
      })
    );
  }
  return Object.freeze(result);
}

/**
 * Fresh original-ID-only readiness acquisition. Does not read image defaults,
 * health output or container environment. The mutation store separately rechecks
 * exact resource/source authority before effects and before clearing its journal.
 */
export async function inspectLegacyComposeReadiness(opts: {
  readonly binding: LegacyComposeVerifiedBinding;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<readonly LegacyComposeReadinessState[]> {
  const probe = createNativeComposeProbe(opts);
  const result: LegacyComposeReadinessState[] = [];
  for (const container of opts.binding.containers) {
    if (!ID.test(container.id)) {
      refuse();
    }
    const value = row(
      await probe([
        "container",
        "inspect",
        "--format",
        '{"id":{{json .Id}},"running":{{json .State.Running}},"paused":{{json .State.Paused}},"status":{{json .State.Status}},"health":{{with (index .State "Health")}}{{json .Status}}{{else}}""{{end}}}',
        container.id,
      ])
    );
    if (
      Object.keys(value).sort().join() !== "health,id,paused,running,status" ||
      value.id !== container.id ||
      typeof value.running !== "boolean" ||
      typeof value.paused !== "boolean" ||
      typeof value.status !== "string" ||
      ![
        "created",
        "running",
        "paused",
        "restarting",
        "removing",
        "exited",
        "dead",
      ].includes(value.status) ||
      !["", "starting", "healthy", "unhealthy"].includes(String(value.health))
    ) {
      refuse();
    }
    if (
      value.health !== "" &&
      value.health !== "starting" &&
      value.health !== "healthy" &&
      value.health !== "unhealthy"
    ) {
      refuse();
    }
    result.push(
      Object.freeze({
        id: container.id,
        running: value.running,
        paused: value.paused,
        status: value.status,
        health: value.health,
      })
    );
  }
  return Object.freeze(result);
}

/** Fresh v7 job/service facts from exact original IDs. The strict codec closes the whole snapshot. */
export async function inspectLegacyComposeJobStates(opts: {
  readonly binding: LegacyComposeVerifiedBinding;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<readonly LegacyComposeJobState[]> {
  try {
    const probe = createNativeComposeProbe(opts);
    const result: unknown[] = [];
    for (const container of opts.binding.containers) {
      if (!ID.test(container.id)) {
        throw legacyComposeOrderedError({
          diagnostic: { stage: "ordered-observation", reason: "membership" },
          message:
            "Legacy adoption runtime inspection refused; values omitted.",
        });
      }
      const output = await probe([
        "container",
        "inspect",
        "--format",
        '{"id":{{json .Id}},"running":{{json .State.Running}},"paused":{{json .State.Paused}},"status":{{json .State.Status}},"health":{{with (index .State "Health")}}{{json .Status}}{{else}}""{{end}},"exitCode":{{json .State.ExitCode}},"startedAt":{{json .State.StartedAt}},"finishedAt":{{json .State.FinishedAt}},"restartPolicy":{{json .HostConfig.RestartPolicy.Name}},"maximumRetryCount":{{json .HostConfig.RestartPolicy.MaximumRetryCount}}}',
        container.id,
      ]);
      let parsed: unknown;
      try {
        parsed = JSON.parse(output);
      } catch {
        throw legacyComposeOrderedError({
          diagnostic: { stage: "ordered-observation", reason: "probe-json" },
          message:
            "Legacy adoption runtime inspection refused; values omitted.",
        });
      }
      if (!isRecord(parsed)) {
        throw legacyComposeOrderedError({
          diagnostic: { stage: "ordered-observation", reason: "probe-row" },
          message:
            "Legacy adoption runtime inspection refused; values omitted.",
        });
      }
      result.push(parsed);
    }
    return legacyComposeJobStates({ binding: opts.binding, observed: result });
  } catch (error: unknown) {
    if (legacyComposeOrderedRefusal(error)) {
      throw error;
    }
    throw legacyComposeOrderedError({
      diagnostic: {
        stage: "ordered-observation",
        reason: `probe-${nativeComposeProbeFailure(error) ?? "unknown"}`,
      },
      message: "Legacy adoption runtime inspection refused; values omitted.",
    });
  }
}
