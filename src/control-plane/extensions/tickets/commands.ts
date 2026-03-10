import { runTicketsTui } from "../../../tui/tickets-tui.ts";
import { display } from "../../../ui/display.ts";
import { gumConfirm, isGumAvailable } from "../../../ui/gum.ts";
import { isTty } from "../../../ui/terminal.ts";
import type { ExtensionCommand, ExtensionCommandContext } from "../types.ts";
import {
  checkTicketsAgentDocs,
  removeTicketsAgentDocs,
  type TicketsAgentDocCheckResult,
  type TicketsAgentDocRemoveResult,
  type TicketsAgentDocUpdateResult,
  upsertTicketsAgentDocs,
} from "./agent-docs.ts";
import {
  checkTicketsRepoState,
  ensureTicketsGitignore,
  type TicketsRepoGitignoreFixStatus,
  type TicketsRepoGitignoreStatus,
  type TicketsRepoTrackedStatus,
  type TicketsRepoUntrackStatus,
  untrackTicketsRepo,
} from "./repo-state.ts";
import {
  createTicketsStore,
  type TicketSyncConflictResolution,
} from "./store.ts";
import {
  createGitTicketsChannel,
  type TicketsGitHealth,
  type TicketsGitRepairResult,
} from "./tickets-git-channel.ts";
import {
  checkTicketsSkill,
  installTicketsSkill,
  removeTicketsSkill,
} from "./tickets-skill.ts";
import { normalizeTicketRef, normalizeTicketRefs } from "./util.ts";

const TICKET_REF_SEPARATOR_PATTERN = /[,\s]+/;

let didPromptTicketsGitHealth = false;

