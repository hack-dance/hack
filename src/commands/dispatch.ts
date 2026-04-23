// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: Unsupported experimental dispatch keeps the remote orchestration state machine in one module.
import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";

import type { CliContext, CommandArgs } from "../cli/command.ts";
import { defineCommand, defineOption, withHandler } from "../cli/command.ts";
import { optFollow, optJson, optTail } from "../cli/options.ts";
import type { JobMeta } from "../control-plane/extensions/supervisor/job-store.ts";
import { persistDispatchRunToTicketsChannel } from "../control-plane/extensions/tickets/runs-channel.ts";
import { appendPolicyAuditEvent } from "../control-plane/policy/audit.ts";
import { resolvePolicyDecision } from "../control-plane/policy/engine.ts";
import { assessCommandRisk } from "../control-plane/policy/risk.ts";
import {
  type DispatchRouteDiagnostic,
  resolveDispatchRoute,
} from "../control-plane/routing/resolver.ts";
import {
  type ControlPlaneConfig,
  readControlPlaneConfig,
} from "../control-plane/sdk/config.ts";
import {
  createGatewayClient,
  type GatewayClient,
  type GatewayNodeBootstrapAuthSource,
  type GatewayNodeGitProbeResponse,
  type GatewayNodeStatus,
  type GatewayNodeWorkspace,
  type GatewayNodeWorkspaceBootstrap,
} from "../control-plane/sdk/gateway-client.ts";
import {
  appendDispatchRunEvent,
  appendDispatchRunLog,
  createDispatchRunRecord,
  type DispatchRunRecord,
  type DispatchRunStatus,
  readDispatchRunLogTail,
  readDispatchRunRecord,
  updateDispatchRunRecord,
  writeDispatchRunArtifacts,
} from "../lib/dispatch-runs.ts";
import { getString, isRecord } from "../lib/guards.ts";
import { ensureMutagenLocalToRemoteSync } from "../lib/mutagen-sync.ts";
import {
  deriveNodeHealth,
  type NodeRecord,
  readNodeAuthToken,
  readNodesRegistry,
  touchNode,
} from "../lib/nodes-registry.ts";
import { readProjectConfig } from "../lib/project.ts";
import {
  resolveRegisteredProjectById,
  resolveRegisteredProjectByName,
  upsertProjectRegistration,
} from "../lib/projects-registry.ts";
import {
  type RemoteCaddyRouteBridgeResult,
  reconcileRemoteCaddyRoutesForProject,
} from "../lib/remote-caddy-routes.ts";
import { exec } from "../lib/shell.ts";
import { display } from "../ui/display.ts";
import { logger } from "../ui/logger.ts";

const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);
const PROJECT_ID_LIKE_PATTERN = /^[a-f0-9]{12}$/i;

const optNode = defineOption({
  name: "node",
  type: "string",
  long: "--node",
  valueHint: "<id|default|auto>",
  description: "Target node id, or select default/auto",
} as const);

const optProjectSelector = defineOption({
  name: "project",
  type: "string",
  long: "--project",
  valueHint: "<name|id>",
  description: "Project name or id",
} as const);

const optBranch = defineOption({
  name: "branch",
  type: "string",
  long: "--branch",
  valueHint: "<branch>",
  description: "Target branch on selected node",
} as const);

const optTicket = defineOption({
  name: "ticket",
  type: "string",
  long: "--ticket",
  valueHint: "<ticket-id>",
  description: "Ticket id to associate with this run",
} as const);

const optRunner = defineOption({
  name: "runner",
  type: "string",
  long: "--runner",
  valueHint: "<generic|codex|claude|cursor>",
  description: "Runner identity for policy/audit metadata",
} as const);

const optProvider = defineOption({
  name: "provider",
  type: "string",
  long: "--provider",
  valueHint: "<provider>",
  description: "Route intent provider override (for example: railway, aws)",
} as const);

const optProfile = defineOption({
  name: "profile",
  type: "string",
  long: "--profile",
  valueHint: "<profile-id>",
  description: "Route intent provider profile override",
} as const);

const optBootstrapIfNeeded = defineOption({
  name: "bootstrapIfNeeded",
  type: "boolean",
  long: "--bootstrap-if-needed",
  description:
    "Allow guarded provider bootstrap handoff when no reachable node exists",
} as const);

const optApprove = defineOption({
  name: "approve",
  type: "boolean",
  long: "--approve",
  description: "Approve high/critical command risk without interactive prompt",
} as const);

const optPr = defineOption({
  name: "pr",
  type: "boolean",
  long: "--pr",
  description: "Removed in v3: legacy GitHub PR automation flag",
} as const);

const optPrBase = defineOption({
  name: "prBase",
  type: "string",
  long: "--pr-base",
  valueHint: "<branch>",
  description: "Removed in v3: legacy GitHub PR automation flag",
} as const);

const optPrTitle = defineOption({
  name: "prTitle",
  type: "string",
  long: "--pr-title",
  valueHint: "<title>",
  description: "Removed in v3: legacy GitHub PR automation flag",
} as const);

const optPrBody = defineOption({
  name: "prBody",
  type: "string",
  long: "--pr-body",
  valueHint: "<markdown>",
  description: "Removed in v3: legacy GitHub PR automation flag",
} as const);

const optGitHubProfile = defineOption({
  name: "githubProfile",
  type: "string",
  long: "--github-profile",
  valueHint: "<profile-id>",
  description: "Removed in v3: legacy GitHub PR automation flag",
} as const);

const runOptions = [
  optNode,
  optProvider,
  optProfile,
  optBootstrapIfNeeded,
  optProjectSelector,
  optBranch,
  optTicket,
  optRunner,
  optApprove,
  optPr,
  optPrBase,
  optPrTitle,
  optPrBody,
  optGitHubProfile,
  optJson,
] as const;

const runPositionals = [
  { name: "command", required: false, multiple: true },
] as const;

const statusOptions = [optJson] as const;
const statusPositionals = [{ name: "runId", required: true }] as const;

const logsOptions = [optFollow, optTail, optJson] as const;
const logsPositionals = [{ name: "runId", required: true }] as const;

const dispatchSpec = defineCommand({
  name: "dispatch",
  summary: "Beta: run branch-scoped jobs on remote nodes",
  group: "Beta",
  options: [],
  positionals: [],
  subcommands: [],
} as const);

const runSpec = defineCommand({
  name: "run",
  summary: "Dispatch a command to a node workspace",
  group: "Beta",
  options: runOptions,
  positionals: runPositionals,
  subcommands: [],
} as const);

const statusSpec = defineCommand({
  name: "status",
  summary: "Show dispatched run status",
  group: "Beta",
  options: statusOptions,
  positionals: statusPositionals,
  subcommands: [],
} as const);

const logsSpec = defineCommand({
  name: "logs",
  summary: "Show or follow persisted/remote run logs",
  group: "Beta",
  options: logsOptions,
  positionals: logsPositionals,
  subcommands: [],
} as const);

type DispatchRunArgs = CommandArgs<typeof runOptions, typeof runPositionals>;
type DispatchStatusArgs = CommandArgs<
  typeof statusOptions,
  typeof statusPositionals
>;
type DispatchLogsArgs = CommandArgs<typeof logsOptions, typeof logsPositionals>;

export const dispatchCommand = withHandler(
  defineCommand({
    ...dispatchSpec,
    subcommands: [
      withHandler(runSpec, handleDispatchRun),
      withHandler(statusSpec, handleDispatchStatus),
      withHandler(logsSpec, handleDispatchLogs),
    ],
  } as const),
  async () => {
    await display.panel({
      title: "Dispatch commands",
      tone: "info",
      lines: [
        "hack dispatch run --project <name|id> [--node <id|default|auto>] [--provider <name>] [--profile <id>] [--bootstrap-if-needed] [--branch <name>] [--runner <runner>] -- <command...>",
        "hack dispatch status <run-id>",
        "hack dispatch logs <run-id> [--follow]",
      ],
    });
    return 0;
  }
);

