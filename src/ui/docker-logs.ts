import { pathExists } from "../lib/fs.ts";
import {
  type LifecycleLogRecord,
  parseLifecycleLogRecord,
} from "../lib/lifecycle-runtime.ts";
import { readLinesFromStream } from "./lines.ts";
import { formatPrettyLogLine } from "./log-format.ts";
import { createStructuredLogGrouper } from "./log-group.ts";
import {
  type LogJsonEntry,
  parseComposeLogLine,
  writeJsonLogLine,
} from "./log-json.ts";
import type { LogStreamContext } from "./log-stream.ts";
import {
  buildLogStreamEndEvent,
  buildLogStreamLogEvent,
  buildLogStreamStartEvent,
  writeLogStreamEvent,
} from "./log-stream.ts";

const SERVICE_INSTANCE_REGEX = /^(.*?)-(\d+)$/;

type LifecycleCompanionOptions = {
  readonly logPath: string;
  readonly service?: string;
  readonly composeDisabled?: boolean;
};

type LifecycleTailHandle = {
  readonly proc: ReturnType<typeof Bun.spawn>;
  readonly stdoutTask: Promise<void>;
  readonly stderrTask: Promise<void>;
};

export interface DockerComposeLogsParams {
  readonly composeFile: string;
  readonly cwd: string;
  readonly follow: boolean;
  readonly tail: number;
  readonly service?: string;
  readonly projectName?: string;
  readonly composeProject?: string;
  readonly profiles?: readonly string[];
  readonly streamContext?: LogStreamContext;
  readonly lifecycle?: LifecycleCompanionOptions;
}

export async function dockerComposeLogsPlain(
  opts: DockerComposeLogsParams
): Promise<number> {
  const composeProc = spawnComposeLogs({
    composeFile: opts.composeFile,
    cwd: opts.cwd,
    follow: opts.follow,
    tail: opts.tail,
    service: opts.service,
    composeProject: opts.composeProject,
    profiles: opts.profiles,
    composeDisabled: opts.lifecycle?.composeDisabled === true,
  });

  const lifecycleHandle = await startLifecycleTail({
    lifecycle: opts.lifecycle,
    tail: opts.tail,
    follow: opts.follow,
    onLine: (line) => {
      const record = parseLifecycleLogRecord(line);
      if (!record) {
        return;
      }
      if (!matchesLifecycleServiceFilter(record, opts.lifecycle)) {
        return;
      }
      const stream = resolveLifecycleOutputStream(record);
      const lineText = lifecycleRecordToComposeLine({
        record,
        projectName: opts.projectName,
      });
      if (stream === "stderr") {
        process.stderr.write(`${lineText}\n`);
      } else {
        process.stdout.write(`${lineText}\n`);
      }
    },
  });

  const composeStdoutTask = composeProc
    ? consumeComposeStream({
        stream: composeProc.stdout ?? null,
        output: "stdout",
        onLine: (line) => process.stdout.write(`${line}\n`),
      })
    : Promise.resolve();
  const composeStderrTask = composeProc
    ? consumeComposeStream({
        stream: composeProc.stderr ?? null,
        output: "stderr",
        onLine: (line) => process.stderr.write(`${line}\n`),
      })
    : Promise.resolve();

  const composeExitCode = composeProc ? await composeProc.exited : null;
  await Promise.all([composeStdoutTask, composeStderrTask]);

  if (
    composeProc &&
    lifecycleHandle &&
    lifecycleHandle.proc.exitCode === null
  ) {
    lifecycleHandle.proc.kill();
  }
  const lifecycleExitCode = lifecycleHandle
    ? await lifecycleHandle.proc.exited
    : 0;
  await Promise.all([
    lifecycleHandle?.stdoutTask ?? Promise.resolve(),
    lifecycleHandle?.stderrTask ?? Promise.resolve(),
  ]);

  if (composeExitCode !== null) {
    return composeExitCode;
  }
  return lifecycleExitCode;
}