export const TICKETS_COMMANDS: readonly ExtensionCommand[] = [
  {
    name: "setup",
    summary: "Install tickets integrations (skill + agent docs)",
    scope: "project",
    handler: ({ ctx, args }) => handleTicketsSetupCommand({ ctx, args }),
  },
  {
    name: "create",
    summary: "Create a new ticket",
    scope: "project",
    handler: ({ ctx, args }) => handleTicketsCreateCommand({ ctx, args }),
  },
  {
    name: "update",
    summary: "Update a ticket",
    scope: "project",
    handler: ({ ctx, args }) => handleTicketsUpdateCommand({ ctx, args }),
  },
  {
    name: "comment",
    summary: "Append an immutable ticket comment",
    scope: "project",
    handler: async ({ ctx, args }) => {
      if (!ctx.project) {
        ctx.logger.error({ message: "No project found. Run inside a repo." });
        return 1;
      }

      const parsed = parseTicketsArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const ticketId = (parsed.value.rest[0] ?? "").trim();
      if (!ticketId) {
        ctx.logger.error({
          message:
            'Usage: hack x tickets comment <ticket-id> [--body "..."] [--body-file <path>] [--body-stdin] [--source hack] [--json]',
        });
        return 1;
      }

      const body = await resolveTicketBody({
        body: parsed.value.body,
        bodyFile: parsed.value.bodyFile,
        bodyStdin: parsed.value.bodyStdin,
      });
      if (!body) {
        ctx.logger.error({
          message:
            "Comment body is required. Use --body, --body-file, or --body-stdin.",
        });
        return 1;
      }

      await maybeEnsureTicketsSetup({ ctx, json: parsed.value.json });

      const store = createTicketsStore({
        projectRoot: ctx.project.projectRoot,
        projectId: ctx.projectId,
        projectName: ctx.projectName,
        controlPlaneConfig: ctx.controlPlaneConfig,
        logger: ctx.logger,
      });

      const appended = await store.appendComment({
        ticketId,
        body,
        ...(parsed.value.source ? { source: parsed.value.source } : {}),
        actor: parsed.value.actor,
      });
      if (!appended.ok) {
        ctx.logger.error({ message: appended.error });
        return 1;
      }

      if (parsed.value.json) {
        process.stdout.write(
          `${JSON.stringify({ comment: appended.comment }, null, 2)}\n`
        );
        return 0;
      }

      await display.panel({
        title: "Ticket comment",
        tone: "success",
        lines: [`${ticketId} comment appended`, appended.comment.body],
      });
      return 0;
    },
  },
  {
    name: "review-note",
    summary: "Append a shared ticket review note",
    scope: "project",
    handler: async ({ ctx, args }) => {
      if (!ctx.project) {
        ctx.logger.error({ message: "No project found. Run inside a repo." });
        return 1;
      }

      const parsed = parseTicketsArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const ticketId = (parsed.value.rest[0] ?? "").trim();
      if (!ticketId) {
        ctx.logger.error({
          message:
            'Usage: hack x tickets review-note <ticket-id> [--body "..."] [--body-file <path>] [--body-stdin] [--json]',
        });
        return 1;
      }

      const body = await resolveTicketBody({
        body: parsed.value.body,
        bodyFile: parsed.value.bodyFile,
        bodyStdin: parsed.value.bodyStdin,
      });
      if (!body) {
        ctx.logger.error({
          message:
            "Review note body is required. Use --body, --body-file, or --body-stdin.",
        });
        return 1;
      }

      await maybeEnsureTicketsSetup({ ctx, json: parsed.value.json });

      const store = createTicketsStore({
        projectRoot: ctx.project.projectRoot,
        projectId: ctx.projectId,
        projectName: ctx.projectName,
        controlPlaneConfig: ctx.controlPlaneConfig,
        logger: ctx.logger,
      });

      const appended = await store.appendReviewNote({
        ticketId,
        body,
        actor: parsed.value.actor,
      });
      if (!appended.ok) {
        ctx.logger.error({ message: appended.error });
        return 1;
      }

      if (parsed.value.json) {
        process.stdout.write(
          `${JSON.stringify({ reviewNote: appended.reviewNote }, null, 2)}\n`
        );
        return 0;
      }

      await display.panel({
        title: "Ticket review note",
        tone: "success",
        lines: [`${ticketId} review note appended`, appended.reviewNote.body],
      });
      return 0;
    },
  },
  {
    name: "list",
    summary: "List tickets",
    scope: "project",
    handler: async ({ ctx, args }) => {
      if (!ctx.project) {
        ctx.logger.error({ message: "No project found. Run inside a repo." });
        return 1;
      }

      const parsed = parseTicketsArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      await maybeEnsureTicketsSetup({ ctx, json: parsed.value.json });

      const store = createTicketsStore({
        projectRoot: ctx.project.projectRoot,
        projectId: ctx.projectId,
        projectName: ctx.projectName,
        controlPlaneConfig: ctx.controlPlaneConfig,
        logger: ctx.logger,
      });

      const tickets = (await store.listTickets()).filter((ticket) => {
        if (
          parsed.value.owner &&
          ticket.owner.toLowerCase() !== parsed.value.owner.toLowerCase()
        ) {
          return false;
        }
        if (
          parsed.value.source &&
          ticket.source.toLowerCase() !== parsed.value.source.toLowerCase()
        ) {
          return false;
        }
        if (
          parsed.value.externalSystem &&
          (ticket.externalSystem ?? "").toLowerCase() !==
            parsed.value.externalSystem.toLowerCase()
        ) {
          return false;
        }
        return true;
      });

      if (parsed.value.json) {
        process.stdout.write(`${JSON.stringify({ tickets }, null, 2)}\n`);
        return 0;
      }

      if (tickets.length === 0) {
        await display.panel({
          title: "Tickets",
          tone: "info",
          lines: ["No tickets found."],
        });
        return 0;
      }

      await display.table({
        columns: ["Id", "Title", "Status", "Owner", "Source", "Updated"],
        rows: tickets.map((ticket) => [
          ticket.ticketId,
          ticket.title,
          ticket.status,
          ticket.owner,
          ticket.source,
          ticket.updatedAt,
        ]),
      });
      return 0;
    },
  },
  {
    name: "tui",
    summary: "Open tickets TUI",
    scope: "project",
    handler: async ({ ctx, args }) => {
      if (!ctx.project) {
        ctx.logger.error({ message: "No project found. Run inside a repo." });
        return 1;
      }

      if (args.length > 0) {
        ctx.logger.error({ message: "Usage: hack x tickets tui" });
        return 1;
      }

      await maybeEnsureTicketsSetup({ ctx, json: false });

      return await runTicketsTui({
        projectRoot: ctx.project.projectRoot,
        projectId: ctx.projectId,
        projectName: ctx.projectName,
        controlPlaneConfig: ctx.controlPlaneConfig,
        logger: ctx.logger,
      });
    },
  },
  {
    name: "show",
    summary: "Show a ticket",
    scope: "project",
    handler: ({ ctx, args }) => handleTicketsShowCommand({ ctx, args }),
  },
  {
    name: "resolve-conflict",
    summary: "Resolve a recorded ticket sync conflict",
    scope: "project",
    handler: async ({ ctx, args }) => {
      if (!ctx.project) {
        ctx.logger.error({ message: "No project found. Run inside a repo." });
        return 1;
      }

      const parsed = parseResolveConflictArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const ticketId = (parsed.value.rest[0] ?? "").trim();
      if (!ticketId) {
        ctx.logger.error({
          message:
            'Usage: hack x tickets resolve-conflict <ticket-id> --conflict-id <id> --resolution <accept_local|accept_remote|merged|ignore> [--summary "..."] [--json]',
        });
        return 1;
      }

      await maybeEnsureTicketsSetup({ ctx, json: parsed.value.json });

      const store = createTicketsStore({
        projectRoot: ctx.project.projectRoot,
        projectId: ctx.projectId,
        projectName: ctx.projectName,
        controlPlaneConfig: ctx.controlPlaneConfig,
        logger: ctx.logger,
      });

      const resolved = await store.resolveSyncConflict({
        ticketId,
        conflictId: parsed.value.conflictId,
        resolution: parsed.value.resolution,
        ...(parsed.value.summary !== undefined
          ? { summary: parsed.value.summary }
          : {}),
        actor: parsed.value.actor,
      });
      if (!resolved.ok) {
        ctx.logger.error({ message: resolved.error });
        return 1;
      }

      if (parsed.value.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              ok: true,
              ticketId,
              conflictId: parsed.value.conflictId,
              resolution: parsed.value.resolution,
            },
            null,
            2
          )}\n`
        );
        return 0;
      }

      await display.panel({
        title: "Ticket conflict resolved",
        tone: "success",
        lines: [
          `${ticketId} ${parsed.value.conflictId} → ${parsed.value.resolution}`,
        ],
      });
      return 0;
    },
  },
  {
    name: "status",
    summary: "Change ticket status",
    scope: "project",
    handler: async ({ ctx, args }) => {
      if (!ctx.project) {
        ctx.logger.error({ message: "No project found. Run inside a repo." });
        return 1;
      }

      const parsed = parseTicketsArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const ticketId = (parsed.value.rest[0] ?? "").trim();
      const status = (parsed.value.rest[1] ?? "").trim();
      if (!(ticketId && status)) {
        ctx.logger.error({
          message:
            "Usage: hack x tickets status <ticket-id> <open|in_progress|blocked|done>",
        });
        return 1;
      }

      if (
        status !== "open" &&
        status !== "in_progress" &&
        status !== "blocked" &&
        status !== "done"
      ) {
        ctx.logger.error({ message: `Invalid status: ${status}` });
        return 1;
      }

      await maybeEnsureTicketsSetup({ ctx, json: parsed.value.json });

      const store = createTicketsStore({
        projectRoot: ctx.project.projectRoot,
        projectId: ctx.projectId,
        projectName: ctx.projectName,
        controlPlaneConfig: ctx.controlPlaneConfig,
        logger: ctx.logger,
      });

      const updated = await store.setStatus({
        ticketId,
        status,
        actor: parsed.value.actor,
      });

      if (!updated.ok) {
        ctx.logger.error({ message: updated.error });
        return 1;
      }

      if (parsed.value.json) {
        process.stdout.write(
          `${JSON.stringify({ ok: true, ticketId, status }, null, 2)}\n`
        );
        return 0;
      }

      await display.panel({
        title: "Ticket status",
        tone: "success",
        lines: [`${ticketId} → ${status}`],
      });

      return 0;
    },
  },
  {
    name: "sync",
    summary: "Sync ticket events with git remote",
    scope: "project",
    handler: async ({ ctx, args }) => {
      if (!ctx.project) {
        ctx.logger.error({ message: "No project found. Run inside a repo." });
        return 1;
      }

      const parsed = parseTicketsArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      await maybeEnsureTicketsSetup({ ctx, json: parsed.value.json });

      const store = createTicketsStore({
        projectRoot: ctx.project.projectRoot,
        projectId: ctx.projectId,
        projectName: ctx.projectName,
        controlPlaneConfig: ctx.controlPlaneConfig,
        logger: ctx.logger,
      });

      const synced = await store.sync();
      if (!synced.ok) {
        ctx.logger.error({ message: synced.error });
        return 1;
      }

      if (parsed.value.json) {
        process.stdout.write(`${JSON.stringify({ sync: synced }, null, 2)}\n`);
        return 0;
      }

      await display.panel({
        title: "Tickets sync",
        tone: "success",
        lines: [
          `branch: ${synced.branch}`,
          `remote: ${synced.remote ?? "(none)"}`,
          `committed: ${synced.didCommit ? "yes" : "no"}`,
          `pushed: ${synced.didPush ? "yes" : "no"}`,
        ],
      });
      return 0;
    },
  },
];

const DEFAULT_TICKETS_SETUP_TARGETS = ["agents", "claude"] as const;
const TICKETS_SETUP_USAGE =
  "Usage: hack x tickets setup [--agents|--claude|--all] [--global] [--check|--remove] [--json]";
const TICKETS_UPDATE_USAGE =
  'Usage: hack x tickets update <ticket-id> [--title "..."] [--body "..."] [--body-file <path>] [--body-stdin] [--depends-on "..."] [--blocks "..."] [--clear-depends-on] [--clear-blocks] [--json]';
const TICKETS_RESOLUTION_ERROR =
  "Invalid --resolution value. Expected accept_local|accept_remote|merged|ignore.";

type TicketsSetupTarget = (typeof DEFAULT_TICKETS_SETUP_TARGETS)[number];
type TicketsSetupAction = "install" | "check" | "remove";
type TicketsRepoGitignoreResult = {
  status: TicketsRepoGitignoreStatus | TicketsRepoGitignoreFixStatus;
  path: string;
  message?: string;
};
type TicketsRepoTrackingResult = {
  status: TicketsRepoTrackedStatus | TicketsRepoUntrackStatus;
  message?: string;
};
type TicketsSetupDocResults =
  | TicketsAgentDocCheckResult[]
  | TicketsAgentDocRemoveResult[]
  | TicketsAgentDocUpdateResult[];
type ProjectContext = NonNullable<ExtensionCommandContext["project"]>;

function requireTicketsProject(opts: {
  readonly ctx: ExtensionCommandContext;
}): ProjectContext | null {
  if (!opts.ctx.project) {
    opts.ctx.logger.error({ message: "No project found. Run inside a repo." });
    return null;
  }
  return opts.ctx.project;
}

function createTicketsStoreForProject(opts: {
  readonly ctx: ExtensionCommandContext;
  readonly projectRoot: string;
}) {
  return createTicketsStore({
    projectRoot: opts.projectRoot,
    projectId: opts.ctx.projectId,
    projectName: opts.ctx.projectName,
    controlPlaneConfig: opts.ctx.controlPlaneConfig,
    logger: opts.ctx.logger,
  });
}

function resolveTicketsSetupTargets(opts: {
  readonly input: TicketsSetupArgs;
}): readonly TicketsSetupTarget[] {
  if (opts.input.all) {
    return DEFAULT_TICKETS_SETUP_TARGETS;
  }
  const targets = [
    ...(opts.input.agents ? (["agents"] as const) : []),
    ...(opts.input.claude ? (["claude"] as const) : []),
  ];
  return targets.length > 0 ? targets : DEFAULT_TICKETS_SETUP_TARGETS;
}

function resolveTicketsSetupAction(opts: {
  readonly input: TicketsSetupArgs;
}): TicketsSetupAction {
  if (opts.input.remove) {
    return "remove";
  }
  if (opts.input.check) {
    return "check";
  }
  return "install";
}

function createRepoGitignoreResult(opts: {
  readonly status: TicketsRepoGitignoreStatus | TicketsRepoGitignoreFixStatus;
  readonly path: string;
  readonly message?: string;
}): TicketsRepoGitignoreResult {
  return {
    status: opts.status,
    path: opts.path,
    ...(opts.message ? { message: opts.message } : {}),
  };
}

function createRepoTrackingResult(opts: {
  readonly status: TicketsRepoTrackedStatus | TicketsRepoUntrackStatus;
  readonly message?: string;
}): TicketsRepoTrackingResult {
  return {
    status: opts.status,
    ...(opts.message ? { message: opts.message } : {}),
  };
}

async function resolveTicketsSetupRepoState(opts: {
  readonly action: TicketsSetupAction;
  readonly projectRoot: string;
  readonly json: boolean;
}) {
  const repoState = await checkTicketsRepoState({
    projectRoot: opts.projectRoot,
  });
  let repoGitignore = createRepoGitignoreResult({
    status: repoState.gitignore.status,
    path: repoState.gitignore.path,
    message: repoState.gitignore.message,
  });
  let repoTracking = createRepoTrackingResult({
    status: repoState.tracked.status,
    message: repoState.tracked.message,
  });
  if (opts.action !== "install") {
    return { repoGitignore, repoTracking };
  }

  repoGitignore = await ensureTicketsSetupGitignore({
    projectRoot: opts.projectRoot,
    status: repoState.gitignore.status,
    path: repoState.gitignore.path,
  });
  repoTracking = await ensureTicketsSetupTracking({
    projectRoot: opts.projectRoot,
    status: repoState.tracked.status,
    json: opts.json,
  });

  return { repoGitignore, repoTracking };
}

function ensureTicketsSetupGitignore(opts: {
  readonly projectRoot: string;
  readonly status: TicketsRepoGitignoreStatus;
  readonly path: string;
}): Promise<TicketsRepoGitignoreResult> {
  if (opts.status === "missing") {
    return ensureTicketsGitignore({ projectRoot: opts.projectRoot });
  }
  if (opts.status === "present") {
    return Promise.resolve(
      createRepoGitignoreResult({ status: "noop", path: opts.path })
    );
  }
  return Promise.resolve(
    createRepoGitignoreResult({ status: opts.status, path: opts.path })
  );
}

async function ensureTicketsSetupTracking(opts: {
  readonly projectRoot: string;
  readonly status: TicketsRepoTrackedStatus;
  readonly json: boolean;
}): Promise<TicketsRepoTrackingResult> {
  if (opts.status !== "tracked") {
    return createRepoTrackingResult({ status: opts.status });
  }
  const canPrompt = isTty() && isGumAvailable() && !opts.json;
  if (!canPrompt) {
    return createRepoTrackingResult({
      status: "skipped",
      message: "Run: git rm -r --cached .hack/tickets",
    });
  }
  const confirmed = await gumConfirm({
    prompt: "Untrack .hack/tickets from the main branch? (keeps files on disk)",
    default: true,
  });
  if (!(confirmed.ok && confirmed.value)) {
    return createRepoTrackingResult({
      status: "skipped",
      message: "Skipped untracking .hack/tickets.",
    });
  }
  return untrackTicketsRepo({ projectRoot: opts.projectRoot });
}

function runTicketsSkillAction(opts: {
  readonly action: TicketsSetupAction;
  readonly scope: "project" | "user";
  readonly projectRoot: string;
}) {
  const projectRoot = opts.scope === "project" ? opts.projectRoot : undefined;
  if (opts.action === "check") {
    return checkTicketsSkill({ scope: opts.scope, projectRoot });
  }
  if (opts.action === "remove") {
    return removeTicketsSkill({ scope: opts.scope, projectRoot });
  }
  return installTicketsSkill({ scope: opts.scope, projectRoot });
}

function runTicketsDocsAction(opts: {
  readonly action: TicketsSetupAction;
  readonly projectRoot: string;
  readonly targets: readonly TicketsSetupTarget[];
}): Promise<TicketsSetupDocResults> {
  if (opts.action === "check") {
    return checkTicketsAgentDocs({
      projectRoot: opts.projectRoot,
      targets: opts.targets,
    });
  }
  if (opts.action === "remove") {
    return removeTicketsAgentDocs({
      projectRoot: opts.projectRoot,
      targets: opts.targets,
    });
  }
  return upsertTicketsAgentDocs({
    projectRoot: opts.projectRoot,
    targets: opts.targets,
  });
}

async function writeTicketsSetupOutput(opts: {
  readonly json: boolean;
  readonly skill: Awaited<ReturnType<typeof checkTicketsSkill>>;
  readonly docs: TicketsSetupDocResults;
  readonly repoGitignore: TicketsRepoGitignoreResult;
  readonly repoTracking: TicketsRepoTrackingResult;
}) {
  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          skill: opts.skill,
          docs: opts.docs,
          repo: {
            gitignore: opts.repoGitignore,
            tracking: opts.repoTracking,
          },
        },
        null,
        2
      )}\n`
    );
    return;
  }

  await display.panel({
    title: "Tickets setup",
    tone: "success",
    lines: [
      `skill: ${opts.skill.status} (${opts.skill.path})`,
      ...opts.docs.map(
        (result) => `${result.target}: ${result.status} (${result.path})`
      ),
      `repo.gitignore: ${opts.repoGitignore.status} (${opts.repoGitignore.path})`,
      `repo.tracking: ${opts.repoTracking.status}${
        opts.repoTracking.message ? ` (${opts.repoTracking.message})` : ""
      }`,
    ],
  });
}