async function handleDispatchRun({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: DispatchRunArgs;
}): Promise<number> {
  const projectSelector = (args.options.project ?? "").trim();
  if (!projectSelector) {
    logger.error({
      message:
        "Missing --project <name|id>. Example: hack dispatch run --project my-app --branch feat/foo -- bun test",
    });
    return 1;
  }
  const command = args.positionals.command;
  if (!command || command.length === 0) {
    logger.error({
      message:
        "Missing command. Example: hack dispatch run --project my-app --branch feat/foo -- bun test",
    });
    return 1;
  }
  const removedPrMessage = resolveRemovedDispatchPrAutomationMessage({
    pr: args.options.pr,
    prBase: args.options.prBase,
    prTitle: args.options.prTitle,
    prBody: args.options.prBody,
    githubProfile: args.options.githubProfile,
  });
  if (removedPrMessage) {
    logger.warn({ message: removedPrMessage });
  }
  const runner = (args.options.runner ?? "generic").trim() || "generic";
  const ticketId = (args.options.ticket ?? "").trim() || undefined;
  const branch = (args.options.branch ?? "").trim() || undefined;
  const actor = (process.env.USER ?? "unknown").trim() || "unknown";

  const project = await resolveDispatchProject({
    selector: projectSelector,
  });
  const controlPlane = await readControlPlaneConfig({
    ...(project.projectDir ? { projectDir: project.projectDir } : {}),
  });
  if (controlPlane.parseError) {
    logger.warn({ message: controlPlane.parseError });
  }

  const requestedNode = normalizeOptionalString(args.options.node);
  const route = resolveDispatchRoute({
    config: controlPlane.config,
    commandNode: requestedNode,
    commandProvider: normalizeOptionalString(args.options.provider),
    commandProfile: normalizeOptionalString(args.options.profile),
    commandBootstrapIfNeeded: args.options.bootstrapIfNeeded === true,
  });
  emitRouteDiagnostics({ diagnostics: route.diagnostics });
  if (shouldFailForRouteDiagnostics({ route, args })) {
    logger.error({
      message: formatRouteDiagnosticSummary({ diagnostics: route.diagnostics }),
    });
    return 1;
  }
  const nodeResolution = await resolveDispatchNodeWithRoute({
    requestedNode,
    projectNodeId: project.projectNodeId,
    route,
    project,
    staleAfterMs: controlPlane.config.cluster.staleAfterMs,
    offlineAfterMs: controlPlane.config.cluster.offlineAfterMs,
    defaultNodeIdHint: controlPlane.config.cluster.defaultNodeId ?? undefined,
    jsonMode: args.options.json === true,
  });
  if (!nodeResolution.ok) {
    logger.error({ message: nodeResolution.error });
    return 1;
  }
  const selectedNode = nodeResolution.node;
  const routeMetadata = buildDispatchRouteMetadata({
    requestedNode,
    requestedProvider: normalizeOptionalString(args.options.provider),
    requestedProfile: normalizeOptionalString(args.options.profile),
    route,
    selectedNode,
    bootstrap: nodeResolution.bootstrap,
  });

  const risk = assessCommandRisk({ command, runner });
  const policy = await resolvePolicyDecision({
    level: risk.level,
    reasons: risk.reasons,
    requiresApproval: risk.requiresApproval,
    approveFlag: args.options.approve === true,
    actor,
    promptLabel: "primary command",
  });

  const runId = randomUUID();
  const run = await createDispatchRunRecord({
    runId,
    nodeId: selectedNode.node.id,
    nodeName: selectedNode.node.name,
    nodeEndpoint: selectedNode.node.endpoint,
    projectSelector,
    ...(project.projectName ? { projectName: project.projectName } : {}),
    ...(project.projectRoot ? { projectRoot: project.projectRoot } : {}),
    ...(branch ? { branch } : {}),
    ...(ticketId ? { ticketId } : {}),
    runner,
    command,
    policy: {
      level: policy.level,
      requiresApproval: policy.requiresApproval,
      approved: policy.approved,
      rationale: [...policy.reasons],
      actor,
      decidedAt: new Date().toISOString(),
      mode: policy.mode,
    },
  });
  await appendDispatchRunEvent({
    runId,
    event: {
      type: "run.created",
      nodeId: selectedNode.node.id,
      project: project.projectName ?? project.selector,
      branch: branch ?? null,
      runner,
      ticketId: ticketId ?? null,
    },
  });
  await appendDispatchRunEvent({
    runId,
    event: {
      type: "run.route.resolved",
      route: routeMetadata,
    },
  });
  await appendDispatchRunEvent({
    runId,
    event: {
      type: "policy.decision",
      level: policy.level,
      requiresApproval: policy.requiresApproval,
      approved: policy.approved,
      mode: policy.mode,
      reasons: policy.reasons,
      actor,
    },
  });
  await appendPolicyAuditEvent({
    actor,
    operation: "dispatch.run",
    level: policy.level,
    requiresApproval: policy.requiresApproval,
    approved: policy.approved,
    mode: policy.mode,
    reasons: policy.reasons,
    command,
    runner,
    runId,
    ...(ticketId ? { ticketId } : {}),
    nodeId: selectedNode.node.id,
    projectSelector,
    ...(policy.approved ? {} : { error: policy.error }),
  });
  if (!policy.approved) {
    await finalizeFailedRun({
      run,
      errorMessage: policy.error,
      status: "cancelled",
      reason: "policy_denied",
      controlPlaneConfig: controlPlane.config,
      actor,
    });
    logger.error({ message: policy.error });
    return 1;
  }

  await updateDispatchRunRecord({
    runId,
    patch: {
      status: "running",
      startedAt: new Date().toISOString(),
    },
  });

  const workspaceRequest = await resolveWorkspaceEnsureRequest({
    project,
    controlPlaneConfig: controlPlane.config,
    branch,
  });
  const bootstrapProbe = await probeWorkspaceBootstrapAccess({
    client: selectedNode.client,
    request: workspaceRequest,
  });
  if (bootstrapProbe) {
    await appendDispatchRunEvent({
      runId,
      event: {
        type: "run.bootstrap.probe",
        repoUrl: bootstrapProbe.repoUrl,
        ok: bootstrapProbe.ok,
        authSource: bootstrapProbe.authSource,
        ...(bootstrapProbe.unsupported ? { unsupported: true } : {}),
        ...(bootstrapProbe.error ? { error: bootstrapProbe.error } : {}),
      },
    });
    if (!(bootstrapProbe.ok || bootstrapProbe.unsupported)) {
      logger.warn({
        message: `Git credential probe failed before workspace bootstrap: ${bootstrapProbe.error ?? "unknown_error"}`,
      });
    }
  }
  const workspace =
    await selectedNode.client.ensureNodeWorkspace(workspaceRequest);
  if (!workspace.ok) {
    const errorMessage = formatWorkspaceEnsureError({
      workspace,
      workspaceRequest,
      bootstrapProbe,
    });
    await finalizeFailedRun({
      run,
      errorMessage,
      status: "error",
      reason: "workspace_ensure_failed",
      controlPlaneConfig: controlPlane.config,
      actor,
    });
    logger.error({ message: errorMessage });
    return 1;
  }
  const bootstrapAuthEnsured = workspace.data.bootstrapAuthSource;
  if (bootstrapAuthEnsured) {
    await appendDispatchRunEvent({
      runId,
      event: {
        type: "run.bootstrap.auth_source",
        authSource: bootstrapAuthEnsured,
      },
    });
  }
  const bootstrapAuth: DispatchWorkspaceBootstrapAuth = {
    ...(bootstrapProbe ? { probe: bootstrapProbe } : {}),
    ...(bootstrapAuthEnsured ? { ensured: bootstrapAuthEnsured } : {}),
  };
  const remoteRouteBridge = await reconcileDispatchRemoteRouteBridge({
    project,
    workspace: workspace.data.workspace,
    node: selectedNode.node,
  });
  if (remoteRouteBridge) {
    await appendDispatchRunEvent({
      runId,
      event: {
        type: "run.route.bridge",
        status: remoteRouteBridge.status,
        reason: remoteRouteBridge.reason,
        hosts: remoteRouteBridge.hosts,
        upstream: remoteRouteBridge.upstream,
        composePath: remoteRouteBridge.composePath,
        ...(remoteRouteBridge.error ? { error: remoteRouteBridge.error } : {}),
      },
    });
    if (remoteRouteBridge.status === "failed") {
      logger.warn({
        message: `Remote route bridge failed: ${remoteRouteBridge.error ?? remoteRouteBridge.reason}`,
      });
    } else if (remoteRouteBridge.status === "applied") {
      logger.info({
        message: `Remote route bridge applied (${remoteRouteBridge.hosts.length} host${remoteRouteBridge.hosts.length === 1 ? "" : "s"})`,
      });
    }
  }

  let syncMetadata: DispatchSyncMetadata | null = null;
  const preparedSync = await prepareDispatchSync({
    config: controlPlane.config,
    project,
    node: selectedNode.node,
    workspace: workspace.data.workspace,
  });
  if (!preparedSync.ok) {
    await finalizeFailedRun({
      run,
      errorMessage: preparedSync.error,
      status: "error",
      reason: preparedSync.reason,
      controlPlaneConfig: controlPlane.config,
      actor,
    });
    logger.error({ message: preparedSync.error });
    return 1;
  }
  if (preparedSync.sync) {
    syncMetadata = preparedSync.sync;
    await appendDispatchRunEvent({
      runId,
      event: {
        type: "run.sync.prepared",
        engine: syncMetadata.engine,
        sessionName: syncMetadata.sessionName,
        created: syncMetadata.created,
        localPath: syncMetadata.localPath,
        remotePath: syncMetadata.remotePath,
        excludes: syncMetadata.excludes,
      },
    });
  }

  const created = await selectedNode.client.createJob({
    projectId: workspace.data.workspace.projectId,
    runner,
    command,
    cwd: workspace.data.workspace.projectRoot,
  });
  if (!created.ok) {
    const errorMessage = `Job create failed (${created.status}): ${created.error.message}`;
    await finalizeFailedRun({
      run,
      errorMessage,
      status: "error",
      reason: "job_create_failed",
      controlPlaneConfig: controlPlane.config,
      actor,
    });
    logger.error({ message: errorMessage });
    return 1;
  }

  await updateDispatchRunRecord({
    runId,
    patch: {
      projectName: workspace.data.workspace.projectName,
      projectId: workspace.data.workspace.projectId,
      ...(workspace.data.workspace.branch
        ? { branch: workspace.data.workspace.branch }
        : {}),
      jobId: created.data.job.jobId,
      jobStatus: created.data.job.status,
      status: "running",
    },
  });
  await appendDispatchRunEvent({
    runId,
    event: {
      type: "job.created",
      jobId: created.data.job.jobId,
      projectId: workspace.data.workspace.projectId,
      projectName: workspace.data.workspace.projectName,
      branch: workspace.data.workspace.branch,
    },
  });

  if (!args.options.json) {
    await display.kv({
      title: "Dispatch run started",
      entries: [
        ["run_id", runId],
        ["node", selectedNode.node.name],
        ["project", workspace.data.workspace.projectName],
        ["branch", workspace.data.workspace.branch ?? ""],
        ["job_id", created.data.job.jobId],
        ["runner", runner],
      ],
    });
  }

  const outcome = await streamRemoteJob({
    runId,
    client: selectedNode.client,
    projectId: workspace.data.workspace.projectId,
    jobId: created.data.job.jobId,
    logsFrom: 0,
    eventsFrom: 0,
    printLogs: args.options.json !== true,
  });

  if (outcome.job) {
    const status = mapJobStatusToRunStatus({ jobStatus: outcome.job.status });
    await updateDispatchRunRecord({
      runId,
      patch: {
        status,
        jobStatus: outcome.job.status,
        logOffset: outcome.logsOffset,
        eventsSeq: outcome.eventsSeq,
        ...(outcome.exitCode !== undefined
          ? { exitCode: outcome.exitCode }
          : {}),
        finishedAt: new Date().toISOString(),
      },
    });
    await appendDispatchRunEvent({
      runId,
      event: {
        type: "run.completed",
        runStatus: status,
        jobStatus: outcome.job.status,
        exitCode: outcome.exitCode ?? null,
      },
    });

    const summary = buildSummaryMarkdown({
      runId,
      runStatus: status,
      node: selectedNode.node,
      workspace: workspace.data.workspace,
      job: outcome.job,
      command,
      runner,
      riskLevel: policy.level,
      riskReasons: policy.reasons,
      route: routeMetadata,
      sync: syncMetadata,
      bootstrapAuth,
      remoteRouteBridge,
    });
    await writeDispatchRunArtifacts({
      runId,
      summaryMarkdown: summary,
      patchDiff: "# no diff captured for this run",
      testsManifest: {
        runner,
        command,
        status,
        jobStatus: outcome.job.status,
        ...(outcome.exitCode !== undefined
          ? { exitCode: outcome.exitCode }
          : {}),
      },
      manifest: {
        runId,
        nodeId: selectedNode.node.id,
        projectId: workspace.data.workspace.projectId,
        projectName: workspace.data.workspace.projectName,
        branch: workspace.data.workspace.branch,
        jobId: outcome.job.jobId,
        jobStatus: outcome.job.status,
        runner,
        command,
        riskLevel: policy.level,
        riskReasons: policy.reasons,
        route: routeMetadata,
        ...(Object.keys(bootstrapAuth).length > 0 ? { bootstrapAuth } : {}),
        ...(remoteRouteBridge ? { remoteRouteBridge } : {}),
        ...(syncMetadata ? { sync: syncMetadata } : {}),
        ...(ticketId ? { ticketId } : {}),
      },
    });

    const currentRun = (await readDispatchRunRecord({ runId })) ?? run;
    await persistRunArtifactsToCanonicalTickets({
      run: currentRun,
      controlPlaneConfig: controlPlane.config,
      actor,
    });

    const exitCode = status === "completed" ? 0 : 1;
    if (args.options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            runId,
            status,
            job: outcome.job,
            node: selectedNode.node,
            workspace: workspace.data.workspace,
            artifacts: run.artifacts,
            route: routeMetadata,
            ...(Object.keys(bootstrapAuth).length > 0 ? { bootstrapAuth } : {}),
            ...(syncMetadata ? { sync: syncMetadata } : {}),
            ...(outcome.exitCode !== undefined
              ? { exitCode: outcome.exitCode }
              : {}),
          },
          null,
          2
        )}\n`
      );
      return exitCode;
    }

    await display.kv({
      title: "Dispatch run completed",
      entries: [
        ["run_id", runId],
        ["status", status],
        ["job_status", outcome.job.status],
        ["job_id", outcome.job.jobId],
        ["route_source", routeMetadata.nodeSource],
        ["provider", routeMetadata.provider],
        ["profile", routeMetadata.profileId ?? ""],
        ...(syncMetadata
          ? ([
              ["sync", `${syncMetadata.engine}:${syncMetadata.sessionName}`],
            ] as const)
          : []),
        ["logs", run.artifacts.logPath],
        ["summary", run.artifacts.summaryPath],
      ],
    });
    return exitCode;
  }

  const failure = `Job stream ended before final status; run id: ${runId}`;
  await finalizeFailedRun({
    run,
    errorMessage: failure,
    status: "error",
    reason: "job_stream_failed",
    controlPlaneConfig: controlPlane.config,
    actor,
  });
  logger.error({ message: failure });
  return 1;
}

async function handleDispatchStatus({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: DispatchStatusArgs;
}): Promise<number> {
  const runId = args.positionals.runId.trim();
  const run = await readDispatchRunRecord({ runId });
  if (!run) {
    logger.error({ message: `Run not found: ${runId}` });
    return 1;
  }

  const refreshed = await refreshRunStatusFromRemote({ run });
  const current = refreshed ?? run;

  if (args.options.json) {
    process.stdout.write(`${JSON.stringify({ run: current }, null, 2)}\n`);
    return 0;
  }

  await display.kv({
    title: `Dispatch run ${runId}`,
    entries: [
      ["status", current.status],
      ["job_status", current.jobStatus ?? ""],
      ["node", `${current.nodeName} (${current.nodeId})`],
      ["project", current.projectName ?? current.projectSelector],
      ["project_id", current.projectId ?? ""],
      ["branch", current.branch ?? ""],
      ["runner", current.runner],
      ["job_id", current.jobId ?? ""],
      ["created_at", current.createdAt],
      ["updated_at", current.updatedAt],
      ["logs", current.artifacts.logPath],
    ],
  });
  return 0;
}

async function handleDispatchLogs({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: DispatchLogsArgs;
}): Promise<number> {
  const runId = args.positionals.runId.trim();
  const run = await readDispatchRunRecord({ runId });
  if (!run) {
    logger.error({ message: `Run not found: ${runId}` });
    return 1;
  }

  const maxBytes = Math.max(1000, (args.options.tail ?? 200) * 250);
  const existing = await readDispatchRunLogTail({ runId, maxBytes });
  if (args.options.json) {
    process.stdout.write(
      `${JSON.stringify({ runId, follow: args.options.follow === true, logs: existing }, null, 2)}\n`
    );
  } else if (existing.length > 0) {
    process.stdout.write(existing);
  }

  const follow = args.options.follow === true;
  if (!follow) {
    return 0;
  }

  if (
    run.status === "completed" ||
    run.status === "failed" ||
    run.status === "cancelled" ||
    run.status === "error"
  ) {
    return run.status === "completed" ? 0 : 1;
  }

  if (!(run.projectId && run.jobId)) {
    logger.error({ message: "Run is missing project/job identifiers." });
    return 1;
  }

  const nodeClient = await resolveNodeClient({ nodeId: run.nodeId });
  if (!nodeClient.ok) {
    logger.error({ message: nodeClient.error });
    return 1;
  }

  const stream = await streamRemoteJob({
    runId,
    client: nodeClient.client,
    projectId: run.projectId,
    jobId: run.jobId,
    logsFrom: run.logOffset ?? 0,
    eventsFrom: run.eventsSeq ?? 0,
    printLogs: args.options.json !== true,
  });

  if (!stream.job) {
    logger.error({ message: "Unable to resolve remote job status." });
    return 1;
  }
  const status = mapJobStatusToRunStatus({ jobStatus: stream.job.status });
  const updated = await updateDispatchRunRecord({
    runId,
    patch: {
      status,
      jobStatus: stream.job.status,
      logOffset: stream.logsOffset,
      eventsSeq: stream.eventsSeq,
      ...(stream.exitCode !== undefined ? { exitCode: stream.exitCode } : {}),
      ...(TERMINAL_JOB_STATUSES.has(stream.job.status)
        ? { finishedAt: new Date().toISOString() }
        : {}),
    },
  });
  if (args.options.json) {
    process.stdout.write(`${JSON.stringify({ run: updated }, null, 2)}\n`);
  }
  return runStatusToExitCode({ status });
}

type DispatchProjectResolution = {
  readonly selector: string;
  readonly selectorType: "name" | "id" | "raw";
  readonly controllerProjectId?: string;
  readonly projectName?: string;
  readonly projectNodeId?: string;
  readonly projectDir?: string;
  readonly projectRoot?: string;
};

type WorkspaceEnsureRequest = {
  readonly project?: string;
  readonly projectId?: string;
  readonly controllerProjectId?: string;
  readonly controllerProjectName?: string;
  readonly branch?: string;
  readonly bootstrap?: GatewayNodeWorkspaceBootstrap;
};

type WorkspaceBootstrapProbeResult = GatewayNodeGitProbeResponse & {
  readonly unsupported?: boolean;
};

async function resolveDispatchProject(input: {
  readonly selector: string;
}): Promise<DispatchProjectResolution> {
  const selector = input.selector.trim();
  const byId = await resolveRegisteredProjectById({ id: selector });
  if (byId) {
    const controlPlane = await readControlPlaneConfig({
      projectDir: byId.project.projectDir,
    });
    return {
      selector,
      selectorType: "id",
      controllerProjectId: byId.registration.id,
      projectName: byId.registration.name,
      ...(controlPlane.config.nodeId
        ? { projectNodeId: controlPlane.config.nodeId }
        : {}),
      projectDir: byId.project.projectDir,
      projectRoot: byId.project.projectRoot,
    };
  }

  const byName = await resolveRegisteredProjectByName({ name: selector });
  if (byName) {
    const registration = await upsertProjectRegistration({ project: byName });
    const projectConfig = await readProjectConfig(byName);
    const controlPlane = await readControlPlaneConfig({
      projectDir: byName.projectDir,
    });
    return {
      selector,
      selectorType: "name",
      controllerProjectId:
        registration.status === "conflict"
          ? registration.existing.id
          : registration.project.id,
      projectName:
        registration.status === "conflict"
          ? (projectConfig.name ?? selector)
          : registration.project.name,
      ...(controlPlane.config.nodeId
        ? { projectNodeId: controlPlane.config.nodeId }
        : {}),
      projectDir: byName.projectDir,
      projectRoot: byName.projectRoot,
    };
  }

  const idLike = PROJECT_ID_LIKE_PATTERN.test(selector);
  return {
    selector,
    selectorType: idLike ? "id" : "raw",
  };
}

async function resolveWorkspaceEnsureRequest(input: {
  readonly project: DispatchProjectResolution;
  readonly controlPlaneConfig: ControlPlaneConfig;
  readonly branch?: string;
}): Promise<WorkspaceEnsureRequest> {
  let base: { readonly project?: string; readonly projectId?: string };
  if (input.project.projectName && input.project.projectName.length > 0) {
    base = { project: input.project.projectName };
  } else if (input.project.selectorType === "id") {
    base = { projectId: input.project.selector };
  } else {
    base = { project: input.project.selector };
  }
  const bootstrap = await resolveWorkspaceBootstrap({
    project: input.project,
    controlPlaneConfig: input.controlPlaneConfig,
  });
  return {
    ...base,
    ...(input.project.controllerProjectId
      ? { controllerProjectId: input.project.controllerProjectId }
      : {}),
    ...(input.project.projectName
      ? { controllerProjectName: input.project.projectName }
      : {}),
    ...(input.branch ? { branch: input.branch } : {}),
    ...(bootstrap ? { bootstrap } : {}),
  };
}

async function resolveWorkspaceBootstrap(input: {
  readonly project: DispatchProjectResolution;
  readonly controlPlaneConfig: ControlPlaneConfig;
}): Promise<GatewayNodeWorkspaceBootstrap | null> {
  const projectRoot = input.project.projectRoot;
  if (!projectRoot) {
    return null;
  }

  const remote = await exec(
    ["git", "-C", projectRoot, "remote", "get-url", "origin"],
    {
      stdin: "ignore",
    }
  );
  if (remote.exitCode !== 0) {
    return null;
  }

  const repoUrl = remote.stdout.trim();
  if (!repoUrl) {
    return null;
  }

  return {
    repoUrl,
    projectName: input.project.projectName ?? basename(projectRoot).trim(),
  };
}

/**
 * Probe bootstrap auth path before workspace ensure so UX can explain why bootstrap will fail or succeed.
 */
async function probeWorkspaceBootstrapAccess(input: {
  readonly client: GatewayClient;
  readonly request: WorkspaceEnsureRequest;
}): Promise<WorkspaceBootstrapProbeResult | null> {
  const bootstrap = input.request.bootstrap;
  if (!bootstrap) {
    return null;
  }
  const probe = await input.client.probeNodeGitAccess({
    repoUrl: bootstrap.repoUrl,
  });
  if (probe.ok) {
    return probe.data;
  }
  if (probe.status === 404 && probe.error.code === "not_found") {
    return {
      repoUrl: bootstrap.repoUrl,
      ok: false,
      authSource: "none",
      error: "probe_unsupported",
      unsupported: true,
    };
  }
  return {
    repoUrl: bootstrap.repoUrl,
    ok: false,
    authSource: "none",
    error: `probe_failed (${probe.status}): ${probe.error.message}`,
  };
}

type ResolvedNode =
  | {
      readonly ok: true;
      readonly node: NodeRecord;
      readonly client: GatewayClient;
      readonly source:
        | "explicit"
        | "project"
        | "default"
        | "auto"
        | "bootstrap";
    }
  | { readonly ok: false; readonly error: string };

type ResolvedNodeSource =
  | "explicit"
  | "project"
  | "default"
  | "auto"
  | "bootstrap";

function resolveDefaultNodeId(input: {
  readonly registryDefaultNodeId: string | null;
  readonly defaultNodeIdHint?: string;
}): string | null {
  return input.registryDefaultNodeId ?? input.defaultNodeIdHint ?? null;
}

function rankNodeHealth(input: {
  readonly node: NodeRecord;
  readonly staleAfterMs: number;
  readonly offlineAfterMs: number;
}): number {
  const health = deriveNodeHealth({
    lastSeenAt: input.node.lastSeenAt,
    staleAfterMs: input.staleAfterMs,
    offlineAfterMs: input.offlineAfterMs,
  });
  if (health === "healthy") {
    return 0;
  }
  if (health === "stale") {
    return 1;
  }
  if (health === "offline") {
    return 2;
  }
  return 3;
}

function rankNodeCandidate(input: {
  readonly node: NodeRecord;
  readonly preferredProvider?: string;
  readonly staleAfterMs: number;
  readonly offlineAfterMs: number;
}): number {
  const provider = normalizeOptionalString(input.preferredProvider);
  const providerMatch =
    typeof provider === "string" &&
    input.node.labels.some((label) => label.trim() === provider);
  let providerPenalty = 0;
  if (provider && !providerMatch) {
    providerPenalty = 1;
  }
  return (
    providerPenalty * 10 +
    rankNodeHealth({
      node: input.node,
      staleAfterMs: input.staleAfterMs,
      offlineAfterMs: input.offlineAfterMs,
    })
  );
}

async function probeNodeById(input: {
  readonly nodeId: string;
  readonly registryNodes: readonly NodeRecord[];
  readonly staleAfterMs: number;
  readonly offlineAfterMs: number;
  readonly source: ResolvedNodeSource;
  readonly missingNodeError: string;
}): Promise<ResolvedNode> {
  const node = input.registryNodes.find(
    (candidate) => candidate.id === input.nodeId
  );
  if (!node) {
    return { ok: false, error: input.missingNodeError };
  }
  const probe = await probeNode({
    node,
    staleAfterMs: input.staleAfterMs,
    offlineAfterMs: input.offlineAfterMs,
  });
  return probe.ok
    ? { ok: true, node: probe.node, client: probe.client, source: input.source }
    : { ok: false, error: probe.error };
}

async function probeNodeByIdOptional(input: {
  readonly nodeId: string;
  readonly registryNodes: readonly NodeRecord[];
  readonly staleAfterMs: number;
  readonly offlineAfterMs: number;
  readonly source: ResolvedNodeSource;
  readonly unavailablePrefix: string;
}): Promise<ResolvedNode | null> {
  const resolved = await probeNodeById({
    nodeId: input.nodeId,
    registryNodes: input.registryNodes,
    staleAfterMs: input.staleAfterMs,
    offlineAfterMs: input.offlineAfterMs,
    source: input.source,
    missingNodeError: `${input.unavailablePrefix} is not registered.`,
  });
  if (resolved.ok) {
    return resolved;
  }
  logger.warn({
    message: `${input.unavailablePrefix} unavailable: ${resolved.error}`,
  });
  return null;
}

async function resolveDispatchNode(input: {
  readonly requested?: string;
  readonly projectNodeId?: string;
  readonly preferredProvider?: string;
  readonly staleAfterMs: number;
  readonly offlineAfterMs: number;
  readonly defaultNodeIdHint?: string;
}): Promise<ResolvedNode> {
  const registry = await readNodesRegistry();
  if (registry.nodes.length === 0) {
    return {
      ok: false,
      error:
        "No nodes registered. Run `hack node init` on a host, then `hack node add --bundle <file>` on this controller.",
    };
  }

  const requested = input.requested;
  const defaultNodeId = resolveDefaultNodeId({
    registryDefaultNodeId: registry.defaultNodeId,
    defaultNodeIdHint: input.defaultNodeIdHint,
  });

  if (requested && requested !== "auto" && requested !== "default") {
    return await probeNodeById({
      nodeId: requested,
      registryNodes: registry.nodes,
      staleAfterMs: input.staleAfterMs,
      offlineAfterMs: input.offlineAfterMs,
      source: "explicit",
      missingNodeError: `Unknown node id: ${requested}`,
    });
  }

  if (requested === "default") {
    if (!defaultNodeId) {
      return {
        ok: false,
        error: "No default node set. Use `hack node use <id>`.",
      };
    }
    return await probeNodeById({
      nodeId: defaultNodeId,
      registryNodes: registry.nodes,
      staleAfterMs: input.staleAfterMs,
      offlineAfterMs: input.offlineAfterMs,
      source: "default",
      missingNodeError: `Default node ${defaultNodeId} is not registered.`,
    });
  }

  if (requested === undefined && input.projectNodeId) {
    const projectNode = await probeNodeByIdOptional({
      nodeId: input.projectNodeId,
      registryNodes: registry.nodes,
      staleAfterMs: input.staleAfterMs,
      offlineAfterMs: input.offlineAfterMs,
      source: "project",
      unavailablePrefix: `Project-affine node ${input.projectNodeId}`,
    });
    if (projectNode?.ok) {
      return projectNode;
    }
  }

  if (requested === undefined && defaultNodeId) {
    const defaultNode = await probeNodeByIdOptional({
      nodeId: defaultNodeId,
      registryNodes: registry.nodes,
      staleAfterMs: input.staleAfterMs,
      offlineAfterMs: input.offlineAfterMs,
      source: "default",
      unavailablePrefix: `Default node ${defaultNodeId}`,
    });
    if (defaultNode?.ok) {
      return defaultNode;
    }
  }

  const candidates = [...registry.nodes].sort(
    (left, right) =>
      rankNodeCandidate({
        node: left,
        preferredProvider: input.preferredProvider,
        staleAfterMs: input.staleAfterMs,
        offlineAfterMs: input.offlineAfterMs,
      }) -
      rankNodeCandidate({
        node: right,
        preferredProvider: input.preferredProvider,
        staleAfterMs: input.staleAfterMs,
        offlineAfterMs: input.offlineAfterMs,
      })
  );
  for (const node of candidates) {
    const probe = await probeNode({
      node,
      staleAfterMs: input.staleAfterMs,
      offlineAfterMs: input.offlineAfterMs,
    });
    if (probe.ok) {
      return {
        ok: true,
        node: probe.node,
        client: probe.client,
        source: "auto",
      };
    }
  }
  return { ok: false, error: "No healthy reachable nodes found." };
}

type DispatchBootstrapResult = {
  readonly provider: string;
  readonly created: boolean;
  readonly nodeId: string;
};

type DispatchRouteMetadata = {
  readonly nodeSource: ResolvedNodeSource;
  readonly provider: string;
  readonly providerSource: string;
  readonly profileId?: string;
  readonly profileSource: string;
  readonly mode: string;
  readonly bootstrapAllowed: boolean;
  readonly bootstrapAttempted: boolean;
  readonly bootstrapProvider?: string;
  readonly bootstrapCreated?: boolean;
  readonly bootstrapNodeId?: string;
  readonly diagnostics: readonly DispatchRouteDiagnostic[];
  readonly requestedNode?: string;
  readonly requestedProvider?: string;
  readonly requestedProfile?: string;
};

type ResolveDispatchNodeWithRouteResult =
  | {
      readonly ok: true;
      readonly node: Extract<ResolvedNode, { readonly ok: true }>;
      readonly bootstrap: DispatchBootstrapResult | null;
    }
  | { readonly ok: false; readonly error: string };

type DispatchWorkspaceBootstrapAuth = {
  readonly probe?: WorkspaceBootstrapProbeResult;
  readonly ensured?: GatewayNodeBootstrapAuthSource;
};

async function reconcileDispatchRemoteRouteBridge(input: {
  readonly project: DispatchProjectResolution;
  readonly workspace: GatewayNodeWorkspace;
  readonly node: NodeRecord;
}): Promise<RemoteCaddyRouteBridgeResult | null> {
  const projectKey =
    input.project.controllerProjectId ??
    normalizeOptionalString(input.workspace.projectId) ??
    normalizeOptionalString(input.workspace.projectName);
  if (!projectKey) {
    return null;
  }
  return await reconcileRemoteCaddyRoutesForProject({
    projectKey,
    projectDir: input.project.projectDir,
    fallbackProjectHost: input.workspace.projectName,
    node: input.node,
  });
}

function formatWorkspaceEnsureError(input: {
  readonly workspace: {
    readonly status: number;
    readonly error: { readonly message: string; readonly code?: string };
  };
  readonly workspaceRequest: WorkspaceEnsureRequest;
  readonly bootstrapProbe: WorkspaceBootstrapProbeResult | null;
}): string {
  return `Workspace ensure failed (${input.workspace.status}): ${input.workspace.error.message}`;
}

type DispatchSyncMetadata = {
  readonly engine: "mutagen";
  readonly sessionName: string;
  readonly created: boolean;
  readonly localPath: string;
  readonly remotePath: string;
  readonly remoteUri: string;
  readonly excludes: readonly string[];
};

type PrepareDispatchSyncResult =
  | { readonly ok: true; readonly sync: DispatchSyncMetadata | null }
  | { readonly ok: false; readonly reason: string; readonly error: string };

/**
 * Prepare local->remote source sync when execution mode requires local edits to
 * be reflected on a remote workspace before the dispatched job starts.
 */
async function prepareDispatchSync(input: {
  readonly config: ControlPlaneConfig;
  readonly project: DispatchProjectResolution;
  readonly node: NodeRecord;
  readonly workspace: GatewayNodeWorkspace;
}): Promise<PrepareDispatchSyncResult> {
  if (input.config.execution.mode !== "local_edit_remote_run") {
    return { ok: true, sync: null };
  }

  if (input.config.execution.sync.engine !== "mutagen") {
    return {
      ok: false,
      reason: "sync_engine_unsupported",
      error: `Execution sync engine "${input.config.execution.sync.engine}" is not implemented yet.`,
    };
  }

  const localProjectRoot = input.project.projectRoot?.trim();
  if (!localProjectRoot) {
    return {
      ok: false,
      reason: "sync_local_path_missing",
      error:
        "local_edit_remote_run requires a local project root. Dispatch with a registered local project name.",
    };
  }

  const nodeSource = input.node.source?.trim();
  if (!nodeSource) {
    return {
      ok: false,
      reason: "sync_source_missing",
      error:
        "Selected node is missing SSH source metadata. Re-pair with `hack node pair --source <user@host> ...`.",
    };
  }

  const synced = await ensureMutagenLocalToRemoteSync({
    projectName: input.workspace.projectName,
    nodeId: input.node.id,
    branch: input.workspace.branch ?? undefined,
    nodeSource,
    localProjectRoot,
    remoteProjectRoot: input.workspace.projectRoot,
    exclude: input.config.execution.sync.exclude,
  });
  if (!synced.ok) {
    return {
      ok: false,
      reason: `sync_${synced.code}`,
      error: synced.error,
    };
  }

  return {
    ok: true,
    sync: {
      engine: "mutagen",
      sessionName: synced.sessionName,
      created: synced.created,
      localPath: synced.localPath,
      remotePath: synced.remotePath,
      remoteUri: synced.remoteUri,
      excludes: synced.excludes,
    },
  };
}

function emitRouteDiagnostics(input: {
  readonly diagnostics: readonly DispatchRouteDiagnostic[];
}): void {
  for (const diagnostic of input.diagnostics) {
    if (diagnostic.severity === "error") {
      logger.warn({
        message: `Route diagnostic [${diagnostic.code}]: ${diagnostic.message}`,
      });
      continue;
    }
    logger.info({
      message: `Route note [${diagnostic.code}]: ${diagnostic.message}`,
    });
  }
}

function shouldFailForRouteDiagnostics(input: {
  readonly route: ReturnType<typeof resolveDispatchRoute>;
  readonly args: DispatchRunArgs;
}): boolean {
  if (!input.route.hasErrors) {
    return false;
  }
  if (input.route.nodeDirective?.source === "command_flags") {
    return false;
  }
  const commandProvider = normalizeOptionalString(input.args.options.provider);
  const commandProfile = normalizeOptionalString(input.args.options.profile);
  if (commandProvider || commandProfile) {
    return true;
  }
  if (input.route.providerRoute.profileSource === "project_routing") {
    return true;
  }
  if (input.route.providerRoute.providerSource === "project_routing") {
    return true;
  }
  return false;
}

function formatRouteDiagnosticSummary(input: {
  readonly diagnostics: readonly DispatchRouteDiagnostic[];
}): string {
  const errors = input.diagnostics.filter(
    (entry) => entry.severity === "error"
  );
  if (errors.length === 0) {
    return "Route diagnostics reported warnings.";
  }
  return errors.map((entry) => `${entry.code}: ${entry.message}`).join(" | ");
}

function buildDispatchRouteMetadata(input: {
  readonly requestedNode?: string;
  readonly requestedProvider?: string;
  readonly requestedProfile?: string;
  readonly route: ReturnType<typeof resolveDispatchRoute>;
  readonly selectedNode: Extract<ResolvedNode, { readonly ok: true }>;
  readonly bootstrap: DispatchBootstrapResult | null;
}): DispatchRouteMetadata {
  return {
    nodeSource: input.selectedNode.source,
    provider: input.route.providerRoute.provider,
    providerSource: input.route.providerRoute.providerSource,
    profileSource: input.route.providerRoute.profileSource,
    ...(input.route.providerRoute.profileId
      ? { profileId: input.route.providerRoute.profileId }
      : {}),
    mode: input.route.providerRoute.mode,
    bootstrapAllowed: input.route.providerRoute.bootstrapEnabled,
    bootstrapAttempted: input.bootstrap !== null,
    ...(input.bootstrap
      ? {
          bootstrapProvider: input.bootstrap.provider,
          bootstrapCreated: input.bootstrap.created,
          bootstrapNodeId: input.bootstrap.nodeId,
        }
      : {}),
    diagnostics: input.route.diagnostics,
    ...(input.requestedNode ? { requestedNode: input.requestedNode } : {}),
    ...(input.requestedProvider
      ? { requestedProvider: input.requestedProvider }
      : {}),
    ...(input.requestedProfile
      ? { requestedProfile: input.requestedProfile }
      : {}),
  };
}

async function resolveDispatchNodeWithRoute(input: {
  readonly requestedNode?: string;
  readonly projectNodeId?: string;
  readonly route: ReturnType<typeof resolveDispatchRoute>;
  readonly project: DispatchProjectResolution;
  readonly staleAfterMs: number;
  readonly offlineAfterMs: number;
  readonly defaultNodeIdHint?: string;
  readonly jsonMode: boolean;
}): Promise<ResolveDispatchNodeWithRouteResult> {
  const selectedNode = await resolveDispatchNode({
    requested: input.requestedNode,
    projectNodeId: input.projectNodeId,
    preferredProvider: input.route.providerRoute.provider,
    staleAfterMs: input.staleAfterMs,
    offlineAfterMs: input.offlineAfterMs,
    defaultNodeIdHint: input.defaultNodeIdHint,
  });
  if (selectedNode.ok) {
    return {
      ok: true,
      node: selectedNode,
      bootstrap: null,
    };
  }

  const requested = normalizeOptionalString(input.requestedNode);
  if (requested && requested !== "auto" && requested !== "default") {
    return { ok: false, error: selectedNode.error };
  }
  if (requested === "default") {
    return { ok: false, error: selectedNode.error };
  }
  if (!input.route.providerRoute.bootstrapEnabled) {
    return { ok: false, error: selectedNode.error };
  }
  if (input.route.hasErrors) {
    return {
      ok: false,
      error: `Bootstrap blocked by route diagnostics: ${formatRouteDiagnosticSummary(
        {
          diagnostics: input.route.diagnostics,
        }
      )}`,
    };
  }

  const bootstrap = await bootstrapNodeFromProviderRoute({
    route: input.route,
    project: input.project,
    jsonMode: input.jsonMode,
  });
  if (!bootstrap.ok) {
    return { ok: false, error: bootstrap.error };
  }

  const reprobe = await resolveDispatchNode({
    requested: bootstrap.nodeId,
    preferredProvider: input.route.providerRoute.provider,
    staleAfterMs: input.staleAfterMs,
    offlineAfterMs: input.offlineAfterMs,
    defaultNodeIdHint: input.defaultNodeIdHint,
  });
  if (!reprobe.ok) {
    return {
      ok: false,
      error: `Node bootstrap completed but node probe failed: ${reprobe.error}`,
    };
  }

  return {
    ok: true,
    node: {
      ok: true,
      node: reprobe.node,
      client: reprobe.client,
      source: "bootstrap",
    },
    bootstrap: {
      provider: bootstrap.provider,
      created: bootstrap.created,
      nodeId: bootstrap.nodeId,
    },
  };
}

async function bootstrapNodeFromProviderRoute(input: {
  readonly route: ReturnType<typeof resolveDispatchRoute>;
  readonly project: DispatchProjectResolution;
  readonly jsonMode: boolean;
}): Promise<
  | {
      readonly ok: true;
      readonly provider: "railway";
      readonly created: boolean;
      readonly nodeId: string;
    }
  | { readonly ok: false; readonly error: string }
> {
  if (input.route.providerRoute.provider !== "railway") {
    return {
      ok: false,
      error: `Bootstrap handoff is not implemented for provider "${input.route.providerRoute.provider}".`,
    };
  }

  const config = input.route.providerRoute.effectiveConfig;
  const railwayProject = resolveConfigString({
    config,
    key: "project",
  });
  if (!railwayProject) {
    return {
      ok: false,
      error:
        "Provider route is missing railway project. Set controlPlane.providers.profiles.<id>.config.project.",
    };
  }

  const cliArgs = [
    "bun",
    resolve(import.meta.dir, "../index.ts"),
    "node",
    "provider",
    "railway",
    "bootstrap",
    "--json",
    "--railway-project",
    railwayProject,
  ];

  const railwayService = resolveConfigString({
    config,
    key: "service",
  });
  if (railwayService) {
    cliArgs.push("--railway-service", railwayService);
  }
  const createService =
    parseConfigBoolean({ config, key: "createService" }) ??
    railwayService === undefined;
  if (createService) {
    cliArgs.push("--create-service");
  }
  const railwayEnvironment = resolveConfigString({
    config,
    key: "environment",
  });
  if (railwayEnvironment) {
    cliArgs.push("--railway-environment", railwayEnvironment);
  }
  const railwayWorkspace = resolveConfigString({
    config,
    key: "workspace",
  });
  if (railwayWorkspace) {
    cliArgs.push("--railway-workspace", railwayWorkspace);
  }
  const image = resolveConfigString({
    config,
    key: "image",
  });
  if (image) {
    cliArgs.push("--railway-image", image);
  }
  const endpoint = resolveConfigString({
    config,
    key: "endpoint",
  });
  if (endpoint) {
    cliArgs.push("--endpoint", endpoint);
  }
  const nodeName =
    resolveConfigString({
      config,
      key: "nodeName",
    }) ??
    input.project.projectName ??
    input.project.selector;
  if (nodeName) {
    cliArgs.push("--name", nodeName);
  }
  const labelsCsv = resolveConfigString({
    config,
    key: "labelsCsv",
  });
  if (labelsCsv) {
    cliArgs.push("--labels", labelsCsv);
  }

  if (input.route.providerRoute.privateNetworking) {
    cliArgs.push("--railway-private");
    const auth = isRecord(config.auth) ? config.auth : {};
    const tailscaleAuthKey = resolveConfigString({
      config: { ...auth, ...config },
      key: "tailscaleAuthKey",
    });
    if (tailscaleAuthKey) {
      cliArgs.push("--tailscale-auth-key", tailscaleAuthKey);
    }
    const hostname = resolveConfigString({
      config: { ...auth, ...config },
      key: "tailscaleHostname",
    });
    if (hostname) {
      cliArgs.push("--tailscale-hostname", hostname);
    }
    const tags = resolveConfigString({
      config: { ...auth, ...config },
      key: "tailscaleTagsCsv",
    });
    if (tags) {
      cliArgs.push("--tailscale-tags", tags);
    }
  }

  const result = await exec(cliArgs, {
    stdin: "ignore",
    env: {
      NO_COLOR: "1",
    },
  });
  if (result.exitCode !== 0) {
    return {
      ok: false,
      error:
        result.stderr.trim() ||
        result.stdout.trim() ||
        `Provider bootstrap failed (exit ${result.exitCode}).`,
    };
  }
  const payload = parseEmbeddedJson(result.stdout);
  if (!(payload && isRecord(payload))) {
    return {
      ok: false,
      error: "Provider bootstrap did not return JSON payload.",
    };
  }
  const node = isRecord(payload.node) ? payload.node : null;
  const nodeId = node ? getString(node, "id") : undefined;
  if (!nodeId) {
    return {
      ok: false,
      error: "Provider bootstrap JSON is missing node.id.",
    };
  }
  const created = payload.created === true;
  if (!input.jsonMode) {
    logger.info({
      message: `Bootstrap handoff registered node ${nodeId} via provider railway.`,
    });
  }
  return {
    ok: true,
    provider: "railway",
    created,
    nodeId,
  };
}

async function resolveNodeClient(input: {
  readonly nodeId: string;
}): Promise<
  | { readonly ok: true; readonly client: GatewayClient }
  | { readonly ok: false; readonly error: string }
> {
  const registry = await readNodesRegistry();
  const node = registry.nodes.find(
    (candidate) => candidate.id === input.nodeId
  );
  if (!node) {
    return { ok: false, error: `Node not found: ${input.nodeId}` };
  }
  const token = await readNodeAuthToken({ authRef: node.authRef });
  if (!token) {
    return {
      ok: false,
      error: `Missing auth token for node ${node.id}. Re-add bundle with \`hack node add --bundle ...\`.`,
    };
  }
  const client = createGatewayClient({
    baseUrl: node.endpoint,
    token,
    timeoutMs: 10_000,
  });
  return { ok: true, client };
}