export async function dockerComposeLogsPretty(
  opts: DockerComposeLogsParams
): Promise<number> {
  const composeProc = spawnComposeLogs({
    composeFile: opts.composeFile,
    cwd: opts.cwd,
    follow: opts.follow,
    tail: opts.tail,
    service: opts.service,
    composeProject: opts.composeProject,
    profiles: opts.profiles,
    composeDisabled: opts.lifecycle?.composeDisabled === true,
  });

  const stdoutGrouper = createStructuredLogGrouper({
    write: (text) => process.stdout.write(text),
    formatLine: (line) =>
      formatPrettyLogLine({
        line,
        stream: "stdout",
        format: "docker-compose",
      }),
  });
  const stderrGrouper = createStructuredLogGrouper({
    write: (text) => process.stderr.write(text),
    formatLine: (line) =>
      formatPrettyLogLine({
        line,
        stream: "stderr",
        format: "docker-compose",
      }),
  });

  const lifecycleHandle = await startLifecycleTail({
    lifecycle: opts.lifecycle,
    tail: opts.tail,
    follow: opts.follow,
    onLine: (line) => {
      const record = parseLifecycleLogRecord(line);
      if (!record) {
        return;
      }
      if (!matchesLifecycleServiceFilter(record, opts.lifecycle)) {
        return;
      }
      const rewritten = lifecycleRecordToComposeLine({
        record,
        projectName: opts.projectName,
      });
      if (resolveLifecycleOutputStream(record) === "stderr") {
        stderrGrouper.handleLine(rewritten);
      } else {
        stdoutGrouper.handleLine(rewritten);
      }
    },
  });

  const composeStdoutTask = composeProc
    ? consumeComposeStream({
        stream: composeProc.stdout ?? null,
        output: "stdout",
        onLine: (line) => {
          const rewritten = rewriteComposePrefix({
            line,
            projectName: opts.projectName,
          });
          stdoutGrouper.handleLine(rewritten);
        },
      })
    : Promise.resolve();
  const composeStderrTask = composeProc
    ? consumeComposeStream({
        stream: composeProc.stderr ?? null,
        output: "stderr",
        onLine: (line) => {
          const rewritten = rewriteComposePrefix({
            line,
            projectName: opts.projectName,
          });
          stderrGrouper.handleLine(rewritten);
        },
      })
    : Promise.resolve();

  const composeExitCode = composeProc ? await composeProc.exited : null;
  await Promise.all([composeStdoutTask, composeStderrTask]);

  if (
    composeProc &&
    lifecycleHandle &&
    lifecycleHandle.proc.exitCode === null
  ) {
    lifecycleHandle.proc.kill();
  }
  const lifecycleExitCode = lifecycleHandle
    ? await lifecycleHandle.proc.exited
    : 0;
  await Promise.all([
    lifecycleHandle?.stdoutTask ?? Promise.resolve(),
    lifecycleHandle?.stderrTask ?? Promise.resolve(),
  ]);

  stdoutGrouper.flush();
  stderrGrouper.flush();

  if (composeExitCode !== null) {
    return composeExitCode;
  }
  return lifecycleExitCode;
}

