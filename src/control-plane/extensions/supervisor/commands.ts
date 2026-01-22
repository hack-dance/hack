import { isAbsolute, resolve } from "node:path";

import { requestDaemonJson } from "../../../daemon/client.ts";
import { resolveGlobalConfigPath } from "../../../lib/config-paths.ts";
import { isRecord } from "../../../lib/guards.ts";
import { resolveHackInvocation } from "../../../lib/hack-cli.ts";
import type { ProjectContext } from "../../../lib/project.ts";
import {
  findProjectContext,
  sanitizeProjectSlug,
} from "../../../lib/project.ts";
import {
  readProjectsRegistry,
  resolveRegisteredProjectById,
  upsertProjectRegistration,
} from "../../../lib/projects-registry.ts";
import { display } from "../../../ui/display.ts";
import { gumConfirm, isGumAvailable } from "../../../ui/gum.ts";
import { isTty } from "../../../ui/terminal.ts";
import type { GatewayClient } from "../../sdk/gateway-client.ts";
import { createGatewayClient } from "../../sdk/gateway-client.ts";
import { resolveGatewayConfig } from "../gateway/config.ts";

import type { ExtensionCommand } from "../types.ts";
import type { JobMeta, JobStatus, JobStore } from "./job-store.ts";
import { createJobStore } from "./job-store.ts";
import { createSupervisorService } from "./service.ts";

const TERMINAL_STATUSES = new Set<JobStatus>([
  "completed",
  "failed",
  "cancelled",
]);