type ProbedNode =
  | {
      readonly ok: true;
      readonly node: NodeRecord;
      readonly status: GatewayNodeStatus;
      readonly client: GatewayClient;
    }
  | { readonly ok: false; readonly error: string };

async function probeNode(input: {
  readonly node: NodeRecord;
  readonly staleAfterMs: number;
  readonly offlineAfterMs: number;
}): Promise<ProbedNode> {
  const token = await readNodeAuthToken({ authRef: input.node.authRef });
  if (!token) {
    const derived = deriveNodeHealth({
      lastSeenAt: input.node.lastSeenAt,
      staleAfterMs: input.staleAfterMs,
      offlineAfterMs: input.offlineAfterMs,
    });
    await touchNode({
      id: input.node.id,
      status: derived,
    });
    return {
      ok: false,
      error: `Missing auth token for node ${input.node.id}`,
    };
  }

  const client = createGatewayClient({
    baseUrl: input.node.endpoint,
    token,
    timeoutMs: 7500,
  });
  const status = await client.getNodeStatus();
  if (!status.ok) {
    const derived = deriveNodeHealth({
      lastSeenAt: input.node.lastSeenAt,
      staleAfterMs: input.staleAfterMs,
      offlineAfterMs: input.offlineAfterMs,
    });
    await touchNode({
      id: input.node.id,
      status: derived,
    });
    return {
      ok: false,
      error: `${input.node.id}: ${status.error.message}`,
    };
  }

  const touched = await touchNode({
    id: input.node.id,
    status: "healthy",
    version: status.data.version,
    platform:
      typeof status.data.node.platform === "string"
        ? status.data.node.platform
        : undefined,
    arch:
      typeof status.data.node.arch === "string"
        ? status.data.node.arch
        : undefined,
  });
  return {
    ok: true,
    node: touched ?? input.node,
    status: status.data,
    client,
  };
}