function getTicketsSetupExitCode(opts: {
  readonly skill: Awaited<ReturnType<typeof checkTicketsSkill>>;
  readonly docs: TicketsSetupDocResults;
}): number {
  return opts.docs.some((result) => result.status === "error") ||
    opts.skill.status === "error"
    ? 1
    : 0;
}

async function handleTicketsSetupCommand(opts: {
  readonly ctx: ExtensionCommandContext;
  readonly args: readonly string[];
}): Promise<number> {
  const project = requireTicketsProject({ ctx: opts.ctx });
  if (!project) {
    return 1;
  }

  await ensureTicketsExtensionEnabled({
    projectDir: project.projectDir,
    logger: opts.ctx.logger,
  });

  const parsed = parseTicketsSetupArgs({ args: opts.args });
  if (!parsed.ok) {
    opts.ctx.logger.error({ message: parsed.error });
    return 1;
  }

  const action = resolveTicketsSetupAction({ input: parsed.value });
  const projectRoot = project.projectRoot;
  const scope = parsed.value.global ? "user" : "project";
  const targets = resolveTicketsSetupTargets({ input: parsed.value });
  const { repoGitignore, repoTracking } = await resolveTicketsSetupRepoState({
    action,
    projectRoot,
    json: parsed.value.json,
  });
  const skill = await runTicketsSkillAction({ action, scope, projectRoot });
  const docs = await runTicketsDocsAction({ action, projectRoot, targets });

  await writeTicketsSetupOutput({
    json: parsed.value.json,
    skill,
    docs,
    repoGitignore,
    repoTracking,
  });

  if (action === "install") {
    await maybeEnsureTicketsGitHealth({
      ctx: opts.ctx,
      json: parsed.value.json,
    });
  }

  return getTicketsSetupExitCode({ skill, docs });
}

function buildCreateTicketInput(opts: {
  readonly parsed: TicketsArgs;
  readonly title: string;
  readonly body?: string;
  readonly dependsOn: readonly string[];
  readonly blocks: readonly string[];
}) {
  return {
    title: opts.title,
    ...(opts.body !== undefined ? { body: opts.body } : {}),
    ...(opts.dependsOn.length > 0 ? { dependsOn: opts.dependsOn } : {}),
    ...(opts.blocks.length > 0 ? { blocks: opts.blocks } : {}),
    ...(opts.parsed.owner ? { owner: opts.parsed.owner } : {}),
    ...(opts.parsed.source ? { source: opts.parsed.source } : {}),
    ...(opts.parsed.assignee ? { assignee: opts.parsed.assignee } : {}),
    ...(opts.parsed.tags.length > 0 ? { tags: opts.parsed.tags } : {}),
    ...(opts.parsed.externalSystem
      ? { externalSystem: opts.parsed.externalSystem }
      : {}),
    ...(opts.parsed.externalId ? { externalId: opts.parsed.externalId } : {}),
    ...(opts.parsed.externalKey
      ? { externalKey: opts.parsed.externalKey }
      : {}),
    ...(opts.parsed.externalUrl
      ? { externalUrl: opts.parsed.externalUrl }
      : {}),
    ...(opts.parsed.externalProjectId
      ? { externalProjectId: opts.parsed.externalProjectId }
      : {}),
    ...(opts.parsed.externalProjectName
      ? { externalProjectName: opts.parsed.externalProjectName }
      : {}),
    ...(opts.parsed.externalTeamId
      ? { externalTeamId: opts.parsed.externalTeamId }
      : {}),
    actor: opts.parsed.actor,
  };
}