export async function dockerComposeLogsJson(
  opts: DockerComposeLogsParams
): Promise<number> {
  const composeProc = spawnComposeLogs({
    composeFile: opts.composeFile,
    cwd: opts.cwd,
    follow: opts.follow,
    tail: opts.tail,
    service: opts.service,
    composeProject: opts.composeProject,
    profiles: opts.profiles,
    composeDisabled: opts.lifecycle?.composeDisabled === true,
  });

  if (opts.streamContext) {
    writeLogStreamEvent({
      event: buildLogStreamStartEvent({ context: opts.streamContext }),
    });
  }

  const writeEntry = (entry: LogJsonEntry) => {
    if (opts.streamContext) {
      writeLogStreamEvent({
        event: buildLogStreamLogEvent({
          context: opts.streamContext,
          entry,
        }),
      });
      return;
    }
    writeJsonLogLine(entry);
  };

  const stdoutWriter = createJsonLogWriter({
    stream: "stdout",
    projectName: opts.projectName,
    writeEntry,
  });
  const stderrWriter = createJsonLogWriter({
    stream: "stderr",
    projectName: opts.projectName,
    writeEntry,
  });

  const stdoutGrouper = createStructuredLogGrouper({
    write: stdoutWriter,
  });
  const stderrGrouper = createStructuredLogGrouper({
    write: stderrWriter,
  });

  const lifecycleHandle = await startLifecycleTail({
    lifecycle: opts.lifecycle,
    tail: opts.tail,
    follow: opts.follow,
    onLine: (line) => {
      const record = parseLifecycleLogRecord(line);
      if (!record) {
        return;
      }
      if (!matchesLifecycleServiceFilter(record, opts.lifecycle)) {
        return;
      }
      const entry = lifecycleRecordToJsonEntry({
        record,
        projectName: opts.projectName,
      });
      writeEntry(entry);
    },
  });

  const composeStdoutTask = composeProc
    ? consumeComposeStream({
        stream: composeProc.stdout ?? null,
        output: "stdout",
        onLine: (line) => stdoutGrouper.handleLine(line),
      }).then(() => stdoutGrouper.flush())
    : Promise.resolve();
  const composeStderrTask = composeProc
    ? consumeComposeStream({
        stream: composeProc.stderr ?? null,
        output: "stderr",
        onLine: (line) => stderrGrouper.handleLine(line),
      }).then(() => stderrGrouper.flush())
    : Promise.resolve();

  const composeExitCode = composeProc ? await composeProc.exited : null;
  await Promise.all([composeStdoutTask, composeStderrTask]);

  if (
    composeProc &&
    lifecycleHandle &&
    lifecycleHandle.proc.exitCode === null
  ) {
    lifecycleHandle.proc.kill();
  }
  const lifecycleExitCode = lifecycleHandle
    ? await lifecycleHandle.proc.exited
    : 0;
  await Promise.all([
    lifecycleHandle?.stdoutTask ?? Promise.resolve(),
    lifecycleHandle?.stderrTask ?? Promise.resolve(),
  ]);

  const exitCode = composeExitCode ?? lifecycleExitCode;
  if (opts.streamContext) {
    writeLogStreamEvent({
      event: buildLogStreamEndEvent({
        context: opts.streamContext,
        reason: exitCode === 0 ? "eof" : `exit:${exitCode}`,
      }),
    });
  }

  return exitCode;
}

function createJsonLogWriter(opts: {
  readonly stream: "stdout" | "stderr";
  readonly projectName?: string;
  readonly writeEntry: (entry: LogJsonEntry) => void;
}): (text: string) => void {
  return (text) => {
    const lines = text.split("\n");
    for (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }
      opts.writeEntry(
        parseComposeLogLine({
          line,
          stream: opts.stream,
          projectName: opts.projectName,
        })
      );
    }
  };
}

