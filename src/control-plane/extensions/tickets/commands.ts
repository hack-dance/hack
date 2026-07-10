import { runTicketsTui } from "../../../tui/tickets-tui.ts";
import { display } from "../../../ui/display.ts";
import { gumConfirm, isGumAvailable } from "../../../ui/gum.ts";
import { isTty } from "../../../ui/terminal.ts";
import type { ExtensionCommand, ExtensionCommandContext } from "../types.ts";
import {
  checkDeprecatedTicketsAgentDocs,
  removeTicketsAgentDocs,
  type TicketsAgentDocCheckResult,
  type TicketsAgentDocRemoveResult,
  type TicketsAgentDocUpdateResult,
} from "./agent-docs.ts";
import {
  isTicketDocumentKind,
  isTicketDocumentRole,
  type TicketDocumentKind,
  type TicketDocumentRole,
} from "./documents.ts";
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
import { createGitTicketsChannel } from "./tickets-git-channel.ts";
import {
  checkDeprecatedTicketsSkill,
  removeTicketsSkill,
} from "./tickets-skill.ts";
import { normalizeTicketRef, normalizeTicketRefs } from "./util.ts";

const TICKET_REF_SEPARATOR_PATTERN = /[,\s]+/;

let didPromptTicketsGitHealth = false;
let didWarnTicketsDeprecation = false;