export const SUPERVISOR_COMMANDS: readonly ExtensionCommand[] = [
  {
    name: "job-list",
    summary: "List supervisor jobs",
    scope: "project",
    handler: async ({ ctx, args }) => {
      const parsed = parseSupervisorArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const projectResult = await resolveSupervisorProject({
        ctx,
        projectOpt: parsed.value.project,
        pathOpt: parsed.value.path,
      });
      if (!projectResult.ok) {
        ctx.logger.error({ message: projectResult.error });
        return 1;
      }

      const jobs = await listJobs({
        project: projectResult.project,
        projectId: projectResult.projectId,
      });
      if (parsed.value.json) {
        process.stdout.write(`${JSON.stringify({ jobs }, null, 2)}\n`);
        return 0;
      }

      if (jobs.length === 0) {
        await display.panel({
          title: "Jobs",
          tone: "info",
          lines: ["No jobs found."],
        });
        return 0;
      }

      await display.table({
        columns: ["Id", "Status", "Runner", "Updated"],
        rows: jobs.map((job) => [
          job.jobId,
          job.status,
          job.runner,
          job.updatedAt,
        ]),
      });
      return 0;
    },
  },
  {
    name: "job-create",
    summary: "Create a new job",
    scope: "project",
    handler: async ({ ctx, args }) => {
      const parsed = parseJobCreateArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const projectResult = await resolveSupervisorProject({
        ctx,
        projectOpt: parsed.value.project,
        pathOpt: parsed.value.path,
      });
      if (!projectResult.ok) {
        ctx.logger.error({ message: projectResult.error });
        return 1;
      }

      const cwd = resolveJobCwd({
        projectRoot: projectResult.project.projectRoot,
        cwd: parsed.value.cwd,
      });

      const created = await createJob({
        project: projectResult.project,
        projectId: projectResult.projectId,
        projectName: projectResult.projectName,
        runner: parsed.value.runner,
        command: parsed.value.command,
        cwd,
        env: parsed.value.env,
      });

      if (!created.ok) {
        ctx.logger.error({ message: created.error });
        return 1;
      }

      if (parsed.value.json) {
        process.stdout.write(
          `${JSON.stringify({ job: created.job }, null, 2)}\n`
        );
        return 0;
      }

      await display.kv({
        title: "Job created",
        entries: [
          ["job_id", created.job.jobId],
          ["status", created.job.status],
          ["runner", created.job.runner],
          ["created_at", created.job.createdAt],
        ],
      });
      ctx.logger.info({
        message: `Attach with: hack x supervisor job-attach ${created.job.jobId}`,
      });
      return 0;
    },
  },
  {
    name: "job-show",
    summary: "Show a job by id",
    scope: "project",
    handler: async ({ ctx, args }) => {
      const parsed = parseSupervisorArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const jobId = (parsed.value.rest[0] ?? "").trim();
      if (!jobId) {
        ctx.logger.error({
          message: "Usage: hack x supervisor job-show <job-id>",
        });
        return 1;
      }

      const projectResult = await resolveSupervisorProject({
        ctx,
        projectOpt: parsed.value.project,
        pathOpt: parsed.value.path,
      });
      if (!projectResult.ok) {
        ctx.logger.error({ message: projectResult.error });
        return 1;
      }

      const job = await getJob({
        project: projectResult.project,
        projectId: projectResult.projectId,
        jobId,
      });
      if (!job) {
        ctx.logger.error({ message: `Job not found: ${jobId}` });
        return 1;
      }

      if (parsed.value.json) {
        process.stdout.write(`${JSON.stringify({ job }, null, 2)}\n`);
        return 0;
      }

      await display.kv({
        title: `Job ${jobId}`,
        entries: [
          ["status", job.status],
          ["runner", job.runner],
          ["created_at", job.createdAt],
          ["updated_at", job.updatedAt],
          ["project_id", job.projectId ?? ""],
          ["project_name", job.projectName ?? ""],
          ["last_event_seq", String(job.lastEventSeq)],
        ],
      });
      return 0;
    },
  },
  {
    name: "job-cancel",
    summary: "Cancel a running job",
    scope: "project",
    handler: async ({ ctx, args }) => {
      const parsed = parseSupervisorArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const jobId = (parsed.value.rest[0] ?? "").trim();
      if (!jobId) {
        ctx.logger.error({
          message: "Usage: hack x supervisor job-cancel <job-id>",
        });
        return 1;
      }

      const projectResult = await resolveSupervisorProject({
        ctx,
        projectOpt: parsed.value.project,
        pathOpt: parsed.value.path,
      });
      if (!projectResult.ok) {
        ctx.logger.error({ message: projectResult.error });
        return 1;
      }

      if (!projectResult.projectId) {
        ctx.logger.error({
          message: "Missing project id; run `hack init` and try again.",
        });
        return 1;
      }

      const cancelled = await requestDaemonJson({
        path: `/control-plane/projects/${projectResult.projectId}/jobs/${jobId}/cancel`,
        method: "POST",
      });
      if (!cancelled) {
        ctx.logger.error({ message: "hackd is not running or incompatible." });
        return 1;
      }

      if (!cancelled.ok) {
        if (cancelled.status === 404) {
          ctx.logger.error({ message: `Job not found: ${jobId}` });
          return 1;
        }
        if (cancelled.status === 409) {
          ctx.logger.error({ message: `Job not running: ${jobId}` });
          return 1;
        }
        ctx.logger.error({ message: `Cancel failed (${cancelled.status}).` });
        return 1;
      }

      ctx.logger.success({ message: `Cancelled job ${jobId}` });
      return 0;
    },
  },
  {
    name: "job-tail",
    summary: "Stream job logs (combined)",
    scope: "project",
    handler: async ({ ctx, args }) => {
      const parsed = parseSupervisorArgs({
        args,
        allowLogsFrom: true,
        allowFollow: true,
      });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const jobId = (parsed.value.rest[0] ?? "").trim();
      if (!jobId) {
        ctx.logger.error({
          message: "Usage: hack x supervisor job-tail <job-id>",
        });
        return 1;
      }

      const projectResult = await resolveSupervisorProject({
        ctx,
        projectOpt: parsed.value.project,
        pathOpt: parsed.value.path,
      });
      if (!projectResult.ok) {
        ctx.logger.error({ message: projectResult.error });
        return 1;
      }

      const store = await createJobStore({
        projectDir: projectResult.project.projectDir,
      });
      const meta = await store.readJobMeta({ jobId });
      if (!meta) {
        ctx.logger.error({ message: `Job not found: ${jobId}` });
        return 1;
      }

      const outcome = await streamJobLogs({
        store,
        jobId,
        logsOffset: parsed.value.logsFrom ?? 0,
        eventsSeq: undefined,
        follow: parsed.value.follow,
        json: parsed.value.json,
        includeEvents: false,
        logger: ctx.logger,
      });

      if (!parsed.value.json) {
        ctx.logger.info({
          message: `Resume with: hack x supervisor job-tail ${jobId} --from ${outcome.logsOffset}`,
        });
      }
      return 0;
    },
  },
  {
    name: "job-attach",
    summary: "Stream job logs + events",
    scope: "project",
    handler: async ({ ctx, args }) => {
      const parsed = parseSupervisorArgs({
        args,
        allowLogsFrom: true,
        allowEventsFrom: true,
        allowFollow: true,
      });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const jobId = (parsed.value.rest[0] ?? "").trim();
      if (!jobId) {
        ctx.logger.error({
          message: "Usage: hack x supervisor job-attach <job-id>",
        });
        return 1;
      }

      const projectResult = await resolveSupervisorProject({
        ctx,
        projectOpt: parsed.value.project,
        pathOpt: parsed.value.path,
      });
      if (!projectResult.ok) {
        ctx.logger.error({ message: projectResult.error });
        return 1;
      }

      const store = await createJobStore({
        projectDir: projectResult.project.projectDir,
      });
      const meta = await store.readJobMeta({ jobId });
      if (!meta) {
        ctx.logger.error({ message: `Job not found: ${jobId}` });
        return 1;
      }

      const outcome = await streamJobLogs({
        store,
        jobId,
        logsOffset: parsed.value.logsFrom ?? 0,
        eventsSeq: parsed.value.eventsFrom ?? 0,
        follow: parsed.value.follow,
        json: parsed.value.json,
        includeEvents: true,
        logger: ctx.logger,
      });

      if (!parsed.value.json) {
        ctx.logger.info({
          message: `Resume with: hack x supervisor job-attach ${jobId} --logs-from ${outcome.logsOffset} --events-from ${outcome.eventsSeq}`,
        });
      }
      return 0;
    },
  },
  {
    name: "shell",
    summary: "Open an interactive shell over the gateway",
    scope: "project",
    handler: async ({ ctx, args }) => {
      const parsed = parseShellArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      if (!isTty() || process.stdin.isTTY !== true) {
        ctx.logger.error({ message: "Interactive shell requires a TTY." });
        return 1;
      }

      const envGateway = (process.env.HACK_GATEWAY_URL ?? "").trim();
      const gatewayUrl =
        parsed.value.gateway ??
        (envGateway.length > 0 ? envGateway : "http://127.0.0.1:7788");
      const token =
        parsed.value.token ?? (process.env.HACK_GATEWAY_TOKEN ?? "").trim();
      if (!token) {
        ctx.logger.error({
          message:
            "Missing gateway token. Set HACK_GATEWAY_TOKEN or pass --token (write scope required).",
        });
        return 1;
      }

      const client = createGatewayClient({ baseUrl: gatewayUrl, token });
      let projectId: string | undefined =
        parsed.value.projectId ?? ctx.projectId;
      let projectName: string | undefined =
        parsed.value.project ?? ctx.projectName;

      let localProject: ProjectContext | undefined = ctx.project;

      if (parsed.value.project || parsed.value.path) {
        const localProjectResult = await resolveSupervisorProject({
          ctx,
          projectOpt: parsed.value.project,
          pathOpt: parsed.value.path,
        });
        if (!localProjectResult.ok) {
          ctx.logger.error({ message: localProjectResult.error });
          return 1;
        }
        localProject = localProjectResult.project;
        projectId = projectId ?? localProjectResult.projectId;
        projectName = localProjectResult.projectName ?? projectName;
      }

      const projectIdResult = await resolveGatewayProjectId({
        client,
        projectId,
        projectName,
      });
      if (!projectIdResult.ok) {
        ctx.logger.error({ message: projectIdResult.error });
        return 1;
      }

      const fallbackCols = 120;
      const fallbackRows = 30;
      const cols =
        parsed.value.cols ??
        (typeof process.stdout.columns === "number"
          ? process.stdout.columns
          : fallbackCols);
      const rows =
        parsed.value.rows ??
        (typeof process.stdout.rows === "number"
          ? process.stdout.rows
          : fallbackRows);

      const shellInput = {
        projectId: projectIdResult.projectId,
        ...(parsed.value.shell ? { shell: parsed.value.shell } : {}),
        ...(parsed.value.cwd ? { cwd: parsed.value.cwd } : {}),
        ...(parsed.value.env ? { env: parsed.value.env } : {}),
        cols,
        rows,
      };

      let created = await client.createShell(shellInput);
      if (!created.ok && created.error.code === "writes_disabled") {
        const didEnable = await maybeEnableGatewayWrites({
          ctx,
          project: localProject,
        });
        if (didEnable) {
          created = await client.createShell(shellInput);
        }
      }

      if (!created.ok) {
        if (
          created.error.code === "writes_disabled" ||
          created.error.code === "write_scope_required"
        ) {
          await reportGatewayConfigSource({ logger: ctx.logger });
        }
        const detailed = buildShellCreateErrorHint({ error: created.error });
        ctx.logger.error({
          message: `Shell create failed (${created.status}): ${created.error.message}`,
        });
        if (detailed) {
          ctx.logger.info({ message: detailed });
        }
        return 1;
      }

      const shellId = created.data.shell.shellId;
      const ws = client.openShellStream({
        projectId: projectIdResult.projectId,
        shellId,
      });
      const outcome = await attachGatewayShellStream({ ws, cols, rows });

      if (outcome.signal) {
        ctx.logger.info({ message: `Shell exited via ${outcome.signal}` });
      }
      return outcome.exitCode;
    },
  },
];

