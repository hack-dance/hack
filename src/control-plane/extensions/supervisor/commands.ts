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

      const connection = resolveShellConnection({ parsed: parsed.value });
      if (!connection.ok) {
        ctx.logger.error({
          message: connection.error,
        });
        return 1;
      }

      const client = createGatewayClient({
        baseUrl: connection.gatewayUrl,
        token: connection.token,
      });
      const shellProject = await resolveShellProject({
        ctx,
        parsed: parsed.value,
        client,
      });
      if (!shellProject.ok) {
        ctx.logger.error({ message: shellProject.error });
        return 1;
      }

      const shellDimensions = resolveShellDimensions({ parsed: parsed.value });
      const shellInput = buildShellCreateInput({
        parsed: parsed.value,
        projectId: shellProject.projectId,
        cols: shellDimensions.cols,
        rows: shellDimensions.rows,
      });

      const created = await createShellWithRetry({
        ctx,
        client,
        localProject: shellProject.localProject,
        shellInput,
      });
      if (!created.ok) {
        await reportShellCreateFailure({
          logger: ctx.logger,
          created,
        });
        return 1;
      }

      const shellId = created.data.shell.shellId;
      const ws = client.openShellStream({
        projectId: shellProject.projectId,
        shellId,
      });
      const outcome = await attachGatewayShellStream({
        ws,
        cols: shellDimensions.cols,
        rows: shellDimensions.rows,
      });

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

type ArgStepResult =
  | { readonly kind: "handled"; readonly nextIndex: number }
  | { readonly kind: "unhandled" }
  | { readonly kind: "error"; readonly error: string };

type SupervisorArgsState = {
  project?: string;
  path?: string;
  json: boolean;
  follow: boolean;
  logsFrom?: number;
  eventsFrom?: number;
  rest: string[];
};