export const TICKETS_COMMANDS: readonly ExtensionCommand[] = [
  {
    name: "setup",
    summary: "Deprecated: remove Tickets agent integrations and repair storage",
    scope: "project",
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Tickets setup intentionally coordinates repo, skill, and docs repair in one CLI flow.
    handler: async ({ ctx, args }) => {
      if (!ctx.project) {
        ctx.logger.error({ message: "No project found. Run inside a repo." });
        return 1;
      }

      const parsed = parseTicketsSetupArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const targets = parsed.value.all
        ? (["agents", "claude"] as const)
        : ([
            ...(parsed.value.agents ? (["agents"] as const) : []),
            ...(parsed.value.claude ? (["claude"] as const) : []),
          ] as const);

      const resolvedTargets =
        targets.length > 0 ? targets : (["agents", "claude"] as const);

      const scope = parsed.value.global ? "user" : "project";
      const projectRoot = ctx.project.projectRoot;

      let action: "install" | "check" | "remove";
      if (parsed.value.remove) {
        action = "remove";
      } else if (parsed.value.check) {
        action = "check";
      } else {
        action = "install";
      }
      const repoState = await checkTicketsRepoState({ projectRoot });

      let repoGitignore: {
        status: TicketsRepoGitignoreStatus | TicketsRepoGitignoreFixStatus;
        path: string;
        message?: string;
      } = {
        status: repoState.gitignore.status,
        path: repoState.gitignore.path,
        message: repoState.gitignore.message,
      };
      let repoTracking: {
        status: TicketsRepoTrackedStatus | TicketsRepoUntrackStatus;
        message?: string;
      } = {
        status: repoState.tracked.status,
        message: repoState.tracked.message,
      };

      if (action === "install") {
        if (repoState.gitignore.status === "missing") {
          repoGitignore = await ensureTicketsGitignore({ projectRoot });
        } else if (repoState.gitignore.status === "present") {
          repoGitignore = { status: "noop", path: repoState.gitignore.path };
        }

        if (repoState.tracked.status === "tracked") {
          const canPrompt = isTty() && isGumAvailable() && !parsed.value.json;
          if (canPrompt) {
            const confirmed = await gumConfirm({
              prompt:
                "Untrack .hack/tickets from the main branch? (keeps files on disk)",
              default: true,
            });
            if (confirmed.ok && confirmed.value) {
              repoTracking = await untrackTicketsRepo({ projectRoot });
            } else {
              repoTracking = {
                status: "skipped",
                message: "Skipped untracking .hack/tickets.",
              };
            }
          } else {
            repoTracking = {
              status: "skipped",
              message: "Run: git rm -r --cached .hack/tickets",
            };
          }
        }
      }

      let skill: Awaited<ReturnType<typeof checkDeprecatedTicketsSkill>>;
      const skillProjectRoot = scope === "project" ? projectRoot : undefined;
      if (action === "check") {
        skill = await checkDeprecatedTicketsSkill({
          scope,
          projectRoot: skillProjectRoot,
        });
      } else {
        skill = await removeTicketsSkill({
          scope,
          projectRoot: skillProjectRoot,
        });
      }

      let docs:
        | TicketsAgentDocCheckResult[]
        | TicketsAgentDocRemoveResult[]
        | TicketsAgentDocUpdateResult[];
      if (action === "check") {
        docs = await checkDeprecatedTicketsAgentDocs({
          projectRoot,
          targets: resolvedTargets,
        });
      } else {
        docs = await removeTicketsAgentDocs({
          projectRoot,
          targets: resolvedTargets,
        });
      }

      if (parsed.value.json) {
        process.stdout.write(
          `${JSON.stringify({ skill, docs, repo: { gitignore: repoGitignore, tracking: repoTracking } }, null, 2)}\n`
        );
        return 0;
      }

      await display.panel({
        title: "Tickets deprecated",
        tone: "warn",
        lines: [
          "Agent skills and instruction blocks are no longer installed.",
          `skill: ${skill.status} (${skill.path})`,
          ...docs.map((r) => `${r.target}: ${r.status} (${r.path})`),
          `repo.gitignore: ${repoGitignore.status} (${repoGitignore.path})`,
          `repo.tracking: ${repoTracking.status}${
            repoTracking.message ? ` (${repoTracking.message})` : ""
          }`,
        ],
      });

      if (action === "install") {
        await maybeEnsureTicketsGitHealth({ ctx, json: parsed.value.json });
      }

      const deprecatedFound =
        action === "check" &&
        (skill.status === "deprecated" ||
          docs.some((result) => result.status === "deprecated"));
      return docs.some((r) => r.status === "error") ||
        skill.status === "error" ||
        deprecatedFound
        ? 1
        : 0;
    },
  },
  {
    name: "create",
    summary: "Create a new ticket",
    scope: "project",
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Ticket creation keeps validation and projection writeback together for CLI UX.
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

      const title = (parsed.value.title ?? "").trim();
      if (!title) {
        ctx.logger.error({
          message: 'Usage: hack x tickets create --title "..."',
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

      const body = await resolveTicketBody({
        body: parsed.value.body,
        bodyFile: parsed.value.bodyFile,
        bodyStdin: parsed.value.bodyStdin,
      });

      const dependsOnResult = resolveTicketRefs({
        values: parsed.value.dependsOn,
        label: "--depends-on",
      });
      if (!dependsOnResult.ok) {
        ctx.logger.error({ message: dependsOnResult.error });
        return 1;
      }

      const blocksResult = resolveTicketRefs({
        values: parsed.value.blocks,
        label: "--blocks",
      });
      if (!blocksResult.ok) {
        ctx.logger.error({ message: blocksResult.error });
        return 1;
      }

      const created = await store.createTicket({
        title,
        body,
        ...(dependsOnResult.refs.length > 0
          ? { dependsOn: dependsOnResult.refs }
          : {}),
        ...(blocksResult.refs.length > 0 ? { blocks: blocksResult.refs } : {}),
        ...(parsed.value.owner ? { owner: parsed.value.owner } : {}),
        ...(parsed.value.source ? { source: parsed.value.source } : {}),
        ...(parsed.value.assignee ? { assignee: parsed.value.assignee } : {}),
        ...(parsed.value.tags.length > 0 ? { tags: parsed.value.tags } : {}),
        ...(parsed.value.externalSystem
          ? { externalSystem: parsed.value.externalSystem }
          : {}),
        ...(parsed.value.externalId
          ? { externalId: parsed.value.externalId }
          : {}),
        ...(parsed.value.externalKey
          ? { externalKey: parsed.value.externalKey }
          : {}),
        ...(parsed.value.externalUrl
          ? { externalUrl: parsed.value.externalUrl }
          : {}),
        ...(parsed.value.externalProjectId
          ? { externalProjectId: parsed.value.externalProjectId }
          : {}),
        ...(parsed.value.externalProjectName
          ? { externalProjectName: parsed.value.externalProjectName }
          : {}),
        ...(parsed.value.externalTeamId
          ? { externalTeamId: parsed.value.externalTeamId }
          : {}),
        actor: parsed.value.actor,
      });

      if (!created.ok) {
        ctx.logger.error({ message: created.error });
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
    },
  },
  {
    name: "update",
    summary: "Update a ticket",
    scope: "project",
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Ticket update keeps patch validation and projection writeback together for CLI UX.
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
            'Usage: hack x tickets update <ticket-id> [--title "..."] [--body "..."] [--body-file <path>] [--body-stdin] [--depends-on "..."] [--blocks "..."] [--clear-depends-on] [--clear-blocks] [--json]',
        });
        return 1;
      }

      const title = parsed.value.title?.trim();
      if (parsed.value.title !== undefined && !title) {
        ctx.logger.error({ message: "Title cannot be empty." });
        return 1;
      }

      if (parsed.value.clearDependsOn && parsed.value.dependsOn.length > 0) {
        ctx.logger.error({
          message: "--clear-depends-on cannot be combined with --depends-on.",
        });
        return 1;
      }

      if (parsed.value.clearBlocks && parsed.value.blocks.length > 0) {
        ctx.logger.error({
          message: "--clear-blocks cannot be combined with --blocks.",
        });
        return 1;
      }
      if (parsed.value.clearTags && parsed.value.tags.length > 0) {
        ctx.logger.error({
          message: "--clear-tags cannot be combined with --tags/--tag.",
        });
        return 1;
      }
      if (parsed.value.clearAssignee && parsed.value.assignee !== undefined) {
        ctx.logger.error({
          message: "--clear-assignee cannot be combined with --assignee.",
        });
        return 1;
      }

      const bodyRequested =
        parsed.value.body !== undefined ||
        parsed.value.bodyFile !== undefined ||
        parsed.value.bodyStdin;

      const body = bodyRequested
        ? await resolveTicketBody({
            body: parsed.value.body,
            bodyFile: parsed.value.bodyFile,
            bodyStdin: parsed.value.bodyStdin,
            allowEmpty: true,
          })
        : undefined;

      const dependsOnResult =
        parsed.value.dependsOn.length > 0
          ? resolveTicketRefs({
              values: parsed.value.dependsOn,
              label: "--depends-on",
            })
          : { ok: true as const, refs: [] };

      if (!dependsOnResult.ok) {
        ctx.logger.error({ message: dependsOnResult.error });
        return 1;
      }

      const blocksResult =
        parsed.value.blocks.length > 0
          ? resolveTicketRefs({
              values: parsed.value.blocks,
              label: "--blocks",
            })
          : { ok: true as const, refs: [] };

      if (!blocksResult.ok) {
        ctx.logger.error({ message: blocksResult.error });
        return 1;
      }

      let dependsOn: string[] | undefined;
      if (parsed.value.clearDependsOn) {
        dependsOn = [];
      } else if (parsed.value.dependsOn.length > 0) {
        dependsOn = dependsOnResult.refs;
      } else {
        dependsOn = undefined;
      }

      let blocks: string[] | undefined;
      if (parsed.value.clearBlocks) {
        blocks = [];
      } else if (parsed.value.blocks.length > 0) {
        blocks = blocksResult.refs;
      } else {
        blocks = undefined;
      }

      let tags: string[] | undefined;
      if (parsed.value.clearTags) {
        tags = [];
      } else if (parsed.value.tags.length > 0) {
        tags = [...parsed.value.tags];
      } else {
        tags = undefined;
      }

      const hasUpdates =
        title !== undefined ||
        bodyRequested ||
        dependsOn !== undefined ||
        blocks !== undefined ||
        parsed.value.assignee !== undefined ||
        parsed.value.clearAssignee ||
        tags !== undefined ||
        parsed.value.owner !== undefined ||
        parsed.value.source !== undefined ||
        parsed.value.externalSystem !== undefined ||
        parsed.value.externalId !== undefined ||
        parsed.value.externalKey !== undefined ||
        parsed.value.externalUrl !== undefined ||
        parsed.value.externalProjectId !== undefined ||
        parsed.value.externalProjectName !== undefined ||
        parsed.value.externalTeamId !== undefined;

      if (!hasUpdates) {
        ctx.logger.error({ message: "No updates provided." });
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

      const updated = await store.updateTicket({
        ticketId,
        ...(title !== undefined ? { title } : {}),
        ...(bodyRequested ? { body } : {}),
        ...(dependsOn !== undefined ? { dependsOn } : {}),
        ...(blocks !== undefined ? { blocks } : {}),
        ...(tags !== undefined ? { tags } : {}),
        ...(parsed.value.owner !== undefined
          ? { owner: parsed.value.owner }
          : {}),
        ...(parsed.value.source !== undefined
          ? { source: parsed.value.source }
          : {}),
        ...(parsed.value.clearAssignee ? { assignee: "" } : {}),
        ...(!parsed.value.clearAssignee && parsed.value.assignee !== undefined
          ? { assignee: parsed.value.assignee }
          : {}),
        ...(parsed.value.externalSystem !== undefined
          ? { externalSystem: parsed.value.externalSystem }
          : {}),
        ...(parsed.value.externalId !== undefined
          ? { externalId: parsed.value.externalId }
          : {}),
        ...(parsed.value.externalKey !== undefined
          ? { externalKey: parsed.value.externalKey }
          : {}),
        ...(parsed.value.externalUrl !== undefined
          ? { externalUrl: parsed.value.externalUrl }
          : {}),
        ...(parsed.value.externalProjectId !== undefined
          ? { externalProjectId: parsed.value.externalProjectId }
          : {}),
        ...(parsed.value.externalProjectName !== undefined
          ? { externalProjectName: parsed.value.externalProjectName }
          : {}),
        ...(parsed.value.externalTeamId !== undefined
          ? { externalTeamId: parsed.value.externalTeamId }
          : {}),
        actor: parsed.value.actor,
      });

      if (!updated.ok) {
        ctx.logger.error({ message: updated.error });
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
    },
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
    name: "document",
    summary: "Append an immutable ticket document",
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
            'Usage: hack x tickets document <ticket-id> --kind <description|spec|notes> [--role <description|spec|notes|handoff>] [--body "..."] [--body-file <path>] [--body-stdin] [--json]',
        });
        return 1;
      }
      if (!parsed.value.kind) {
        ctx.logger.error({
          message:
            "Document kind is required. Use --kind <description|spec|notes>.",
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
            "Document body is required. Use --body, --body-file, or --body-stdin.",
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

      const appended = await store.appendDocument({
        ticketId,
        kind: parsed.value.kind,
        ...(parsed.value.role ? { role: parsed.value.role } : {}),
        content: body,
        actor: parsed.value.actor,
      });
      if (!appended.ok) {
        ctx.logger.error({ message: appended.error });
        return 1;
      }

      if (parsed.value.json) {
        process.stdout.write(
          `${JSON.stringify({ document: appended.document }, null, 2)}\n`
        );
        return 0;
      }

      await display.panel({
        title: "Ticket document",
        tone: "success",
        lines: [
          `${ticketId} ${appended.document.role} document appended`,
          appended.document.content,
        ],
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
    handler: async ({ ctx, args }) => {
      const project = ctx.project;
      if (!project) {
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
        ctx.logger.error({ message: "Usage: hack x tickets show <ticket-id>" });
        return 1;
      }

      await maybeEnsureTicketsSetup({ ctx, json: parsed.value.json });

      const store = createTicketsStore({
        projectRoot: project.projectRoot,
        projectId: ctx.projectId,
        projectName: ctx.projectName,
        controlPlaneConfig: ctx.controlPlaneConfig,
        logger: ctx.logger,
      });

      const detail = await store.getTicketDetail({ ticketId });
      const ticket = detail.ticket;
      if (!ticket) {
        ctx.logger.error({ message: `Ticket not found: ${ticketId}` });
        return 1;
      }

      await renderTicketDetail({
        detail,
        json: parsed.value.json,
      });
      return 0;
    },
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

type TicketsArgs = {
  readonly title?: string;
  readonly body?: string;
  readonly bodyFile?: string;
  readonly bodyStdin: boolean;
  readonly kind?: TicketDocumentKind;
  readonly role?: TicketDocumentRole;
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
  title?: string;
  body?: string;
  bodyFile?: string;
  bodyStdin: boolean;
  kind?: TicketDocumentKind;
  role?: TicketDocumentRole;
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
  rest: string[];
};

type MutableResolveConflictArgs = {
  conflictId?: string;
  resolution?: TicketSyncConflictResolution;
  summary?: string;
  actor?: string;
  json: boolean;
  rest: string[];
};

type MutableTicketsSetupArgs = {
  agents: boolean;
  claude: boolean;
  all: boolean;
  global: boolean;
  check: boolean;
  remove: boolean;
  json: boolean;
};

type TicketsSetupNeeds = {
  readonly needsGitignore: boolean;
  readonly needsUntrack: boolean;
};

type TicketDetailResult = Awaited<
  ReturnType<ReturnType<typeof createTicketsStore>["getTicketDetail"]>
>;

type TicketsGitHealthSummary = {
  readonly hasRefDivergence: boolean;
  readonly hasLegacyRef: boolean;
  readonly legacyRef?: string;
  readonly hasNonTicketFiles: boolean;
  readonly nonTicketPaths: readonly string[];
  readonly remoteRefOid?: string;
  readonly legacyRefOid?: string;
};

type TicketsRepairSummary = {
  readonly didCommit: boolean;
  readonly didPush: boolean;
  readonly pruneError?: string;
};

type ParseHandlerResult = {
  readonly handled: boolean;
  readonly nextIndex: number;
  readonly error?: string;
};

type ConsumedOptionValue =
  | { readonly matched: false }
  | {
      readonly matched: true;
      readonly nextIndex: number;
      readonly value?: string;
      readonly error?: string;
    };

type TicketsSetupTokenResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

function parseTicketsArgs(opts: {
  readonly args: readonly string[];
}): TicketsParseResult {
  const state: MutableTicketsArgs = {
    bodyStdin: false,
    dependsOn: [],
    blocks: [],
    clearDependsOn: false,
    clearBlocks: false,
    clearAssignee: false,
    tags: [],
    clearTags: false,
    json: false,
    rest: [],
  };

  for (let i = 0; i < opts.args.length; i += 1) {
    const token = opts.args[i] ?? "";

    if (token === "--") {
      state.rest.push(...opts.args.slice(i + 1));
      break;
    }

    if (token === "--json") {
      state.json = true;
      continue;
    }
    const handlers = [
      parseTicketContentOption,
      parseTicketDocumentOption,
      parseTicketRelationshipOption,
      parseTicketIdentityOption,
      parseTicketTagOption,
      parseTicketExternalOption,
    ] as const;
    let handled = false;
    for (const handler of handlers) {
      const result = handler({
        args: opts.args,
        index: i,
        state,
      });
      if (result.error) {
        return { ok: false, error: result.error };
      }
      if (result.handled) {
        i = result.nextIndex;
        handled = true;
        break;
      }
    }
    if (handled) {
      continue;
    }

    if (token.startsWith("-")) {
      return { ok: false, error: `Unknown option: ${token}` };
    }

    state.rest.push(token);
  }

  return {
    ok: true,
    value: finalizeTicketsArgs(state),
  };
}

function parseResolveConflictArgs(opts: {
  readonly args: readonly string[];
}):
  | { readonly ok: true; readonly value: ResolveConflictArgs }
  | { readonly ok: false; readonly error: string } {
  const state: MutableResolveConflictArgs = {
    json: false,
    rest: [],
  };

  for (let i = 0; i < opts.args.length; i += 1) {
    const token = opts.args[i] ?? "";
    if (token === "--") {
      state.rest.push(...opts.args.slice(i + 1));
      break;
    }
    if (token === "--json") {
      state.json = true;
      continue;
    }

    const result = parseResolveConflictOption({
      args: opts.args,
      index: i,
      state,
    });
    if (result.error) {
      return { ok: false, error: result.error };
    }
    if (result.handled) {
      i = result.nextIndex;
      continue;
    }

    if (token.startsWith("-")) {
      return { ok: false, error: `Unknown option: ${token}` };
    }
    state.rest.push(token);
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

function finalizeTicketsArgs(state: MutableTicketsArgs): TicketsArgs {
  return {
    ...(state.title ? { title: state.title } : {}),
    ...(state.body ? { body: state.body } : {}),
    ...(state.bodyFile ? { bodyFile: state.bodyFile } : {}),
    bodyStdin: state.bodyStdin,
    ...(state.kind ? { kind: state.kind } : {}),
    ...(state.role ? { role: state.role } : {}),
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

function consumeOptionValue(opts: {
  readonly args: readonly string[];
  readonly index: number;
  readonly flag: string;
}): ConsumedOptionValue {
  const token = opts.args[opts.index] ?? "";
  if (token.startsWith(`${opts.flag}=`)) {
    return {
      matched: true,
      nextIndex: opts.index,
      value: token.slice(opts.flag.length + 1),
    };
  }
  if (token !== opts.flag) {
    return { matched: false };
  }
  const value = opts.args[opts.index + 1];
  if (!value || value.startsWith("-")) {
    return {
      matched: true,
      nextIndex: opts.index,
      error: `${opts.flag} requires a value.`,
    };
  }
  return {
    matched: true,
    nextIndex: opts.index + 1,
    value,
  };
}

function parseTicketContentOption(opts: {
  readonly args: readonly string[];
  readonly index: number;
  readonly state: MutableTicketsArgs;
}): ParseHandlerResult {
  const bodyStdinToken = opts.args[opts.index];
  if (bodyStdinToken === "--body-stdin") {
    opts.state.bodyStdin = true;
    return { handled: true, nextIndex: opts.index };
  }

  for (const [flag, assign] of [
    ["--title", (value: string | undefined) => (opts.state.title = value)],
    ["--body", (value: string | undefined) => (opts.state.body = value)],
    [
      "--body-file",
      (value: string | undefined) => (opts.state.bodyFile = value),
    ],
  ] as const) {
    const consumed = consumeOptionValue({
      args: opts.args,
      index: opts.index,
      flag,
    });
    if (!consumed.matched) {
      continue;
    }
    if (consumed.error) {
      return {
        handled: true,
        nextIndex: consumed.nextIndex,
        error: consumed.error,
      };
    }
    assign(consumed.value);
    return { handled: true, nextIndex: consumed.nextIndex };
  }

  return { handled: false, nextIndex: opts.index };
}

function parseTicketDocumentOption(opts: {
  readonly args: readonly string[];
  readonly index: number;
  readonly state: MutableTicketsArgs;
}): ParseHandlerResult {
  const kindOption = consumeOptionValue({
    args: opts.args,
    index: opts.index,
    flag: "--kind",
  });
  if (kindOption.matched) {
    if (kindOption.error) {
      return {
        handled: true,
        nextIndex: kindOption.nextIndex,
        error: kindOption.error,
      };
    }
    const kind = kindOption.value ?? "";
    if (!isTicketDocumentKind(kind)) {
      return {
        handled: true,
        nextIndex: kindOption.nextIndex,
        error: "Invalid --kind value. Expected description|spec|notes.",
      };
    }
    opts.state.kind = kind;
    return { handled: true, nextIndex: kindOption.nextIndex };
  }

  const roleOption = consumeOptionValue({
    args: opts.args,
    index: opts.index,
    flag: "--role",
  });
  if (roleOption.matched) {
    if (roleOption.error) {
      return {
        handled: true,
        nextIndex: roleOption.nextIndex,
        error: roleOption.error,
      };
    }
    const role = roleOption.value ?? "";
    if (!isTicketDocumentRole(role)) {
      return {
        handled: true,
        nextIndex: roleOption.nextIndex,
        error: "Invalid --role value. Expected description|spec|notes|handoff.",
      };
    }
    opts.state.role = role;
    return { handled: true, nextIndex: roleOption.nextIndex };
  }

  return { handled: false, nextIndex: opts.index };
}

function parseTicketRelationshipOption(opts: {
  readonly args: readonly string[];
  readonly index: number;
  readonly state: MutableTicketsArgs;
}): ParseHandlerResult {
  const token = opts.args[opts.index] ?? "";
  switch (token) {
    case "--clear-depends-on":
      opts.state.clearDependsOn = true;
      return { handled: true, nextIndex: opts.index };
    case "--clear-blocks":
      opts.state.clearBlocks = true;
      return { handled: true, nextIndex: opts.index };
    case "--clear-tags":
      opts.state.clearTags = true;
      return { handled: true, nextIndex: opts.index };
    case "--clear-assignee":
      opts.state.clearAssignee = true;
      return { handled: true, nextIndex: opts.index };
    default:
      break;
  }

  for (const [flag, assign] of [
    [
      "--depends-on",
      (value: string) => opts.state.dependsOn.push(...splitTicketRefs(value)),
    ],
    [
      "--blocks",
      (value: string) => opts.state.blocks.push(...splitTicketRefs(value)),
    ],
  ] as const) {
    const consumed = consumeOptionValue({
      args: opts.args,
      index: opts.index,
      flag,
    });
    if (!consumed.matched) {
      continue;
    }
    if (consumed.error) {
      return {
        handled: true,
        nextIndex: consumed.nextIndex,
        error: consumed.error,
      };
    }
    assign(consumed.value ?? "");
    return { handled: true, nextIndex: consumed.nextIndex };
  }

  return { handled: false, nextIndex: opts.index };
}

function parseTicketIdentityOption(opts: {
  readonly args: readonly string[];
  readonly index: number;
  readonly state: MutableTicketsArgs;
}): ParseHandlerResult {
  for (const [flag, assign] of [
    ["--actor", (value: string | undefined) => (opts.state.actor = value)],
    ["--owner", (value: string | undefined) => (opts.state.owner = value)],
    ["--source", (value: string | undefined) => (opts.state.source = value)],
    [
      "--assignee",
      (value: string | undefined) => (opts.state.assignee = value),
    ],
  ] as const) {
    const consumed = consumeOptionValue({
      args: opts.args,
      index: opts.index,
      flag,
    });
    if (!consumed.matched) {
      continue;
    }
    if (consumed.error) {
      return {
        handled: true,
        nextIndex: consumed.nextIndex,
        error: consumed.error,
      };
    }
    assign(consumed.value);
    return { handled: true, nextIndex: consumed.nextIndex };
  }

  return { handled: false, nextIndex: opts.index };
}

function parseTicketTagOption(opts: {
  readonly args: readonly string[];
  readonly index: number;
  readonly state: MutableTicketsArgs;
}): ParseHandlerResult {
  for (const [flag, split] of [
    ["--tags", splitTags],
    ["--tag", (value: string) => [value]],
  ] as const) {
    const consumed = consumeOptionValue({
      args: opts.args,
      index: opts.index,
      flag,
    });
    if (!consumed.matched) {
      continue;
    }
    if (consumed.error) {
      return {
        handled: true,
        nextIndex: consumed.nextIndex,
        error: consumed.error,
      };
    }
    opts.state.tags.push(...split(consumed.value ?? ""));
    return { handled: true, nextIndex: consumed.nextIndex };
  }

  return { handled: false, nextIndex: opts.index };
}

function parseTicketExternalOption(opts: {
  readonly args: readonly string[];
  readonly index: number;
  readonly state: MutableTicketsArgs;
}): ParseHandlerResult {
  for (const [flag, assign] of [
    [
      "--external-system",
      (value: string | undefined) => (opts.state.externalSystem = value),
    ],
    [
      "--external-id",
      (value: string | undefined) => (opts.state.externalId = value),
    ],
    [
      "--external-key",
      (value: string | undefined) => (opts.state.externalKey = value),
    ],
    [
      "--external-url",
      (value: string | undefined) => (opts.state.externalUrl = value),
    ],
    [
      "--external-project-id",
      (value: string | undefined) => (opts.state.externalProjectId = value),
    ],
    [
      "--external-project-name",
      (value: string | undefined) => (opts.state.externalProjectName = value),
    ],
    [
      "--external-team-id",
      (value: string | undefined) => (opts.state.externalTeamId = value),
    ],
  ] as const) {
    const consumed = consumeOptionValue({
      args: opts.args,
      index: opts.index,
      flag,
    });
    if (!consumed.matched) {
      continue;
    }
    if (consumed.error) {
      return {
        handled: true,
        nextIndex: consumed.nextIndex,
        error: consumed.error,
      };
    }
    assign(consumed.value);
    return { handled: true, nextIndex: consumed.nextIndex };
  }

  return { handled: false, nextIndex: opts.index };
}

function parseResolveConflictOption(opts: {
  readonly args: readonly string[];
  readonly index: number;
  readonly state: MutableResolveConflictArgs;
}): ParseHandlerResult {
  for (const [flag, assign] of [
    [
      "--conflict-id",
      (value: string | undefined) => (opts.state.conflictId = value),
    ],
    ["--summary", (value: string | undefined) => (opts.state.summary = value)],
    ["--actor", (value: string | undefined) => (opts.state.actor = value)],
  ] as const) {
    const consumed = consumeOptionValue({
      args: opts.args,
      index: opts.index,
      flag,
    });
    if (!consumed.matched) {
      continue;
    }
    if (consumed.error) {
      return {
        handled: true,
        nextIndex: consumed.nextIndex,
        error: consumed.error,
      };
    }
    assign(consumed.value);
    return { handled: true, nextIndex: consumed.nextIndex };
  }

  const resolution = consumeOptionValue({
    args: opts.args,
    index: opts.index,
    flag: "--resolution",
  });
  if (!resolution.matched) {
    return { handled: false, nextIndex: opts.index };
  }
  if (resolution.error) {
    return {
      handled: true,
      nextIndex: resolution.nextIndex,
      error: resolution.error,
    };
  }
  const parsedResolution = parseConflictResolutionValue({
    value: resolution.value ?? "",
  });
  if (!parsedResolution) {
    return {
      handled: true,
      nextIndex: resolution.nextIndex,
      error:
        "Invalid --resolution value. Expected accept_local|accept_remote|merged|ignore.",
    };
  }
  opts.state.resolution = parsedResolution;
  return { handled: true, nextIndex: resolution.nextIndex };
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

async function renderTicketDetail(opts: {
  readonly detail: TicketDetailResult;
  readonly json: boolean;
}): Promise<void> {
  if (opts.json) {
    writeTicketDetailJson({ detail: opts.detail });
    return;
  }

  await displayTicketDetailSections({ detail: opts.detail });
}

function writeTicketDetailJson(opts: {
  readonly detail: TicketDetailResult;
}): void {
  process.stdout.write(
    `${JSON.stringify(
      {
        ticket: opts.detail.ticket,
        documents: opts.detail.documents,
        comments: opts.detail.comments,
        reviewNotes: opts.detail.reviewNotes,
        syncCheckpoints: opts.detail.syncCheckpoints,
        conflicts: opts.detail.conflicts,
        events: opts.detail.events,
      },
      null,
      2
    )}\n`
  );
}

async function displayTicketDetailSections(opts: {
  readonly detail: TicketDetailResult;
}): Promise<void> {
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

  if (detail.documents.length > 0) {
    await display.table({
      columns: ["document_id", "kind", "role", "updated_at"],
      rows: detail.documents.map((document) => [
        document.documentId,
        document.kind,
        document.role,
        document.updatedAt,
      ]),
    });
  }

  if (detail.comments.length > 0) {
    await display.table({
      columns: ["comment_id", "source", "actor", "created_at", "body"],
      rows: detail.comments.map((comment) => [
        comment.commentId,
        comment.source,
        comment.actor,
        comment.createdAt,
        comment.body,
      ]),
    });
  }

  if (detail.reviewNotes.length > 0) {
    await display.table({
      columns: ["note_id", "actor", "created_at", "context", "body"],
      rows: detail.reviewNotes.map((reviewNote) => [
        reviewNote.noteId,
        reviewNote.actor,
        reviewNote.createdAt,
        reviewNote.context ?? "",
        reviewNote.body,
      ]),
    });
  }

  if (detail.syncCheckpoints.length > 0) {
    await display.table({
      columns: ["checkpoint_id", "provider", "profile", "direction", "cursor"],
      rows: detail.syncCheckpoints.map((checkpoint) => [
        checkpoint.checkpointId,
        checkpoint.provider,
        checkpoint.profileId ?? "",
        checkpoint.direction ?? "",
        checkpoint.remoteCursor ?? "",
      ]),
    });
  }

  if (detail.conflicts.length > 0) {
    await display.table({
      columns: ["conflict_id", "field", "status", "provider", "resolution"],
      rows: detail.conflicts.map((conflict) => [
        conflict.conflictId,
        conflict.field,
        conflict.status,
        conflict.provider,
        conflict.resolution ?? "",
      ]),
    });
  }

  await display.table({
    columns: ["ts", "type", "event_id"],
    rows: detail.events.map((event) => [
      event.tsIso,
      event.type,
      event.eventId,
    ]),
  });
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

  if (!didWarnTicketsDeprecation) {
    didWarnTicketsDeprecation = true;
    opts.ctx.logger.warn({
      message:
        "Hack Tickets is deprecated. Agent skills and instruction blocks are no longer installed; use this command only for compatibility or migration.",
    });
  }

  const projectRoot = opts.ctx.project.projectRoot;
  const repoState = await checkTicketsRepoState({ projectRoot });
  const needs = getTicketsSetupNeeds({ repoState });
  if (!hasIncompleteTicketsSetup({ needs })) {
    return;
  }

  if (!(isTty() && isGumAvailable())) {
    const notices = buildTicketsSetupNotices({ needs });
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

  const lines = await repairTicketsSetup({ projectRoot, needs });
  if (lines.length > 0) {
    await display.panel({
      title: "Tickets setup",
      tone: "success",
      lines,
    });
  }

  await maybeEnsureTicketsGitHealth({ ctx: opts.ctx, json: opts.json });
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
  if (
    !(
      health.hasLegacyRef ||
      health.hasRefDivergence ||
      health.hasNonTicketFiles
    )
  ) {
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

  const lines = buildTicketsRepairLines({
    health,
    repaired,
    pruneLegacyRef,
  });

  await display.panel({
    title: "Tickets repair",
    tone: repaired.pruneError ? "warn" : "success",
    lines,
  });
}

function getTicketsSetupNeeds(opts: {
  readonly repoState: Awaited<ReturnType<typeof checkTicketsRepoState>>;
}): TicketsSetupNeeds {
  return {
    needsGitignore: opts.repoState.gitignore.status === "missing",
    needsUntrack: opts.repoState.tracked.status === "tracked",
  };
}

function hasIncompleteTicketsSetup(opts: {
  readonly needs: TicketsSetupNeeds;
}): boolean {
  return opts.needs.needsGitignore || opts.needs.needsUntrack;
}

function buildTicketsSetupNotices(opts: {
  readonly needs: TicketsSetupNeeds;
}): string[] {
  const notices: string[] = [];
  if (opts.needs.needsGitignore) {
    notices.push("add .hack/tickets/ to .gitignore");
  }
  if (opts.needs.needsUntrack) {
    notices.push("untrack .hack/tickets from main branch");
  }
  return notices;
}

async function repairTicketsSetup(opts: {
  readonly projectRoot: string;
  readonly needs: TicketsSetupNeeds;
}): Promise<string[]> {
  const lines: string[] = [];

  if (opts.needs.needsGitignore) {
    const gitignore = await ensureTicketsGitignore({
      projectRoot: opts.projectRoot,
    });
    lines.push(`repo.gitignore: ${gitignore.status} (${gitignore.path})`);
  }

  if (opts.needs.needsUntrack) {
    const untrack = await untrackTicketsRepo({ projectRoot: opts.projectRoot });
    lines.push(
      `repo.tracking: ${untrack.status}${untrack.message ? ` (${untrack.message})` : ""}`
    );
  }

  return lines;
}

function buildTicketsGitHealthReasons(opts: {
  readonly health: TicketsGitHealthSummary;
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
  readonly health: TicketsGitHealthSummary;
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
  readonly health: TicketsGitHealthSummary;
  readonly repaired: TicketsRepairSummary;
  readonly pruneLegacyRef: boolean;
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

function parseTicketsSetupArgs(opts: {
  readonly args: readonly string[];
}): TicketsSetupParseResult {
  const state: MutableTicketsSetupArgs = {
    agents: false,
    claude: false,
    all: false,
    global: false,
    check: false,
    remove: false,
    json: false,
  };

  for (const token of opts.args) {
    const applied = applyTicketsSetupToken({ token, state });
    if (!applied.ok) {
      return applied;
    }
  }

  if (state.check && state.remove) {
    return { ok: false, error: "--check and --remove are mutually exclusive." };
  }

  return {
    ok: true,
    value: state,
  };
}

function applyTicketsSetupToken(opts: {
  readonly token: string;
  readonly state: MutableTicketsSetupArgs;
}): TicketsSetupTokenResult {
  if (opts.token === "--agents" || opts.token === "--agents-md") {
    opts.state.agents = true;
    return { ok: true };
  }

  if (opts.token === "--claude" || opts.token === "--claude-md") {
    opts.state.claude = true;
    return { ok: true };
  }

  if (opts.token === "--all") {
    opts.state.all = true;
    return { ok: true };
  }

  if (opts.token === "--global") {
    opts.state.global = true;
    return { ok: true };
  }

  if (opts.token === "--check") {
    opts.state.check = true;
    return { ok: true };
  }

  if (opts.token === "--remove") {
    opts.state.remove = true;
    return { ok: true };
  }

  if (opts.token === "--json") {
    opts.state.json = true;
    return { ok: true };
  }

  if (opts.token === "--help" || opts.token === "help") {
    return {
      ok: false,
      error:
        "Usage: hack x tickets setup [--agents|--claude|--all] [--global] [--check|--remove] [--json]",
    };
  }

  return { ok: false, error: `Unknown option: ${opts.token}` };
}
