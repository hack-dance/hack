import { HackCliError } from "./cli-result.ts";
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

/**
 * One volume bound to one retained reference. A single helper container is
 * created with the volume mounted at `/v` and kept running (`sleep
 * infinity`); every read or write of that volume runs in it through
 * `docker exec`, so all of them use the same mount. Mounting by name in
 * separate containers could silently use a replacement volume, or have
 * Docker create an empty one, between steps.
 *
 * Once the container holds the mount, the volume is inspected again and must
 * match the validated identity (CreatedAt, driver, mountpoint, options and
 * Compose labels), and the container's own mount must name it. The helper
 * runs with no network, no logging, a read-only root, no privilege gain and
 * the pinned image.
 */
export type HeldVolume = {
  /** The helper container's unique name. */
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

export type HeldVolumeRelease = {
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
  /** The inspection validated before; null when the caller verifies itself. */
  readonly identity: InspectedVolume | null;
  readonly readOnly: boolean;
  readonly purpose: HelperPurpose;
  readonly deadlines: DataBackupDeadlines;
  /** Every helper name this run used; the mount monitor excludes them. */
  readonly helperNames: Set<string>;
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
    });
  }
  return opts.result;
}

function heldMountMatches(opts: {
  readonly stdout: string;
  readonly volume: string;
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
    mount.Type === "volume" &&
    mount.Name === opts.volume &&
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
  const note = `The helper container ${released.container} could not be confirmed removed and may still hold the volume; remove it with \`docker rm -f ${released.container}\`.`;
  const cleanup = { container: released.container, removed: false };
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

async function holdVolume(
  opts: HoldVolumeOptions & { readonly container: string }
): Promise<HeldVolume> {
  const { docker, deadlines, container } = opts;
  const created = await docker.capture(
    [
      "docker",
      "create",
      "--name",
      container,
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
      "--volume",
      `${opts.volume}:/v${opts.readOnly ? ":ro" : ""}`,
      "--entrypoint",
      "sleep",
      dataBackupHelperImage(),
      "infinity",
    ],
    // Creating may pull the pinned image once.
    { timeoutMs: deadlines.stepMs }
  );
  if (created.exitCode !== 0) {
    throw dockerReadError({ result: created, command: "docker create" });
  }
  const started = await docker.capture(["docker", "start", container], {
    timeoutMs: deadlines.commandMs,
  });
  if (started.exitCode !== 0) {
    throw dockerReadError({ result: started, command: "docker start" });
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
    (opts.identity !== null && !sameVolumeIdentity(opts.identity, now)) ||
    mounts.exitCode !== 0 ||
    !heldMountMatches({
      stdout: mounts.stdout,
      volume: opts.volume,
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

/**
 * Run `work` with a container this run owns, named `container`, and remove
 * it on every path: the name is registered first (so the signal cleanup and
 * the mount monitor know it, even if `work` fails halfway through creating
 * it), and removal is confirmed with Docker. An unconfirmed removal is added
 * to the outcome (`detail.cleanup`) and turns a success into a refusal,
 * never a silent claim of cleanup.
 */
export async function withTrackedContainer<T>(
  opts: {
    readonly docker: DataBackupDocker;
    readonly container: string;
    readonly deadlines: DataBackupDeadlines;
    readonly helperNames: Set<string>;
  },
  work: () => Promise<T>
): Promise<T> {
  const { container } = opts;
  opts.helperNames.add(container);
  let failure: unknown;
  let value: T | undefined;
  let ok = false;
  try {
    value = await work();
    ok = true;
  } catch (error: unknown) {
    failure = error;
  }
  const released = await release({
    docker: opts.docker,
    container,
    deadlines: opts.deadlines,
  }).catch((): HeldVolumeRelease => ({ container, removed: false }));
  if (!released.removed) {
    throw withUnconfirmedCleanup(ok ? undefined : failure, released);
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
  const container = helperContainerName(opts.purpose);
  return await withTrackedContainer({ ...opts, container }, async () =>
    work(await holdVolume({ ...opts, container }))
  );
}
