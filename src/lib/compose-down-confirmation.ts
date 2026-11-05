import { isRecord } from "./guards.ts";
import { exec } from "./shell.ts";

/**
 * Whether a successful `docker compose down` really stopped a Compose project
 * before its shared helper holders are released.
 *
 * `docker compose down` runs with the current Compose file and without
 * `--remove-orphans`, so a container of a service that the file no longer
 * declares (an orphan) keeps running, and Compose can still exit 0 (a network
 * still in use is only a warning). The project's containers are therefore
 * listed by the Compose project label, not by the file's services, and the
 * holders may be released only when none of them may still run. A failed,
 * timed-out or unparseable listing is uncertain and counts as running.
 */

const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
/** Container states in which nothing runs and nothing restarts on its own. */
const NOT_RUNNING_STATES = new Set(["created", "exited", "dead"]);
const PS_FORMAT = '{"name":{{json .Names}},"state":{{json .State}}}';

export interface ComposeProjectContainer {
  readonly name: string;
  readonly state: string;
}

/** The containers labelled with a Compose project, or why they are unknown. */
export type ComposeProjectContainerListing =
  | {
      readonly ok: true;
      readonly containers: readonly ComposeProjectContainer[];
    }
  | { readonly ok: false; readonly reason: string };

type ExecRunner = (
  cmd: readonly string[],
  opts: { readonly stdin: "ignore"; readonly timeoutMs: number }
) => Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}>;

/**
 * Lists every container (any state, orphans included) whose
 * `com.docker.compose.project` label is `composeProject`. Bounded by
 * `timeoutMs`; never throws.
 */
export async function listComposeProjectContainers(opts: {
  readonly composeProject: string;
  readonly timeoutMs?: number;
  /** Test seam; defaults to the shell runner. */
  readonly run?: ExecRunner;
}): Promise<ComposeProjectContainerListing> {
  const run = opts.run ?? exec;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  let result: Awaited<ReturnType<ExecRunner>>;
  try {
    result = await run(
      [
        "docker",
        "ps",
        "--all",
        "--no-trunc",
        "--filter",
        `label=${COMPOSE_PROJECT_LABEL}=${opts.composeProject}`,
        "--format",
        PS_FORMAT,
      ],
      { stdin: "ignore", timeoutMs }
    );
  } catch (error: unknown) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "docker ps failed",
    };
  }
  if (result.exitCode === 124) {
    return { ok: false, reason: `docker ps timed out after ${timeoutMs}ms` };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      reason: `docker ps failed (exit ${result.exitCode})`,
    };
  }
  return parseComposeProjectContainers(result.stdout);
}

/** Parses the `docker ps` lines; any malformed line makes the listing unknown. */
export function parseComposeProjectContainers(
  stdout: string
): ComposeProjectContainerListing {
  const containers: ComposeProjectContainer[] = [];
  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (text.length === 0) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { ok: false, reason: "docker ps printed an unreadable line" };
    }
    if (
      !isRecord(value) ||
      typeof value.name !== "string" ||
      typeof value.state !== "string"
    ) {
      return { ok: false, reason: "docker ps printed an unexpected entry" };
    }
    containers.push({ name: value.name, state: value.state.toLowerCase() });
  }
  return { ok: true, containers };
}

/** The containers of a listing that may still run (unknown states included). */
export function containersThatMayRun(
  containers: readonly ComposeProjectContainer[]
): readonly ComposeProjectContainer[] {
  return containers.filter(
    (container) => !NOT_RUNNING_STATES.has(container.state)
  );
}

/**
 * The outcome of a Compose down for the shared helper holders. Only
 * `"stopped"` lets them be released.
 */
export type ComposeDownConfirmation =
  | { readonly containers: "stopped" }
  | {
      readonly containers: "unconfirmed";
      readonly reason:
        | { readonly kind: "down-failed"; readonly exitCode: number }
        | {
            readonly kind: "containers-remain";
            readonly remaining: readonly ComposeProjectContainer[];
          }
        | { readonly kind: "probe-failed"; readonly detail: string };
    };

/**
 * Decides whether a Compose down confirmed the project stopped. A failed down
 * is unconfirmed. After a successful down, an instance that holds no shared
 * helper needs no check (nothing would be released); otherwise the project's
 * containers are listed by label and the down is confirmed only when none may
 * still run. A listing that fails, times out, is unreadable or throws is
 * unconfirmed. Never throws.
 */
export async function confirmComposeDownStopped(opts: {
  readonly downCode: number;
  /** Helpers the instance may still hold; must not throw. */
  readonly heldHelperNames: () => Promise<readonly string[]>;
  readonly listContainers: () => Promise<ComposeProjectContainerListing>;
}): Promise<ComposeDownConfirmation> {
  if (opts.downCode !== 0) {
    return {
      containers: "unconfirmed",
      reason: { kind: "down-failed", exitCode: opts.downCode },
    };
  }
  const held = await opts.heldHelperNames().catch(() => null);
  if (held !== null && held.length === 0) {
    return { containers: "stopped" };
  }
  const listing = await opts.listContainers().catch(
    (error: unknown): ComposeProjectContainerListing => ({
      ok: false,
      reason: error instanceof Error ? error.message : "listing failed",
    })
  );
  if (!listing.ok) {
    return {
      containers: "unconfirmed",
      reason: { kind: "probe-failed", detail: listing.reason },
    };
  }
  const remaining = containersThatMayRun(listing.containers);
  if (remaining.length > 0) {
    return {
      containers: "unconfirmed",
      reason: { kind: "containers-remain", remaining },
    };
  }
  return { containers: "stopped" };
}

/**
 * Explains why a successful Compose down kept the shared helpers, or null
 * when nothing beyond the generic warning applies (the down failed or the
 * project stopped).
 */
export function describeUnconfirmedComposeDown(opts: {
  readonly composeProject: string;
  readonly confirmation: ComposeDownConfirmation;
}): string | null {
  const { confirmation } = opts;
  if (confirmation.containers === "stopped") {
    return null;
  }
  const { reason } = confirmation;
  if (reason.kind === "containers-remain") {
    const names = reason.remaining
      .map((container) => `${container.name} (${container.state})`)
      .join(", ");
    return `Compose project ${opts.composeProject} still has containers that may run after docker compose down: ${names}. Containers of services no longer in the Compose file are not removed by down. Stop them (for example with docker compose -p ${opts.composeProject} down --remove-orphans), then run hack down again.`;
  }
  if (reason.kind === "probe-failed") {
    return `Could not confirm that no container of Compose project ${opts.composeProject} still runs (${reason.detail}). Run hack down again.`;
  }
  return null;
}