async function handleTicketsCreateCommand(opts: {
  readonly ctx: ExtensionCommandContext;
  readonly args: readonly string[];
}): Promise<number> {
  const project = requireTicketsProject({ ctx: opts.ctx });
  if (!project) {
    return 1;
  }

  const parsed = parseTicketsArgs({ args: opts.args });
  if (!parsed.ok) {
    opts.ctx.logger.error({ message: parsed.error });
    return 1;
  }

  const title = (parsed.value.title ?? "").trim();
  if (!title) {
    opts.ctx.logger.error({
      message: 'Usage: hack x tickets create --title "..."',
    });
    return 1;
  }

  await maybeEnsureTicketsSetup({ ctx: opts.ctx, json: parsed.value.json });

  const dependsOnResult = resolveTicketRefs({
    values: parsed.value.dependsOn,
    label: "--depends-on",
  });
  if (!dependsOnResult.ok) {
    opts.ctx.logger.error({ message: dependsOnResult.error });
    return 1;
  }
  const blocksResult = resolveTicketRefs({
    values: parsed.value.blocks,
    label: "--blocks",
  });
  if (!blocksResult.ok) {
    opts.ctx.logger.error({ message: blocksResult.error });
    return 1;
  }

  const body = await resolveTicketBody({
    body: parsed.value.body,
    bodyFile: parsed.value.bodyFile,
    bodyStdin: parsed.value.bodyStdin,
  });
  const store = createTicketsStoreForProject({
    ctx: opts.ctx,
    projectRoot: project.projectRoot,
  });
  const created = await store.createTicket(
    buildCreateTicketInput({
      parsed: parsed.value,
      title,
      body,
      dependsOn: dependsOnResult.refs,
      blocks: blocksResult.refs,
    })
  );
  if (!created.ok) {
    opts.ctx.logger.error({ message: created.error });
    return 1;
  }

  if (parsed.value.json) {
    process.stdout.write(
      `${JSON.stringify({ ticket: created.ticket }, null, 2)}\n`
    );
    return 0;
  }

  await display.kv({
    title: "Ticket created",
    entries: [
      ["ticket_id", created.ticket.ticketId],
      ["title", created.ticket.title],
      ["status", created.ticket.status],
      ["owner", created.ticket.owner],
      ["source", created.ticket.source],
      ["created_at", created.ticket.createdAt],
      ["updated_at", created.ticket.updatedAt],
    ],
  });
  return 0;
}

function resolveUpdateRefValue(opts: {
  readonly clear: boolean;
  readonly values: readonly string[];
  readonly refs: readonly string[];
}): string[] | undefined {
  if (opts.clear) {
    return [];
  }
  if (opts.values.length > 0) {
    return [...opts.refs];
  }
  return undefined;
}

function resolveUpdateTags(opts: {
  readonly clear: boolean;
  readonly tags: readonly string[];
}): string[] | undefined {
  if (opts.clear) {
    return [];
  }
  if (opts.tags.length > 0) {
    return [...opts.tags];
  }
  return undefined;
}

function validateTicketUpdateArgs(opts: {
  readonly parsed: TicketsArgs;
  readonly ticketId: string;
  readonly title?: string;
}): string | null {
  if (!opts.ticketId) {
    return TICKETS_UPDATE_USAGE;
  }
  if (opts.parsed.title !== undefined && !opts.title) {
    return "Title cannot be empty.";
  }
  if (opts.parsed.clearDependsOn && opts.parsed.dependsOn.length > 0) {
    return "--clear-depends-on cannot be combined with --depends-on.";
  }
  if (opts.parsed.clearBlocks && opts.parsed.blocks.length > 0) {
    return "--clear-blocks cannot be combined with --blocks.";
  }
  if (opts.parsed.clearTags && opts.parsed.tags.length > 0) {
    return "--clear-tags cannot be combined with --tags/--tag.";
  }
  if (opts.parsed.clearAssignee && opts.parsed.assignee !== undefined) {
    return "--clear-assignee cannot be combined with --assignee.";
  }
  return null;
}

type TicketUpdatePayload = {
  readonly ticketId: string;
  readonly title?: string;
  readonly bodyRequested: boolean;
  readonly body?: string;
  readonly dependsOn?: readonly string[];
  readonly blocks?: readonly string[];
  readonly tags?: readonly string[];
};

async function resolveTicketUpdatePayload(opts: {
  readonly parsed: TicketsArgs;
  readonly ticketId: string;
  readonly title?: string;
}): Promise<
  | { readonly ok: true; readonly value: TicketUpdatePayload }
  | { readonly ok: false; readonly error: string }
> {
  const dependsOnResult =
    opts.parsed.dependsOn.length > 0
      ? resolveTicketRefs({
          values: opts.parsed.dependsOn,
          label: "--depends-on",
        })
      : { ok: true as const, refs: [] };
  if (!dependsOnResult.ok) {
    return dependsOnResult;
  }
  const blocksResult =
    opts.parsed.blocks.length > 0
      ? resolveTicketRefs({
          values: opts.parsed.blocks,
          label: "--blocks",
        })
      : { ok: true as const, refs: [] };
  if (!blocksResult.ok) {
    return blocksResult;
  }

  const bodyRequested =
    opts.parsed.body !== undefined ||
    opts.parsed.bodyFile !== undefined ||
    opts.parsed.bodyStdin;
  const body = bodyRequested
    ? await resolveTicketBody({
        body: opts.parsed.body,
        bodyFile: opts.parsed.bodyFile,
        bodyStdin: opts.parsed.bodyStdin,
        allowEmpty: true,
      })
    : undefined;

  return {
    ok: true,
    value: {
      ticketId: opts.ticketId,
      ...(opts.title !== undefined ? { title: opts.title } : {}),
      bodyRequested,
      ...(bodyRequested ? { body } : {}),
      ...(resolveUpdateRefValue({
        clear: opts.parsed.clearDependsOn,
        values: opts.parsed.dependsOn,
        refs: dependsOnResult.refs,
      }) !== undefined
        ? {
            dependsOn: resolveUpdateRefValue({
              clear: opts.parsed.clearDependsOn,
              values: opts.parsed.dependsOn,
              refs: dependsOnResult.refs,
            }),
          }
        : {}),
      ...(resolveUpdateRefValue({
        clear: opts.parsed.clearBlocks,
        values: opts.parsed.blocks,
        refs: blocksResult.refs,
      }) !== undefined
        ? {
            blocks: resolveUpdateRefValue({
              clear: opts.parsed.clearBlocks,
              values: opts.parsed.blocks,
              refs: blocksResult.refs,
            }),
          }
        : {}),
      ...(resolveUpdateTags({
        clear: opts.parsed.clearTags,
        tags: opts.parsed.tags,
      }) !== undefined
        ? {
            tags: resolveUpdateTags({
              clear: opts.parsed.clearTags,
              tags: opts.parsed.tags,
            }),
          }
        : {}),
    },
  };
}

function hasTicketUpdateChanges(opts: {
  readonly parsed: TicketsArgs;
  readonly payload: TicketUpdatePayload;
}): boolean {
  return (
    opts.payload.title !== undefined ||
    opts.payload.bodyRequested ||
    opts.payload.dependsOn !== undefined ||
    opts.payload.blocks !== undefined ||
    opts.payload.tags !== undefined ||
    opts.parsed.assignee !== undefined ||
    opts.parsed.clearAssignee ||
    opts.parsed.owner !== undefined ||
    opts.parsed.source !== undefined ||
    opts.parsed.externalSystem !== undefined ||
    opts.parsed.externalId !== undefined ||
    opts.parsed.externalKey !== undefined ||
    opts.parsed.externalUrl !== undefined ||
    opts.parsed.externalProjectId !== undefined ||
    opts.parsed.externalProjectName !== undefined ||
    opts.parsed.externalTeamId !== undefined
  );
}

function buildTicketUpdateInput(opts: {
  readonly parsed: TicketsArgs;
  readonly payload: TicketUpdatePayload;
}) {
  return {
    ticketId: opts.payload.ticketId,
    ...(opts.payload.title !== undefined ? { title: opts.payload.title } : {}),
    ...(opts.payload.bodyRequested ? { body: opts.payload.body } : {}),
    ...(opts.payload.dependsOn !== undefined
      ? { dependsOn: opts.payload.dependsOn }
      : {}),
    ...(opts.payload.blocks !== undefined
      ? { blocks: opts.payload.blocks }
      : {}),
    ...(opts.payload.tags !== undefined ? { tags: opts.payload.tags } : {}),
    ...(opts.parsed.owner !== undefined ? { owner: opts.parsed.owner } : {}),
    ...(opts.parsed.source !== undefined ? { source: opts.parsed.source } : {}),
    ...(opts.parsed.clearAssignee ? { assignee: "" } : {}),
    ...(!opts.parsed.clearAssignee && opts.parsed.assignee !== undefined
      ? { assignee: opts.parsed.assignee }
      : {}),
    ...(opts.parsed.externalSystem !== undefined
      ? { externalSystem: opts.parsed.externalSystem }
      : {}),
    ...(opts.parsed.externalId !== undefined
      ? { externalId: opts.parsed.externalId }
      : {}),
    ...(opts.parsed.externalKey !== undefined
      ? { externalKey: opts.parsed.externalKey }
      : {}),
    ...(opts.parsed.externalUrl !== undefined
      ? { externalUrl: opts.parsed.externalUrl }
      : {}),
    ...(opts.parsed.externalProjectId !== undefined
      ? { externalProjectId: opts.parsed.externalProjectId }
      : {}),
    ...(opts.parsed.externalProjectName !== undefined
      ? { externalProjectName: opts.parsed.externalProjectName }
      : {}),
    ...(opts.parsed.externalTeamId !== undefined
      ? { externalTeamId: opts.parsed.externalTeamId }
      : {}),
    actor: opts.parsed.actor,
  };
}

