import { chmod, lstat, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  appendLine,
  type CommandMeta,
  commandsRoot,
  type JournalPaths,
} from "./journal.ts";

/**
 * Background audit log, `<hack home>/commands/audit.log` (0600). Starts, every
 * final outcome (whoever writes it) and cancels are recorded; reads are not.
 * Lines never hold argv, output or environment values.
 */
export async function appendCommandAudit(opts: {
  readonly root?: string;
  readonly entry: {
    readonly event: "start" | "end" | "cancel";
    readonly commandId: string;
    readonly operation: string;
    readonly projectId: string;
    readonly instanceId: string;
    readonly service: string;
    readonly caller: string;
    readonly outcome?: string;
    readonly reason?: string;
    readonly exitCode?: number | null;
  };
}): Promise<void> {
  try {
    const root = opts.root ?? commandsRoot();
    await mkdir(root, { recursive: true, mode: 0o700 });
    const stats = await lstat(root);
    if (!stats.isDirectory()) {
      return;
    }
    if ((stats.mode & 0o077) !== 0) {
      await chmod(root, 0o700);
    }
    await appendLine(
      resolve(root, "audit.log"),
      `${JSON.stringify({ ts: new Date().toISOString(), ...opts.entry })}\n`
    );
  } catch {
    // Auditing never blocks or fails a command, matching the MCP audit log.
  }
}

/** Audit line for a final record written by any writer of this journal. */
export async function auditEnd(opts: {
  readonly paths: JournalPaths;
  readonly meta: CommandMeta;
  readonly payload: Readonly<Record<string, unknown>>;
}): Promise<void> {
  const { meta, payload } = opts;
  await appendCommandAudit({
    root: dirname(opts.paths.dir),
    entry: {
      event: "end",
      commandId: meta.commandId,
      operation: meta.operation,
      projectId: meta.projectId,
      instanceId: meta.instanceId,
      service: meta.service,
      caller: meta.caller,
      outcome: String(payload.outcome),
      ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
      exitCode: typeof payload.exitCode === "number" ? payload.exitCode : null,
    },
  });
}
