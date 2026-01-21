import { run } from "../lib/shell.ts";
import {
  dockerComposeLogsJson,
  dockerComposeLogsPretty,
} from "../ui/docker-logs.ts";
import type { LogStreamContext } from "../ui/log-stream.ts";
import { canReachLoki, lokiLogs } from "../ui/loki-logs.ts";

export type LogBackendName = "compose" | "loki";
export type LogOutputFormat = "plain" | "pretty" | "json";

export interface ComposeLogOptions {
  readonly composeFile: string;
  readonly cwd: string;
  readonly follow: boolean;
  readonly tail: number;
  readonly service?: string;
  readonly projectName?: string;
  readonly composeProject?: string;
  readonly profiles?: readonly string[];
  readonly format: LogOutputFormat;
  readonly streamContext?: LogStreamContext;
}

export interface LokiLogOptions {
  readonly baseUrl: string;
  readonly query: string;
  readonly follow: boolean;
  readonly tail: number;
  readonly format: LogOutputFormat;
  readonly showProjectPrefix: boolean;
  readonly start?: Date;
  readonly end?: Date;
  readonly streamContext?: LogStreamContext;
}

export interface LogBackend<Options> {
  readonly name: LogBackendName;
  run(opts: Options): Promise<number>;
}

export interface LogBackendAvailability {
  isAvailable(opts: { readonly baseUrl: string }): Promise<boolean>;
}

export type ComposeLogBackend = LogBackend<ComposeLogOptions>;
export type LokiLogBackend = LogBackend<LokiLogOptions> &
  LogBackendAvailability;

export const composeLogBackend: ComposeLogBackend = {
  name: "compose",
  async run(opts) {
    if (opts.format === "json") {
      return await dockerComposeLogsJson({
        composeFile: opts.composeFile,
        cwd: opts.cwd,
        follow: opts.follow,
        tail: opts.tail,
        service: opts.service,
        projectName: opts.projectName,
        composeProject: opts.composeProject,
        profiles: opts.profiles,
        streamContext: opts.streamContext,
      });
    }

    if (opts.format === "pretty") {
      return await dockerComposeLogsPretty({
        composeFile: opts.composeFile,
        cwd: opts.cwd,
        follow: opts.follow,
        tail: opts.tail,
        service: opts.service,
        projectName: opts.projectName,
        composeProject: opts.composeProject,
        profiles: opts.profiles,
      });
    }

    const cmd = [
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
      ...(opts.service ? [opts.service] : []),
    ];

    return await run(cmd, { cwd: opts.cwd });
  },
};

export const lokiLogBackend: LokiLogBackend = {
  name: "loki",
  async isAvailable({ baseUrl }) {
    return await canReachLoki({ baseUrl });
  },
  async run(opts) {
    return await lokiLogs({
      baseUrl: opts.baseUrl,
      query: opts.query,
      follow: opts.follow,
      tail: opts.tail,
      pretty: opts.format === "pretty",
      json: opts.format === "json" ? true : undefined,
      showProjectPrefix: opts.showProjectPrefix,
      streamContext: opts.streamContext,
      start: opts.start,
      end: opts.end,
    });
  },
};