async function handleTicketsUpdateCommand(opts: {
  readonly ctx: ExtensionCommandContext;
  readonly args: readonly string[];
}): Promise<number> {
  const project = requireTicketsProject({ ctx: opts.ctx });
  if (!project) {
    return 1;
  }

  const parsed = parseTicketsArgs({ args: opts.args });
  if (!parsed.ok) {
    opts.ctx.logger.error({ message: parsed.error });
    return 1;
  }

  const ticketId = (parsed.value.rest[0] ?? "").trim();
  const title = parsed.value.title?.trim();
  const validationError = validateTicketUpdateArgs({
    parsed: parsed.value,
    ticketId,
    title,
  });
  if (validationError) {
    opts.ctx.logger.error({ message: validationError });
    return 1;
  }

  const payload = await resolveTicketUpdatePayload({
    parsed: parsed.value,
    ticketId,
    title,
  });
  if (!payload.ok) {
    opts.ctx.logger.error({ message: payload.error });
    return 1;
  }
  if (
    !hasTicketUpdateChanges({ parsed: parsed.value, payload: payload.value })
  ) {
    opts.ctx.logger.error({ message: "No updates provided." });
    return 1;
  }

  await maybeEnsureTicketsSetup({ ctx: opts.ctx, json: parsed.value.json });

  const store = createTicketsStoreForProject({
    ctx: opts.ctx,
    projectRoot: project.projectRoot,
  });
  const updated = await store.updateTicket(
    buildTicketUpdateInput({ parsed: parsed.value, payload: payload.value })
  );
  if (!updated.ok) {
    opts.ctx.logger.error({ message: updated.error });
    return 1;
  }

  if (parsed.value.json) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, ticketId }, null, 2)}\n`
    );
    return 0;
  }

  await display.panel({
    title: "Ticket updated",
    tone: "success",
    lines: [`${ticketId} updated`],
  });
  return 0;
}

async function writeTicketDetailSections(opts: {
  readonly detail: Awaited<
    ReturnType<ReturnType<typeof createTicketsStore>["getTicketDetail"]>
  >;
}) {
  const { detail } = opts;
  const ticket = detail.ticket;
  if (!ticket) {
    return;
  }

  await display.kv({
    title: `Ticket ${ticket.ticketId}`,
    entries: [
      ["title", ticket.title],
      ["status", ticket.status],
      ["owner", ticket.owner],
      ["source", ticket.source],
      ["assignee", ticket.assignee ?? ""],
      ["tags", ticket.tags.join(", ")],
      ["external_system", ticket.externalSystem ?? ""],
      ["external_id", ticket.externalId ?? ""],
      ["external_key", ticket.externalKey ?? ""],
      ["external_url", ticket.externalUrl ?? ""],
      ["external_project_id", ticket.externalProjectId ?? ""],
      ["external_project_name", ticket.externalProjectName ?? ""],
      ["external_team_id", ticket.externalTeamId ?? ""],
      ["depends_on", ticket.dependsOn.join(", ")],
      ["blocks", ticket.blocks.join(", ")],
      ["created_at", ticket.createdAt],
      ["updated_at", ticket.updatedAt],
      ["project_id", ticket.projectId ?? ""],
      ["project_name", ticket.projectName ?? ""],
    ],
  });
  if (ticket.body) {
    await display.panel({
      title: "Body",
      tone: "info",
      lines: ticket.body.split("\n"),
    });
  }
  await maybeDisplayTable({
    rows: detail.comments.map((comment) => [
      comment.commentId,
      comment.source,
      comment.actor,
      comment.createdAt,
      comment.body,
    ]),
    columns: ["comment_id", "source", "actor", "created_at", "body"],
  });
  await maybeDisplayTable({
    rows: detail.reviewNotes.map((reviewNote) => [
      reviewNote.noteId,
      reviewNote.actor,
      reviewNote.createdAt,
      reviewNote.context ?? "",
      reviewNote.body,
    ]),
    columns: ["note_id", "actor", "created_at", "context", "body"],
  });
  await maybeDisplayTable({
    rows: detail.syncCheckpoints.map((checkpoint) => [
      checkpoint.checkpointId,
      checkpoint.provider,
      checkpoint.profileId ?? "",
      checkpoint.direction ?? "",
      checkpoint.remoteCursor ?? "",
    ]),
    columns: ["checkpoint_id", "provider", "profile", "direction", "cursor"],
  });
  await maybeDisplayTable({
    rows: detail.conflicts.map((conflict) => [
      conflict.conflictId,
      conflict.field,
      conflict.status,
      conflict.provider,
      conflict.resolution ?? "",
    ]),
    columns: ["conflict_id", "field", "status", "provider", "resolution"],
  });
  await display.table({
    columns: ["ts", "type", "event_id"],
    rows: detail.events.map((event) => [
      event.tsIso,
      event.type,
      event.eventId,
    ]),
  });
}

async function maybeDisplayTable(opts: {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}) {
  if (opts.rows.length === 0) {
    return;
  }
  await display.table({
    columns: [...opts.columns],
    rows: opts.rows.map((row) => [...row]),
  });
}

async function handleTicketsShowCommand(opts: {
  readonly ctx: ExtensionCommandContext;
  readonly args: readonly string[];
}): Promise<number> {
  const project = requireTicketsProject({ ctx: opts.ctx });
  if (!project) {
    return 1;
  }

  const parsed = parseTicketsArgs({ args: opts.args });
  if (!parsed.ok) {
    opts.ctx.logger.error({ message: parsed.error });
    return 1;
  }

  const ticketId = (parsed.value.rest[0] ?? "").trim();
  if (!ticketId) {
    opts.ctx.logger.error({
      message: "Usage: hack x tickets show <ticket-id>",
    });
    return 1;
  }

  await maybeEnsureTicketsSetup({ ctx: opts.ctx, json: parsed.value.json });
  const store = createTicketsStoreForProject({
    ctx: opts.ctx,
    projectRoot: project.projectRoot,
  });
  const detail = await store.getTicketDetail({ ticketId });
  if (!detail.ticket) {
    opts.ctx.logger.error({ message: `Ticket not found: ${ticketId}` });
    return 1;
  }

  if (parsed.value.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ticket: detail.ticket,
          comments: detail.comments,
          reviewNotes: detail.reviewNotes,
          syncCheckpoints: detail.syncCheckpoints,
          conflicts: detail.conflicts,
          events: detail.events,
        },
        null,
        2
      )}\n`
    );
    return 0;
  }

  await writeTicketDetailSections({ detail });
  return 0;
}

type TicketsArgs = {
  readonly title?: string;
  readonly body?: string;
  readonly bodyFile?: string;
  readonly bodyStdin: boolean;
  readonly dependsOn: readonly string[];
  readonly blocks: readonly string[];
  readonly clearDependsOn: boolean;
  readonly clearBlocks: boolean;
  readonly owner?: string;
  readonly source?: string;
  readonly assignee?: string;
  readonly clearAssignee: boolean;
  readonly tags: readonly string[];
  readonly clearTags: boolean;
  readonly externalSystem?: string;
  readonly externalId?: string;
  readonly externalKey?: string;
  readonly externalUrl?: string;
  readonly externalProjectId?: string;
  readonly externalProjectName?: string;
  readonly externalTeamId?: string;
  readonly actor?: string;
  readonly json: boolean;
  readonly rest: readonly string[];
};

type TicketsParseResult =
  | { readonly ok: true; readonly value: TicketsArgs }
  | { readonly ok: false; readonly error: string };

type TicketsSetupArgs = {
  readonly agents: boolean;
  readonly claude: boolean;
  readonly all: boolean;
  readonly global: boolean;
  readonly check: boolean;
  readonly remove: boolean;
  readonly json: boolean;
};