async function finalizeFailedRun(input: {
  readonly run: DispatchRunRecord;
  readonly errorMessage: string;
  readonly status: DispatchRunStatus;
  readonly reason: string;
  readonly controlPlaneConfig: ControlPlaneConfig;
  readonly actor: string;
}): Promise<void> {
  await updateDispatchRunRecord({
    runId: input.run.runId,
    patch: {
      status: input.status,
      finishedAt: new Date().toISOString(),
    },
  });
  await appendDispatchRunEvent({
    runId: input.run.runId,
    event: {
      type: "run.failed",
      reason: input.reason,
      error: input.errorMessage,
    },
  });
  await appendDispatchRunLog({
    runId: input.run.runId,
    text: `${input.errorMessage}\n`,
  });
  await writeDispatchRunArtifacts({
    runId: input.run.runId,
    summaryMarkdown: `# Dispatch Run ${input.run.runId}\n\nStatus: ${input.status}\n\nError: ${input.errorMessage}`,
    patchDiff: "# no diff captured due to early failure",
    testsManifest: {
      status: input.status,
      error: input.errorMessage,
    },
    manifest: {
      runId: input.run.runId,
      status: input.status,
      error: input.errorMessage,
      reason: input.reason,
    },
  });
  const currentRun =
    (await readDispatchRunRecord({ runId: input.run.runId })) ?? input.run;
  await persistRunArtifactsToCanonicalTickets({
    run: currentRun,
    controlPlaneConfig: input.controlPlaneConfig,
    actor: input.actor,
  });
}

