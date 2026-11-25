import { randomBytes } from "node:crypto";
import { HackCliError } from "./cli-result.ts";
import {
  cleanupInstruction,
  HELPER_NONCE_LABEL,
} from "./data-backup-cleanup-instruction.ts";
import {
  DATA_STEP_TIMEOUT_ENV,
  type DataBackupDeadlines,
} from "./data-backup-deadlines.ts";
import type {
  DataBackupDocker,
  DataBackupProcessResult,
  DataBackupStreamResult,
} from "./data-backup-docker.ts";
import { DATA_BACKUP_TIMEOUT_EXIT } from "./data-backup-docker.ts";
import {
  DATA_BACKUP_DIGEST_SCRIPT,
  dataBackupHelperImage,
} from "./data-backup-format.ts";
import {
  type HelperPurpose,
  helperContainerName,
  helperFailure,
  parseJsonText,
  parseTreeDigest,
  type TreeDigest,
} from "./data-backup-helper.ts";
import {
  dockerReadError,
  type InspectedVolume,
  inspectVolume,
  sameVolumeIdentity,
} from "./data-backup-volumes.ts";
import { isRecord } from "./guards.ts";

const NO_SUCH_CONTAINER = /no such (container|object)/i;
/** A full container ID, as `docker create` prints it. */
const CONTAINER_ID = /^[0-9a-f]{64}$/;
/**
 * A random per-container label. It lets a create whose outcome is unknown
 * (the client timed out or was interrupted) find the container this run
 * created, if any, without trusting the name: a name can be reused by
 * another container, an ID cannot.
 */
/** Lookups after a create that timed out: attempts and their spacing. */
export const TIMED_OUT_CREATE_LOOKUPS = 5;
export const TIMED_OUT_CREATE_LOOKUP_GAP_MS = 400;
/**
 * After a timed-out create's lookups, how long the run's live event
 * subscription is watched for that create to land before a final listing.
 * The window is only a further chance to find (and remove) the container:
 * nothing seen in it proves the create will not land later, so it never
 * settles a create as absent.
 */
export const TIMED_OUT_CREATE_SETTLE_MS = 2000;
/**
 * How the local driver refuses a reference to a missing volume (a `type`
 * option without `device`): the volume was removed after validation.
 */
const MISSING_REFERENCED_VOLUME =
  /missing required option: "?device"?|no such volume/i;
/** Docker's refusal of a bind whose source path does not exist. */
const MISSING_BIND =
  /bind source path does not exist|no such file or directory/i;

/**
 * One volume bound to one retained reference. A single helper container is
 * created with the volume's inspected `Mountpoint` bind-mounted at `/v`
 * and kept running (`sleep infinity`); every read or write of that volume
 * runs in it through `docker exec`, so all of them use the same mount. The
 * volume is never mounted by name: Docker creates a missing named volume
 * when a container mounts it, while a bind of a missing path fails, so a
 * volume removed after validation refuses and nothing is created. Only
 * plain `local` volumes (no driver options) qualify: their data is the
 * Mountpoint directory itself.
 *
 * Once the container holds the mount, the volume is inspected again and must
 * match the validated identity (CreatedAt, driver, mountpoint, options and
 * Compose labels), and the container's mount must be that directory. The helper
 * runs with no network, no logging, a read-only root, no privilege gain and
 * the pinned image.
 */
export type HeldVolume = {
  /** The helper container's ID, as its own `docker create` returned it. */
  readonly container: string;
  /** Run a command in the helper, bounded by the step deadline. */
  exec(
    args: readonly string[],
    opts?: { readonly timeoutMs?: number }
  ): Promise<DataBackupProcessResult>;
  /** Stream a command's stdout to a new file, bounded by the step deadline. */
  execToFile(
    args: readonly string[],
    path: string
  ): Promise<DataBackupStreamResult>;
  /** Run a command with a file as its stdin, bounded by the step deadline. */
  execFromFile(
    args: readonly string[],
    path: string
  ): Promise<DataBackupProcessResult>;
  /** The live tree digest of `/v`. */
  treeDigest(consequence: string): Promise<TreeDigest>;
};

/**
 * The containers one data command created, by the immutable ID each of its
 * own creates returned; never by name, which another container can reuse
 * once ours is gone. `live` holds those whose removal is not confirmed yet:
 * the signal cleanup removes exactly these. `created` keeps every ID (Docker
 * never reuses one), so the mount monitor can tell this run's container
 * starts from anyone else's.
 */
