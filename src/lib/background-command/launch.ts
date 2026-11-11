import { lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { emitCliResult, HackCliError, okResult } from "../cli-result.ts";
import { createPrivateFileExclusive } from "../private-file.ts";
import { appendCommandAudit, auditEnd } from "./audit.ts";
import {
  type CaptureMode,
  type CommandMeta,
  type CommandOperation,
  endedEvent,
  type JournalPaths,
  JournalWriter,
  readEvents,
} from "./journal.ts";
import { describeStdin, readSessionId, spawnInNewSession } from "./platform.ts";
import { stateOf } from "./reader.ts";
import { withJournalLock } from "./recovery.ts";
import {
  type BackgroundCommandRequest,
  readBackgroundCommandConfigs,
  resolveBackgroundSettings,
} from "./settings.ts";
import { acceptCommand, cursorBeforeFirst, expiresAt } from "./store.ts";
import {
  BACKGROUND_SUPERVISOR_ARGUMENT,
  REDACT_VALUES_ENV,
} from "./supervisor.ts";

/** Set by `hack mcp serve` on its children so admission counts per MCP session. */
export const CALLER_ENV = "HACK_COMMAND_CALLER";
const OWNER_WAIT_MS = 10_000;

export type BackgroundRequest = BackgroundCommandRequest & {
  readonly requestKey: string | null;
  readonly json: boolean;
};

const REQUEST_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * Validate the background flags of `hack exec`/`hack run`. Returns null for an
 * ordinary foreground call and refuses background-only flags without
 * `--detach`, so a typo cannot silently run a command in the foreground.
 */
export function parseBackgroundRequest(options: {
  readonly detach?: boolean;
  readonly json?: boolean;
  readonly requestKey?: string;
  readonly timeoutMs?: number;
  readonly stallAfterMs?: number;
  readonly capture?: string;
}): BackgroundRequest | null {
  const backgroundOnly =
    options.json === true ||
    options.requestKey !== undefined ||
    options.timeoutMs !== undefined ||
    options.stallAfterMs !== undefined ||
    options.capture !== undefined;
  if (options.detach !== true) {
    if (backgroundOnly) {
      throw new HackCliError({
        code: "E_USAGE",
        message:
          "--json, --request-key, --timeout-ms, --stall-after-ms and --capture apply only with --detach.",
      });
    }
    return null;
  }
  if (
    options.capture !== undefined &&
    options.capture !== "full" &&
    options.capture !== "metadata"
  ) {
    throw new HackCliError({
      code: "E_USAGE",
      message: "--capture must be full or metadata.",
    });
  }
  if (
    options.requestKey !== undefined &&
    !REQUEST_KEY_PATTERN.test(options.requestKey)
  ) {
    throw new HackCliError({
      code: "E_USAGE",
      message:
        "--request-key must be 1-128 characters: letters, digits, '_', '.', ':' or '-', starting with a letter or digit.",
    });
  }
  // Bounds are checked here, before any project or runtime work.
  resolveBackgroundSettings({
    request: {
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
      ...(options.stallAfterMs === undefined
        ? {}
        : { stallAfterMs: options.stallAfterMs }),
    },
    project: {},
    global: {},
  });
  return {
    requestKey: options.requestKey ?? null,
    json: options.json === true,
    ...(options.capture === undefined
      ? {}
      : { capture: options.capture as CaptureMode }),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
    ...(options.stallAfterMs === undefined
      ? {}
      : { stallAfterMs: options.stallAfterMs }),
  };
}

/** argv that runs this same hack binary (compiled or from source). */
export function selfInvocation(): string[] {
  return [
    process.execPath,
    ...(Bun.main.startsWith("/$bunfs/")
      ? []
      : [fileURLToPath(new URL("../../../index.ts", import.meta.url))]),
  ];
}

async function resolveCaller(): Promise<string> {
  const fromEnv = (process.env[CALLER_ENV] ?? "").trim();
  if (fromEnv.length > 0 && fromEnv.length <= 128) {
    return fromEnv;
  }
  const session = await readSessionId(process.pid);
  return session === null ? "cli:unknown" : `cli:session-${session}`;
}

export type BackgroundStart = {
  readonly request: BackgroundRequest;
  readonly operation: CommandOperation;
  readonly backend: "compose" | "native";
  readonly projectId: string;
  readonly projectRoot: string;
  readonly projectDir: string | null;
  readonly instanceId: string;
  readonly service: string;
  readonly argv: readonly string[];
  readonly workdir: string | null;
  /** What the supervisor runs, with stdin closed and output in files. */
  readonly child: {
    readonly argv: readonly string[];
    readonly cwd: string;
    /** Complete environment for the child; values are never written to disk. */
    readonly env: Readonly<Record<string, string>>;
  };
  /** Values Hack already resolved for injection into this command. */
  readonly redactValues: readonly string[];
  /**
   * The launch argv without decisions Hack derived from runtime state (such
   * as `--no-deps` when the stack happens to run), so a retried request key
   * with the same inputs matches. Defaults to `child.argv`.
   */
  readonly requestIdentityArgv?: readonly string[];
  /** Selected env overlay; part of "the same request" for a request key. */
  readonly overlay: string | null;
};

/**
 * Accept and launch one background command, then print its id.
 *
 * Order: settings and refusals; `acceptCommand` persists the request (or
 * returns the earlier command for a retried request key, which is never run
 * twice); `launch.json` is written; the supervisor starts in a new session;
 * the launcher waits until the supervisor has recorded itself, so a start that
 * returns success has a live, identifiable owner.
 */
export async function startBackgroundCommand(
  opts: BackgroundStart
): Promise<number> {
  if (describeStdin() === "file") {
    throw new HackCliError({
      code: "E_USAGE",
      message:
        "Background commands run with stdin closed; input redirected from a file would be ignored. Run the command in the foreground instead.",
    });
  }
  const configs = await readBackgroundCommandConfigs({
    projectDir: opts.projectDir,
  });
  const settings = resolveBackgroundSettings({
    request: opts.request,
    ...configs,
  });
  const native = opts.backend === "native";
  const caller = await resolveCaller();
  const accepted = await acceptCommand({
    input: {
      requestKey: opts.request.requestKey,
      operation: opts.operation,
      backend: opts.backend,
      projectId: opts.projectId,
      projectRoot: opts.projectRoot,
      instanceId: opts.instanceId,
      service: opts.service,
      argv: [...opts.argv],
      workdir: opts.workdir,
      caller,
      timeoutMs: settings.timeoutMs,
      stallAfterMs: settings.stallAfterMs,
      capture: settings.capture,
      retentionMs: settings.retentionMs,
      liveOutput: native ? "unavailable" : "available",
      stallDetection:
        native || settings.capture === "metadata" ? "unavailable" : "available",
      redaction: {
        values: settings.capture === "full" ? opts.redactValues.length : 0,
      },
      fingerprintInputs: {
        operation: opts.operation,
        backend: opts.backend,
        projectRoot: opts.projectRoot,
        instanceId: opts.instanceId,
        service: opts.service,
        argv: [...opts.argv],
        workdir: opts.workdir,
        timeoutMs: settings.timeoutMs,
        stallAfterMs: settings.stallAfterMs,
        capture: settings.capture,
        // Compose project, files and profiles, or the foreground CLI argv.
        childArgv: [...(opts.requestIdentityArgv ?? opts.child.argv)],
        overlay: opts.overlay,
      },
    },
  });
  const { meta, paths } = accepted;
  if (!accepted.reused) {
    await createPrivateFileExclusive({
      path: paths.launch,
      text: JSON.stringify({ argv: opts.child.argv, cwd: opts.child.cwd }),
    });
    const supervisor = spawnInNewSession({
      argv: [
        ...selfInvocation(),
        BACKGROUND_SUPERVISOR_ARGUMENT,
        meta.commandId,
      ],
      cwd: opts.child.cwd,
      env: {
        ...opts.child.env,
        ...(settings.capture === "full" && opts.redactValues.length > 0
          ? { [REDACT_VALUES_ENV]: JSON.stringify(opts.redactValues) }
          : {}),
      },
    });
    const started = await waitForOwner({
      ownerPath: paths.owner,
      exited: supervisor.exited,
    });
    if (!(started || (await settleFailedStart({ paths, meta })))) {
      throw new HackCliError({
        code: "E_UNEXPECTED",
        message:
          "The background supervisor did not start; the command was not run.",
        detail: { commandId: meta.commandId },
      });
    }
    await appendCommandAudit({
      entry: {
        event: "start",
        commandId: meta.commandId,
        operation: meta.operation,
        projectId: meta.projectId,
        instanceId: meta.instanceId,
        service: meta.service,
        caller,
      },
    });
  }
  const events = await readEvents(paths);
  const data = {
    commandId: meta.commandId,
    cursor: cursorBeforeFirst(meta),
    state: accepted.reused ? stateOf(events) : "accepted",
    expiresAt: expiresAt(meta),
    reused: accepted.reused,
    capture: meta.capture,
    liveOutput: meta.liveOutput,
    stallDetection: meta.stallDetection,
    limits: {
      timeoutMs: meta.timeoutMs,
      stallAfterMs: meta.stallAfterMs,
      retentionMs: meta.retentionMs,
    },
  };
  if (opts.request.json) {
    emitCliResult({ result: okResult({ data }) });
  } else {
    process.stdout.write(
      `${data.commandId}\nStarted in the background${accepted.reused ? " (existing command for this request key)" : ""}. Follow it with: hack commands read ${data.commandId} --follow\n`
    );
  }
  return 0;
}

/**
 * The supervisor did not record itself in time. Under the journal lock: if
 * it has recorded itself by now, it owns the command (true). Otherwise write
 * the single final record; a supervisor that starts later finds it under the
 * same lock and exits without running anything (false).
 */
async function settleFailedStart(opts: {
  readonly paths: JournalPaths;
  readonly meta: CommandMeta;
}): Promise<boolean> {
  const { paths, meta } = opts;
  return await withJournalLock(paths, async () => {
    if (await lstat(paths.owner).catch(() => null)) {
      return true;
    }
    const events = await readEvents(paths);
    if (endedEvent(events)) {
      return false;
    }
    const ended = await new JournalWriter(
      paths,
      meta,
      events.at(-1)?.seq ?? 0
    ).write("command.ended", {
      outcome: "unknown",
      reason: "supervisor_failed_to_start",
      exitCode: null,
      signal: null,
      durationMs: 0,
      truncated: false,
      suppressed: meta.capture === "metadata",
    });
    await auditEnd({ paths, meta, payload: ended.payload });
    return false;
  });
}

async function waitForOwner(opts: {
  readonly ownerPath: string;
  readonly exited: Promise<number | null>;
}): Promise<boolean> {
  let gone = false;
  opts.exited.then(() => {
    gone = true;
  });
  const deadline = Date.now() + OWNER_WAIT_MS;
  while (Date.now() < deadline) {
    if (await lstat(opts.ownerPath).catch(() => null)) {
      return true;
    }
    if (gone) {
      return (await lstat(opts.ownerPath).catch(() => null)) !== null;
    }
    await Bun.sleep(25);
  }
  return false;
}