async function refreshRunStatusFromRemote(input: {
  readonly run: DispatchRunRecord;
}): Promise<DispatchRunRecord | null> {
  const run = input.run;
  if (!(run.projectId && run.jobId)) {
    return null;
  }
  if (
    run.status === "completed" ||
    run.status === "failed" ||
    run.status === "cancelled" ||
    run.status === "error"
  ) {
    return null;
  }
  const nodeClient = await resolveNodeClient({ nodeId: run.nodeId });
  if (!nodeClient.ok) {
    return null;
  }
  const job = await nodeClient.client.getJob({
    projectId: run.projectId,
    jobId: run.jobId,
  });
  if (!job.ok) {
    return null;
  }
  const nextStatus = mapJobStatusToRunStatus({
    jobStatus: job.data.job.status,
  });
  const next = await updateDispatchRunRecord({
    runId: run.runId,
    patch: {
      status: nextStatus,
      jobStatus: job.data.job.status,
      ...(TERMINAL_JOB_STATUSES.has(job.data.job.status)
        ? { finishedAt: new Date().toISOString() }
        : {}),
    },
  });
  return next;
}

function mapJobStatusToRunStatus(input: {
  readonly jobStatus: string;
}): DispatchRunStatus {
  if (input.jobStatus === "completed") {
    return "completed";
  }
  if (input.jobStatus === "failed") {
    return "failed";
  }
  if (input.jobStatus === "cancelled") {
    return "cancelled";
  }
  return "running";
}