export class DataHelperContainers {
  readonly live = new Set<string>();
  readonly created = new Set<string>();
  /**
   * The run's nonce, the `io.hack.data-backup.nonce` label of every
   * container it creates, and the key of its cleanup record.
   */
  readonly nonce: string;
  private unknownOutcome = false;
  /** Names of this run's creates whose outcome stayed unknown. */
  readonly unresolved = new Set<string>();
  /** Containers with this run's nonce whose create event arrived, by name. */
  private readonly landed = new Map<string, string>();

  constructor(nonce: string = randomBytes(16).toString("hex")) {
    this.nonce = nonce;
  }

  /** A create of this run (named `name`) could not be reconciled. */
  markUnknown(name?: string): void {
    this.unknownOutcome = true;
    if (name !== undefined) {
      this.unresolved.add(name);
    }
  }

  /** A container `create` event carried this run's nonce. */
  noteLanded(name: string, id: string): void {
    this.landed.set(name, id);
  }

  /** The ID of a container of this run whose create event arrived, by name. */
  landedId(name: string): string | undefined {
    return this.landed.get(name);
  }

  /**
   * Every container this run created is confirmed removed and no create is
   * unknown: nothing of this run can be left behind.
   */
  get settled(): boolean {
    return this.live.size === 0 && !this.unknownOutcome;
  }

  add(id: string): void {
    this.live.add(id);
    this.created.add(id);
  }

  /** Docker confirmed the removal. */
  retire(id: string): void {
    this.live.delete(id);
  }
}

export type HeldVolumeRelease = {
  /** The container ID. */
  readonly container: string;
  /** True only when Docker confirms the container no longer exists. */
  readonly removed: boolean;
};

export type HoldVolumeOptions = {
  readonly docker: DataBackupDocker;
  /** The Docker volume name (never printed). */
  readonly volume: string;
  /** The Compose key, used in messages. */
  readonly label: string;
  /** The validated inspection: its Mountpoint is bound, its identity rechecked. */
  readonly identity: InspectedVolume;
  readonly readOnly: boolean;
  readonly purpose: HelperPurpose;
  readonly deadlines: DataBackupDeadlines;
  /** The containers this run created (see {@link DataHelperContainers}). */
  readonly helpers: DataHelperContainers;
  /** The refusal when the held volume is not the validated one. */
  readonly changed: () => HackCliError;
  /** What a failure leaves behind, as a sentence, for helper errors. */
  readonly consequence: string;
};

/** A step that ran past its bound; the helper container is removed after. */
function stepTimeout(opts: {
  readonly label: string;
  readonly action: string;
  readonly timeoutMs: number;
  readonly consequence: string;
}): HackCliError {
  return new HackCliError({
    code: "E_DOCKER_UNAVAILABLE",
    message: `The backup helper did not ${opts.action} volume ${opts.label} within ${opts.timeoutMs} ms, so it was stopped; ${opts.consequence} Raise the bound with ${DATA_STEP_TIMEOUT_ENV}=<ms> for a large or slow volume.`,
    detail: { reason: "step_timeout", timeoutMs: opts.timeoutMs },
  });
}

/** Turn a finished step into a refusal when it timed out or failed. */
export function requireStep<T extends { readonly exitCode: number }>(opts: {
  readonly result: T;
  readonly label: string;
  readonly action: string;
  readonly timeoutMs: number;
  readonly consequence: string;
  /** The managed values to redact from a quoted engine line. */
  readonly redactValues: readonly string[];
}): T {
  if (opts.result.exitCode === DATA_BACKUP_TIMEOUT_EXIT) {
    throw stepTimeout(opts);
  }
  // 130/143: the client was interrupted (Ctrl-C or SIGTERM reached it).
  if (opts.result.exitCode === 130 || opts.result.exitCode === 143) {
    throw new HackCliError({
      code: "E_CANCELLED",
      message: `Interrupted while the backup helper was working on volume ${opts.label}; ${opts.consequence}`,
    });
  }
  if (opts.result.exitCode !== 0) {
    throw helperFailure({
      volume: opts.label,
      action: opts.action,
      result: {
        exitCode: opts.result.exitCode,
        stderr:
          "stderr" in opts.result && typeof opts.result.stderr === "string"
            ? opts.result.stderr
            : "",
      },
      consequence: opts.consequence,
      redactValues: opts.redactValues,
    });
  }
  return opts.result;
}