type SupervisorArgs = {
  readonly project?: string;
  readonly path?: string;
  readonly json: boolean;
  readonly follow: boolean;
  readonly logsFrom?: number;
  readonly eventsFrom?: number;
  readonly rest: readonly string[];
};

type ParseResult =
  | { readonly ok: true; readonly value: SupervisorArgs }
  | { readonly ok: false; readonly error: string };

export function parseSupervisorArgs(opts: {
  readonly args: readonly string[];
  readonly allowLogsFrom?: boolean;
  readonly allowEventsFrom?: boolean;
  readonly allowFollow?: boolean;
}): ParseResult {
  const rest: string[] = [];
  let project: string | undefined;
  let path: string | undefined;
  let json = false;
  let follow = true;
  let logsFrom: number | undefined;
  let eventsFrom: number | undefined;

  const takeValue = (
    _flag: string,
    value: string | undefined
  ): string | null => {
    if (!value || value.startsWith("-")) {
      return null;
    }
    return value;
  };

  for (let i = 0; i < opts.args.length; i += 1) {
    const token = opts.args[i] ?? "";
    if (token === "--") {
      rest.push(...opts.args.slice(i + 1));
      break;
    }

    if (token === "--json") {
      json = true;
      continue;
    }

    if (token === "--follow") {
      if (!opts.allowFollow) {
        return { ok: false, error: "--follow is not supported here." };
      }
      follow = true;
      continue;
    }

    if (token === "--no-follow") {
      if (!opts.allowFollow) {
        return { ok: false, error: "--no-follow is not supported here." };
      }
      follow = false;
      continue;
    }

    if (token.startsWith("--project=")) {
      project = token.slice("--project=".length).trim();
      continue;
    }

    if (token === "--project") {
      const value = takeValue(token, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--project requires a value." };
      }
      project = value;
      i += 1;
      continue;
    }

    if (token.startsWith("--path=")) {
      path = token.slice("--path=".length).trim();
      continue;
    }

    if (token === "--path") {
      const value = takeValue(token, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--path requires a value." };
      }
      path = value;
      i += 1;
      continue;
    }

    if (token.startsWith("--logs-from=")) {
      if (!opts.allowLogsFrom) {
        return { ok: false, error: "--logs-from is not supported here." };
      }
      const value = token.slice("--logs-from=".length).trim();
      const parsed = parseOffset(value);
      if (parsed === null) {
        return { ok: false, error: "--logs-from must be a number." };
      }
      logsFrom = parsed;
      continue;
    }

    if (token === "--logs-from") {
      if (!opts.allowLogsFrom) {
        return { ok: false, error: "--logs-from is not supported here." };
      }
      const value = takeValue(token, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--logs-from requires a value." };
      }
      const parsed = parseOffset(value);
      if (parsed === null) {
        return { ok: false, error: "--logs-from must be a number." };
      }
      logsFrom = parsed;
      i += 1;
      continue;
    }

    if (token.startsWith("--from=")) {
      if (!opts.allowLogsFrom) {
        return { ok: false, error: "--from is not supported here." };
      }
      const value = token.slice("--from=".length).trim();
      const parsed = parseOffset(value);
      if (parsed === null) {
        return { ok: false, error: "--from must be a number." };
      }
      logsFrom = parsed;
      continue;
    }

    if (token === "--from") {
      if (!opts.allowLogsFrom) {
        return { ok: false, error: "--from is not supported here." };
      }
      const value = takeValue(token, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--from requires a value." };
      }
      const parsed = parseOffset(value);
      if (parsed === null) {
        return { ok: false, error: "--from must be a number." };
      }
      logsFrom = parsed;
      i += 1;
      continue;
    }

    if (token.startsWith("--events-from=")) {
      if (!opts.allowEventsFrom) {
        return { ok: false, error: "--events-from is not supported here." };
      }
      const value = token.slice("--events-from=".length).trim();
      const parsed = parseOffset(value);
      if (parsed === null) {
        return { ok: false, error: "--events-from must be a number." };
      }
      eventsFrom = parsed;
      continue;
    }

    if (token === "--events-from") {
      if (!opts.allowEventsFrom) {
        return { ok: false, error: "--events-from is not supported here." };
      }
      const value = takeValue(token, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--events-from requires a value." };
      }
      const parsed = parseOffset(value);
      if (parsed === null) {
        return { ok: false, error: "--events-from must be a number." };
      }
      eventsFrom = parsed;
      i += 1;
      continue;
    }

    if (token.startsWith("-")) {
      return { ok: false, error: `Unknown option: ${token}` };
    }

    rest.push(token);
  }

  return {
    ok: true,
    value: {
      ...(project ? { project } : {}),
      ...(path ? { path } : {}),
      ...(logsFrom !== undefined ? { logsFrom } : {}),
      ...(eventsFrom !== undefined ? { eventsFrom } : {}),
      json,
      follow,
      rest,
    },
  };
}

