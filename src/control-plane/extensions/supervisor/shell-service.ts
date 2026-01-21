import { randomUUID } from "node:crypto";
import type { Logger } from "../../../ui/logger.ts";
import { logger as baseLogger } from "../../../ui/logger.ts";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_TERM = "xterm-256color";
const SHELL_TTL_MS = 10 * 60 * 1000;

export type ShellStatus = "running" | "exited";

export type ShellMeta = {
  readonly shellId: string;
  readonly status: ShellStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly cwd: string;
  readonly shell: string;
  readonly cols: number;
  readonly rows: number;
  readonly pid?: number;
  readonly exitCode?: number;
  readonly signal?: string | null;
};

export type ShellCreateInput = {
  readonly projectRoot: string;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly shell?: string;
  readonly cols?: number;
  readonly rows?: number;
};

export type ShellCreateResult =
  | { readonly ok: true; readonly shell: ShellMeta }
  | { readonly ok: false; readonly error: string };

export type ShellAttachment = {
  readonly meta: ShellMeta;
  readonly write: (data: string | Uint8Array) => void;
  readonly resize: (cols: number, rows: number) => void;
  readonly signal: (signal: NodeJS.Signals) => void;
  readonly close: () => void;
  readonly detach: () => void;
};

export type ShellService = {
  createShell: (opts: ShellCreateInput) => ShellCreateResult;
  getShell: (opts: { readonly shellId: string }) => ShellMeta | null;
  attachShell: (opts: {
    readonly shellId: string;
    readonly onData: (data: Uint8Array) => void;
    readonly onExit: (exitCode: number, signal: string | null) => void;
  }) => ShellAttachment | null;
  closeShell: (opts: {
    readonly shellId: string;
    readonly signal?: NodeJS.Signals;
  }) => boolean;
};

type ShellListener = {
  readonly id: string;
  readonly onData: (data: Uint8Array) => void;
  readonly onExit: (exitCode: number, signal: string | null) => void;
};

type ShellSession = {
  meta: ShellMeta;
  readonly terminal: Bun.Terminal;
  readonly proc: ReturnType<typeof Bun.spawn>;
  readonly listeners: Set<ShellListener>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
};

/**
 * Create an in-memory shell service for PTY-backed sessions.
 *
 * @param opts.logger - Optional logger override.
 * @returns Shell service helpers.
 */
