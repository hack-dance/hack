import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { DispatchRunRecord } from "../../../lib/dispatch-runs.ts";
import { ensureDir, readTextFile } from "../../../lib/fs.ts";
import type { Logger } from "../../../ui/logger.ts";
import type { ControlPlaneConfig } from "../../sdk/config.ts";
import { createGitTicketsChannel } from "./tickets-git-channel.ts";
import { unixSeconds } from "./util.ts";

const MAX_LOG_BYTES = 200_000;

const SECRET_PATTERNS = [
  {
    pattern: /(authorization:\s*bearer\s+)[^\s]+/gi,
    replacement: "$1***",
  },
  {
    pattern: /((?:token|api[_-]?key|password|secret)\s*[:=]\s*)[^\s]+/gi,
    replacement: "$1***",
  },
  {
    pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
    replacement: "gh_***",
  },
] as const;

/**
 * Mirror a dispatched run's durable artifacts to the canonical tickets git channel.
 */
export async function persistDispatchRunToTicketsChannel(input: {
  readonly projectRoot: string;
  readonly controlPlaneConfig: ControlPlaneConfig;
  readonly run: DispatchRunRecord;
  readonly actor: string;
  readonly logger: Pick<Logger, "info" | "warn">;
}): Promise<
  | { readonly ok: true; readonly didWrite: boolean }
  | { readonly ok: false; readonly error: string }
> {
  const channel = createGitTicketsChannel({
    projectRoot: input.projectRoot,
    config: input.controlPlaneConfig.tickets.git,
    logger: input.logger,
  });

  let worktreeRoot: string;
  try {
    worktreeRoot = await channel.ensureCheckedOut();
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to checkout tickets ref";
    return { ok: false, error: message };
  }

  const runDir = resolve(worktreeRoot, ".hack/tickets/runs", input.run.runId);
  await ensureDir(runDir);

  const artifacts = input.run.artifacts;
  const [summary, patch, tests, logs, manifest, events] = await Promise.all([
    readArtifactText({ path: artifacts.summaryPath }),
    readArtifactText({ path: artifacts.patchPath }),
    readArtifactText({ path: artifacts.testsPath }),
    readArtifactText({ path: artifacts.logPath }),
    readArtifactText({ path: artifacts.manifestPath }),
    readArtifactText({ path: artifacts.eventsPath }),
  ]);

  const sanitizedLogs = sanitizeText({
    text: logs,
    maxBytes: MAX_LOG_BYTES,
  });

  await Promise.all([
    Bun.write(resolve(runDir, "summary.md"), summary),
    Bun.write(resolve(runDir, "patch.diff"), patch),
    Bun.write(resolve(runDir, "tests.json"), tests),
    Bun.write(resolve(runDir, "logs.txt"), sanitizedLogs),
    Bun.write(resolve(runDir, "manifest.json"), manifest),
    Bun.write(resolve(runDir, "events.jsonl"), sanitizeText({ text: events })),
    Bun.write(
      resolve(runDir, "run.json"),
      `${JSON.stringify(input.run, null, 2)}\n`
    ),
  ]);

  const ts = unixSeconds();
  if (input.run.ticketId) {
    const persisted = await channel.appendEvents({
      events: [
        {
          eventId: randomUUID(),
          ts,
          actor: input.actor,
          ticketId: input.run.ticketId,
          type: "run.artifacts_persisted",
          payload: {
            runId: input.run.runId,
            status: input.run.status,
            nodeId: input.run.nodeId,
            projectId: input.run.projectId ?? null,
            projectName: input.run.projectName ?? null,
            branch: input.run.branch ?? null,
            path: `.hack/tickets/runs/${input.run.runId}`,
          },
        },
      ],
    });
    if (!persisted.ok) {
      return persisted;
    }
    return { ok: true, didWrite: true };
  }

  const synced = await channel.sync();
  if (!synced.ok) {
    return synced;
  }
  return { ok: true, didWrite: synced.didCommit || synced.didPush };
}

async function readArtifactText(input: {
  readonly path: string;
}): Promise<string> {
  return (await readTextFile(input.path)) ?? "";
}

function sanitizeText(input: {
  readonly text: string;
  readonly maxBytes?: number;
}): string {
  let next = input.text;
  for (const entry of SECRET_PATTERNS) {
    next = next.replaceAll(entry.pattern, entry.replacement);
  }
  const maxBytes = input.maxBytes;
  if (maxBytes && next.length > maxBytes) {
    const suffix = "\n\n[truncated]\n";
    next = `${next.slice(next.length - maxBytes)}${suffix}`;
  }
  if (!next.endsWith("\n")) {
    next = `${next}\n`;
  }
  return next;
}