function heldMountMatches(opts: {
  readonly stdout: string;
  readonly mountpoint: string;
  readonly readOnly: boolean;
}): boolean {
  const mounts = parseJsonText(opts.stdout.trim());
  if (!(Array.isArray(mounts) && mounts.length === 1)) {
    return false;
  }
  const mount: unknown = mounts[0];
  return (
    isRecord(mount) &&
    mount.Type === "bind" &&
    mount.Destination === "/v" &&
    mount.Source === opts.mountpoint &&
    mount.RW === !opts.readOnly
  );
}

/** Attempts at confirming removal, 200 ms apart (a removal already in flight). */
const REMOVAL_CHECKS = 10;

/**
 * Force-remove the helper and confirm with Docker that it is gone. A
 * concurrent removal (the signal cleanup, or Docker still tearing the
 * container down) can make one `rm` fail or one inspect still see it, so
 * the absence check is retried a few times before removal is reported as
 * unconfirmed.
 */
/**
 * Force-remove the container `container` (a full ID) and confirm with
 * Docker that it is gone; see {@link release}. Never removes a volume.
 */
export async function removeContainerConfirmed(opts: {
  readonly docker: DataBackupDocker;
  readonly container: string;
  readonly deadlines: DataBackupDeadlines;
}): Promise<boolean> {
  return (
    await release(opts).catch(
      (): HeldVolumeRelease => ({ container: opts.container, removed: false })
    )
  ).removed;
}

async function release(opts: {
  readonly docker: DataBackupDocker;
  readonly container: string;
  readonly deadlines: DataBackupDeadlines;
}): Promise<HeldVolumeRelease> {
  for (let attempt = 0; attempt < REMOVAL_CHECKS; attempt += 1) {
    if (attempt > 0) {
      await Bun.sleep(200);
    }
    await opts.docker.capture(["docker", "rm", "--force", opts.container], {
      timeoutMs: opts.deadlines.commandMs,
    });
    const gone = await opts.docker.capture(
      ["docker", "container", "inspect", "--format", "{{.Id}}", opts.container],
      { timeoutMs: opts.deadlines.commandMs }
    );
    if (gone.exitCode === 1 && NO_SUCH_CONTAINER.test(gone.stderr)) {
      return { container: opts.container, removed: true };
    }
  }
  return { container: opts.container, removed: false };
}

/** Add the unconfirmed cleanup to a refusal (or make one) and name the fix. */
function withUnconfirmedCleanup(
  failure: unknown,
  released: HeldVolumeRelease
): unknown {
  return withCleanupNote(failure, {
    note: `The helper container ${released.container} could not be confirmed removed and may still hold the volume; remove it with \`docker rm -f ${released.container}\`.`,
    cleanup: { container: released.container, removed: false },
  });
}

/**
 * Add an unknown cleanup outcome to a refusal: a `docker create` whose
 * outcome Hack could not reconcile (no ID came back, and no lookup by name
 * and nonce found it), so a container of this run may exist that Hack does
 * not track and cannot remove; it could hold a volume. The only recovery
 * instruction is `hack data cleanup --nonce <nonce>` (see
 * {@link cleanupInstruction}): no raw docker command and no endpoint value.
 */
function withUnknownCleanup(
  failure: unknown,
  opts: { readonly nonce: string; readonly docker: DataBackupDocker }
): unknown {
  const label = `${HELPER_NONCE_LABEL}=${opts.nonce}`;
  const hackCommand = cleanupInstruction({
    nonce: opts.nonce,
    hackCommand: opts.docker.hackCleanupCommand?.(opts.nonce),
  });
  return withCleanupNote(failure, {
    note: `A helper container may have been created without Hack learning its ID, so it was not removed and may hold a volume. Remove it with \`${hackCommand}\` (it finds containers by their label ${label}, on the engine this command used).`,
    cleanup: {
      container: null,
      removed: false,
      outcome: "unknown",
      label,
      hackCommand,
    },
  });
}