type JobCreateArgs = {
  readonly project?: string;
  readonly path?: string;
  readonly json: boolean;
  readonly runner: string;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly command: readonly string[];
};

type JobCreateParseResult =
  | { readonly ok: true; readonly value: JobCreateArgs }
  | { readonly ok: false; readonly error: string };

export function parseJobCreateArgs(opts: {
  readonly args: readonly string[];
}): JobCreateParseResult {
  const command: string[] = [];
  const envEntries: string[] = [];
  let project: string | undefined;
  let path: string | undefined;
  let json = false;
  let runner = "generic";
  let cwd: string | undefined;

  const takeValue = (
    _flag: string,
    value: string | undefined
  ): string | null => {
    if (!value || value.startsWith("-")) {
      return null;
    }
    return value;
  };

  for (let i = 0; i < opts.args.length; i += 1) {
    const token = opts.args[i] ?? "";
    if (token === "--") {
      command.push(...opts.args.slice(i + 1));
      break;
    }

    if (token === "--json") {
      json = true;
      continue;
    }

    if (token.startsWith("--project=")) {
      project = token.slice("--project=".length).trim();
      continue;
    }

    if (token === "--project") {
      const value = takeValue(token, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--project requires a value." };
      }
      project = value;
      i += 1;
      continue;
    }

    if (token.startsWith("--path=")) {
      path = token.slice("--path=".length).trim();
      continue;
    }

    if (token === "--path") {
      const value = takeValue(token, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--path requires a value." };
      }
      path = value;
      i += 1;
      continue;
    }

    if (token.startsWith("--runner=")) {
      const value = token.slice("--runner=".length).trim();
      if (value.length > 0) {
        runner = value;
      }
      continue;
    }

    if (token === "--runner") {
      const value = takeValue(token, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--runner requires a value." };
      }
      runner = value;
      i += 1;
      continue;
    }

    if (token.startsWith("--cwd=")) {
      cwd = token.slice("--cwd=".length).trim();
      continue;
    }

    if (token === "--cwd") {
      const value = takeValue(token, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--cwd requires a value." };
      }
      cwd = value;
      i += 1;
      continue;
    }

    if (token.startsWith("--env=")) {
      envEntries.push(token.slice("--env=".length));
      continue;
    }

    if (token === "--env") {
      const value = takeValue(token, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--env requires KEY=VALUE." };
      }
      envEntries.push(value);
      i += 1;
      continue;
    }

    if (token.startsWith("-")) {
      return { ok: false, error: `Unknown option: ${token}` };
    }

    command.push(...opts.args.slice(i));
    break;
  }

  if (command.length === 0) {
    return {
      ok: false,
      error: "Usage: hack x supervisor job-create [options] -- <command...>",
    };
  }

  const envParsed = parseEnvAssignments({ entries: envEntries });
  if (!envParsed.ok) {
    return envParsed;
  }

  return {
    ok: true,
    value: {
      ...(project ? { project } : {}),
      ...(path ? { path } : {}),
      json,
      runner,
      ...(cwd ? { cwd } : {}),
      ...(envParsed.value ? { env: envParsed.value } : {}),
      command,
    },
  };
}

type ShellArgs = {
  readonly project?: string;
  readonly projectId?: string;
  readonly path?: string;
  readonly gateway?: string;
  readonly token?: string;
  readonly shell?: string;
  readonly cwd?: string;
  readonly cols?: number;
  readonly rows?: number;
  readonly env?: Record<string, string>;
};

type ShellParseResult =
  | { readonly ok: true; readonly value: ShellArgs }
  | { readonly ok: false; readonly error: string };

