import { fileURLToPath } from "node:url";
import type { ExecResult, RunOptions } from "../lib/shell.ts";
import { findExecutableInPath } from "../lib/shell.ts";
import {
  type MuxBackend,
  MuxCommandTimeoutError,
  type MuxSession,
  type MuxSessionCreateResult,
  runMuxCommand,
} from "./mux-backend.ts";
import { stageMuxEnvironment } from "./private-environment.ts";

const LIFECYCLE_OWNER_OPTION = "@hack_lifecycle_owner";
const LIFECYCLE_OWNER_ENV = "HACK_LIFECYCLE_OWNER_TOKEN";
const NO_TMUX_SERVER = /^no server running on [^\r\n]+$/;
const NUMERIC_FIELD = /^\d+$/;
const MISSING_TMUX_SOCKET =
  /^error connecting to [^\r\n]+ \(No such file or directory\)$/;

/** Quote one tmux source-file argument, without expanding environment variables. */
function tmuxQuote(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "\\$")
    .replaceAll("\t", "\\t")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")}"`;
}

/**
 * Send values over stdin; even a pre-existing server receives the new
 * session's env. Runs under {@link runMuxCommand}'s bound with the `-u`
 * client flag (HACK-1797); a timeout throws MuxCommandTimeoutError, whose
 * message names only `tmux -u`. No command input ever reaches argv.
 */
async function execTmuxSource(
  args: readonly string[],
  opts: {
    /** An exact diagnostic that carries no command input and may be kept. */
    readonly safeDiagnostic?: string;
  } = {}
): Promise<ExecResult> {
  if (args.some((arg) => arg.includes("\0"))) {
    return { exitCode: 1, stdout: "", stderr: "Invalid tmux command input" };
  }
  const result = await runMuxCommand(
    ["tmux", "-u", "start-server", ";", "source-file", "-"],
    {
      stdin: new Blob([`${args.map(tmuxQuote).join(" ")}\n`]),
    }
  );
  if (result.exitCode === 0) {
    return result;
  }
  // Parser diagnostics may quote command input, including private environment values.
  const diagnostic = result.stderr.trim();
  return {
    ...result,
    stderr:
      opts.safeDiagnostic !== undefined && diagnostic === opts.safeDiagnostic
        ? diagnostic
        : "tmux command failed",
  };
}

/** Accept only tmux's explicit absence diagnostics; other failures remain unknown. */
export function classifyTmuxSessionPresence(opts: {
  readonly result: ExecResult;
  readonly name: string;
}): "present" | "absent" | "unknown" {
  if (opts.result.exitCode === 0) {
    return "present";
  }
  const diagnostic = opts.result.stderr.trim();
  if (
    opts.result.exitCode === 1 &&
    (diagnostic === `can't find session: ${opts.name}` ||
      NO_TMUX_SERVER.test(diagnostic) ||
      MISSING_TMUX_SOCKET.test(diagnostic))
  ) {
    return "absent";
  }
  return "unknown";
}