type ResolveConflictArgs = {
  readonly conflictId: string;
  readonly resolution: TicketSyncConflictResolution;
  readonly summary?: string;
  readonly actor?: string;
  readonly json: boolean;
  readonly rest: readonly string[];
};

type TicketsSetupParseResult =
  | { readonly ok: true; readonly value: TicketsSetupArgs }
  | { readonly ok: false; readonly error: string };

type MutableTicketsArgs = {
  rest: string[];
  title?: string;
  body?: string;
  bodyFile?: string;
  bodyStdin: boolean;
  dependsOn: string[];
  blocks: string[];
  clearDependsOn: boolean;
  clearBlocks: boolean;
  owner?: string;
  source?: string;
  assignee?: string;
  clearAssignee: boolean;
  tags: string[];
  clearTags: boolean;
  externalSystem?: string;
  externalId?: string;
  externalKey?: string;
  externalUrl?: string;
  externalProjectId?: string;
  externalProjectName?: string;
  externalTeamId?: string;
  actor?: string;
  json: boolean;
};

type MutableResolveConflictArgs = {
  rest: string[];
  conflictId?: string;
  resolution?: TicketSyncConflictResolution;
  summary?: string;
  actor?: string;
  json: boolean;
};

type ParsedCliToken =
  | { readonly kind: "terminator" }
  | {
      readonly kind: "option";
      readonly name: string;
      readonly inlineValue?: string;
    }
  | { readonly kind: "positional"; readonly value: string };

type OptionApplyResult =
  | { readonly ok: true; readonly consumedNext: boolean }
  | { readonly ok: false; readonly error: string };

const TICKETS_STRING_OPTION_FIELDS = {
  title: "title",
  body: "body",
  "body-file": "bodyFile",
  actor: "actor",
  owner: "owner",
  source: "source",
  assignee: "assignee",
  "external-system": "externalSystem",
  "external-id": "externalId",
  "external-key": "externalKey",
  "external-url": "externalUrl",
  "external-project-id": "externalProjectId",
  "external-project-name": "externalProjectName",
  "external-team-id": "externalTeamId",
} as const;

const TICKETS_BOOLEAN_OPTION_FIELDS = {
  json: "json",
  "body-stdin": "bodyStdin",
  "clear-depends-on": "clearDependsOn",
  "clear-blocks": "clearBlocks",
  "clear-tags": "clearTags",
  "clear-assignee": "clearAssignee",
} as const;

const TICKETS_LIST_OPTION_FIELDS = {
  "depends-on": { field: "dependsOn", split: splitTicketRefs },
  blocks: { field: "blocks", split: splitTicketRefs },
  tags: { field: "tags", split: splitTags },
  tag: { field: "tags", split: (value: string) => [value] },
} as const;

const TICKETS_SETUP_FLAGS = {
  "--agents": "agents",
  "--agents-md": "agents",
  "--claude": "claude",
  "--claude-md": "claude",
  "--all": "all",
  "--global": "global",
  "--check": "check",
  "--remove": "remove",
  "--json": "json",
} as const;

function createMutableTicketsArgs(): MutableTicketsArgs {
  return {
    rest: [],
    bodyStdin: false,
    dependsOn: [],
    blocks: [],
    clearDependsOn: false,
    clearBlocks: false,
    clearAssignee: false,
    tags: [],
    clearTags: false,
    json: false,
  };
}

function createMutableResolveConflictArgs(): MutableResolveConflictArgs {
  return {
    rest: [],
    json: false,
  };
}

function parseCliToken(opts: { readonly token: string }): ParsedCliToken {
  if (opts.token === "--") {
    return { kind: "terminator" };
  }
  if (!opts.token.startsWith("-")) {
    return { kind: "positional", value: opts.token };
  }
  if (!opts.token.startsWith("--")) {
    return { kind: "option", name: opts.token.slice(1) };
  }
  const equalsIndex = opts.token.indexOf("=");
  if (equalsIndex === -1) {
    return { kind: "option", name: opts.token.slice(2) };
  }
  return {
    kind: "option",
    name: opts.token.slice(2, equalsIndex),
    inlineValue: opts.token.slice(equalsIndex + 1),
  };
}

function takeRequiredOptionValue(opts: {
  readonly option: string;
  readonly inlineValue?: string;
  readonly nextToken?: string;
}):
  | {
      readonly ok: true;
      readonly value: string;
      readonly consumedNext: boolean;
    }
  | { readonly ok: false; readonly error: string } {
  if (opts.inlineValue !== undefined) {
    return { ok: true, value: opts.inlineValue, consumedNext: false };
  }
  if (!opts.nextToken || opts.nextToken.startsWith("-")) {
    return { ok: false, error: `--${opts.option} requires a value.` };
  }
  return { ok: true, value: opts.nextToken, consumedNext: true };
}

function applyTicketsOption(opts: {
  readonly state: MutableTicketsArgs;
  readonly option: string;
  readonly inlineValue?: string;
  readonly nextToken?: string;
}): OptionApplyResult {
  const booleanField =
    TICKETS_BOOLEAN_OPTION_FIELDS[
      opts.option as keyof typeof TICKETS_BOOLEAN_OPTION_FIELDS
    ];
  if (booleanField) {
    if (opts.inlineValue !== undefined) {
      return {
        ok: false,
        error: `Unknown option: --${opts.option}=${opts.inlineValue}`,
      };
    }
    opts.state[booleanField] = true;
    return { ok: true, consumedNext: false };
  }

  const stringField =
    TICKETS_STRING_OPTION_FIELDS[
      opts.option as keyof typeof TICKETS_STRING_OPTION_FIELDS
    ];
  if (stringField) {
    const value = takeRequiredOptionValue({
      option: opts.option,
      inlineValue: opts.inlineValue,
      nextToken: opts.nextToken,
    });
    if (!value.ok) {
      return value;
    }
    opts.state[stringField] = value.value;
    return { ok: true, consumedNext: value.consumedNext };
  }

  const listField =
    TICKETS_LIST_OPTION_FIELDS[
      opts.option as keyof typeof TICKETS_LIST_OPTION_FIELDS
    ];
  if (listField) {
    const value = takeRequiredOptionValue({
      option: opts.option,
      inlineValue: opts.inlineValue,
      nextToken: opts.nextToken,
    });
    if (!value.ok) {
      return value;
    }
    opts.state[listField.field].push(...listField.split(value.value));
    return { ok: true, consumedNext: value.consumedNext };
  }

  return { ok: false, error: `Unknown option: --${opts.option}` };
}

function finalizeTicketsArgs(opts: {
  readonly state: MutableTicketsArgs;
}): TicketsArgs {
  const { state } = opts;
  return {
    ...(state.title ? { title: state.title } : {}),
    ...(state.body ? { body: state.body } : {}),
    ...(state.bodyFile ? { bodyFile: state.bodyFile } : {}),
    bodyStdin: state.bodyStdin,
    dependsOn: state.dependsOn,
    blocks: state.blocks,
    clearDependsOn: state.clearDependsOn,
    clearBlocks: state.clearBlocks,
    ...(state.owner ? { owner: state.owner } : {}),
    ...(state.source ? { source: state.source } : {}),
    ...(state.assignee !== undefined ? { assignee: state.assignee } : {}),
    clearAssignee: state.clearAssignee,
    tags: normalizeTags(state.tags),
    clearTags: state.clearTags,
    ...(state.externalSystem !== undefined
      ? { externalSystem: state.externalSystem }
      : {}),
    ...(state.externalId !== undefined ? { externalId: state.externalId } : {}),
    ...(state.externalKey !== undefined
      ? { externalKey: state.externalKey }
      : {}),
    ...(state.externalUrl !== undefined
      ? { externalUrl: state.externalUrl }
      : {}),
    ...(state.externalProjectId !== undefined
      ? { externalProjectId: state.externalProjectId }
      : {}),
    ...(state.externalProjectName !== undefined
      ? { externalProjectName: state.externalProjectName }
      : {}),
    ...(state.externalTeamId !== undefined
      ? { externalTeamId: state.externalTeamId }
      : {}),
    ...(state.actor ? { actor: state.actor } : {}),
    json: state.json,
    rest: state.rest,
  };
}