function withCleanupNote(
  failure: unknown,
  opts: { readonly note: string; readonly cleanup: Record<string, unknown> }
): unknown {
  const { note, cleanup } = opts;
  if (failure === undefined) {
    return new HackCliError({
      code: "E_UNEXPECTED",
      message: `Nothing was published. ${note}`,
      detail: { cleanup },
    });
  }
  if (failure instanceof HackCliError) {
    return new HackCliError({
      code: failure.code,
      message: `${failure.message} ${note}`,
      detail: {
        ...(isRecord(failure.detail) ? failure.detail : {}),
        cleanup,
      },
    });
  }
  // An unclassified failure (an EIO on the tar write, say) keeps the
  // container name and cleanup status too.
  const reason =
    failure instanceof Error && failure.message
      ? failure.message
      : String(failure);
  return new HackCliError({
    code: "E_UNEXPECTED",
    message: `The data command failed (${reason}); nothing was published. ${note}`,
    detail: { cleanup },
  });
}

/** The `docker create` arguments of a helper that holds `opts.volume`. */
function holdCreateArgs(opts: HoldVolumeOptions): string[] {
  return [
    "--network",
    "none",
    "--log-driver",
    "none",
    "--pull",
    "missing",
    "--read-only",
    "--security-opt",
    "no-new-privileges",
    "--label",
    `io.hack.data-backup=${opts.purpose}`,
    "--tmpfs",
    "/tmp",
    "--env",
    "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0",
    "--mount",
    `type=bind,src=${opts.identity.mountpoint},dst=/v${opts.readOnly ? ",readonly" : ""}`,
    "--entrypoint",
    "sleep",
    dataBackupHelperImage(),
    "infinity",
  ];
}

/** Start the created helper `container` (an ID) and prove what it holds. */
async function holdVolume(
  opts: HoldVolumeOptions & { readonly container: string }
): Promise<HeldVolume> {
  const { docker, deadlines, container } = opts;
  const started = await docker.capture(["docker", "start", container], {
    timeoutMs: deadlines.commandMs,
  });
  if (started.exitCode !== 0) {
    throw MISSING_BIND.test(started.stderr)
      ? opts.changed()
      : dockerReadError({
          result: started,
          command: "docker start",
          redactValues: docker.redactValues,
        });
  }
  // The container holds the mount now: the volume it holds must be the one
  // validated, unchanged.
  const now = await inspectVolume({ docker, name: opts.volume });
  const mounts = await docker.capture(
    [
      "docker",
      "container",
      "inspect",
      "--format",
      "{{json .Mounts}}",
      container,
    ],
    { timeoutMs: deadlines.commandMs }
  );
  if (
    now === null ||
    !sameVolumeIdentity(opts.identity, now) ||
    mounts.exitCode !== 0 ||
    !heldMountMatches({
      stdout: mounts.stdout,
      mountpoint: now.mountpoint,
      readOnly: opts.readOnly,
    })
  ) {
    throw opts.changed();
  }
  const run = (args: readonly string[], stdin: boolean): string[] => [
    "docker",
    "exec",
    ...(stdin ? ["--interactive"] : []),
    container,
    ...args,
  ];
  const held: HeldVolume = {
    container,
    exec: (args, execOpts) =>
      docker.capture(run(args, false), {
        timeoutMs: execOpts?.timeoutMs ?? deadlines.stepMs,
      }),
    execToFile: (args, path) =>
      docker.streamToFile({
        argv: run(args, false),
        path,
        timeoutMs: deadlines.stepMs,
      }),
    execFromFile: (args, path) =>
      docker.streamFromFile({
        argv: run(args, true),
        path,
        timeoutMs: deadlines.stepMs,
      }),
    async treeDigest(consequence) {
      const result = requireStep({
        result: await docker.capture(
          run(["bun", "-e", DATA_BACKUP_DIGEST_SCRIPT], false),
          { timeoutMs: deadlines.stepMs }
        ),
        label: opts.label,
        action: "digest",
        timeoutMs: deadlines.stepMs,
        consequence,
        redactValues: docker.redactValues,
      });
      return parseTreeDigest({
        stdout: result.stdout,
        label: opts.label,
        consequence,
      });
    },
  };
  return held;
}

/** Read the container ID `docker create` printed, or null. */
function createdContainerId(stdout: string): string | null {
  const id = stdout.trim();
  return CONTAINER_ID.test(id) ? id : null;
}

