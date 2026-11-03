import type { ExecResult, RunOptions } from "../lib/shell.ts";
import { findExecutableInPath } from "../lib/shell.ts";

import {
  type MuxBackend,
  MuxCommandTimeoutError,
  type MuxSession,
  type MuxSessionCreateResult,
  runMuxCommand,
} from "./mux-backend.ts";

const LIFECYCLE_OWNER_OPTION = "@hack_lifecycle_owner";
const LIFECYCLE_OWNER_ENV = "HACK_LIFECYCLE_OWNER_TOKEN";
const NO_TMUX_SERVER = /^no server running on [^\r\n]+$/;
const MISSING_TMUX_SOCKET =
  /^error connecting to [^\r\n]+ \(No such file or directory\)$/;

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

function buildEnvInjectedCommand(opts: {
  readonly command: string;
  readonly env?: Readonly<Record<string, string>>;
}): string {
  if (!opts.env || Object.keys(opts.env).length === 0) {
    return opts.command;
  }

  const assignments = Object.entries(opts.env)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  return `env ${assignments} ${opts.command}`;
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

    const result = await runMuxCommand(
      ["tmux", "list-sessions", "-F", format],
      {
        stdin: "ignore",
      }
    );

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

    const args = ["tmux", "new-session", "-d", "-s", opts.name];
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

    const result = await runMuxCommand(args, {
      stdin: "ignore",
    });
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: "create_failed",
        stderr: result.stderr.trim(),
      };
    }

    if (opts.lifecycleOwnerToken) {
      const ownerResult = await runMuxCommand(
        [
          "tmux",
          "set-option",
          "-t",
          opts.name,
          LIFECYCLE_OWNER_OPTION,
          opts.lifecycleOwnerToken,
        ],
        {}
      );
      if (ownerResult.exitCode !== 0) {
        await runMuxCommand(["tmux", "kill-session", "-t", opts.name], {
          stdin: "ignore",
        });
        return {
          ok: false,
          error: "owner_metadata_failed",
          stderr: ownerResult.stderr.trim(),
        };
      }
    }

    const sessions = await listSessions();
    const session = sessions.find((s) => s.name === opts.name) ?? null;
    return { ok: true, session };
  };

  const killSession = async (opts: {
    readonly name: string;
  }): Promise<ExecResult> => {
    return await runMuxCommand(["tmux", "kill-session", "-t", opts.name], {
      stdin: "ignore",
    });
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
    return await runMuxCommand(
      [
        "tmux",
        "send-keys",
        "-t",
        opts.name,
        buildEnvInjectedCommand({
          command: opts.command,
          env: opts.env,
        }),
        "Enter",
      ],
      {
        stdin: "ignore",
      }
    );
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