function runStatusToExitCode(input: {
  readonly status: DispatchRunStatus;
}): number {
  if (input.status === "running" || input.status === "completed") {
    return 0;
  }
  return 1;
}

async function persistRunArtifactsToCanonicalTickets(input: {
  readonly run: DispatchRunRecord;
  readonly controlPlaneConfig: ControlPlaneConfig;
  readonly actor: string;
}): Promise<void> {
  if (!input.run.projectRoot) {
    return;
  }
  const persisted = await persistDispatchRunToTicketsChannel({
    projectRoot: input.run.projectRoot,
    controlPlaneConfig: input.controlPlaneConfig,
    run: input.run,
    actor: input.actor,
    logger,
  });
  if (!persisted.ok) {
    logger.warn({
      message: `Failed to persist canonical run artifacts: ${persisted.error}`,
    });
    await appendDispatchRunEvent({
      runId: input.run.runId,
      event: {
        type: "run.artifacts.persist_failed",
        error: persisted.error,
      },
    });
    return;
  }
  await appendDispatchRunEvent({
    runId: input.run.runId,
    event: {
      type: "run.artifacts.persisted",
      canonicalPath: `.hack/tickets/runs/${input.run.runId}`,
    },
  });
}

type StreamOutcome = {
  readonly job: JobMeta | null;
  readonly logsOffset: number;
  readonly eventsSeq: number;
  readonly exitCode?: number;
};