export function createShellService(opts?: {
  readonly logger?: Logger;
}): ShellService {
  const logger = opts?.logger ?? baseLogger;
  const shells = new Map<string, ShellSession>();

  const createShell = (input: ShellCreateInput): ShellCreateResult => {
    const shellId = randomUUID();
    const shellRaw = (input.shell ?? process.env.SHELL ?? "/bin/bash").trim();
    const shell = shellRaw.length > 0 ? shellRaw : "/bin/bash";
    const cwd =
      input.cwd && input.cwd.trim().length > 0 ? input.cwd : input.projectRoot;
    const cols = normalizeDimension(input.cols, DEFAULT_COLS);
    const rows = normalizeDimension(input.rows, DEFAULT_ROWS);
    const createdAt = new Date().toISOString();
    const listeners = new Set<ShellListener>();

    let terminal: Bun.Terminal;
    try {
      terminal = new Bun.Terminal({
        cols,
        rows,
        data: (_term, data) => {
          for (const listener of listeners) {
            listener.onData(data);
          }
        },
        exit: (_term, exitCode) => {
          if (exitCode !== 0) {
            logger.warn({ message: `Shell PTY closed with code ${exitCode}` });
          }
        },
      });
      terminal.setRawMode(true);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to create PTY";
      return { ok: false, error: message };
    }

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([shell], {
        cwd,
        env: buildShellEnv({ env: input.env }),
        terminal,
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to start shell";
      terminal.close();
      return { ok: false, error: message };
    }

    const meta: ShellMeta = {
      shellId,
      status: "running",
      createdAt,
      updatedAt: createdAt,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.projectName ? { projectName: input.projectName } : {}),
      cwd,
      shell,
      cols,
      rows,
      ...(Number.isFinite(proc.pid) ? { pid: proc.pid } : {}),
    };

    const session: ShellSession = {
      meta,
      terminal,
      proc,
      listeners,
    };
    shells.set(shellId, session);

    proc.exited
      .then((exitCode) => {
        handleShellExit({
          shells,
          session,
          exitCode,
        });
      })
      .catch(() => {
        handleShellExit({
          shells,
          session,
          exitCode: 1,
        });
      });

    return { ok: true, shell: meta };
  };

  const getShell = (opts: { readonly shellId: string }): ShellMeta | null => {
    const session = shells.get(opts.shellId);
    return session ? session.meta : null;
  };

  const attachShell = (opts: {
    readonly shellId: string;
    readonly onData: (data: Uint8Array) => void;
    readonly onExit: (exitCode: number, signal: string | null) => void;
  }): ShellAttachment | null => {
    const session = shells.get(opts.shellId);
    if (!session) {
      return null;
    }

    const listener: ShellListener = {
      id: randomUUID(),
      onData: opts.onData,
      onExit: opts.onExit,
    };
    session.listeners.add(listener);

    if (session.meta.status === "exited") {
      opts.onExit(session.meta.exitCode ?? 0, session.meta.signal ?? null);
    }

    const detach = () => {
      session.listeners.delete(listener);
    };

    return {
      meta: session.meta,
      write: (data) => {
        session.terminal.write(data);
        touchShell(session);
      },
      resize: (cols, rows) => {
        session.terminal.resize(cols, rows);
        session.meta = {
          ...session.meta,
          cols,
          rows,
          updatedAt: new Date().toISOString(),
        };
      },
      signal: (signal) => {
        session.proc.kill(signal);
        touchShell(session);
      },
      close: () => {
        session.proc.kill();
        touchShell(session);
      },
      detach,
    };
  };

  const closeShell = (opts: {
    readonly shellId: string;
    readonly signal?: NodeJS.Signals;
  }): boolean => {
    const session = shells.get(opts.shellId);
    if (!session) {
      return false;
    }
    session.proc.kill(opts.signal ?? "SIGTERM");
    touchShell(session);
    return true;
  };

  return {
    createShell,
    getShell,
    attachShell,
    closeShell,
  };
}

function normalizeDimension(
  value: number | undefined,
  fallback: number
): number {
  if (!Number.isFinite(value) || value === undefined) {
    return fallback;
  }
  const intValue = Math.trunc(value);
  return intValue > 0 ? intValue : fallback;
}

function buildShellEnv(opts: {
  readonly env?: Record<string, string>;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  if (opts.env) {
    for (const [key, value] of Object.entries(opts.env)) {
      env[key] = value;
    }
  }
  env.TERM = process.env.TERM ?? DEFAULT_TERM;
  return env;
}

function touchShell(session: ShellSession): void {
  session.meta = {
    ...session.meta,
    updatedAt: new Date().toISOString(),
  };
}

function handleShellExit(opts: {
  readonly shells: Map<string, ShellSession>;
  readonly session: ShellSession;
  readonly exitCode: number;
}): void {
  if (opts.session.meta.status === "exited") {
    return;
  }

  opts.session.meta = {
    ...opts.session.meta,
    status: "exited",
    exitCode: opts.exitCode,
    signal: null,
    updatedAt: new Date().toISOString(),
  };

  for (const listener of opts.session.listeners) {
    listener.onExit(opts.exitCode, null);
  }

  opts.session.terminal.close();

  if (opts.session.cleanupTimer) {
    clearTimeout(opts.session.cleanupTimer);
  }

  opts.session.cleanupTimer = setTimeout(() => {
    opts.shells.delete(opts.session.meta.shellId);
  }, SHELL_TTL_MS);
}