export function parseShellArgs(opts: {
  readonly args: readonly string[];
}): ShellParseResult {
  let project: string | undefined;
  let projectId: string | undefined;
  let path: string | undefined;
  let gateway: string | undefined;
  let token: string | undefined;
  let shell: string | undefined;
  let cwd: string | undefined;
  let cols: number | undefined;
  let rows: number | undefined;
  const envEntries: string[] = [];

  const takeValue = (
    _flag: string,
    value: string | undefined
  ): string | null => {
    if (!value || value.startsWith("-")) {
      return null;
    }
    return value;
  };

  for (let i = 0; i < opts.args.length; i += 1) {
    const tokenArg = opts.args[i] ?? "";
    if (tokenArg === "--") {
      if (opts.args.length > i + 1) {
        return { ok: false, error: "Unexpected extra arguments for shell." };
      }
      break;
    }

    if (tokenArg.startsWith("--project=")) {
      project = tokenArg.slice("--project=".length).trim();
      continue;
    }

    if (tokenArg === "--project") {
      const value = takeValue(tokenArg, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--project requires a value." };
      }
      project = value;
      i += 1;
      continue;
    }

    if (tokenArg.startsWith("--project-id=")) {
      projectId = tokenArg.slice("--project-id=".length).trim();
      continue;
    }

    if (tokenArg === "--project-id") {
      const value = takeValue(tokenArg, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--project-id requires a value." };
      }
      projectId = value;
      i += 1;
      continue;
    }

    if (tokenArg.startsWith("--path=")) {
      path = tokenArg.slice("--path=".length).trim();
      continue;
    }

    if (tokenArg === "--path") {
      const value = takeValue(tokenArg, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--path requires a value." };
      }
      path = value;
      i += 1;
      continue;
    }

    if (tokenArg.startsWith("--gateway=")) {
      gateway = tokenArg.slice("--gateway=".length).trim();
      continue;
    }

    if (tokenArg === "--gateway") {
      const value = takeValue(tokenArg, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--gateway requires a value." };
      }
      gateway = value;
      i += 1;
      continue;
    }

    if (tokenArg.startsWith("--token=")) {
      token = tokenArg.slice("--token=".length).trim();
      continue;
    }

    if (tokenArg === "--token") {
      const value = takeValue(tokenArg, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--token requires a value." };
      }
      token = value;
      i += 1;
      continue;
    }

    if (tokenArg.startsWith("--shell=")) {
      shell = tokenArg.slice("--shell=".length).trim();
      continue;
    }

    if (tokenArg === "--shell") {
      const value = takeValue(tokenArg, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--shell requires a value." };
      }
      shell = value;
      i += 1;
      continue;
    }

    if (tokenArg.startsWith("--cwd=")) {
      cwd = tokenArg.slice("--cwd=".length).trim();
      continue;
    }

    if (tokenArg === "--cwd") {
      const value = takeValue(tokenArg, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--cwd requires a value." };
      }
      cwd = value;
      i += 1;
      continue;
    }

    if (tokenArg.startsWith("--cols=")) {
      const value = tokenArg.slice("--cols=".length).trim();
      const parsed = parsePositiveInt(value);
      if (parsed === null) {
        return { ok: false, error: "--cols must be a positive number." };
      }
      cols = parsed;
      continue;
    }

    if (tokenArg === "--cols") {
      const value = takeValue(tokenArg, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--cols requires a value." };
      }
      const parsed = parsePositiveInt(value);
      if (parsed === null) {
        return { ok: false, error: "--cols must be a positive number." };
      }
      cols = parsed;
      i += 1;
      continue;
    }

    if (tokenArg.startsWith("--rows=")) {
      const value = tokenArg.slice("--rows=".length).trim();
      const parsed = parsePositiveInt(value);
      if (parsed === null) {
        return { ok: false, error: "--rows must be a positive number." };
      }
      rows = parsed;
      continue;
    }

    if (tokenArg === "--rows") {
      const value = takeValue(tokenArg, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--rows requires a value." };
      }
      const parsed = parsePositiveInt(value);
      if (parsed === null) {
        return { ok: false, error: "--rows must be a positive number." };
      }
      rows = parsed;
      i += 1;
      continue;
    }

    if (tokenArg.startsWith("--env=")) {
      envEntries.push(tokenArg.slice("--env=".length));
      continue;
    }

    if (tokenArg === "--env") {
      const value = takeValue(tokenArg, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--env requires KEY=VALUE." };
      }
      envEntries.push(value);
      i += 1;
      continue;
    }

    if (tokenArg.startsWith("-")) {
      return { ok: false, error: `Unknown option: ${tokenArg}` };
    }

    return { ok: false, error: "Unexpected extra arguments for shell." };
  }

  if (project && projectId) {
    return {
      ok: false,
      error: "Use either --project or --project-id (not both).",
    };
  }

  const envParsed = parseEnvAssignments({ entries: envEntries });
  if (!envParsed.ok) {
    return envParsed;
  }

  return {
    ok: true,
    value: {
      ...(project ? { project } : {}),
      ...(projectId ? { projectId } : {}),
      ...(path ? { path } : {}),
      ...(gateway ? { gateway } : {}),
      ...(token ? { token } : {}),
      ...(shell ? { shell } : {}),
      ...(cwd ? { cwd } : {}),
      ...(cols !== undefined ? { cols } : {}),
      ...(rows !== undefined ? { rows } : {}),
      ...(envParsed.value ? { env: envParsed.value } : {}),
    },
  };
}