/**
 * After a create whose outcome is unknown, the ID of the container this run
 * created under `name`, if Docker has one: it must carry this create's
 * nonce. A container that merely has the name is someone else's.
 */
async function findOwnCreated(opts: {
  readonly docker: DataBackupDocker;
  readonly name: string;
  readonly nonce: string;
  readonly deadlines: DataBackupDeadlines;
}): Promise<
  | { readonly kind: "found"; readonly id: string }
  | { readonly kind: "absent" | "taken" | "unknown" }
> {
  const found = await opts.docker
    .capture(
      [
        "docker",
        "container",
        "inspect",
        "--format",
        `{{.Id}} {{index .Config.Labels "${HELPER_NONCE_LABEL}"}}`,
        opts.name,
      ],
      { timeoutMs: opts.deadlines.commandMs }
    )
    .catch(() => null);
  if (found === null) {
    return { kind: "unknown" };
  }
  if (found.exitCode !== 0) {
    // Docker answered that no container has the name: none of ours exists.
    return NO_SUCH_CONTAINER.test(found.stderr)
      ? { kind: "absent" }
      : { kind: "unknown" };
  }
  const [id, nonce] = found.stdout.trim().split(" ");
  if (id !== undefined && CONTAINER_ID.test(id) && nonce === opts.nonce) {
    return { kind: "found", id };
  }
  // The name is someone else's: our create under it cannot have succeeded.
  return { kind: "taken" };
}

/**
 * Create a container this run owns, named `name`, run `work` with its ID,
 * and remove it on every path. The container is tracked by the immutable ID
 * its own `docker create` returned, never by name (a name can be reused once
 * the container is gone): the ID is registered in `helpers` before
 * `work` runs, so the signal cleanup removes exactly it, and retired once
 * Docker confirms its removal. Every later call (start, exec, inspect, rm)
 * uses the ID. When the create's outcome is unknown, a container under the
 * name counts as ours only with this create's nonce label. An unconfirmed
 * removal is added to the outcome (`detail.cleanup`) and turns a success
 * into a refusal, never a silent claim of cleanup.
 */
export async function withTrackedContainer<T>(
  opts: {
    readonly docker: DataBackupDocker;
    /** A unique name, for `docker ps` readability only. */
    readonly name: string;
    /** `docker create` arguments after `--name` (options, image, command). */
    readonly createArgs: readonly string[];
    readonly createTimeoutMs: number;
    /** Throws the refusal for a failed create. */
    readonly checkCreate: (result: DataBackupProcessResult) => void;
    readonly deadlines: DataBackupDeadlines;
    readonly helpers: DataHelperContainers;
  },
  work: (container: string) => Promise<T>
): Promise<T> {
  const { created, printed, container, unknownNonce } =
    await createTracked(opts);
  if (unknownNonce !== null) {
    failUnreconciled({
      created,
      printed,
      checkCreate: opts.checkCreate,
      unknownNonce,
      docker: opts.docker,
      name: opts.name,
      helpers: opts.helpers,
    });
  }
  let failure: unknown;
  let value: T | undefined;
  let ok = false;
  try {
    requireCreated({ created, printed, checkCreate: opts.checkCreate });
    value = await work(printed as string);
    ok = true;
  } catch (error: unknown) {
    failure = error;
  }
  if (container !== null) {
    const released = await release({
      docker: opts.docker,
      container,
      deadlines: opts.deadlines,
    }).catch((): HeldVolumeRelease => ({ container, removed: false }));
    if (!released.removed) {
      throw withUnconfirmedCleanup(ok ? undefined : failure, released);
    }
    opts.helpers.retire(container);
  }
  if (!ok) {
    throw failure;
  }
  return value as T;
}

/**
 * `docker create` a container this run owns, under `name` with a fresh nonce
 * label, and register its ID in `helpers` (the ID the create printed, or,
 * when the outcome is unknown, the one a container under the name carries
 * with this nonce). `container` is null when nothing of this run exists.
 */