function parseTicketsArgs(opts: {
  readonly args: readonly string[];
}): TicketsParseResult {
  const state = createMutableTicketsArgs();
  for (let i = 0; i < opts.args.length; i += 1) {
    const parsedToken = parseCliToken({ token: opts.args[i] ?? "" });
    if (parsedToken.kind === "terminator") {
      state.rest.push(...opts.args.slice(i + 1));
      break;
    }
    if (parsedToken.kind === "positional") {
      state.rest.push(parsedToken.value);
      continue;
    }
    const applied = applyTicketsOption({
      state,
      option: parsedToken.name,
      inlineValue: parsedToken.inlineValue,
      nextToken: opts.args[i + 1],
    });
    if (!applied.ok) {
      return applied;
    }
    if (applied.consumedNext) {
      i += 1;
    }
  }

  return { ok: true, value: finalizeTicketsArgs({ state }) };
}

function parseResolveConflictArgs(opts: {
  readonly args: readonly string[];
}):
  | { readonly ok: true; readonly value: ResolveConflictArgs }
  | { readonly ok: false; readonly error: string } {
  const state = createMutableResolveConflictArgs();
  for (let i = 0; i < opts.args.length; i += 1) {
    const parsedToken = parseCliToken({ token: opts.args[i] ?? "" });
    if (parsedToken.kind === "terminator") {
      state.rest.push(...opts.args.slice(i + 1));
      break;
    }
    if (parsedToken.kind === "positional") {
      state.rest.push(parsedToken.value);
      continue;
    }
    const applied = applyResolveConflictOption({
      state,
      option: parsedToken.name,
      inlineValue: parsedToken.inlineValue,
      nextToken: opts.args[i + 1],
    });
    if (!applied.ok) {
      return applied;
    }
    if (applied.consumedNext) {
      i += 1;
    }
  }

  if (!state.conflictId) {
    return { ok: false, error: "Missing --conflict-id <ID>." };
  }
  if (!state.resolution) {
    return {
      ok: false,
      error: "Missing --resolution <accept_local|accept_remote|merged|ignore>.",
    };
  }

  return {
    ok: true,
    value: {
      conflictId: state.conflictId,
      resolution: state.resolution,
      ...(state.summary !== undefined ? { summary: state.summary } : {}),
      ...(state.actor ? { actor: state.actor } : {}),
      json: state.json,
      rest: state.rest,
    },
  };
}

function applyResolveConflictOption(opts: {
  readonly state: MutableResolveConflictArgs;
  readonly option: string;
  readonly inlineValue?: string;
  readonly nextToken?: string;
}): OptionApplyResult {
  if (opts.option === "json") {
    if (opts.inlineValue !== undefined) {
      return {
        ok: false,
        error: `Unknown option: --${opts.option}=${opts.inlineValue}`,
      };
    }
    opts.state.json = true;
    return { ok: true, consumedNext: false };
  }
  if (opts.option === "resolution") {
    const value = takeRequiredOptionValue({
      option: opts.option,
      inlineValue: opts.inlineValue,
      nextToken: opts.nextToken,
    });
    if (!value.ok) {
      return value;
    }
    const resolution = parseConflictResolutionValue({ value: value.value });
    if (!resolution) {
      return { ok: false, error: TICKETS_RESOLUTION_ERROR };
    }
    opts.state.resolution = resolution;
    return { ok: true, consumedNext: value.consumedNext };
  }
  const fieldMap = {
    "conflict-id": "conflictId",
    summary: "summary",
    actor: "actor",
  } as const;
  const field = fieldMap[opts.option as keyof typeof fieldMap];
  if (!field) {
    return { ok: false, error: `Unknown option: --${opts.option}` };
  }
  const value = takeRequiredOptionValue({
    option: opts.option,
    inlineValue: opts.inlineValue,
    nextToken: opts.nextToken,
  });
  if (!value.ok) {
    return value;
  }
  opts.state[field] = value.value;
  return { ok: true, consumedNext: value.consumedNext };
}

async function resolveTicketBody(opts: {
  readonly body?: string;
  readonly bodyFile?: string;
  readonly bodyStdin: boolean;
  readonly allowEmpty?: boolean;
}): Promise<string | undefined> {
  const allowEmpty = opts.allowEmpty ?? false;
  if (opts.bodyStdin) {
    const text = await Bun.stdin.text();
    const trimmed = text.trimEnd();
    if (trimmed.length > 0) {
      return trimmed;
    }
    return allowEmpty ? "" : undefined;
  }

  const bodyFile = (opts.bodyFile ?? "").trim();
  if (bodyFile.length > 0) {
    const text = await Bun.file(bodyFile).text();
    const trimmed = text.trimEnd();
    if (trimmed.length > 0) {
      return trimmed;
    }
    return allowEmpty ? "" : undefined;
  }

  const body = (opts.body ?? "").trimEnd();
  if (body.length > 0) {
    return body;
  }
  return allowEmpty ? "" : undefined;
}