function parseIntOrNull(value: string | undefined): number | null {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Parse `list-sessions` output in the
 * `name<TAB>attached<TAB>path<TAB>windows<TAB>created` format.
 *
 * tmux rejects tabs in session names, and the attached, windows and created
 * fields are numeric, so the path is everything between the second field and
 * the last two. That keeps a path containing tabs, spaces or other delimiter
 * characters out of the session name (HACK-1798). A line without all five
 * fields, or with a non-numeric tail, is not a session row: returning its
 * whole text as a name would print an ID that no session answers to.
 */
export function parseTmuxSessionListing(stdout: string): MuxSession[] {
  const sessions: MuxSession[] = [];
  for (const line of stdout.split("\n")) {
    const fields = line.endsWith("\r") ? line.slice(0, -1) : line;
    const parts = fields.split("\t");
    if (parts.length < 5) {
      continue;
    }
    const name = parts[0] ?? "";
    const attached = parts[1] ?? "";
    const created = parts.at(-1) ?? "";
    const windows = parts.at(-2) ?? "";
    const path = parts.slice(2, -2).join("\t");
    const numeric = [attached, windows, created].every((field) =>
      NUMERIC_FIELD.test(field)
    );
    if (!(name && numeric)) {
      continue;
    }
    sessions.push({
      backend: "tmux",
      name,
      attached: attached === "1",
      path: path || null,
      windows: parseIntOrNull(windows),
      createdAt: new Date(Number.parseInt(created, 10) * 1000).toISOString(),
    });
  }
  return sessions;
}

export function createTmuxBackend(): MuxBackend {
  const available = Boolean(findExecutableInPath("tmux"));

  const listSessions = async (): Promise<readonly MuxSession[]> => {
    if (!available) {
      return [];
    }

    const format = [
      "#{session_name}",
      "#{session_attached}",
      "#{session_path}",
      "#{session_windows}",
      "#{session_created}",
    ].join("\t");

    // `-u` keeps the tab separators intact. Without a UTF-8 locale (LANG
    // unset or C), tmux replaces control characters in client output with
    // `_`, which turns every line into one unmatched name: lifecycle
    // sessions then look absent to both `up` and `down` (HACK-1797).
    const result = await runMuxCommand(
      ["tmux", "-u", "list-sessions", "-F", format],
      {
        stdin: "ignore",
      }
    );

    if (result.exitCode !== 0) {
      return [];
    }

    return parseTmuxSessionListing(result.stdout);
  };

  const createSession = async (opts: {
    readonly name: string;
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly lifecycleOwnerToken?: string;
  }): Promise<MuxSessionCreateResult> => {
    if (!available) {
      return { ok: false, error: "tmux_unavailable" };
    }

    // These are source-file words sent over stdin, never tmux argv. The
    // owner token and environment travel with the creating command itself,
    // so no interrupted create leaves a live session without its token
    // (createsWithOwnerToken) and no separate set-option/set-environment runs.
    const args = ["new-session", "-d", "-s", opts.name];
    if (opts.cwd) {
      args.push("-c", opts.cwd);
    }
    if (opts.env) {
      for (const [key, value] of Object.entries(opts.env).sort(
        ([left], [right]) => left.localeCompare(right)
      )) {
        args.push("-e", `${key}=${value}`);
      }
    }
    if (opts.lifecycleOwnerToken) {
      args.push("-e", `${LIFECYCLE_OWNER_ENV}=${opts.lifecycleOwnerToken}`);
    }

    const result = await execTmuxSource(args, {
      // tmux's duplicate-session refusal names only the session: keep it
      // visible (describeSessionCreateFailure), scrub everything else.
      safeDiagnostic: `duplicate session: ${opts.name}`,
    });
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: "create_failed",
        stderr: result.stderr.trim(),
      };
    }

    const sessions = await listSessions();
    const session = sessions.find((s) => s.name === opts.name) ?? null;
    return { ok: true, session };
  };

  const killSession = async (opts: {
    readonly name: string;
  }): Promise<ExecResult> => {
    // `=` makes tmux match the name exactly. A bare target falls back to a
    // prefix match, so stopping `demo` after it exited could kill
    // `demo--lifecycle`, a session the caller never verified.
    return await runMuxCommand(
      ["tmux", "kill-session", "-t", `=${opts.name}`],
      {
        stdin: "ignore",
      }
    );
  };

  const readSessionPresence = async (opts: { readonly name: string }) => {
    if (!available) {
      return "unknown" as const;
    }
    const result = await runMuxCommand(
      ["tmux", "has-session", "-t", `=${opts.name}`],
      {
        stdin: "ignore",
      }
    ).catch((error: unknown) => {
      if (error instanceof MuxCommandTimeoutError) {
        return null;
      }
      throw error;
    });
    // A timed-out query proves nothing about presence.
    return result === null
      ? ("unknown" as const)
      : classifyTmuxSessionPresence({ result, name: opts.name });
  };

  const readLifecycleOwnerToken = async (opts: {
    readonly name: string;
  }): Promise<string | null> => {
    const result = await runMuxCommand(
      ["tmux", "show-options", "-v", "-t", opts.name, LIFECYCLE_OWNER_OPTION],
      {}
    );
    if (result.exitCode === 0) {
      const token = result.stdout.trim();
      if (token.length > 0) {
        return token;
      }
    }
    const environment = await runMuxCommand(
      ["tmux", "show-environment", "-t", opts.name, LIFECYCLE_OWNER_ENV],
      {}
    );
    if (environment.exitCode !== 0) {
      return null;
    }
    const assignment = environment.stdout.trim();
    const prefix = `${LIFECYCLE_OWNER_ENV}=`;
    return assignment.startsWith(prefix)
      ? assignment.slice(prefix.length)
      : null;
  };

  const listSessionWindowNames = async (opts: {
    readonly name: string;
  }): Promise<ReadonlySet<string> | null> => {
    const result = await runMuxCommand(
      ["tmux", "list-windows", "-t", opts.name, "-F", "#{window_name}"],
      {}
    );
    if (result.exitCode !== 0) {
      return null;
    }
    return new Set(
      result.stdout
        .split("\n")
        .map((name) => name.trim())
        .filter((name) => name.length > 0)
    );
  };

  const execInSession = async (opts: {
    readonly name: string;
    readonly command: string;
    readonly env?: Readonly<Record<string, string>>;
  }): Promise<ExecResult> => {
    const privateInput =
      opts.env && Object.keys(opts.env).length > 0
        ? await stageMuxEnvironment(opts.env)
        : undefined;
    const entrypoint = fileURLToPath(
      new URL("../../index.ts", import.meta.url)
    );
    const invocation = Bun.main.startsWith("/$bunfs/")
      ? [process.execPath]
      : [process.execPath, entrypoint];
    const prefix = privateInput
      ? `${[
          ...invocation,
          "--internal-mux-environment",
          privateInput.path,
          "--",
        ]
          .map(shellQuote)
          .join(" ")} `
      : "";
    try {
      const result = await execTmuxSource([
        "send-keys",
        "-t",
        opts.name,
        prefix + opts.command,
        "Enter",
      ]);
      if (result.exitCode !== 0) {
        await privateInput?.cleanup();
      }
      return result;
    } catch (error) {
      await privateInput?.cleanup();
      throw error;
    }
  };

  const sendInput = async (opts: {
    readonly name: string;
    readonly keys: string;
  }): Promise<ExecResult> => {
    return await runMuxCommand(
      ["tmux", "send-keys", "-t", opts.name, opts.keys],
      {
        stdin: "ignore",
      }
    );
  };

  return {
    name: "tmux",
    available,
    createsWithOwnerToken: true,
    listSessions,
    createSession,
    killSession,
    readSessionPresence,
    readLifecycleOwnerToken,
    listSessionWindowNames,
    execInSession,
    sendInput,
  };
}

export async function attachTmuxSession(opts: {
  readonly name: string;
  readonly run: (cmd: readonly string[], opts: RunOptions) => Promise<number>;
}): Promise<number> {
  const insideTmux = Boolean(process.env.TMUX);
  if (insideTmux) {
    return await opts.run(["tmux", "switch-client", "-t", opts.name], {
      stdin: "inherit",
    });
  }

  return await opts.run(["tmux", "attach", "-d", "-t", opts.name], {
    stdin: "inherit",
  });
}