async function createTracked(opts: {
  readonly docker: DataBackupDocker;
  readonly name: string;
  readonly createArgs: readonly string[];
  readonly createTimeoutMs: number;
  readonly deadlines: DataBackupDeadlines;
  readonly helpers: DataHelperContainers;
}): Promise<{
  readonly created: DataBackupProcessResult;
  readonly printed: string | null;
  readonly container: string | null;
  /**
   * The create's nonce when its outcome could not be reconciled: no ID came
   * back, Docker did not refuse it outright, and the lookup by name and
   * nonce failed. A container of this run may exist untracked.
   */
  readonly unknownNonce: string | null;
}> {
  const nonce = opts.helpers.nonce;
  const created = await opts.docker.capture(
    [
      "docker",
      "create",
      "--name",
      opts.name,
      "--label",
      `${HELPER_NONCE_LABEL}=${nonce}`,
      ...opts.createArgs,
    ],
    { timeoutMs: opts.createTimeoutMs }
  );
  const printed =
    created.exitCode === 0 ? createdContainerId(created.stdout) : null;
  // A create that timed out (or was interrupted) may still be processed by
  // the daemon after the client gave up: "No such container" right after
  // it proves nothing, so the lookup is retried a few times (bounded), and
  // only finding the container settles it.
  const timedOut = INTERRUPTED_EXITS.has(created.exitCode);
  const lookup =
    printed === null
      ? await lookupOwnCreated({
          docker: opts.docker,
          name: opts.name,
          nonce,
          deadlines: opts.deadlines,
          attempts: timedOut ? TIMED_OUT_CREATE_LOOKUPS : 1,
        })
      : null;
  // The daemon refused the create outright: nothing was created.
  const refused = created.exitCode !== 0 && DAEMON_REFUSAL.test(created.stderr);
  // A timed-out create the lookups did not find may still land: watch the
  // run's live subscription for its create through a bounded window, then
  // list once more (see settleTimedOutCreate). Not finding it leaves the
  // create unknown.
  const settle =
    printed === null &&
    timedOut &&
    !refused &&
    lookup !== null &&
    lookup.kind !== "found" &&
    lookup.kind !== "taken"
      ? await settleTimedOutCreate({
          docker: opts.docker,
          name: opts.name,
          helpers: opts.helpers,
          deadlines: opts.deadlines,
        })
      : null;
  const container = printed ?? foundId(lookup) ?? foundId(settle);
  if (container !== null) {
    opts.helpers.add(container);
  }
  // Settled without a container: the name is someone else's (our create
  // cannot have succeeded), or Docker answered "no such container" for a
  // create that returned without a timeout. A timed-out or interrupted
  // create is never settled as absent: the daemon may still create it.
  const settledAbsent =
    lookup?.kind === "taken" || (lookup?.kind === "absent" && !timedOut);
  const unknownNonce =
    container === null && !refused && !settledAbsent ? nonce : null;
  return { created, printed, container, unknownNonce };
}

/**
 * A last chance to find a create that timed out and that the lookups did
 * not find. The daemon may still be processing it, so a "no such
 * container" proves nothing. Wait {@link TIMED_OUT_CREATE_SETTLE_MS} while
 * the run's event subscription watches for a container `create` with the
 * run's nonce and this name; then list containers by that label and name
 * (`docker ps -a`). A create event, or a listed container, is found (and
 * then removed by ID like any other). Anything else stays unknown: Docker
 * emits no event for a create that fails or is abandoned, so no window,
 * however quiet, proves the container will not appear later.
 */
async function settleTimedOutCreate(opts: {
  readonly docker: DataBackupDocker;
  readonly name: string;
  readonly helpers: DataHelperContainers;
  readonly deadlines: DataBackupDeadlines;
}): Promise<
  { readonly kind: "found"; readonly id: string } | { readonly kind: "unknown" }
> {
  await Bun.sleep(TIMED_OUT_CREATE_SETTLE_MS);
  const landed = opts.helpers.landedId(opts.name);
  if (landed !== undefined) {
    return { kind: "found", id: landed };
  }
  const listed = await opts.docker
    .capture(
      [
        "docker",
        "ps",
        "--all",
        "--quiet",
        "--no-trunc",
        "--filter",
        `label=${HELPER_NONCE_LABEL}=${opts.helpers.nonce}`,
        "--filter",
        `name=^${opts.name}$`,
      ],
      { timeoutMs: opts.deadlines.commandMs }
    )
    .catch(() => null);
  if (listed === null || listed.exitCode !== 0) {
    return { kind: "unknown" };
  }
  const id = listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => CONTAINER_ID.test(line));
  return id === undefined ? { kind: "unknown" } : { kind: "found", id };
}

