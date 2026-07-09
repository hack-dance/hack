import type { ExecResult, RunOptions } from "../lib/shell.ts";
import { exec, findExecutableInPath } from "../lib/shell.ts";

import type {
  MuxBackend,
  MuxSession,
  MuxSessionCreateResult,
} from "./mux-backend.ts";

const LIFECYCLE_OWNER_TAB_PREFIX = "hack-lifecycle-owner-";
const LIFECYCLE_OWNER_TAB_PATTERN =
  /tab name="hack-lifecycle-owner-([a-zA-Z0-9-]+)"/;
const NAMED_PANE_PATTERN = /pane name="([^"]+)"/g;

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
    readonly env?: Readonly<Record<string, string>>;
    readonly lifecycleOwnerToken?: string;
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
        env: opts.env,
      }
    );

    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim();
      return { ok: false, error: "create_failed", stderr };
    }

    if (opts.lifecycleOwnerToken) {
      const ownerResult = await exec(
        [
          "zellij",
          "action",
          "rename-tab",
          `${LIFECYCLE_OWNER_TAB_PREFIX}${opts.lifecycleOwnerToken}`,
        ],
        {
          stdin: "ignore",
          env: { ZELLIJ_SESSION_NAME: opts.name },
        }
      );
      if (ownerResult.exitCode !== 0) {
        await exec(["zellij", "kill-session", opts.name], { stdin: "ignore" });
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
    return await exec(["zellij", "kill-session", opts.name], {
      stdin: "ignore",
    });
  };

  const readLifecycleOwnerToken = async (opts: {
    readonly name: string;
  }): Promise<string | null> => {
    const result = await exec(["zellij", "action", "dump-layout"], {
      stdin: "ignore",
      env: { ZELLIJ_SESSION_NAME: opts.name },
    });
    if (result.exitCode !== 0) {
      return null;
    }
    const match = result.stdout.match(LIFECYCLE_OWNER_TAB_PATTERN);
    return match?.[1] ?? null;
  };

  const listSessionWindowNames = async (opts: {
    readonly name: string;
  }): Promise<ReadonlySet<string> | null> => {
    const result = await exec(["zellij", "action", "dump-layout"], {
      stdin: "ignore",
      env: { ZELLIJ_SESSION_NAME: opts.name },
    });
    if (result.exitCode !== 0) {
      return null;
    }
    return new Set(
      [...result.stdout.matchAll(NAMED_PANE_PATTERN)]
        .map((match) => match[1]?.trim() ?? "")
        .filter((name) => name.length > 0)
    );
  };

  const execInSession = async (opts: {
    readonly name: string;
    readonly command: string;
    readonly env?: Readonly<Record<string, string>>;
  }): Promise<ExecResult> => {
    // `zellij run` requires an active session; set env to target the desired session.
    return await exec(["zellij", "run", "--", "sh", "-lc", opts.command], {
      stdin: "ignore",
      env: {
        ...(opts.env ?? {}),
        ZELLIJ_SESSION_NAME: opts.name,
      },
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
    readLifecycleOwnerToken,
    listSessionWindowNames,
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