function parseOffset(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function parsePositiveInt(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

type ProjectResolution =
  | {
      readonly ok: true;
      readonly project: ProjectContext;
      readonly projectId?: string;
      readonly projectName?: string;
    }
  | { readonly ok: false; readonly error: string };

async function resolveSupervisorProject(opts: {
  readonly ctx: {
    readonly cwd: string;
    readonly logger: { warn: (input: { message: string }) => void };
  };
  readonly projectOpt?: string;
  readonly pathOpt?: string;
}): Promise<ProjectResolution> {
  if (opts.projectOpt && opts.pathOpt) {
    return { ok: false, error: "Use either --project or --path (not both)." };
  }

  if (opts.projectOpt) {
    const name = sanitizeProjectSlug(opts.projectOpt);
    if (name.length === 0) {
      return { ok: false, error: "Invalid --project value." };
    }
    const registry = await readProjectsRegistry();
    const match = registry.projects.find((p) => p.name === name);
    if (!match) {
      return {
        ok: false,
        error: `Unknown project "${name}". Run 'hack projects' to see registered projects.`,
      };
    }

    const resolved = await resolveRegisteredProjectById({ id: match.id });
    if (!resolved) {
      return { ok: false, error: `Project "${name}" is missing or invalid.` };
    }

    return {
      ok: true,
      project: resolved.project,
      projectId: resolved.registration.id,
      projectName: resolved.registration.name,
    };
  }

  const baseDir = opts.pathOpt
    ? resolve(opts.ctx.cwd, opts.pathOpt)
    : opts.ctx.cwd;
  const project = await findProjectContext(baseDir);
  if (!project) {
    return {
      ok: false,
      error: "No project found. Run inside a repo or pass --project/--path.",
    };
  }

  const registration = await upsertProjectRegistration({ project });
  if (registration.status === "conflict") {
    opts.ctx.logger.warn({
      message: `Project name conflict: ${registration.conflictName} already exists.`,
    });
    return { ok: true, project };
  }

  return {
    ok: true,
    project,
    projectId: registration.project.id,
    projectName: registration.project.name,
  };
}

type EnvParseResult =
  | { readonly ok: true; readonly value?: Record<string, string> }
  | { readonly ok: false; readonly error: string };

function parseEnvAssignments(opts: {
  readonly entries: readonly string[];
}): EnvParseResult {
  if (opts.entries.length === 0) {
    return { ok: true };
  }
  const env: Record<string, string> = {};

  for (const entry of opts.entries) {
    const idx = entry.indexOf("=");
    if (idx <= 0) {
      return {
        ok: false,
        error: `Invalid --env entry: ${entry}. Expected KEY=VALUE.`,
      };
    }
    const key = entry.slice(0, idx).trim();
    const value = entry.slice(idx + 1);
    if (key.length === 0) {
      return {
        ok: false,
        error: `Invalid --env entry: ${entry}. Expected KEY=VALUE.`,
      };
    }
    env[key] = value;
  }

  return { ok: true, value: env };
}

type GatewayProjectResolution =
  | { readonly ok: true; readonly projectId: string }
  | { readonly ok: false; readonly error: string };

async function resolveGatewayProjectId(opts: {
  readonly client: GatewayClient;
  readonly projectId?: string;
  readonly projectName?: string;
}): Promise<GatewayProjectResolution> {
  if (opts.projectId) {
    return { ok: true, projectId: opts.projectId };
  }

  const name = (opts.projectName ?? "").trim();
  if (!name) {
    return {
      ok: false,
      error: "Missing project id; use --project-id or --project.",
    };
  }

  const response = await opts.client.getProjects({
    filter: name,
    includeGlobal: true,
    includeUnregistered: true,
  });
  if (!response.ok) {
    return {
      ok: false,
      error: `Gateway projects lookup failed (${response.status}): ${response.error.message}`,
    };
  }

  const projectId = findProjectIdByName({
    projects: response.data.projects,
    name,
  });
  if (!projectId) {
    return {
      ok: false,
      error: `Project "${name}" is not registered (missing project_id).`,
    };
  }

  return { ok: true, projectId };
}

function findProjectIdByName(opts: {
  readonly projects: readonly Record<string, unknown>[];
  readonly name: string;
}): string | null {
  for (const project of opts.projects) {
    const candidate = isRecord(project) ? project : null;
    if (!candidate) {
      continue;
    }
    if (candidate.name !== opts.name) {
      continue;
    }
    const projectId = candidate.project_id;
    if (typeof projectId === "string" && projectId.length > 0) {
      return projectId;
    }
  }
  return null;
}

function buildShellCreateErrorHint(opts: {
  readonly error: { readonly code?: string };
}): string | null {
  if (opts.error.code === "writes_disabled") {
    return [
      "Gateway writes are disabled.",
      "Fix: hack config set --global 'controlPlane.gateway.allowWrites' true && hack daemon stop && hack daemon start",
    ].join(" ");
  }
  if (opts.error.code === "write_scope_required") {
    return "Write token required. Run: hack x gateway token-create --scope write";
  }
  if (opts.error.code === "project_disabled") {
    return "Project not gateway-enabled. Run: hack gateway enable (from the project directory).";
  }
  return null;
}

async function maybeEnableGatewayWrites(opts: {
  readonly ctx: {
    readonly logger: {
      info: (input: { message: string }) => void;
      warn: (input: { message: string }) => void;
    };
  };
  readonly project?: ProjectContext;
}): Promise<boolean> {
  if (!(isTty() && isGumAvailable())) {
    return false;
  }

  const configPath = resolveGlobalConfigPath();
  const prompt = `Gateway writes disabled. Enable writes + restart hackd? (updates ${configPath})`;
  const confirmed = await gumConfirm({ prompt, default: true });
  if (!(confirmed.ok && confirmed.value)) {
    return false;
  }

  const invocation = await resolveHackInvocation();
  const okSet = await runHackCommand({
    invocation,
    argv: [
      "config",
      "set",
      "--global",
      "controlPlane.gateway.allowWrites",
      "true",
    ],
    cwd: opts.project?.projectRoot ?? process.cwd(),
  });
  if (!okSet) {
    return false;
  }

  const stopped = await runHackCommand({
    invocation,
    argv: ["daemon", "stop"],
    cwd: opts.project?.projectRoot ?? process.cwd(),
  });
  if (!stopped) {
    return false;
  }

  const started = await runHackCommand({
    invocation,
    argv: ["daemon", "start"],
    cwd: opts.project?.projectRoot ?? process.cwd(),
  });
  if (!started) {
    return false;
  }

  opts.ctx.logger.info({
    message: "Gateway writes enabled; retrying shell create...",
  });
  return true;
}

async function reportGatewayConfigSource(opts: {
  readonly logger: {
    info: (input: { message: string }) => void;
    warn: (input: { message: string }) => void;
  };
}): Promise<void> {
  const resolved = await resolveGatewayConfig();
  if (resolved.enabledProjects.length > 0) {
    const projects = resolved.enabledProjects.map(
      (project) => `${project.projectName} (${project.projectId})`
    );
    opts.logger.info({
      message: `Gateway projects enabled: ${projects.join(", ")}`,
    });
    return;
  }
  opts.logger.warn({
    message:
      "No gateway-enabled projects found. Run `hack gateway enable` in the project you want to use.",
  });
}

async function runHackCommand(opts: {
  readonly invocation: {
    readonly bin: string;
    readonly args: readonly string[];
  };
  readonly argv: readonly string[];
  readonly cwd: string;
}): Promise<boolean> {
  const proc = Bun.spawn(
    [opts.invocation.bin, ...opts.invocation.args, ...opts.argv],
    {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      cwd: opts.cwd,
    }
  );
  const exitCode = await proc.exited;
  return exitCode === 0;
}

type ShellStreamOutcome = {
  readonly exitCode: number;
  readonly signal?: string;
};

async function attachGatewayShellStream(opts: {
  readonly ws: WebSocket;
  readonly cols: number;
  readonly rows: number;
}): Promise<ShellStreamOutcome> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const decoder = new TextDecoder();
  let currentCols = opts.cols;
  let currentRows = opts.rows;
  let exitCode = 0;
  let signal: string | undefined;
  let rawMode = false;

  const sendResize = () => {
    const nextCols =
      typeof stdout.columns === "number" ? stdout.columns : currentCols;
    const nextRows =
      typeof stdout.rows === "number" ? stdout.rows : currentRows;
    if (nextCols === currentCols && nextRows === currentRows) {
      return;
    }
    currentCols = nextCols;
    currentRows = nextRows;
    if (opts.ws.readyState === WebSocket.OPEN) {
      opts.ws.send(
        JSON.stringify({ type: "resize", cols: currentCols, rows: currentRows })
      );
    }
  };

  const onStdin = (chunk: Uint8Array) => {
    if (opts.ws.readyState === WebSocket.OPEN) {
      opts.ws.send(chunk);
    }
  };

  const onOpen = () => {
    opts.ws.send(
      JSON.stringify({ type: "hello", cols: currentCols, rows: currentRows })
    );
  };

  const onMessage = (event: { readonly data: unknown }) => {
    const text = decodeWebSocketText({ decoder, data: event.data });
    const parsed = parseShellServerMessage({ text });
    if (!parsed) {
      stdout.write(text);
      return;
    }
    if (parsed.type === "output") {
      stdout.write(parsed.data);
      return;
    }
    if (parsed.type === "exit") {
      exitCode = parsed.exitCode ?? 0;
      signal = parsed.signal;
      if (opts.ws.readyState === WebSocket.OPEN) {
        opts.ws.close(1000, "shell_exit");
      }
      return;
    }
  };

  const onClose = () => {
    cleanup();
    resolver({ exitCode, ...(signal ? { signal } : {}) });
  };

  const onError = () => {
    exitCode = 1;
    if (opts.ws.readyState === WebSocket.OPEN) {
      opts.ws.close(1011, "stream_error");
    }
  };

  const onResize = () => {
    sendResize();
  };

  // biome-ignore lint/suspicious/noEmptyBlockStatements: placeholder until promise assignment
  let resolver: (value: ShellStreamOutcome) => void = () => {};

  const cleanup = () => {
    opts.ws.removeEventListener("open", onOpen);
    opts.ws.removeEventListener("message", onMessage);
    opts.ws.removeEventListener("close", onClose);
    opts.ws.removeEventListener("error", onError);
    stdin.off("data", onStdin);
    stdout.off("resize", onResize);
    if (rawMode && typeof stdin.setRawMode === "function") {
      stdin.setRawMode(false);
    }
    stdin.pause();
  };

  const ready = new Promise<ShellStreamOutcome>((resolve) => {
    resolver = resolve;
  });

  if (stdin.isTTY && typeof stdin.setRawMode === "function") {
    stdin.setRawMode(true);
    rawMode = true;
  }

  stdin.resume();
  stdin.on("data", onStdin);
  stdout.on("resize", onResize);
  opts.ws.addEventListener("open", onOpen);
  opts.ws.addEventListener("message", onMessage);
  opts.ws.addEventListener("close", onClose);
  opts.ws.addEventListener("error", onError);

  return await ready;
}

type ShellServerMessage =
  | { readonly type: "ready" }
  | { readonly type: "output"; readonly data: string }
  | {
      readonly type: "exit";
      readonly exitCode?: number;
      readonly signal?: string;
    };

function parseShellServerMessage(opts: {
  readonly text: string;
}): ShellServerMessage | null {
  const trimmed = opts.text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const type = parsed.type;
  if (type === "ready") {
    return { type: "ready" };
  }
  if (type === "output") {
    const data = parsed.data;
    if (typeof data !== "string") {
      return null;
    }
    return { type: "output", data };
  }
  if (type === "exit") {
    const exitCode =
      typeof parsed.exitCode === "number" ? parsed.exitCode : undefined;
    const signal =
      typeof parsed.signal === "string" ? parsed.signal : undefined;
    return {
      type: "exit",
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(signal ? { signal } : {}),
    };
  }
  return null;
}

function decodeWebSocketText(opts: {
  readonly decoder: TextDecoder;
  readonly data: unknown;
}): string {
  if (typeof opts.data === "string") {
    return opts.data;
  }
  if (opts.data instanceof ArrayBuffer) {
    return opts.decoder.decode(new Uint8Array(opts.data));
  }
  if (opts.data instanceof Uint8Array) {
    return opts.decoder.decode(opts.data);
  }
  return String(opts.data ?? "");
}

function resolveJobCwd(opts: {
  readonly projectRoot: string;
  readonly cwd?: string;
}): string | undefined {
  const raw = (opts.cwd ?? "").trim();
  if (raw.length === 0) {
    return undefined;
  }
  return isAbsolute(raw) ? raw : resolve(opts.projectRoot, raw);
}

type JobCreateResult =
  | { readonly ok: true; readonly job: JobMeta }
  | { readonly ok: false; readonly error: string };

async function createJob(opts: {
  readonly project: ProjectContext;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly runner: string;
  readonly command: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
}): Promise<JobCreateResult> {
  if (opts.projectId) {
    const response = await requestDaemonJson({
      path: `/control-plane/projects/${opts.projectId}/jobs`,
      method: "POST",
      body: {
        runner: opts.runner,
        command: opts.command,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.env ? { env: opts.env } : {}),
      },
    });
    if (!response) {
      return { ok: false, error: "hackd is not running or incompatible." };
    }
    if (!response.ok) {
      return { ok: false, error: `Job create failed (${response.status}).` };
    }
    const job = response.json?.job;
    if (job && isRecordWithJob(job)) {
      return { ok: true, job };
    }
    return { ok: false, error: "Job create response missing job payload." };
  }

  const service = createSupervisorService();
  const created = await service.createJob({
    projectDir: opts.project.projectDir,
    projectId: opts.projectId,
    projectName: opts.projectName,
    runner: opts.runner,
    command: opts.command,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.env ? { env: opts.env } : {}),
  });

  return { ok: true, job: created.meta };
}

