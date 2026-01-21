import { readLinesFromStream } from "./lines.ts";
import { formatPrettyLogLine } from "./log-format.ts";
import { createStructuredLogGrouper } from "./log-group.ts";
import { parseComposeLogLine, writeJsonLogLine } from "./log-json.ts";
import type { LogStreamContext } from "./log-stream.ts";
import {
  buildLogStreamEndEvent,
  buildLogStreamLogEvent,
  buildLogStreamStartEvent,
  writeLogStreamEvent,
} from "./log-stream.ts";

/** Matches a service name with a trailing instance number (e.g., "myservice-1") */
const SERVICE_INSTANCE_REGEX = /^(.*?)-(\d+)$/;

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
}

export async function dockerComposeLogsPretty({
  composeFile,
  cwd,
  follow,
  tail,
  service,
  projectName,
  composeProject,
  profiles,
}: DockerComposeLogsParams): Promise<number> {
  const cmd = [
    "docker",
    "compose",
    ...(composeProject ? ["-p", composeProject] : []),
    "-f",
    composeFile,
    ...(profiles
      ? profiles.flatMap((profile) => ["--profile", profile] as const)
      : []),
    "logs",
    ...(follow ? ["-f"] : []),
    "--tail",
    String(tail),
    "--timestamps",
    "--no-color",
    ...(service ? [service] : []),
  ];

  const proc = Bun.spawn(cmd, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
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

  const stdoutTask = (async () => {
    for await (const line of readLinesFromStream(proc.stdout)) {
      const rewritten = rewriteComposePrefix({ line, projectName });
      stdoutGrouper.handleLine(rewritten);
    }
  })();

  const stderrTask = (async () => {
    for await (const line of readLinesFromStream(proc.stderr)) {
      const rewritten = rewriteComposePrefix({ line, projectName });
      stderrGrouper.handleLine(rewritten);
    }
  })();

  const exitCode = await proc.exited;
  await Promise.all([stdoutTask, stderrTask]);
  stdoutGrouper.flush();
  stderrGrouper.flush();
  return exitCode;
}

export async function dockerComposeLogsJson({
  composeFile,
  cwd,
  follow,
  tail,
  service,
  projectName,
  composeProject,
  profiles,
  streamContext,
}: DockerComposeLogsParams): Promise<number> {
  const cmd = [
    "docker",
    "compose",
    ...(composeProject ? ["-p", composeProject] : []),
    "-f",
    composeFile,
    ...(profiles
      ? profiles.flatMap((profile) => ["--profile", profile] as const)
      : []),
    "logs",
    ...(follow ? ["-f"] : []),
    "--tail",
    String(tail),
    "--timestamps",
    "--no-color",
    ...(service ? [service] : []),
  ];

  const proc = Bun.spawn(cmd, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (streamContext) {
    writeLogStreamEvent({
      event: buildLogStreamStartEvent({ context: streamContext }),
    });
  }

  const stdoutWriter = createJsonLogWriter({
    stream: "stdout",
    projectName,
    streamContext,
  });
  const stderrWriter = createJsonLogWriter({
    stream: "stderr",
    projectName,
    streamContext,
  });

  const stdoutGrouper = createStructuredLogGrouper({
    write: stdoutWriter,
  });
  const stderrGrouper = createStructuredLogGrouper({
    write: stderrWriter,
  });

  const stdoutTask = (async () => {
    for await (const line of readLinesFromStream(proc.stdout)) {
      stdoutGrouper.handleLine(line);
    }
    stdoutGrouper.flush();
  })();

  const stderrTask = (async () => {
    for await (const line of readLinesFromStream(proc.stderr)) {
      stderrGrouper.handleLine(line);
    }
    stderrGrouper.flush();
  })();

  const exitCode = await proc.exited;
  await Promise.all([stdoutTask, stderrTask]);
  if (streamContext) {
    writeLogStreamEvent({
      event: buildLogStreamEndEvent({
        context: streamContext,
        reason: exitCode === 0 ? "eof" : `exit:${exitCode}`,
      }),
    });
  }
  return exitCode;
}

function createJsonLogWriter(opts: {
  readonly stream: "stdout" | "stderr";
  readonly projectName?: string;
  readonly streamContext?: LogStreamContext;
}): (text: string) => void {
  return (text) => {
    const lines = text.split("\n");
    for (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }
      const entry = parseComposeLogLine({
        line,
        stream: opts.stream,
        projectName: opts.projectName,
      });
      if (opts.streamContext) {
        writeLogStreamEvent({
          event: buildLogStreamLogEvent({ context: opts.streamContext, entry }),
        });
      } else {
        writeJsonLogLine(entry);
      }
    }
  };
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