type StreamMutableState = {
  logsOffset: number;
  eventsSeq: number;
  exitCode?: number;
  writeQueue: Promise<void>;
};

function queueRunLogAppend(input: {
  readonly state: StreamMutableState;
  readonly runId: string;
  readonly text: string;
}): void {
  input.state.writeQueue = input.state.writeQueue
    .then(() =>
      appendDispatchRunLog({
        runId: input.runId,
        text: input.text,
      })
    )
    .catch(() => undefined);
}

function queueRunEventAppend(input: {
  readonly state: StreamMutableState;
  readonly runId: string;
  readonly event: Record<string, unknown>;
}): void {
  input.state.writeQueue = input.state.writeQueue
    .then(() =>
      appendDispatchRunEvent({
        runId: input.runId,
        event: input.event,
      })
    )
    .catch(() => undefined);
}

function handleStreamReadyMessage(input: {
  readonly state: StreamMutableState;
  readonly message: Record<string, unknown>;
}): void {
  if (typeof input.message.logsOffset === "number") {
    input.state.logsOffset = input.message.logsOffset;
  }
  if (typeof input.message.eventsSeq === "number") {
    input.state.eventsSeq = input.message.eventsSeq;
  }
}

function handleStreamLogMessage(input: {
  readonly state: StreamMutableState;
  readonly message: Record<string, unknown>;
  readonly runId: string;
  readonly printLogs: boolean;
}): void {
  const logData = input.message.data;
  if (typeof logData !== "string") {
    return;
  }
  if (typeof input.message.offset === "number") {
    input.state.logsOffset = input.message.offset;
  }
  if (input.printLogs) {
    process.stdout.write(logData);
  }
  queueRunLogAppend({
    state: input.state,
    runId: input.runId,
    text: logData,
  });
}

function handleStreamEventMessage(input: {
  readonly state: StreamMutableState;
  readonly message: Record<string, unknown>;
  readonly runId: string;
}): void {
  if (!isRecord(input.message.event)) {
    return;
  }
  const eventSeq =
    typeof input.message.event.seq === "number"
      ? input.message.event.seq
      : undefined;
  const eventType =
    typeof input.message.event.type === "string"
      ? input.message.event.type
      : undefined;
  if (eventSeq !== undefined) {
    input.state.eventsSeq = Math.max(input.state.eventsSeq, eventSeq);
  }
  if (
    (eventType === "job.completed" ||
      eventType === "job.failed" ||
      eventType === "job.cancelled") &&
    isRecord(input.message.event.payload) &&
    typeof input.message.event.payload.exitCode === "number"
  ) {
    input.state.exitCode = input.message.event.payload.exitCode;
  }
  queueRunEventAppend({
    state: input.state,
    runId: input.runId,
    event: {
      type: "job.event",
      event: input.message.event,
    },
  });
}