function splitTicketRefs(value: string): string[] {
  return value
    .split(TICKET_REF_SEPARATOR_PATTERN)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function parseConflictResolutionValue(input: {
  readonly value: string;
}): TicketSyncConflictResolution | null {
  const value = input.value.trim();
  if (
    value === "accept_local" ||
    value === "accept_remote" ||
    value === "merged" ||
    value === "ignore"
  ) {
    return value;
  }
  return null;
}

function splitTags(value: string): string[] {
  return value
    .split(TICKET_REF_SEPARATOR_PATTERN)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function normalizeTags(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const tag = value.trim();
    if (!(tag && !seen.has(tag))) {
      continue;
    }
    seen.add(tag);
    normalized.push(tag);
  }
  normalized.sort((left, right) => left.localeCompare(right));
  return normalized;
}

function resolveTicketRefs(opts: {
  readonly values: readonly string[];
  readonly label: string;
}):
  | { readonly ok: true; readonly refs: string[] }
  | { readonly ok: false; readonly error: string } {
  if (opts.values.length === 0) {
    return { ok: true, refs: [] };
  }

  const invalid: string[] = [];
  const normalized: string[] = [];
  for (const value of opts.values) {
    const parsed = normalizeTicketRef(value);
    if (parsed) {
      normalized.push(parsed);
    } else {
      invalid.push(value);
    }
  }

  if (invalid.length > 0) {
    return {
      ok: false,
      error: `Invalid ${opts.label} ticket(s): ${invalid.join(", ")}`,
    };
  }

  return { ok: true, refs: normalizeTicketRefs(normalized) };
}

function buildTicketsSetupNotices(opts: {
  readonly needsGitignore: boolean;
  readonly needsUntrack: boolean;
  readonly needsSkill: boolean;
  readonly needsDocs: boolean;
}): string[] {
  const notices: string[] = [];
  if (opts.needsGitignore) {
    notices.push("add .hack/tickets/ to .gitignore");
  }
  if (opts.needsUntrack) {
    notices.push("untrack .hack/tickets from main branch");
  }
  if (opts.needsSkill || opts.needsDocs) {
    notices.push("run tickets setup");
  }
  return notices;
}

async function applyTicketsSetupRepairs(opts: {
  readonly projectRoot: string;
  readonly needsGitignore: boolean;
  readonly needsUntrack: boolean;
  readonly needsSkill: boolean;
  readonly needsDocs: boolean;
}): Promise<string[]> {
  const lines: string[] = [];
  if (opts.needsGitignore) {
    const gitignore = await ensureTicketsGitignore({
      projectRoot: opts.projectRoot,
    });
    lines.push(`repo.gitignore: ${gitignore.status} (${gitignore.path})`);
  }
  if (opts.needsUntrack) {
    const untrack = await untrackTicketsRepo({ projectRoot: opts.projectRoot });
    lines.push(
      `repo.tracking: ${untrack.status}${untrack.message ? ` (${untrack.message})` : ""}`
    );
  }
  if (opts.needsSkill) {
    const installed = await installTicketsSkill({
      scope: "project",
      projectRoot: opts.projectRoot,
    });
    lines.push(`skill: ${installed.status} (${installed.path})`);
  }
  if (opts.needsDocs) {
    const updatedDocs = await upsertTicketsAgentDocs({
      projectRoot: opts.projectRoot,
      targets: ["agents", "claude"],
    });
    lines.push(
      ...updatedDocs.map((doc) => `${doc.target}: ${doc.status} (${doc.path})`)
    );
  }
  return lines;
}

async function maybeEnsureTicketsSetup(opts: {
  readonly ctx: ExtensionCommandContext;
  readonly json: boolean;
}): Promise<void> {
  if (!opts.ctx.project) {
    return;
  }
  if (opts.json) {
    return;
  }

  const projectRoot = opts.ctx.project.projectRoot;
  const repoState = await checkTicketsRepoState({ projectRoot });

  const skill = await checkTicketsSkill({ scope: "project", projectRoot });
  const docs = await checkTicketsAgentDocs({
    projectRoot,
    targets: ["agents", "claude"],
  });

  const needsGitignore = repoState.gitignore.status === "missing";
  const needsUntrack = repoState.tracked.status === "tracked";
  const needsSkill = skill.status === "missing" || skill.status === "error";
  const needsDocs = docs.some(
    (doc) => doc.status === "missing" || doc.status === "error"
  );

  const needsRepair = needsGitignore || needsUntrack || needsSkill || needsDocs;
  if (!needsRepair) {
    return;
  }

  const notices = buildTicketsSetupNotices({
    needsGitignore,
    needsUntrack,
    needsSkill,
    needsDocs,
  });
  if (!(isTty() && isGumAvailable())) {
    if (notices.length > 0) {
      opts.ctx.logger.warn({
        message: `Tickets setup incomplete: ${notices.join("; ")}.`,
      });
    }
    return;
  }

  const confirmed = await gumConfirm({
    prompt: "Tickets setup is incomplete. Fix now?",
    default: true,
  });
  if (!(confirmed.ok && confirmed.value)) {
    return;
  }
  const lines = await applyTicketsSetupRepairs({
    projectRoot,
    needsGitignore,
    needsUntrack,
    needsSkill,
    needsDocs,
  });
  if (lines.length > 0) {
    await display.panel({
      title: "Tickets setup",
      tone: "success",
      lines,
    });
  }

  await maybeEnsureTicketsGitHealth({ ctx: opts.ctx, json: opts.json });
}

function needsTicketsGitHealthRepair(opts: {
  readonly health: TicketsGitHealth;
}): boolean {
  return (
    opts.health.hasLegacyRef ||
    opts.health.hasRefDivergence ||
    opts.health.hasNonTicketFiles
  );
}

function buildTicketsGitHealthReasons(opts: {
  readonly health: TicketsGitHealth;
}): string[] {
  const reasons: string[] = [];
  if (opts.health.hasRefDivergence) {
    reasons.push("hidden ref diverges from legacy branch");
  }
  if (opts.health.hasLegacyRef && opts.health.legacyRef) {
    reasons.push(`legacy ref ${opts.health.legacyRef}`);
  }
  if (opts.health.hasNonTicketFiles) {
    reasons.push("non-ticket files in tickets ref");
  }
  return reasons;
}

async function confirmLegacyRefPrune(opts: {
  readonly health: TicketsGitHealth;
}): Promise<boolean> {
  if (!(opts.health.hasLegacyRef && opts.health.legacyRef)) {
    return false;
  }
  const prune = await gumConfirm({
    prompt: `Remove legacy ref ${opts.health.legacyRef} from the remote?`,
    default: true,
  });
  return prune.ok && prune.value;
}

function buildTicketsRepairLines(opts: {
  readonly health: TicketsGitHealth;
  readonly pruneLegacyRef: boolean;
  readonly repaired: Extract<TicketsGitRepairResult, { readonly ok: true }>;
}): string[] {
  const lines: string[] = [];
  if (opts.health.hasNonTicketFiles) {
    const sample = opts.health.nonTicketPaths.slice(0, 5);
    const extra = opts.health.nonTicketPaths.length - sample.length;
    lines.push(`non-ticket files: ${opts.health.nonTicketPaths.length}`);
    if (sample.length > 0) {
      lines.push(
        `sample: ${sample.join(", ")}${extra > 0 ? ` (+${extra} more)` : ""}`
      );
    }
  }
  if (opts.health.hasLegacyRef && opts.health.legacyRef) {
    lines.push(
      `legacy ref: ${opts.health.legacyRef} ${
        opts.pruneLegacyRef ? "pruned" : "left intact"
      }`
    );
  }
  if (opts.health.hasRefDivergence) {
    lines.push(
      `ref divergence: ${
        opts.health.remoteRefOid?.slice(0, 8) ?? "missing"
      } vs ${opts.health.legacyRefOid?.slice(0, 8) ?? "missing"}`
    );
  }
  lines.push(`commit: ${opts.repaired.didCommit ? "created" : "noop"}`);
  lines.push(`push: ${opts.repaired.didPush ? "pushed" : "skipped"}`);
  if (opts.repaired.pruneError) {
    lines.push(`legacy prune error: ${opts.repaired.pruneError}`);
  }
  return lines;
}

async function maybeEnsureTicketsGitHealth(opts: {
  readonly ctx: ExtensionCommandContext;
  readonly json: boolean;
}): Promise<void> {
  if (!opts.ctx.project) {
    return;
  }
  if (opts.json) {
    return;
  }
  if (didPromptTicketsGitHealth) {
    return;
  }
  didPromptTicketsGitHealth = true;

  const gitConfig = opts.ctx.controlPlaneConfig.tickets.git;
  if (!gitConfig.enabled) {
    return;
  }

  const projectRoot = opts.ctx.project.projectRoot;
  const channel = createGitTicketsChannel({
    projectRoot,
    config: gitConfig,
    logger: opts.ctx.logger,
  });

  const inspected = await channel.inspect();
  if (!inspected.ok) {
    opts.ctx.logger.warn({
      message: `Tickets git health check failed: ${inspected.error}`,
    });
    return;
  }

  const health = inspected.health;
  if (!needsTicketsGitHealthRepair({ health })) {
    return;
  }

  const reasons = buildTicketsGitHealthReasons({ health });

  if (!(isTty() && isGumAvailable())) {
    opts.ctx.logger.warn({
      message: `Tickets git storage needs repair (${reasons.join("; ")}). Run: hack x tickets setup`,
    });
    return;
  }

  const confirmed = await gumConfirm({
    prompt: "Tickets git storage needs repair. Fix now?",
    default: true,
  });
  if (!(confirmed.ok && confirmed.value)) {
    return;
  }
  const pruneLegacyRef = await confirmLegacyRefPrune({ health });
  const repaired = await channel.repair({ pruneLegacyRef });
  if (!repaired.ok) {
    await display.panel({
      title: "Tickets repair",
      tone: "warn",
      lines: [`error: ${repaired.error}`],
    });
    return;
  }
  await display.panel({
    title: "Tickets repair",
    tone: repaired.pruneError ? "warn" : "success",
    lines: buildTicketsRepairLines({
      health,
      pruneLegacyRef,
      repaired,
    }),
  });
}

function parseTicketsSetupArgs(opts: {
  readonly args: readonly string[];
}): TicketsSetupParseResult {
  const value = {
    agents: false,
    claude: false,
    all: false,
    global: false,
    check: false,
    remove: false,
    json: false,
  };
  for (const token of opts.args) {
    if (token === "--help" || token === "help") {
      return { ok: false, error: TICKETS_SETUP_USAGE };
    }
    const field =
      TICKETS_SETUP_FLAGS[token as keyof typeof TICKETS_SETUP_FLAGS];
    if (!field) {
      return { ok: false, error: `Unknown option: ${token}` };
    }
    value[field] = true;
  }

  if (value.check && value.remove) {
    return { ok: false, error: "--check and --remove are mutually exclusive." };
  }
  return { ok: true, value };
}

/**
 * Ensures the tickets extension is enabled in the project config.
 * Reads the project's hack.config.json and adds the extension enabled flag if missing.
 */
async function ensureTicketsExtensionEnabled(opts: {
  readonly projectDir: string;
  readonly logger: ExtensionCommandContext["logger"];
}): Promise<void> {
  const { resolve } = await import("node:path");
  const { readTextFile, writeTextFileIfChanged } = await import(
    "../../../lib/fs.ts"
  );
  const { isRecord } = await import("../../../lib/guards.ts");

  const configPath = resolve(opts.projectDir, "hack.config.json");
  const text = await readTextFile(configPath);
  if (text === null) {
    return;
  }

  let config: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) {
      return;
    }
    config = parsed;
  } catch {
    return;
  }

  const controlPlane = isRecord(config.controlPlane)
    ? config.controlPlane
    : ({} as Record<string, unknown>);
  const extensions = isRecord(controlPlane.extensions)
    ? controlPlane.extensions
    : ({} as Record<string, unknown>);
  const ticketsConfig = isRecord(extensions["dance.hack.tickets"])
    ? extensions["dance.hack.tickets"]
    : ({} as Record<string, unknown>);

  if (ticketsConfig.enabled === true) {
    return;
  }

  ticketsConfig.enabled = true;
  extensions["dance.hack.tickets"] = ticketsConfig;
  controlPlane.extensions = extensions;
  config.controlPlane = controlPlane;

  const nextText = `${JSON.stringify(config, null, 2)}\n`;
  const result = await writeTextFileIfChanged(configPath, nextText);
  if (result.changed) {
    opts.logger.success({
      message: `Enabled dance.hack.tickets in ${configPath}`,
    });
  }
}