function spawnComposeLogs(opts: {
  readonly composeFile: string;
  readonly cwd: string;
  readonly follow: boolean;
  readonly tail: number;
  readonly service?: string;
  readonly composeProject?: string;
  readonly profiles?: readonly string[];
  readonly composeDisabled: boolean;
}): ReturnType<typeof Bun.spawn> | null {
  if (opts.composeDisabled) {
    return null;
  }
  return Bun.spawn(buildComposeLogsCommand(opts), {
    cwd: opts.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

function buildComposeLogsCommand(opts: {
  readonly composeFile: string;
  readonly follow: boolean;
  readonly tail: number;
  readonly service?: string;
  readonly composeProject?: string;
  readonly profiles?: readonly string[];
}): string[] {
  return [
    "docker",
    "compose",
    ...(opts.composeProject ? ["-p", opts.composeProject] : []),
    "-f",
    opts.composeFile,
    ...(opts.profiles
      ? opts.profiles.flatMap((profile) => ["--profile", profile] as const)
      : []),
    "logs",
    ...(opts.follow ? ["-f"] : []),
    "--tail",
    String(opts.tail),
    "--timestamps",
    "--no-color",
    ...(opts.service ? [opts.service] : []),
  ];
}

async function consumeComposeStream(opts: {
  readonly stream: ReadableStream<Uint8Array> | number | null;
  readonly output: "stdout" | "stderr";
  readonly onLine: (line: string) => void;
}): Promise<void> {
  if (!opts.stream || typeof opts.stream === "number") {
    return;
  }
  for await (const line of readLinesFromStream(opts.stream)) {
    opts.onLine(line);
  }
}

async function startLifecycleTail(opts: {
  readonly lifecycle: LifecycleCompanionOptions | undefined;
  readonly tail: number;
  readonly follow: boolean;
  readonly onLine: (line: string) => void;
}): Promise<LifecycleTailHandle | null> {
  if (!opts.lifecycle) {
    return null;
  }
  if (!(opts.follow || (await pathExists(opts.lifecycle.logPath)))) {
    return null;
  }
  const proc = Bun.spawn(
    [
      "tail",
      "-n",
      String(opts.tail),
      ...(opts.follow ? ["-F"] : []),
      opts.lifecycle.logPath,
    ],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const stdoutTask = consumeComposeStream({
    stream: proc.stdout,
    output: "stdout",
    onLine: opts.onLine,
  });
  const stderrTask = consumeComposeStream({
    stream: proc.stderr,
    output: "stderr",
    onLine: () => undefined,
  });

  return { proc, stdoutTask, stderrTask };
}

function lifecycleRecordToJsonEntry(opts: {
  readonly record: LifecycleLogRecord;
  readonly projectName?: string;
}): LogJsonEntry {
  const stream = resolveLifecycleOutputStream(opts.record);
  const parsed = parseComposeLogLine({
    line: `${opts.record.service} | ${opts.record.message}`,
    stream,
    projectName: opts.projectName,
  });
  return {
    ...parsed,
    message: opts.record.message,
    raw: opts.record.message,
    service: opts.record.service,
    timestamp: opts.record.timestamp,
    stream,
  };
}

function lifecycleRecordToComposeLine(opts: {
  readonly record: LifecycleLogRecord;
  readonly projectName?: string;
}): string {
  const service = opts.projectName
    ? `${opts.projectName}/${opts.record.service}`
    : opts.record.service;
  return `${service} | ${opts.record.message}`;
}

function resolveLifecycleOutputStream(
  record: LifecycleLogRecord
): "stdout" | "stderr" {
  if (record.stream === "stderr") {
    return "stderr";
  }
  return "stdout";
}

function matchesLifecycleServiceFilter(
  record: LifecycleLogRecord,
  lifecycle: LifecycleCompanionOptions | undefined
): boolean {
  const filter = (lifecycle?.service ?? "").trim();
  if (filter.length === 0) {
    return true;
  }
  return record.service === filter;
}

function rewriteComposePrefix(opts: {
  readonly line: string;
  readonly projectName?: string;
}): string {
  const idx = opts.line.indexOf("|");
  if (idx === -1) {
    return opts.line;
  }

  const rawPrefix = opts.line.slice(0, idx).trim();
  const after = opts.line.slice(idx + 1);
  const payload = after.startsWith(" ") ? after.slice(1) : after;

  const { service, instance } = parseComposeServiceAndInstance({
    rawPrefix,
    projectName: opts.projectName,
  });
  const displayBase = opts.projectName
    ? `${opts.projectName}/${service}`
    : service;
  const display = instance ? `${displayBase}#${instance}` : displayBase;
  return `${display} | ${payload}`;
}

function parseComposeServiceAndInstance(opts: {
  readonly rawPrefix: string;
  readonly projectName?: string;
}): { readonly service: string; readonly instance: string | null } {
  const trimmed = opts.rawPrefix.trim();
  const withoutProjectPrefix =
    opts.projectName && trimmed.startsWith(`${opts.projectName}-`)
      ? trimmed.slice(`${opts.projectName}-`.length)
      : trimmed;

  const match = withoutProjectPrefix.match(SERVICE_INSTANCE_REGEX);
  if (!match) {
    return { service: withoutProjectPrefix, instance: null };
  }

  const base = match[1] ?? "";
  const instance = match[2] ?? null;
  return { service: base.length > 0 ? base : withoutProjectPrefix, instance };
}

export function formatDockerComposeLogLineForTests(opts: {
  readonly line: string;
  readonly stream: "stdout" | "stderr";
}): string {
  return formatPrettyLogLine({ ...opts, format: "docker-compose" });
}