/** The container ID a lookup or settle check found, or null. */
function foundId(
  answer: { readonly kind: string; readonly id?: string } | null
): string | null {
  return answer?.kind === "found" && answer.id !== undefined ? answer.id : null;
}

/** Exit codes of a client that was stopped before the daemon answered. */
const INTERRUPTED_EXITS = new Set([DATA_BACKUP_TIMEOUT_EXIT, 130, 143]);

/**
 * {@link findOwnCreated}, up to `attempts` times, spaced by
 * {@link TIMED_OUT_CREATE_LOOKUP_GAP_MS}, until it finds the container or
 * the name proves someone else's; the last answer otherwise.
 */
async function lookupOwnCreated(
  opts: Parameters<typeof findOwnCreated>[0] & { readonly attempts: number }
): ReturnType<typeof findOwnCreated> {
  let last: Awaited<ReturnType<typeof findOwnCreated>> = { kind: "unknown" };
  for (let attempt = 0; attempt < opts.attempts; attempt += 1) {
    if (attempt > 0) {
      await Bun.sleep(TIMED_OUT_CREATE_LOOKUP_GAP_MS);
    }
    last = await findOwnCreated(opts);
    if (last.kind === "found" || last.kind === "taken") {
      return last;
    }
  }
  return last;
}

/** A create the daemon itself answered with an error: nothing exists. */
const DAEMON_REFUSAL = /^Error response from daemon:/m;

/** Throw `failure` (or the create's own refusal) with the unknown outcome. */
function failUnreconciled(opts: {
  readonly created: DataBackupProcessResult;
  readonly printed: string | null;
  readonly checkCreate: (result: DataBackupProcessResult) => void;
  readonly unknownNonce: string;
  readonly docker: DataBackupDocker;
  readonly helpers: DataHelperContainers;
  /** The create's container name. */
  readonly name: string;
}): never {
  opts.helpers.markUnknown(opts.name);
  let failure: unknown;
  try {
    requireCreated(opts);
  } catch (error: unknown) {
    failure = error;
  }
  throw withUnknownCleanup(failure, {
    nonce: opts.unknownNonce,
    docker: opts.docker,
  });
}

/** Throw the refusal for a failed or untrackable create. */
function requireCreated(opts: {
  readonly created: DataBackupProcessResult;
  readonly printed: string | null;
  readonly checkCreate: (result: DataBackupProcessResult) => void;
}): void {
  opts.checkCreate(opts.created);
  if (opts.printed === null) {
    throw new HackCliError({
      code: "E_UNEXPECTED",
      message:
        "docker create did not print a container ID, so Hack cannot track the helper container; nothing was changed.",
    });
  }
}

/**
 * Docker references to named volumes, held while a data command reads or
 * writes them through binds. A bind of a Mountpoint is no volume reference,
 * so `docker volume rm` would succeed under it and leave the helper an
 * empty tree. Each reference is a container that is created and never
 * started (`--mount type=volume,src=<name>,dst=/v,volume-nocopy`, no
 * network, no logging, the run's nonce label), tracked by the ID its create
 * returned. While it exists Docker refuses to remove the volume, `--force`
 * included ("volume is in use"; checked on Docker 29.9.2); it starts
 * nothing and emits no mount event. Docker would create a missing named
 * volume for a plain volume mount; the reference therefore names the local
 * driver with a `type` option and no `device`, options the driver uses only
 * to create a volume and refuses ("missing required option"), so a missing
 * name refuses instead of being created while an existing volume is
 * referenced unchanged (checked on Docker 29.9.2). A caller still rechecks
 * identity once the reference exists: a volume replaced under its name in
 * between is referenced as it now is. Hack never removes or creates a
 * volume here: only the reference containers, by ID, with removal confirmed.
 */
export type VolumeReferencesOptions = {
  readonly docker: DataBackupDocker;
  readonly purpose: HelperPurpose;
  readonly deadlines: DataBackupDeadlines;
  readonly helpers: DataHelperContainers;
};

export class VolumeReferences {
  private readonly held: string[] = [];
  private readonly opts: VolumeReferencesOptions;

  constructor(opts: VolumeReferencesOptions) {
    this.opts = opts;
  }

