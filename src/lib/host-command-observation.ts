import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, unlink } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { z } from "zod";
import { resolveGlobalHackDir } from "./config-paths.ts";
import {
  collectDescendantProcessIds,
  type ProcessSnapshotRow,
} from "./project-lifecycle-processes.ts";
import { exec, type RunOptions, run } from "./shell.ts";

export type HostLifetime = "command" | "persistent" | "bounded";
const identitySchema = z.object({
  pid: z.number().int().positive(),
  birth: z.string().nullable(),
});
const recordSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  project: z.string(),
  projectRoot: z.string(),
  executable: z.string(),
  wrapper: identitySchema,
  child: identitySchema,
  ownsProcessGroup: z.boolean(),
  processGroupId: z.number().int().positive().nullable(),
  lifetime: z.enum(["command", "persistent", "bounded"]),
  timeoutMs: z.number().positive().nullable(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  status: z.enum(["running", "exited", "cancelled", "timed_out"]),
  exitCode: z.number().int().nullable(),
  cpuTimeMs: z.number().nonnegative().nullable(),
  maxRssBytes: z.number().nonnegative().nullable(),
});
export type HostCommandRecord = z.infer<typeof recordSchema>;
type ProcessIdentity = z.infer<typeof identitySchema>;

export type ObservedProcess = ProcessSnapshotRow & {
  readonly birth: string;
  readonly elapsedMs: number;
  readonly cpuTimeMs: number;
  readonly rssBytes: number;
};
const PROCESS_DURATION = /^(?:\d+-)?\d+(?::\d+){1,2}(?:\.\d+)?$/;
const PROCESS_ROW = /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.+)$/;
const RECORD_NAME = /^[\da-f-]{36}\.json$/;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** ps uses [[days-]hours:]minutes:seconds, with optional fractional seconds. */
export function parseProcessDuration(value: string): number | null {
  if (!PROCESS_DURATION.test(value)) {
    return null;
  }
  const [days, clock] = value.includes("-") ? value.split("-") : ["0", value];
  const parts = (clock ?? "").split(":").map(Number);
  const seconds =
    parts.reduce((total, part) => total * 60 + part, 0) + Number(days) * 86_400;
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

export function parseObservedProcesses(output: string): ObservedProcess[] {
  return output.split("\n").flatMap((line) => {
    const match = PROCESS_ROW.exec(line.trim());
    if (!match) {
      return [];
    }
    const elapsedMs = parseProcessDuration(match[4] ?? "");
    const cpuTimeMs = parseProcessDuration(match[5] ?? "");
    if (elapsedMs === null || cpuTimeMs === null) {
      return [];
    }
    return [
      {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        processGroupId: Number(match[3]),
        elapsedMs,
        cpuTimeMs,
        rssBytes: Number(match[6]) * 1024,
        birth: (match[7] ?? "").replace(/\s+/g, " "),
      },
    ];
  });
}

/** Payload-free snapshot; no argv, environment, open files or output is collected. */
export async function readObservedProcesses(
  pids?: readonly number[]
): Promise<ObservedProcess[] | null> {
  try {
    const result = await exec(
      [
        "ps",
        ...(pids ? ["-p", pids.join(",")] : ["-A"]),
        "-o",
        "pid=,ppid=,pgid=,etime=,time=,rss=,lstart=",
      ],
      { stdin: "ignore", timeoutMs: 2000, env: { LC_ALL: "C" } }
    );
    return result.exitCode === 0 ? parseObservedProcesses(result.stdout) : null;
  } catch {
    return null;
  }
}

function recordRoot(): string {
  return resolve(resolveGlobalHackDir(), "host-commands");
}

async function saveRecord(record: HostCommandRecord): Promise<void> {
  const root = recordRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = resolve(root, `${record.id}.json`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await Bun.write(temporary, JSON.stringify(record), { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

/** Diagnostic records contain no arguments, shell strings, output, env names or values. */
export async function runObservedHostCommand(opts: {
  readonly command: readonly string[];
  readonly project: string;
  readonly projectRoot: string;
  readonly lifetime: HostLifetime;
  readonly runOptions: RunOptions;
}): Promise<number> {
  let record: HostCommandRecord | null = null;
  let warned = false;
  const reportFailure = (): void => {
    if (!warned) {
      process.stderr.write(
        "hack: host-command diagnostics unavailable; execution continues.\n"
      );
    }
    warned = true;
  };
  return await run(opts.command, {
    ...opts.runOptions,
    onSpawn: async ({ pid, ownsProcessGroup, processGroupId }) => {
      try {
        const startedAt = new Date().toISOString();
        const snapshot = await readObservedProcesses([process.pid, pid]);
        record = {
          version: 1,
          id: randomUUID(),
          project: opts.project,
          projectRoot: opts.projectRoot,
          executable: basename(opts.command[0] ?? "unknown"),
          wrapper: {
            pid: process.pid,
            birth:
              snapshot?.find((row) => row.pid === process.pid)?.birth ?? null,
          },
          child: {
            pid,
            birth: snapshot?.find((row) => row.pid === pid)?.birth ?? null,
          },
          ownsProcessGroup,
          processGroupId: ownsProcessGroup ? (processGroupId ?? pid) : null,
          lifetime: opts.lifetime,
          timeoutMs: opts.runOptions.timeoutMs ?? null,
          startedAt,
          finishedAt: null,
          status: "running",
          exitCode: null,
          cpuTimeMs: null,
          maxRssBytes: null,
        };
        await saveRecord(record);
      } catch {
        reportFailure();
      }
    },
    onExit: async (event) => {
      if (!record) {
        return;
      }
      try {
        const completedStatus = event.cancelled ? "cancelled" : "exited";
        await saveRecord({
          ...record,
          finishedAt: event.finishedAt,
          status: event.timedOut ? "timed_out" : completedStatus,
          exitCode: event.exitCode,
          cpuTimeMs: event.cpuTimeMs,
          maxRssBytes: event.maxRssBytes,
        });
        await expireHostCommandRecords();
      } catch {
        reportFailure();
      }
    },
  });
}

/** Schema parsing strips unknown fields, including any accidental payload data. */
export function parseHostCommandRecord(
  value: unknown
): HostCommandRecord | null {
  const parsed = recordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function readHostCommandRecords(): Promise<HostCommandRecord[]> {
  const root = recordRoot();
  const files = await readdir(root).catch(() => []);
  const records: HostCommandRecord[] = [];
  for (const name of files.filter((file) => RECORD_NAME.test(file))) {
    try {
      const record = parseHostCommandRecord(
        await Bun.file(resolve(root, name)).json()
      );
      if (record) {
        records.push(record);
      }
    } catch {
      /* A partial/unreadable record is not evidence of a running process. */
    }
  }
  return records.sort((left, right) =>
    right.startedAt.localeCompare(left.startedAt)
  );
}

/** Only expires our completed diagnostics. Active and interrupted records are preserved. */
export async function expireHostCommandRecords(): Promise<void> {
  const cutoff = Date.now() - RETENTION_MS;
  for (const record of await readHostCommandRecords()) {
    if (record.finishedAt && Date.parse(record.finishedAt) < cutoff) {
      await unlink(resolve(recordRoot(), `${record.id}.json`)).catch(
        () => undefined
      );
    }
  }
}

export function observeHostCommand(
  record: HostCommandRecord,
  snapshot: readonly ObservedProcess[] | null
) {
  const matches = (identity: ProcessIdentity): ObservedProcess | null =>
    identity.birth
      ? (snapshot?.find(
          (row) => row.pid === identity.pid && row.birth === identity.birth
        ) ?? null)
      : null;
  const wrapper = matches(record.wrapper);
  const child = matches(record.child);
  const status = observedCommandStatus({ record, snapshot, wrapper, child });
  const treeIds = new Set(
    child
      ? collectDescendantProcessIds({
          snapshot: snapshot ?? [],
          rootPids: [child.pid],
        })
      : []
  );
  const members = child
    ? (snapshot ?? []).filter(
        (row) =>
          treeIds.has(row.pid) ||
          (record.ownsProcessGroup &&
            row.processGroupId === child.processGroupId)
      )
    : [];
  const unverifiedGroupPids =
    !child && record.ownsProcessGroup
      ? (snapshot ?? [])
          .filter((row) => row.processGroupId === record.processGroupId)
          .map((row) => row.pid)
      : [];
  return {
    ...record,
    status,
    elapsedMs: Math.max(
      0,
      (record.finishedAt ? Date.parse(record.finishedAt) : Date.now()) -
        Date.parse(record.startedAt)
    ),
    observedPids: members.map((row) => row.pid),
    unverifiedGroupPids,
    liveCpuTimeMs: child
      ? members.reduce((total, row) => total + row.cpuTimeMs, 0)
      : null,
    liveRssBytes: child
      ? members.reduce((total, row) => total + row.rssBytes, 0)
      : null,
    cpuAccounting: record.finishedAt ? "reaped_child" : "live_tree_snapshot",
    ownership: child ? "pid_and_start_time" : "unverified",
    attention: unverifiedGroupPids.length
      ? "group_members_require_review"
      : commandAttention(status, record.lifetime),
  };
}

function observedCommandStatus(opts: {
  readonly record: HostCommandRecord;
  readonly snapshot: readonly ObservedProcess[] | null;
  readonly wrapper: ObservedProcess | null;
  readonly child: ObservedProcess | null;
}): string {
  if (opts.record.status !== "running") {
    return opts.record.status;
  }
  if (!(opts.snapshot && opts.record.wrapper.birth)) {
    return "unknown";
  }
  if (opts.wrapper) {
    return "running";
  }
  return opts.child ? "orphaned" : "interrupted";
}
function commandAttention(
  status: string,
  lifetime: HostLifetime
): string | null {
  if (status === "orphaned") {
    return lifetime === "persistent"
      ? "persistent_wrapper_lost"
      : "wrapper_lost";
  }
  return status === "interrupted" ? "completion_unknown" : null;
}
