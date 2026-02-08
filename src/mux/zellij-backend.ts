import type { ExecResult, RunOptions } from "../lib/shell.ts";
import { exec, findExecutableInPath } from "../lib/shell.ts";

import type {
  MuxBackend,
  MuxSession,
  MuxSessionCreateResult,
} from "./mux-backend.ts";

export function createZellijBackend(): MuxBackend {
  const available = Boolean(findExecutableInPath("zellij"));

  const listSessions = async (): Promise<readonly MuxSession[]> => {
    if (!available) {
      return [];
    }

    const result = await exec(
      ["zellij", "list-sessions", "--no-formatting", "--short"],
      {
        stdin: "ignore",
      }
    );
    if (result.exitCode !== 0) {
      return [];
    }

    const out: MuxSession[] = [];
    for (const line of result.stdout.trim().split("\n")) {
      const name = line.trim();
      if (!name) {
        continue;
      }
      out.push({
        backend: "zellij",
        name,
        attached: null,
        path: null,
        windows: null,
        createdAt: null,
      });
    }
    return out;
  };

  const createSession = async (opts: {
    readonly name: string;
    readonly cwd?: string;
  }): Promise<MuxSessionCreateResult> => {
    if (!available) {
      return { ok: false, error: "zellij_unavailable" };
    }

    // Create a detached session in the background.
    const result = await exec(
      ["zellij", "attach", "--create-background", opts.name],
      {
        stdin: "ignore",
        cwd: opts.cwd,
        env: opts.name ? { ZELLIJ_SESSION_NAME: opts.name } : undefined,
      }
    );

    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim();
      if (stderr.toLowerCase().includes("session already exists")) {
        const sessions = await listSessions();
        const session = sessions.find((s) => s.name === opts.name) ?? null;
        return { ok: true, session };
      }
      return { ok: false, error: "create_failed", stderr };
    }

    const sessions = await listSessions();
    const session = sessions.find((s) => s.name === opts.name) ?? null;
    return { ok: true, session };
  };

  const killSession = async (opts: {
    readonly name: string;
  }): Promise<ExecResult> => {
    return await exec(["zellij", "kill-session", opts.name], {
      stdin: "ignore",
    });
  };

  const execInSession = async (opts: {
    readonly name: string;
    readonly command: string;
  }): Promise<ExecResult> => {
    // `zellij run` requires an active session; set env to target the desired session.
    return await exec(["zellij", "run", "--", "sh", "-lc", opts.command], {
      stdin: "ignore",
      env: { ZELLIJ_SESSION_NAME: opts.name },
    });
  };

  const sendInput = async (opts: {
    readonly name: string;
    readonly keys: string;
  }): Promise<ExecResult> => {
    // Best-effort. This sends raw characters and does not attempt to encode special key chords.
    return await exec(["zellij", "action", "write-chars", opts.keys], {
      stdin: "ignore",
      env: { ZELLIJ_SESSION_NAME: opts.name },
    });
  };

  return {
    name: "zellij",
    available,
    listSessions,
    createSession,
    killSession,
    execInSession,
    sendInput,
  };
}

export async function attachZellijSession(opts: {
  readonly name: string;
  readonly createIfMissing: boolean;
  readonly cwd?: string;
  readonly run: (cmd: readonly string[], opts: RunOptions) => Promise<number>;
}): Promise<number> {
  const args = ["zellij", "attach", opts.name];
  if (opts.createIfMissing) {
    args.splice(2, 0, "--create");
  }
  return await opts.run(args, { stdin: "inherit", cwd: opts.cwd });
}