function handleParsedStreamMessage(input: {
  readonly state: StreamMutableState;
  readonly message: Record<string, unknown>;
  readonly runId: string;
  readonly printLogs: boolean;
}): void {
  const messageType = input.message.type;
  if (messageType === "ready") {
    handleStreamReadyMessage({
      state: input.state,
      message: input.message,
    });
    return;
  }
  if (messageType === "log") {
    handleStreamLogMessage({
      state: input.state,
      message: input.message,
      runId: input.runId,
      printLogs: input.printLogs,
    });
    return;
  }
  if (messageType === "event") {
    handleStreamEventMessage({
      state: input.state,
      message: input.message,
      runId: input.runId,
    });
  }
}

async function streamRemoteJob(input: {
  readonly runId: string;
  readonly client: GatewayClient;
  readonly projectId: string;
  readonly jobId: string;
  readonly logsFrom: number;
  readonly eventsFrom: number;
  readonly printLogs: boolean;
}): Promise<StreamOutcome> {
  const state: StreamMutableState = {
    logsOffset: input.logsFrom,
    eventsSeq: input.eventsFrom,
    writeQueue: Promise.resolve(),
  };
  let lastJob: JobMeta | null = null;
  let websocketOpen = false;

  const ws = input.client.openJobStream({
    projectId: input.projectId,
    jobId: input.jobId,
  });

  ws.onopen = () => {
    websocketOpen = true;
    ws.send(
      JSON.stringify({
        type: "hello",
        logsFrom: state.logsOffset,
        eventsFrom: state.eventsSeq,
      })
    );
  };
  ws.onmessage = (event) => {
    const parsed = parseStreamMessage({ data: event.data });
    if (!parsed) {
      return;
    }
    handleParsedStreamMessage({
      state,
      message: parsed,
      runId: input.runId,
      printLogs: input.printLogs,
    });
  };

  const maxPolls = 60 * 60;
  for (let i = 0; i < maxPolls; i += 1) {
    const job = await input.client.getJob({
      projectId: input.projectId,
      jobId: input.jobId,
    });
    if (job.ok) {
      lastJob = job.data.job;
      if (TERMINAL_JOB_STATUSES.has(lastJob.status)) {
        break;
      }
    }
    await Bun.sleep(1000);
  }

  if (websocketOpen) {
    ws.close();
  }
  await state.writeQueue;
  return {
    job: lastJob,
    logsOffset: state.logsOffset,
    eventsSeq: state.eventsSeq,
    ...(state.exitCode !== undefined ? { exitCode: state.exitCode } : {}),
  };
}

function parseStreamMessage(input: {
  readonly data: unknown;
}): Record<string, unknown> | null {
  const raw = input.data;
  let text: string | null = null;
  if (typeof raw === "string") {
    text = raw;
  } else if (raw instanceof ArrayBuffer) {
    text = new TextDecoder().decode(raw);
  }
  if (!text) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveRemovedDispatchPrAutomationMessage(input: {
  readonly pr?: boolean;
  readonly prBase?: string;
  readonly prTitle?: string;
  readonly prBody?: string;
  readonly githubProfile?: string;
}): string | null {
  const requested =
    input.pr === true ||
    normalizeOptionalString(input.prBase) !== undefined ||
    normalizeOptionalString(input.prTitle) !== undefined ||
    normalizeOptionalString(input.prBody) !== undefined ||
    normalizeOptionalString(input.githubProfile) !== undefined;
  if (!requested) {
    return null;
  }
  return [
    "Built-in GitHub PR automation was removed in Hack v3.",
    "Dispatch still runs the remote command, but push and PR follow-up must now use native git and gh outside Hack.",
    "Migration: run `git push -u origin <branch>` and `gh pr create` or `gh pr edit` after the dispatch completes.",
  ].join(" ");
}

export const __testOnlyDispatch = {
  resolveRemovedDispatchPrAutomationMessage,
};

function parseConfigBoolean(input: {
  readonly config: Record<string, unknown>;
  readonly key: string;
}): boolean | undefined {
  const value = input.config[input.key];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return undefined;
}

function resolveConfigString(input: {
  readonly config: Record<string, unknown>;
  readonly key: string;
}): string | undefined {
  return normalizeOptionalString(input.config[input.key]);
}

function parseEmbeddedJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return extractFirstJsonBlock(trimmed);
  }
}

function extractFirstJsonBlock(text: string): unknown {
  let start = -1;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "{" || char === "[") {
      start = i;
      break;
    }
  }
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        const snippet = text.slice(start, i + 1);
        try {
          return JSON.parse(snippet);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function buildSummaryMarkdown(input: {
  readonly runId: string;
  readonly runStatus: DispatchRunStatus;
  readonly node: NodeRecord;
  readonly workspace: {
    readonly projectId: string;
    readonly projectName: string;
    readonly branch: string | null;
  };
  readonly job: JobMeta;
  readonly command: readonly string[];
  readonly runner: string;
  readonly riskLevel: string;
  readonly riskReasons: readonly string[];
  readonly route: DispatchRouteMetadata;
  readonly sync: DispatchSyncMetadata | null;
  readonly bootstrapAuth: DispatchWorkspaceBootstrapAuth;
  readonly remoteRouteBridge: RemoteCaddyRouteBridgeResult | null;
}): string {
  return [
    `# Dispatch Run ${input.runId}`,
    "",
    "## Summary",
    `- status: ${input.runStatus}`,
    `- node: ${input.node.name} (${input.node.id})`,
    `- project: ${input.workspace.projectName} (${input.workspace.projectId})`,
    `- branch: ${input.workspace.branch ?? "detached/unknown"}`,
    `- runner: ${input.runner}`,
    `- job_id: ${input.job.jobId}`,
    `- job_status: ${input.job.status}`,
    "",
    "## Command",
    "```sh",
    input.command.join(" "),
    "```",
    "",
    "## Policy",
    `- risk_level: ${input.riskLevel}`,
    ...(input.riskReasons.length > 0
      ? input.riskReasons.map((reason) => `- rationale: ${reason}`)
      : ["- rationale: none"]),
    "",
    "## Route",
    `- source: ${input.route.nodeSource}`,
    `- provider: ${input.route.provider}`,
    `- provider_source: ${input.route.providerSource}`,
    `- profile: ${input.route.profileId ?? "none"}`,
    `- profile_source: ${input.route.profileSource}`,
    `- mode: ${input.route.mode}`,
    `- bootstrap_allowed: ${input.route.bootstrapAllowed ? "yes" : "no"}`,
    `- bootstrap_attempted: ${input.route.bootstrapAttempted ? "yes" : "no"}`,
    ...(input.route.bootstrapProvider
      ? [`- bootstrap_provider: ${input.route.bootstrapProvider}`]
      : []),
    ...(typeof input.route.bootstrapCreated === "boolean"
      ? [`- bootstrap_created: ${input.route.bootstrapCreated ? "yes" : "no"}`]
      : []),
    ...(input.route.bootstrapNodeId
      ? [`- bootstrap_node_id: ${input.route.bootstrapNodeId}`]
      : []),
    ...(input.route.diagnostics.length > 0
      ? input.route.diagnostics.map(
          (entry) =>
            `- diagnostic_${entry.severity}: [${entry.code}] ${entry.message}`
        )
      : ["- diagnostics: none"]),
    "",
    "## Bootstrap auth",
    ...(input.bootstrapAuth.probe
      ? [
          `- preflight_ok: ${input.bootstrapAuth.probe.ok ? "yes" : "no"}`,
          `- preflight_source: ${input.bootstrapAuth.probe.authSource}`,
          `- preflight_repo: ${input.bootstrapAuth.probe.repoUrl}`,
          ...(input.bootstrapAuth.probe.error
            ? [`- preflight_error: ${input.bootstrapAuth.probe.error}`]
            : []),
        ]
      : ["- preflight: not requested"]),
    ...(input.bootstrapAuth.ensured
      ? [`- workspace_ensure_source: ${input.bootstrapAuth.ensured}`]
      : ["- workspace_ensure_source: unknown_or_not_bootstrapped"]),
    "",
    "## Local route bridge",
    ...(input.remoteRouteBridge
      ? [
          `- status: ${input.remoteRouteBridge.status}`,
          `- reason: ${input.remoteRouteBridge.reason}`,
          `- compose_path: ${input.remoteRouteBridge.composePath}`,
          ...(input.remoteRouteBridge.upstream
            ? [`- upstream: ${input.remoteRouteBridge.upstream}`]
            : []),
          ...(input.remoteRouteBridge.hosts.length > 0
            ? input.remoteRouteBridge.hosts.map((host) => `- host: ${host}`)
            : ["- host: none"]),
          ...(input.remoteRouteBridge.error
            ? [`- error: ${input.remoteRouteBridge.error}`]
            : []),
        ]
      : ["- status: not attempted"]),
    "",
    "## Sync",
    ...(input.sync
      ? [
          `- engine: ${input.sync.engine}`,
          `- session: ${input.sync.sessionName}`,
          `- created: ${input.sync.created ? "yes" : "no"}`,
          `- local_path: ${input.sync.localPath}`,
          `- remote_path: ${input.sync.remotePath}`,
          ...(input.sync.excludes.length > 0
            ? input.sync.excludes.map((entry) => `- exclude: ${entry}`)
            : ["- exclude: none"]),
        ]
      : ["- status: not enabled"]),
    "",
  ].join("\n");
}
