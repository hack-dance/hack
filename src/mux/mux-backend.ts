import type { ExecResult } from "../lib/shell.ts";

export type MuxBackendName = "tmux" | "zellij";

export type MuxSession = {
  readonly backend: MuxBackendName;
  readonly name: string;
  readonly attached: boolean | null;
  readonly path: string | null;
  readonly windows: number | null;
  readonly createdAt: string | null;
};

export type MuxSessionCreateResult =
  | { readonly ok: true; readonly session: MuxSession | null }
  | { readonly ok: false; readonly error: string; readonly stderr?: string };

export interface MuxBackend {
  readonly name: MuxBackendName;
  readonly available: boolean;

  listSessions(): Promise<readonly MuxSession[]>;
  createSession(opts: {
    readonly name: string;
    readonly cwd?: string;
  }): Promise<MuxSessionCreateResult>;
  killSession(opts: { readonly name: string }): Promise<ExecResult>;

  execInSession(opts: {
    readonly name: string;
    readonly command: string;
  }): Promise<ExecResult>;
  sendInput(opts: {
    readonly name: string;
    readonly keys: string;
  }): Promise<ExecResult>;
}