async function listJobs(opts: {
  readonly project: ProjectContext;
  readonly projectId?: string;
}): Promise<readonly JobMeta[]> {
  if (opts.projectId) {
    const response = await requestDaemonJson({
      path: `/control-plane/projects/${opts.projectId}/jobs`,
    });
    if (response?.ok && response.json && Array.isArray(response.json.jobs)) {
      return response.json.jobs as JobMeta[];
    }
  }

  const service = createSupervisorService();
  return await service.listJobs({ projectDir: opts.project.projectDir });
}

async function getJob(opts: {
  readonly project: ProjectContext;
  readonly projectId?: string;
  readonly jobId: string;
}): Promise<JobMeta | null> {
  if (opts.projectId) {
    const response = await requestDaemonJson({
      path: `/control-plane/projects/${opts.projectId}/jobs/${opts.jobId}`,
    });
    if (response?.ok && response.json && isRecordWithJob(response.json.job)) {
      return response.json.job;
    }
  }

  const service = createSupervisorService();
  return await service.getJob({
    projectDir: opts.project.projectDir,
    jobId: opts.jobId,
  });
}

function isRecordWithJob(value: unknown): value is JobMeta {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as JobMeta).jobId === "string"
  );
}

type StreamOutcome = {
  readonly logsOffset: number;
  readonly eventsSeq: number;
};

