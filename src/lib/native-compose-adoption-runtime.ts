import { isRecord } from "./guards.ts";
import type { LegacyComposeVerifiedBinding } from "./native-compose-adoption-binding.ts";
import {
  type LegacyComposeJobState,
  legacyComposeJobStates,
} from "./native-compose-adoption-jobs.ts";
import type { LegacyComposeReadinessState } from "./native-compose-adoption-readiness.ts";
import { createNativeComposeProbe } from "./native-compose-ownership.ts";

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

/**
 * Private ordered-source fidelity check. The strict importer and generated-source
 * owner have already refused interpolation, env files, source binds and unknown
 * options. Explicit selection
 * and a null env file prevent Compose from discovering alternate inputs. Only
 * configuration hashes and engine-created hash labels are read, never container
 * environment/image values. This read-only observation grants no effect authority.
 */
export async function inspectLegacyComposeRuntimeConfig(opts: {
  readonly binding: LegacyComposeVerifiedBinding;
  readonly composeFile: string;
  readonly composeFiles?: readonly string[];
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<
  readonly {
    readonly id: string;
    readonly service: string;
    readonly hash: string;
  }[]
> {
  const probe = createNativeComposeProbe(opts);
  const expectedFiles = [
    opts.composeFile,
    ...(opts.binding.binding_version === 2 || opts.binding.binding_version === 4
      ? opts.binding.composeFiles.slice(1)
      : []),
  ];
  if (
    opts.composeFiles &&
    JSON.stringify(opts.composeFiles) !== JSON.stringify(expectedFiles)
  ) {
    refuse();
  }
  const output = await probe([
    "compose",
    "--project-name",
    opts.binding.composeProject,
    "--project-directory",
    `${opts.binding.projectRoot}/.hack`,
    "--env-file",
    "/dev/null",
    "--profile",
    "*",
    ...expectedFiles.flatMap((file) => ["--file", file]),
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
        refuse();
      }
      result.push(
        row(
          await probe([
            "container",
            "inspect",
            "--format",
            '{"id":{{json .Id}},"running":{{json .State.Running}},"paused":{{json .State.Paused}},"status":{{json .State.Status}},"health":{{with (index .State "Health")}}{{json .Status}}{{else}}""{{end}},"exitCode":{{json .State.ExitCode}},"startedAt":{{json .State.StartedAt}},"finishedAt":{{json .State.FinishedAt}},"restartPolicy":{{json .HostConfig.RestartPolicy.Name}},"maximumRetryCount":{{json .HostConfig.RestartPolicy.MaximumRetryCount}}',
            container.id,
          ])
        )
      );
    }
    return legacyComposeJobStates({ binding: opts.binding, observed: result });
  } catch {
    refuse();
  }
}