  /** Take a reference to the volume `name` (a Docker name, never printed). */
  async add(
    name: string,
    /** The refusal when the volume no longer exists (it was removed). */
    missing: () => HackCliError
  ): Promise<void> {
    const { docker, deadlines, helpers, purpose } = this.opts;
    const referenceName = `${helperContainerName(purpose)}-ref`;
    const { created, printed, container, unknownNonce } = await createTracked({
      docker,
      name: referenceName,
      createArgs: [
        "--network",
        "none",
        "--log-driver",
        "none",
        "--pull",
        "missing",
        "--read-only",
        "--security-opt",
        "no-new-privileges",
        "--label",
        `io.hack.data-backup=${purpose}`,
        "--mount",
        // The driver options are used only to create a volume, which a
        // `type` without `device` makes the local driver refuse: a missing
        // name is refused instead of created, while an existing volume is
        // referenced unchanged (checked on Docker 29.9.2).
        `type=volume,src=${name},dst=/v,volume-nocopy,volume-driver=local,volume-opt=type=none`,
        "--entrypoint",
        "true",
        dataBackupHelperImage(),
      ],
      createTimeoutMs: deadlines.stepMs,
      deadlines,
      helpers,
    });
    if (container !== null) {
      this.held.push(container);
    }
    const checkCreate = (result: DataBackupProcessResult): void => {
      if (result.exitCode === 0) {
        return;
      }
      if (MISSING_REFERENCED_VOLUME.test(result.stderr)) {
        throw missing();
      }
      throw dockerReadError({
        result,
        command: "docker create",
        redactValues: docker.redactValues,
      });
    };
    if (unknownNonce !== null) {
      failUnreconciled({
        created,
        printed,
        checkCreate,
        unknownNonce,
        docker,
        helpers,
        name: referenceName,
      });
    }
    requireCreated({ created, printed, checkCreate });
  }

  /** Remove every reference by ID; the first unconfirmed removal, or null. */
  async releaseAll(): Promise<HeldVolumeRelease | null> {
    let unconfirmed: HeldVolumeRelease | null = null;
    for (const container of this.held.splice(0)) {
      const released = await release({
        docker: this.opts.docker,
        container,
        deadlines: this.opts.deadlines,
      }).catch((): HeldVolumeRelease => ({ container, removed: false }));
      if (released.removed) {
        this.opts.helpers.retire(container);
      } else {
        unconfirmed ??= released;
      }
    }
    return unconfirmed;
  }
}

/**
 * Run `work` with a {@link VolumeReferences} registry and remove every
 * reference it took on every path; an unconfirmed removal is reported like
 * a helper's (`detail.cleanup`).
 */
export async function withVolumeReferences<T>(
  opts: VolumeReferencesOptions,
  work: (references: VolumeReferences) => Promise<T>
): Promise<T> {
  const references = new VolumeReferences(opts);
  let failure: unknown;
  let value: T | undefined;
  let ok = false;
  try {
    value = await work(references);
    ok = true;
  } catch (error: unknown) {
    failure = error;
  }
  const unconfirmed = await references.releaseAll();
  if (unconfirmed) {
    throw withUnconfirmedCleanup(ok ? undefined : failure, unconfirmed);
  }
  if (!ok) {
    throw failure;
  }
  return value as T;
}

/**
 * Hold `opts.volume` in one helper container, run `work` against it, and
 * remove the container on every path (see {@link withTrackedContainer}).
 */
export async function withHeldVolume<T>(
  opts: HoldVolumeOptions,
  work: (held: HeldVolume) => Promise<T>
): Promise<T> {
  return await withTrackedContainer(
    {
      docker: opts.docker,
      name: helperContainerName(opts.purpose),
      createArgs: holdCreateArgs(opts),
      // Creating may pull the pinned image once.
      createTimeoutMs: opts.deadlines.stepMs,
      // A bind of a path that is gone fails instead of creating anything:
      // the volume was removed after validation.
      checkCreate: (created) => {
        if (created.exitCode !== 0) {
          throw MISSING_BIND.test(created.stderr)
            ? opts.changed()
            : dockerReadError({
                result: created,
                command: "docker create",
                redactValues: opts.docker.redactValues,
              });
        }
      },
      deadlines: opts.deadlines,
      helpers: opts.helpers,
    },
    async (container) => work(await holdVolume({ ...opts, container }))
  );
}