async function streamJobLogs(opts: {
  readonly store: JobStore;
  readonly jobId: string;
  readonly logsOffset: number;
  readonly eventsSeq: number | undefined;
  readonly follow: boolean;
  readonly json: boolean;
  readonly includeEvents: boolean;
  readonly logger: { info: (input: { message: string }) => void };
}): Promise<StreamOutcome> {
  let logsOffset = opts.logsOffset;
  let eventsSeq = opts.eventsSeq ?? 0;
  let lastHeartbeatAt = Date.now();
  const heartbeatIntervalMs = 5000;

  if (opts.json) {
    writeJsonLine({
      type: "start",
      jobId: opts.jobId,
      logsOffset,
      ...(opts.includeEvents ? { eventsSeq } : {}),
    });
  }

  while (true) {
    let didWork = false;

    const logChunk = await readFileChunk({
      path: opts.store.getJobPaths({ jobId: opts.jobId }).combinedPath,
      offset: logsOffset,
    });
    if (logChunk) {
      didWork = true;
      logsOffset = logChunk.nextOffset;
      if (opts.json) {
        writeJsonLine({
          type: "log",
          stream: "combined",
          offset: logsOffset,
          data: logChunk.data,
        });
      } else {
        process.stdout.write(logChunk.data);
      }
    }

    if (opts.includeEvents) {
      const events = await opts.store.readEvents({ jobId: opts.jobId });
      const next = events.filter((event) => event.seq > eventsSeq);
      if (next.length > 0) {
        didWork = true;
        for (const event of next) {
          eventsSeq = event.seq;
          if (opts.json) {
            writeJsonLine({ type: "event", seq: event.seq, event });
          } else {
            opts.logger.info({ message: `event ${event.type}` });
          }
        }
      }
    }

    if (!opts.follow) {
      break;
    }

    if (
      opts.json &&
      !didWork &&
      Date.now() - lastHeartbeatAt >= heartbeatIntervalMs
    ) {
      writeJsonLine({
        type: "heartbeat",
        ts: new Date().toISOString(),
        logsOffset,
        ...(opts.includeEvents ? { eventsSeq } : {}),
      });
      lastHeartbeatAt = Date.now();
    }

    if (!didWork) {
      const meta = await opts.store.readJobMeta({ jobId: opts.jobId });
      if (meta && TERMINAL_STATUSES.has(meta.status)) {
        break;
      }
    }

    if (didWork) {
      lastHeartbeatAt = Date.now();
    }

    await sleep(500);
  }

  if (opts.json) {
    writeJsonLine({
      type: "end",
      jobId: opts.jobId,
      logsOffset,
      ...(opts.includeEvents ? { eventsSeq } : {}),
    });
  }

  return { logsOffset, eventsSeq };
}

function writeJsonLine(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function readFileChunk(opts: {
  readonly path: string;
  readonly offset: number;
}): Promise<{ readonly data: string; readonly nextOffset: number } | null> {
  try {
    const file = Bun.file(opts.path);
    const stat = await file.stat();
    if (stat.size <= opts.offset) {
      return null;
    }
    const slice = file.slice(opts.offset, stat.size);
    const data = await slice.text();
    return { data, nextOffset: stat.size };
  } catch {
    return null;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
