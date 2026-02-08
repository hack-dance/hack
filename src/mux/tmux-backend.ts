import type { ExecResult, RunOptions } from "../lib/shell.ts";
import { exec, findExecutableInPath } from "../lib/shell.ts";

import type {
  MuxBackend,
  MuxSession,
  MuxSessionCreateResult,
} from "./mux-backend.ts";

function parseIntOrNull(value: string | undefined): number | null {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : null;
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
  }): Promise<MuxSessionCreateResult> => {
    if (!available) {
      return { ok: false, error: "tmux_unavailable" };
    }

    const args = ["tmux", "new-session", "-d", "-s", opts.name];
    if (opts.cwd) {
      args.push("-c", opts.cwd);
    }

    const result = await exec(args, { stdin: "ignore" });
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

  const execInSession = async (opts: {
    readonly name: string;
    readonly command: string;
  }): Promise<ExecResult> => {
    return await exec(
      ["tmux", "send-keys", "-t", opts.name, opts.command, "Enter"],
      {
        stdin: "ignore",
      }
    );
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
