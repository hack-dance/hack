import { fileURLToPath } from "node:url";
import type { ExecResult, RunOptions } from "../lib/shell.ts";
import { exec, findExecutableInPath } from "../lib/shell.ts";
import type {
  MuxBackend,
  MuxSession,
  MuxSessionCreateResult,
} from "./mux-backend.ts";
import { stageMuxEnvironment } from "./private-environment.ts";

const LIFECYCLE_OWNER_OPTION = "@hack_lifecycle_owner";
const LIFECYCLE_OWNER_ENV = "HACK_LIFECYCLE_OWNER_TOKEN";
const NO_TMUX_SERVER = /^no server running on [^\r\n]+$/;
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

/** Send values over stdin; even a pre-existing server receives the new session's env. */
async function execTmuxSource(args: readonly string[]): Promise<ExecResult> {
  if (args.some((arg) => arg.includes("\0"))) {
    return { exitCode: 1, stdout: "", stderr: "Invalid tmux command input" };
  }
  const result = await exec(["tmux", "start-server", ";", "source-file", "-"], {
    stdin: new Blob([`${args.map(tmuxQuote).join(" ")}\n`]),
    timeoutMs: 5000,
  });
  // Parser diagnostics may quote command input, including private environment values.
  return result.exitCode === 0
    ? result
    : { ...result, stderr: "tmux command failed" };
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

    const result = await exec(["tmux", "list-sessions", "-F", format], {
      stdin: "ignore",
    });

    if (result.exitCode !== 0) {
      return [];
    }

    const sessions: MuxSession[] = [];
    for (const line of result.stdout.trim().split("\n")) {
      if (!line) {
        continue;
      }
      const [name, attached, path, windows, created] = line.split("\t");
      if (!name) {
        continue;
      }

      const createdAt =
        created && created.length > 0
          ? new Date(Number.parseInt(created, 10) * 1000).toISOString()
          : null;

      sessions.push({
        backend: "tmux",
        name,
        attached: attached === "1",
        path: path || null,
        windows: parseIntOrNull(windows),
        createdAt,
      });
    }

    return sessions;
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

    const result = await execTmuxSource(args);
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
    return await exec(["tmux", "kill-session", "-t", opts.name], {
      stdin: "ignore",
    });
  };

  const readSessionPresence = async (opts: { readonly name: string }) => {
    if (!available) {
      return "unknown" as const;
    }
    const result = await exec(["tmux", "has-session", "-t", `=${opts.name}`], {
      stdin: "ignore",
    });
    return classifyTmuxSessionPresence({ result, name: opts.name });
  };

  const readLifecycleOwnerToken = async (opts: {
    readonly name: string;
  }): Promise<string | null> => {
    const result = await exec(
      ["tmux", "show-options", "-v", "-t", opts.name, LIFECYCLE_OWNER_OPTION],
      { stdin: "ignore" }
    );
    if (result.exitCode === 0) {
      const token = result.stdout.trim();
      if (token.length > 0) {
        return token;
      }
    }
    const environment = await exec(
      ["tmux", "show-environment", "-t", opts.name, LIFECYCLE_OWNER_ENV],
      { stdin: "ignore" }
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
    const result = await exec(
      ["tmux", "list-windows", "-t", opts.name, "-F", "#{window_name}"],
      { stdin: "ignore" }
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
    return await exec(["tmux", "send-keys", "-t", opts.name, opts.keys], {
      stdin: "ignore",
    });
  };

  return {
    name: "tmux",
    available,
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