export function parseSupervisorArgs(opts: {
  readonly args: readonly string[];
  readonly allowLogsFrom?: boolean;
  readonly allowEventsFrom?: boolean;
  readonly allowFollow?: boolean;
}): ParseResult {
  const state: SupervisorArgsState = {
    json: false,
    follow: true,
    rest: [],
  };

  for (let i = 0; i < opts.args.length; i += 1) {
    const token = opts.args[i] ?? "";

    if (token === "--") {
      state.rest.push(...opts.args.slice(i + 1));
      break;
    }

    const step = handleSupervisorArg({
      args: opts.args,
      index: i,
      token,
      state,
      allowLogsFrom: opts.allowLogsFrom === true,
      allowEventsFrom: opts.allowEventsFrom === true,
      allowFollow: opts.allowFollow === true,
    });
    if (step.kind === "error") {
      return { ok: false, error: step.error };
    }
    if (step.kind === "handled") {
      i = step.nextIndex;
      continue;
    }

    if (token.startsWith("-")) {
      return { ok: false, error: `Unknown option: ${token}` };
    }

    state.rest.push(token);
  }

  return {
    ok: true,
    value: {
      ...(state.project ? { project: state.project } : {}),
      ...(state.path ? { path: state.path } : {}),
      ...(state.logsFrom !== undefined ? { logsFrom: state.logsFrom } : {}),
      ...(state.eventsFrom !== undefined
        ? { eventsFrom: state.eventsFrom }
        : {}),
      json: state.json,
      follow: state.follow,
      rest: state.rest,
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

type JobCreateArgsState = {
  project?: string;
  path?: string;
  json: boolean;
  runner: string;
  cwd?: string;
  command: string[];
  envEntries: string[];
};

export function parseJobCreateArgs(opts: {
  readonly args: readonly string[];
}): JobCreateParseResult {
  const state: JobCreateArgsState = {
    json: false,
    runner: "generic",
    command: [],
    envEntries: [],
  };

  for (let i = 0; i < opts.args.length; i += 1) {
    const token = opts.args[i] ?? "";
    if (token === "--") {
      state.command.push(...opts.args.slice(i + 1));
      break;
    }

    const step = handleJobCreateArg({
      args: opts.args,
      index: i,
      token,
      state,
    });
    if (step.kind === "error") {
      return { ok: false, error: step.error };
    }
    if (step.kind === "handled") {
      i = step.nextIndex;
      continue;
    }

    if (token.startsWith("-")) {
      return { ok: false, error: `Unknown option: ${token}` };
    }

    state.command.push(...opts.args.slice(i));
    break;
  }

  if (state.command.length === 0) {
    return {
      ok: false,
      error: "Usage: hack x supervisor job-create [options] -- <command...>",
    };
  }

  const envParsed = parseEnvAssignments({ entries: state.envEntries });
  if (!envParsed.ok) {
    return envParsed;
  }

  return {
    ok: true,
    value: {
      ...(state.project ? { project: state.project } : {}),
      ...(state.path ? { path: state.path } : {}),
      json: state.json,
      runner: state.runner,
      ...(state.cwd ? { cwd: state.cwd } : {}),
      ...(envParsed.value ? { env: envParsed.value } : {}),
      command: state.command,
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

type ShellArgsState = {
  project?: string;
  projectId?: string;
  path?: string;
  gateway?: string;
  token?: string;
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  envEntries: string[];
};

export function parseShellArgs(opts: {
  readonly args: readonly string[];
}): ShellParseResult {
  const parsedState = parseShellArgsState({ args: opts.args });
  if (!parsedState.ok) {
    return parsedState;
  }

  if (parsedState.state.project && parsedState.state.projectId) {
    return {
      ok: false,
      error: "Use either --project or --project-id (not both).",
    };
  }

  const envParsed = parseEnvAssignments({
    entries: parsedState.state.envEntries,
  });
  if (!envParsed.ok) {
    return envParsed;
  }

  return {
    ok: true,
    value: {
      ...(parsedState.state.project
        ? { project: parsedState.state.project }
        : {}),
      ...(parsedState.state.projectId
        ? { projectId: parsedState.state.projectId }
        : {}),
      ...(parsedState.state.path ? { path: parsedState.state.path } : {}),
      ...(parsedState.state.gateway
        ? { gateway: parsedState.state.gateway }
        : {}),
      ...(parsedState.state.token ? { token: parsedState.state.token } : {}),
      ...(parsedState.state.shell ? { shell: parsedState.state.shell } : {}),
      ...(parsedState.state.cwd ? { cwd: parsedState.state.cwd } : {}),
      ...(parsedState.state.cols !== undefined
        ? { cols: parsedState.state.cols }
        : {}),
      ...(parsedState.state.rows !== undefined
        ? { rows: parsedState.state.rows }
        : {}),
      ...(envParsed.value ? { env: envParsed.value } : {}),
    },
  };
}

function parseShellArgsState(input: {
  readonly args: readonly string[];
}):
  | { readonly ok: true; readonly state: ShellArgsState }
  | { readonly ok: false; readonly error: string } {
  const state: ShellArgsState = {
    envEntries: [],
  };

  for (let i = 0; i < input.args.length; i += 1) {
    const token = input.args[i] ?? "";
    const structuralError = validateShellStructuralToken({
      args: input.args,
      index: i,
      token,
    });
    if (structuralError) {
      return { ok: false, error: structuralError };
    }
    if (token === "--") {
      break;
    }

    const step = handleShellArg({
      args: input.args,
      index: i,
      token,
      state,
    });
    if (step.kind === "error") {
      return { ok: false, error: step.error };
    }
    if (step.kind === "handled") {
      i = step.nextIndex;
      continue;
    }
    return {
      ok: false,
      error: token.startsWith("-")
        ? `Unknown option: ${token}`
        : "Unexpected extra arguments for shell.",
    };
  }

  return { ok: true, state };
}

function validateShellStructuralToken(input: {
  readonly args: readonly string[];
  readonly index: number;
  readonly token: string;
}): string | null {
  if (input.token !== "--") {
    return null;
  }
  return input.args.length > input.index + 1
    ? "Unexpected extra arguments for shell."
    : null;
}

function handleSupervisorArg(input: {
  readonly args: readonly string[];
  readonly index: number;
  readonly token: string;
  readonly state: SupervisorArgsState;
  readonly allowLogsFrom: boolean;
  readonly allowEventsFrom: boolean;
  readonly allowFollow: boolean;
}): ArgStepResult {
  return (
    handleSupervisorBooleanArg(input) ??
    handleSupervisorStringArg(input) ??
    handleSupervisorOffsetArg(input) ?? { kind: "unhandled" }
  );
}

function handleSupervisorBooleanArg(input: {
  readonly token: string;
  readonly state: SupervisorArgsState;
  readonly allowFollow: boolean;
  readonly index: number;
}): ArgStepResult | null {
  if (input.token === "--json") {
    input.state.json = true;
    return { kind: "handled", nextIndex: input.index };
  }
  if (input.token === "--follow" || input.token === "--no-follow") {
    if (!input.allowFollow) {
      return {
        kind: "error",
        error: `${input.token} is not supported here.`,
      };
    }
    input.state.follow = input.token === "--follow";
    return { kind: "handled", nextIndex: input.index };
  }
  return null;
}

function handleSupervisorStringArg(input: {
  readonly args: readonly string[];
  readonly index: number;
  readonly token: string;
  readonly state: SupervisorArgsState;
}): ArgStepResult | null {
  const project = readStringOption({
    args: input.args,
    index: input.index,
    token: input.token,
    flag: "--project",
  });
  if (project.kind !== "unhandled") {
    return assignStringOption({
      result: project,
      assign: (value) => {
        input.state.project = value;
      },
    });
  }

  const path = readStringOption({
    args: input.args,
    index: input.index,
    token: input.token,
    flag: "--path",
  });
  if (path.kind !== "unhandled") {
    return assignStringOption({
      result: path,
      assign: (value) => {
        input.state.path = value;
      },
    });
  }

  return null;
}

function handleSupervisorOffsetArg(input: {
  readonly args: readonly string[];
  readonly index: number;
  readonly token: string;
  readonly state: SupervisorArgsState;
  readonly allowLogsFrom: boolean;
  readonly allowEventsFrom: boolean;
}): ArgStepResult | null {
  const logsFrom = readNumericOption({
    args: input.args,
    index: input.index,
    token: input.token,
    aliases: ["--logs-from", "--from"],
    allow: input.allowLogsFrom,
    unsupportedError: `${input.token.split("=")[0]} is not supported here.`,
    requiredError:
      input.token === "--from"
        ? "--from requires a value."
        : "--logs-from requires a value.",
    invalidError: input.token.startsWith("--from")
      ? "--from must be a number."
      : "--logs-from must be a number.",
    parser: parseOffset,
  });
  if (logsFrom.kind !== "unhandled") {
    return assignNumericOption({
      result: logsFrom,
      assign: (value) => {
        input.state.logsFrom = value;
      },
    });
  }

  const eventsFrom = readNumericOption({
    args: input.args,
    index: input.index,
    token: input.token,
    aliases: ["--events-from"],
    allow: input.allowEventsFrom,
    unsupportedError: "--events-from is not supported here.",
    requiredError: "--events-from requires a value.",
    invalidError: "--events-from must be a number.",
    parser: parseOffset,
  });
  if (eventsFrom.kind !== "unhandled") {
    return assignNumericOption({
      result: eventsFrom,
      assign: (value) => {
        input.state.eventsFrom = value;
      },
    });
  }

  return null;
}

function handleJobCreateArg(input: {
  readonly args: readonly string[];
  readonly index: number;
  readonly token: string;
  readonly state: JobCreateArgsState;
}): ArgStepResult {
  return (
    handleJobCreateBooleanArg(input) ??
    handleJobCreateStringArg(input) ??
    handleJobCreateEnvArg(input) ?? { kind: "unhandled" }
  );
}

function handleJobCreateBooleanArg(input: {
  readonly token: string;
  readonly state: JobCreateArgsState;
  readonly index: number;
}): ArgStepResult | null {
  if (input.token !== "--json") {
    return null;
  }
  input.state.json = true;
  return { kind: "handled", nextIndex: input.index };
}

function handleJobCreateStringArg(input: {
  readonly args: readonly string[];
  readonly index: number;
  readonly token: string;
  readonly state: JobCreateArgsState;
}): ArgStepResult | null {
  const project = readStringOption({
    args: input.args,
    index: input.index,
    token: input.token,
    flag: "--project",
  });
  if (project.kind !== "unhandled") {
    return assignStringOption({
      result: project,
      assign: (value) => {
        input.state.project = value;
      },
    });
  }

  const path = readStringOption({
    args: input.args,
    index: input.index,
    token: input.token,
    flag: "--path",
  });
  if (path.kind !== "unhandled") {
    return assignStringOption({
      result: path,
      assign: (value) => {
        input.state.path = value;
      },
    });
  }

  const runner = readStringOption({
    args: input.args,
    index: input.index,
    token: input.token,
    flag: "--runner",
  });
  if (runner.kind !== "unhandled") {
    return assignStringOption({
      result: runner,
      assign: (value) => {
        if (value.length > 0) {
          input.state.runner = value;
        }
      },
    });
  }

  const cwd = readStringOption({
    args: input.args,
    index: input.index,
    token: input.token,
    flag: "--cwd",
  });
  if (cwd.kind !== "unhandled") {
    return assignStringOption({
      result: cwd,
      assign: (value) => {
        input.state.cwd = value;
      },
    });
  }

  return null;
}

function handleJobCreateEnvArg(input: {
  readonly args: readonly string[];
  readonly index: number;
  readonly token: string;
  readonly state: JobCreateArgsState;
}): ArgStepResult | null {
  const env = readStringOption({
    args: input.args,
    index: input.index,
    token: input.token,
    flag: "--env",
    requiredError: "--env requires KEY=VALUE.",
  });
  if (env.kind === "unhandled") {
    return null;
  }
  return assignStringOption({
    result: env,
    assign: (value) => {
      input.state.envEntries.push(value);
    },
  });
}

function handleShellArg(input: {
  readonly args: readonly string[];
  readonly index: number;
  readonly token: string;
  readonly state: ShellArgsState;
}): ArgStepResult {
  return (
    handleShellStringArg(input) ??
    handleShellDimensionArg(input) ??
    handleShellEnvArg(input) ?? { kind: "unhandled" }
  );
}

function handleShellStringArg(input: {
  readonly args: readonly string[];
  readonly index: number;
  readonly token: string;
  readonly state: ShellArgsState;
}): ArgStepResult | null {
  const options: ReadonlyArray<{
    readonly flag: string;
    readonly assign: (value: string) => void;
  }> = [
    { flag: "--project", assign: (value) => (input.state.project = value) },
    {
      flag: "--project-id",
      assign: (value) => (input.state.projectId = value),
    },
    { flag: "--path", assign: (value) => (input.state.path = value) },
    { flag: "--gateway", assign: (value) => (input.state.gateway = value) },
    { flag: "--token", assign: (value) => (input.state.token = value) },
    { flag: "--shell", assign: (value) => (input.state.shell = value) },
    { flag: "--cwd", assign: (value) => (input.state.cwd = value) },
  ];
  for (const option of options) {
    const result = readStringOption({
      args: input.args,
      index: input.index,
      token: input.token,
      flag: option.flag,
    });
    if (result.kind === "unhandled") {
      continue;
    }
    return assignStringOption({ result, assign: option.assign });
  }
  return null;
}

function handleShellDimensionArg(input: {
  readonly args: readonly string[];
  readonly index: number;
  readonly token: string;
  readonly state: ShellArgsState;
}): ArgStepResult | null {
  const dimensions: ReadonlyArray<{
    readonly flag: string;
    readonly assign: (value: number) => void;
  }> = [
    { flag: "--cols", assign: (value) => (input.state.cols = value) },
    { flag: "--rows", assign: (value) => (input.state.rows = value) },
  ];
  for (const dimension of dimensions) {
    const result = readNumericOption({
      args: input.args,
      index: input.index,
      token: input.token,
      aliases: [dimension.flag],
      allow: true,
      unsupportedError: "",
      requiredError: `${dimension.flag} requires a value.`,
      invalidError: `${dimension.flag} must be a positive number.`,
      parser: parsePositiveInt,
    });
    if (result.kind === "unhandled") {
      continue;
    }
    return assignNumericOption({ result, assign: dimension.assign });
  }
  return null;
}

function handleShellEnvArg(input: {
  readonly args: readonly string[];
  readonly index: number;
  readonly token: string;
  readonly state: ShellArgsState;
}): ArgStepResult | null {
  const env = readStringOption({
    args: input.args,
    index: input.index,
    token: input.token,
    flag: "--env",
    requiredError: "--env requires KEY=VALUE.",
  });
  if (env.kind === "unhandled") {
    return null;
  }
  return assignStringOption({
    result: env,
    assign: (value) => {
      input.state.envEntries.push(value);
    },
  });
}

type ParsedStringOption =
  | {
      readonly kind: "handled";
      readonly nextIndex: number;
      readonly value: string;
    }
  | { readonly kind: "unhandled" }
  | { readonly kind: "error"; readonly error: string };

function readStringOption(input: {
  readonly args: readonly string[];
  readonly index: number;
  readonly token: string;
  readonly flag: string;
  readonly requiredError?: string;
}): ParsedStringOption {
  const inlinePrefix = `${input.flag}=`;
  if (input.token.startsWith(inlinePrefix)) {
    return {
      kind: "handled",
      nextIndex: input.index,
      value: input.token.slice(inlinePrefix.length).trim(),
    };
  }
  if (input.token !== input.flag) {
    return { kind: "unhandled" };
  }
  const value = takeOptionValue(input.args[input.index + 1]);
  if (value === null) {
    return {
      kind: "error",
      error: input.requiredError ?? `${input.flag} requires a value.`,
    };
  }
  return { kind: "handled", nextIndex: input.index + 1, value };
}

type ParsedNumericOption =
  | {
      readonly kind: "handled";
      readonly nextIndex: number;
      readonly value: number;
    }
  | { readonly kind: "unhandled" }
  | { readonly kind: "error"; readonly error: string };

function readNumericOption(input: {
  readonly args: readonly string[];
  readonly index: number;
  readonly token: string;
  readonly aliases: readonly string[];
  readonly allow: boolean;
  readonly unsupportedError: string;
  readonly requiredError: string;
  readonly invalidError: string;
  readonly parser: (value: string) => number | null;
}): ParsedNumericOption {
  for (const alias of input.aliases) {
    const inlinePrefix = `${alias}=`;
    if (input.token === alias || input.token.startsWith(inlinePrefix)) {
      if (!input.allow) {
        return { kind: "error", error: input.unsupportedError };
      }
      const value =
        input.token === alias
          ? takeOptionValue(input.args[input.index + 1])
          : input.token.slice(inlinePrefix.length).trim();
      if (value === null) {
        return { kind: "error", error: input.requiredError };
      }
      const parsed = input.parser(value);
      if (parsed === null) {
        return { kind: "error", error: input.invalidError };
      }
      return {
        kind: "handled",
        nextIndex: input.token === alias ? input.index + 1 : input.index,
        value: parsed,
      };
    }
  }
  return { kind: "unhandled" };
}

function assignStringOption(input: {
  readonly result: ParsedStringOption;
  readonly assign: (value: string) => void;
}): ArgStepResult {
  if (input.result.kind === "error") {
    return input.result;
  }
  if (input.result.kind === "unhandled") {
    return input.result;
  }
  input.assign(input.result.value);
  return { kind: "handled", nextIndex: input.result.nextIndex };
}

function assignNumericOption(input: {
  readonly result: ParsedNumericOption;
  readonly assign: (value: number) => void;
}): ArgStepResult {
  if (input.result.kind === "error") {
    return input.result;
  }
  if (input.result.kind === "unhandled") {
    return input.result;
  }
  input.assign(input.result.value);
  return { kind: "handled", nextIndex: input.result.nextIndex };
}

function takeOptionValue(value: string | undefined): string | null {
  if (!value || value.startsWith("-")) {
    return null;
  }
  return value;
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

  emitStreamBoundary({
    json: opts.json,
    type: "start",
    jobId: opts.jobId,
    logsOffset,
    includeEvents: opts.includeEvents,
    eventsSeq,
  });

  while (true) {
    const logResult = await streamJobLogChunk({
      store: opts.store,
      jobId: opts.jobId,
      offset: logsOffset,
      json: opts.json,
    });
    logsOffset = logResult.nextOffset;

    const eventResult = opts.includeEvents
      ? await streamJobEventBatch({
          store: opts.store,
          jobId: opts.jobId,
          eventsSeq,
          json: opts.json,
          logger: opts.logger,
        })
      : { didWork: false, nextEventsSeq: eventsSeq };
    eventsSeq = eventResult.nextEventsSeq;

    const didWork = logResult.didWork || eventResult.didWork;
    const now = Date.now();
    lastHeartbeatAt = maybeEmitStreamHeartbeat({
      json: opts.json,
      didWork,
      now,
      lastHeartbeatAt,
      heartbeatIntervalMs,
      logsOffset,
      includeEvents: opts.includeEvents,
      eventsSeq,
    });

    if (!opts.follow) {
      break;
    }

    const shouldStop = await shouldStopStreaming({
      store: opts.store,
      jobId: opts.jobId,
      didWork,
    });
    if (shouldStop) {
      break;
    }

    await sleep(500);
  }

  emitStreamBoundary({
    json: opts.json,
    type: "end",
    jobId: opts.jobId,
    logsOffset,
    includeEvents: opts.includeEvents,
    eventsSeq,
  });

  return { logsOffset, eventsSeq };
}

type ShellConnectionResult =
  | { readonly ok: true; readonly gatewayUrl: string; readonly token: string }
  | { readonly ok: false; readonly error: string };

function resolveShellConnection(input: {
  readonly parsed: ShellArgs;
}): ShellConnectionResult {
  const envGateway = (process.env.HACK_GATEWAY_URL ?? "").trim();
  const gatewayUrl =
    input.parsed.gateway ??
    (envGateway.length > 0 ? envGateway : "http://127.0.0.1:7788");
  const token =
    input.parsed.token ?? (process.env.HACK_GATEWAY_TOKEN ?? "").trim();
  if (!token) {
    return {
      ok: false,
      error:
        "Missing gateway token. Set HACK_GATEWAY_TOKEN or pass --token (write scope required).",
    };
  }
  return { ok: true, gatewayUrl, token };
}

type ResolvedShellProject =
  | {
      readonly ok: true;
      readonly projectId: string;
      readonly localProject?: ProjectContext;
    }
  | { readonly ok: false; readonly error: string };

async function resolveShellProject(input: {
  readonly ctx: {
    readonly project?: ProjectContext;
    readonly projectId?: string;
    readonly projectName?: string;
    readonly cwd: string;
    readonly logger: {
      warn: (input: { message: string }) => void;
    };
  };
  readonly parsed: ShellArgs;
  readonly client: GatewayClient;
}): Promise<ResolvedShellProject> {
  let projectId: string | undefined =
    input.parsed.projectId ?? input.ctx.projectId;
  let projectName: string | undefined =
    input.parsed.project ?? input.ctx.projectName;
  let localProject: ProjectContext | undefined = input.ctx.project;

  if (input.parsed.project || input.parsed.path) {
    const localProjectResult = await resolveSupervisorProject({
      ctx: input.ctx,
      projectOpt: input.parsed.project,
      pathOpt: input.parsed.path,
    });
    if (!localProjectResult.ok) {
      return localProjectResult;
    }
    localProject = localProjectResult.project;
    projectId = projectId ?? localProjectResult.projectId;
    projectName = localProjectResult.projectName ?? projectName;
  }

  const projectIdResult = await resolveGatewayProjectId({
    client: input.client,
    projectId,
    projectName,
  });
  if (!projectIdResult.ok) {
    return projectIdResult;
  }

  return {
    ok: true,
    projectId: projectIdResult.projectId,
    ...(localProject ? { localProject } : {}),
  };
}

function resolveShellDimensions(input: { readonly parsed: ShellArgs }): {
  readonly cols: number;
  readonly rows: number;
} {
  const fallbackCols = 120;
  const fallbackRows = 30;
  return {
    cols:
      input.parsed.cols ??
      (typeof process.stdout.columns === "number"
        ? process.stdout.columns
        : fallbackCols),
    rows:
      input.parsed.rows ??
      (typeof process.stdout.rows === "number"
        ? process.stdout.rows
        : fallbackRows),
  };
}

function buildShellCreateInput(input: {
  readonly parsed: ShellArgs;
  readonly projectId: string;
  readonly cols: number;
  readonly rows: number;
}): {
  readonly projectId: string;
  readonly shell?: string;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly cols: number;
  readonly rows: number;
} {
  return {
    projectId: input.projectId,
    ...(input.parsed.shell ? { shell: input.parsed.shell } : {}),
    ...(input.parsed.cwd ? { cwd: input.parsed.cwd } : {}),
    ...(input.parsed.env ? { env: input.parsed.env } : {}),
    cols: input.cols,
    rows: input.rows,
  };
}

type ShellCreateResult = Awaited<ReturnType<GatewayClient["createShell"]>>;

async function createShellWithRetry(input: {
  readonly ctx: {
    readonly logger: {
      info: (input: { message: string }) => void;
      warn: (input: { message: string }) => void;
    };
  };
  readonly client: GatewayClient;
  readonly localProject?: ProjectContext;
  readonly shellInput: Parameters<GatewayClient["createShell"]>[0];
}): Promise<ShellCreateResult> {
  let created = await input.client.createShell(input.shellInput);
  if (!(created.ok || created.error.code !== "writes_disabled")) {
    const didEnable = await maybeEnableGatewayWrites({
      ctx: input.ctx,
      project: input.localProject,
    });
    if (didEnable) {
      created = await input.client.createShell(input.shellInput);
    }
  }
  return created;
}

async function reportShellCreateFailure(input: {
  readonly logger: {
    error: (input: { message: string }) => void;
    info: (input: { message: string }) => void;
    warn: (input: { message: string }) => void;
  };
  readonly created: ShellCreateResult;
}): Promise<void> {
  if (input.created.ok) {
    return;
  }
  if (
    input.created.error.code === "writes_disabled" ||
    input.created.error.code === "write_scope_required"
  ) {
    await reportGatewayConfigSource({ logger: input.logger });
  }
  const detailed = buildShellCreateErrorHint({ error: input.created.error });
  input.logger.error({
    message: `Shell create failed (${input.created.status}): ${input.created.error.message}`,
  });
  if (detailed) {
    input.logger.info({ message: detailed });
  }
}

function emitStreamBoundary(input: {
  readonly json: boolean;
  readonly type: "start" | "end";
  readonly jobId: string;
  readonly logsOffset: number;
  readonly includeEvents: boolean;
  readonly eventsSeq: number;
}): void {
  if (!input.json) {
    return;
  }
  writeJsonLine({
    type: input.type,
    jobId: input.jobId,
    logsOffset: input.logsOffset,
    ...(input.includeEvents ? { eventsSeq: input.eventsSeq } : {}),
  });
}

async function streamJobLogChunk(input: {
  readonly store: JobStore;
  readonly jobId: string;
  readonly offset: number;
  readonly json: boolean;
}): Promise<{ readonly didWork: boolean; readonly nextOffset: number }> {
  const logChunk = await readFileChunk({
    path: input.store.getJobPaths({ jobId: input.jobId }).combinedPath,
    offset: input.offset,
  });
  if (!logChunk) {
    return { didWork: false, nextOffset: input.offset };
  }
  if (input.json) {
    writeJsonLine({
      type: "log",
      stream: "combined",
      offset: logChunk.nextOffset,
      data: logChunk.data,
    });
  } else {
    process.stdout.write(logChunk.data);
  }
  return { didWork: true, nextOffset: logChunk.nextOffset };
}

async function streamJobEventBatch(input: {
  readonly store: JobStore;
  readonly jobId: string;
  readonly eventsSeq: number;
  readonly json: boolean;
  readonly logger: { info: (input: { message: string }) => void };
}): Promise<{ readonly didWork: boolean; readonly nextEventsSeq: number }> {
  const events = await input.store.readEvents({ jobId: input.jobId });
  const nextEvents = events.filter((event) => event.seq > input.eventsSeq);
  if (nextEvents.length === 0) {
    return { didWork: false, nextEventsSeq: input.eventsSeq };
  }
  let nextEventsSeq = input.eventsSeq;
  for (const event of nextEvents) {
    nextEventsSeq = event.seq;
    if (input.json) {
      writeJsonLine({ type: "event", seq: event.seq, event });
      continue;
    }
    input.logger.info({ message: `event ${event.type}` });
  }
  return { didWork: true, nextEventsSeq };
}

function maybeEmitStreamHeartbeat(input: {
  readonly json: boolean;
  readonly didWork: boolean;
  readonly now: number;
  readonly lastHeartbeatAt: number;
  readonly heartbeatIntervalMs: number;
  readonly logsOffset: number;
  readonly includeEvents: boolean;
  readonly eventsSeq: number;
}): number {
  if (input.didWork) {
    return input.now;
  }
  if (
    !(
      input.json &&
      input.now - input.lastHeartbeatAt >= input.heartbeatIntervalMs
    )
  ) {
    return input.lastHeartbeatAt;
  }
  writeJsonLine({
    type: "heartbeat",
    ts: new Date().toISOString(),
    logsOffset: input.logsOffset,
    ...(input.includeEvents ? { eventsSeq: input.eventsSeq } : {}),
  });
  return input.now;
}

async function shouldStopStreaming(input: {
  readonly store: JobStore;
  readonly jobId: string;
  readonly didWork: boolean;
}): Promise<boolean> {
  if (input.didWork) {
    return false;
  }
  const meta = await input.store.readJobMeta({ jobId: input.jobId });
  return meta ? TERMINAL_STATUSES.has(meta.status) : false;
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
