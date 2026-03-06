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
import { createGitTicketsChannel } from "./tickets-git-channel.ts";
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
    handler: async ({ ctx, args }) => {
      if (!ctx.project) {
        ctx.logger.error({ message: "No project found. Run inside a repo." });
        return 1;
      }

      // Enable the extension in project config if not already enabled
      await ensureTicketsExtensionEnabled({
        projectDir: ctx.project.projectDir,
        logger: ctx.logger,
      });

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

      let skill: Awaited<ReturnType<typeof checkTicketsSkill>>;
      const skillProjectRoot = scope === "project" ? projectRoot : undefined;
      if (action === "check") {
        skill = await checkTicketsSkill({
          scope,
          projectRoot: skillProjectRoot,
        });
      } else if (action === "remove") {
        skill = await removeTicketsSkill({
          scope,
          projectRoot: skillProjectRoot,
        });
      } else {
        skill = await installTicketsSkill({
          scope,
          projectRoot: skillProjectRoot,
        });
      }

      let docs:
        | TicketsAgentDocCheckResult[]
        | TicketsAgentDocRemoveResult[]
        | TicketsAgentDocUpdateResult[];
      if (action === "check") {
        docs = await checkTicketsAgentDocs({
          projectRoot,
          targets: resolvedTargets,
        });
      } else if (action === "remove") {
        docs = await removeTicketsAgentDocs({
          projectRoot,
          targets: resolvedTargets,
        });
      } else {
        docs = await upsertTicketsAgentDocs({
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
        title: "Tickets setup",
        tone: "success",
        lines: [
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

      return docs.some((r) => r.status === "error") || skill.status === "error"
        ? 1
        : 0;
    },
  },
  {
    name: "create",
    summary: "Create a new ticket",
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
        ctx.logger.error({ message: "Usage: hack x tickets show <ticket-id>" });
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

      const detail = await store.getTicketDetail({ ticketId });
      const ticket = detail.ticket;
      if (!ticket) {
        ctx.logger.error({ message: `Ticket not found: ${ticketId}` });
        return 1;
      }

      if (parsed.value.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              ticket,
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
          columns: [
            "checkpoint_id",
            "provider",
            "profile",
            "direction",
            "cursor",
          ],
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

function parseTicketsArgs(opts: {
  readonly args: readonly string[];
}): TicketsParseResult {
  const rest: string[] = [];
  let title: string | undefined;
  let body: string | undefined;
  let bodyFile: string | undefined;
  let bodyStdin = false;
  const dependsOn: string[] = [];
  const blocks: string[] = [];
  let clearDependsOn = false;
  let clearBlocks = false;
  let owner: string | undefined;
  let source: string | undefined;
  let assignee: string | undefined;
  let clearAssignee = false;
  const tags: string[] = [];
  let clearTags = false;
  let externalSystem: string | undefined;
  let externalId: string | undefined;
  let externalKey: string | undefined;
  let externalUrl: string | undefined;
  let externalProjectId: string | undefined;
  let externalProjectName: string | undefined;
  let externalTeamId: string | undefined;
  let actor: string | undefined;
  let json = false;

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

    if (token.startsWith("--title=")) {
      title = token.slice("--title=".length);
      continue;
    }

    if (token === "--title") {
      const value = takeValue(token, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--title requires a value." };
      }
      title = value;
      i += 1;
      continue;
    }

    if (token.startsWith("--body=")) {
      body = token.slice("--body=".length);
      continue;
    }

    if (token === "--body") {
      const value = takeValue(token, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--body requires a value." };
      }
      body = value;
      i += 1;
      continue;
    }

    if (token.startsWith("--body-file=")) {
      bodyFile = token.slice("--body-file=".length);
      continue;
    }

    if (token === "--body-file") {
      const value = takeValue(token, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--body-file requires a value." };
      }
      bodyFile = value;
      i += 1;
      continue;
    }

    if (token === "--body-stdin") {
      bodyStdin = true;
      continue;
    }

    if (token === "--clear-depends-on") {
      clearDependsOn = true;
      continue;
    }

    if (token === "--clear-blocks") {
      clearBlocks = true;
      continue;
    }
    if (token === "--clear-tags") {
      clearTags = true;
      continue;
    }
    if (token === "--clear-assignee") {
      clearAssignee = true;
      continue;
    }

    if (token.startsWith("--depends-on=")) {
      dependsOn.push(...splitTicketRefs(token.slice("--depends-on=".length)));
      continue;
    }

    if (token === "--depends-on") {
      const value = takeValue(token, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--depends-on requires a value." };
      }
      dependsOn.push(...splitTicketRefs(value));
      i += 1;
      continue;
    }

    if (token.startsWith("--blocks=")) {
      blocks.push(...splitTicketRefs(token.slice("--blocks=".length)));
      continue;
    }

    if (token === "--blocks") {
      const value = takeValue(token, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--blocks requires a value." };
      }
      blocks.push(...splitTicketRefs(value));
      i += 1;
      continue;
    }

    if (token.startsWith("--actor=")) {
      actor = token.slice("--actor=".length);
      continue;
    }

    if (token.startsWith("--owner=")) {
      owner = token.slice("--owner=".length);
      continue;
    }
    if (token === "--owner") {
      const value = takeValue(token, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--owner requires a value." };
      }
      owner = value;
      i += 1;
      continue;
    }
    if (token.startsWith("--source=")) {
      source = token.slice("--source=".length);
      continue;
    }
    if (token === "--source") {
      const value = takeValue(token, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--source requires a value." };
      }
      source = value;
      i += 1;
      continue;
    }
    if (token.startsWith("--assignee=")) {
      assignee = token.slice("--assignee=".length);
      continue;
    }
    if (token === "--assignee") {
      const value = takeValue(token, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--assignee requires a value." };
      }
      assignee = value;
      i += 1;
      continue;
    }
    if (token.startsWith("--tags=")) {
      tags.push(...splitTags(token.slice("--tags=".length)));
      continue;
    }
    if (token === "--tags") {
      const value = takeValue(token, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--tags requires a value." };
      }
      tags.push(...splitTags(value));
      i += 1;
      continue;
    }
    if (token.startsWith("--tag=")) {
      tags.push(token.slice("--tag=".length));
      continue;
    }
    if (token === "--tag") {
      const value = takeValue(token, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--tag requires a value." };
      }
      tags.push(value);
      i += 1;
      continue;
    }
    if (token.startsWith("--external-system=")) {
      externalSystem = token.slice("--external-system=".length);
      continue;
    }
    if (token === "--external-system") {
      const value = takeValue(token, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--external-system requires a value." };
      }
      externalSystem = value;
      i += 1;
      continue;
    }
    if (token.startsWith("--external-id=")) {
      externalId = token.slice("--external-id=".length);
      continue;
    }
    if (token === "--external-id") {
      const value = takeValue(token, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--external-id requires a value." };
      }
      externalId = value;
      i += 1;
      continue;
    }
    if (token.startsWith("--external-key=")) {
      externalKey = token.slice("--external-key=".length);
      continue;
    }
    if (token === "--external-key") {
      const value = takeValue(token, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--external-key requires a value." };
      }
      externalKey = value;
      i += 1;
      continue;
    }
    if (token.startsWith("--external-url=")) {
      externalUrl = token.slice("--external-url=".length);
      continue;
    }
    if (token === "--external-url") {
      const value = takeValue(token, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--external-url requires a value." };
      }
      externalUrl = value;
      i += 1;
      continue;
    }
    if (token.startsWith("--external-project-id=")) {
      externalProjectId = token.slice("--external-project-id=".length);
      continue;
    }
    if (token === "--external-project-id") {
      const value = takeValue(token, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--external-project-id requires a value." };
      }
      externalProjectId = value;
      i += 1;
      continue;
    }
    if (token.startsWith("--external-project-name=")) {
      externalProjectName = token.slice("--external-project-name=".length);
      continue;
    }
    if (token === "--external-project-name") {
      const value = takeValue(token, opts.args[i + 1]);
      if (!value) {
        return {
          ok: false,
          error: "--external-project-name requires a value.",
        };
      }
      externalProjectName = value;
      i += 1;
      continue;
    }
    if (token.startsWith("--external-team-id=")) {
      externalTeamId = token.slice("--external-team-id=".length);
      continue;
    }
    if (token === "--external-team-id") {
      const value = takeValue(token, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--external-team-id requires a value." };
      }
      externalTeamId = value;
      i += 1;
      continue;
    }

    if (token === "--actor") {
      const value = takeValue(token, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--actor requires a value." };
      }
      actor = value;
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
      ...(title ? { title } : {}),
      ...(body ? { body } : {}),
      ...(bodyFile ? { bodyFile } : {}),
      bodyStdin,
      dependsOn,
      blocks,
      clearDependsOn,
      clearBlocks,
      ...(owner ? { owner } : {}),
      ...(source ? { source } : {}),
      ...(assignee !== undefined ? { assignee } : {}),
      clearAssignee,
      tags: normalizeTags(tags),
      clearTags,
      ...(externalSystem !== undefined ? { externalSystem } : {}),
      ...(externalId !== undefined ? { externalId } : {}),
      ...(externalKey !== undefined ? { externalKey } : {}),
      ...(externalUrl !== undefined ? { externalUrl } : {}),
      ...(externalProjectId !== undefined ? { externalProjectId } : {}),
      ...(externalProjectName !== undefined ? { externalProjectName } : {}),
      ...(externalTeamId !== undefined ? { externalTeamId } : {}),
      ...(actor ? { actor } : {}),
      json,
      rest,
    },
  };
}

function parseResolveConflictArgs(opts: {
  readonly args: readonly string[];
}):
  | { readonly ok: true; readonly value: ResolveConflictArgs }
  | { readonly ok: false; readonly error: string } {
  const rest: string[] = [];
  let conflictId: string | undefined;
  let resolution: TicketSyncConflictResolution | undefined;
  let summary: string | undefined;
  let actor: string | undefined;
  let json = false;

  const takeValue = (value: string | undefined): string | null => {
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
    if (token.startsWith("--conflict-id=")) {
      conflictId = token.slice("--conflict-id=".length);
      continue;
    }
    if (token === "--conflict-id") {
      const value = takeValue(opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--conflict-id requires a value." };
      }
      conflictId = value;
      i += 1;
      continue;
    }
    if (token.startsWith("--resolution=")) {
      const parsedResolution = parseConflictResolutionValue({
        value: token.slice("--resolution=".length),
      });
      if (!parsedResolution) {
        return {
          ok: false,
          error:
            "Invalid --resolution value. Expected accept_local|accept_remote|merged|ignore.",
        };
      }
      resolution = parsedResolution;
      continue;
    }
    if (token === "--resolution") {
      const value = takeValue(opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--resolution requires a value." };
      }
      const parsedResolution = parseConflictResolutionValue({ value });
      if (!parsedResolution) {
        return {
          ok: false,
          error:
            "Invalid --resolution value. Expected accept_local|accept_remote|merged|ignore.",
        };
      }
      resolution = parsedResolution;
      i += 1;
      continue;
    }
    if (token.startsWith("--summary=")) {
      summary = token.slice("--summary=".length);
      continue;
    }
    if (token === "--summary") {
      const value = takeValue(opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--summary requires a value." };
      }
      summary = value;
      i += 1;
      continue;
    }
    if (token.startsWith("--actor=")) {
      actor = token.slice("--actor=".length);
      continue;
    }
    if (token === "--actor") {
      const value = takeValue(opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--actor requires a value." };
      }
      actor = value;
      i += 1;
      continue;
    }
    if (token.startsWith("-")) {
      return { ok: false, error: `Unknown option: ${token}` };
    }
    rest.push(token);
  }

  if (!conflictId) {
    return { ok: false, error: "Missing --conflict-id <ID>." };
  }
  if (!resolution) {
    return {
      ok: false,
      error: "Missing --resolution <accept_local|accept_remote|merged|ignore>.",
    };
  }

  return {
    ok: true,
    value: {
      conflictId,
      resolution,
      ...(summary !== undefined ? { summary } : {}),
      ...(actor ? { actor } : {}),
      json,
      rest,
    },
  };
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

  if (!(needsGitignore || needsUntrack || needsSkill || needsDocs)) {
    return;
  }

  if (!(isTty() && isGumAvailable())) {
    const notices: string[] = [];
    if (needsGitignore) {
      notices.push("add .hack/tickets/ to .gitignore");
    }
    if (needsUntrack) {
      notices.push("untrack .hack/tickets from main branch");
    }
    if (needsSkill || needsDocs) {
      notices.push("run tickets setup");
    }
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

  const lines: string[] = [];

  if (needsGitignore) {
    const gitignore = await ensureTicketsGitignore({ projectRoot });
    lines.push(`repo.gitignore: ${gitignore.status} (${gitignore.path})`);
  }

  if (needsUntrack) {
    const untrack = await untrackTicketsRepo({ projectRoot });
    lines.push(
      `repo.tracking: ${untrack.status}${untrack.message ? ` (${untrack.message})` : ""}`
    );
  }

  if (needsSkill) {
    const installed = await installTicketsSkill({
      scope: "project",
      projectRoot,
    });
    lines.push(`skill: ${installed.status} (${installed.path})`);
  }

  if (needsDocs) {
    const updatedDocs = await upsertTicketsAgentDocs({
      projectRoot,
      targets: ["agents", "claude"],
    });
    lines.push(
      ...updatedDocs.map((doc) => `${doc.target}: ${doc.status} (${doc.path})`)
    );
  }

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
  if (!(health.hasLegacyRef || health.hasNonTicketFiles)) {
    return;
  }

  const reasons: string[] = [];
  if (health.hasLegacyRef && health.legacyRef) {
    reasons.push(`legacy ref ${health.legacyRef}`);
  }
  if (health.hasNonTicketFiles) {
    reasons.push("non-ticket files in tickets ref");
  }

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

  let pruneLegacyRef = false;
  if (health.hasLegacyRef && health.legacyRef) {
    const prune = await gumConfirm({
      prompt: `Remove legacy ref ${health.legacyRef} from the remote?`,
      default: true,
    });
    pruneLegacyRef = prune.ok && prune.value;
  }

  const repaired = await channel.repair({ pruneLegacyRef });
  if (!repaired.ok) {
    await display.panel({
      title: "Tickets repair",
      tone: "warn",
      lines: [`error: ${repaired.error}`],
    });
    return;
  }

  const lines: string[] = [];
  if (health.hasNonTicketFiles) {
    const sample = health.nonTicketPaths.slice(0, 5);
    const extra = health.nonTicketPaths.length - sample.length;
    lines.push(`non-ticket files: ${health.nonTicketPaths.length}`);
    if (sample.length > 0) {
      lines.push(
        `sample: ${sample.join(", ")}${extra > 0 ? ` (+${extra} more)` : ""}`
      );
    }
  }
  if (health.hasLegacyRef && health.legacyRef) {
    lines.push(
      `legacy ref: ${health.legacyRef} ${pruneLegacyRef ? "pruned" : "left intact"}`
    );
  }
  lines.push(`commit: ${repaired.didCommit ? "created" : "noop"}`);
  lines.push(`push: ${repaired.didPush ? "pushed" : "skipped"}`);
  if (repaired.pruneError) {
    lines.push(`legacy prune error: ${repaired.pruneError}`);
  }

  await display.panel({
    title: "Tickets repair",
    tone: repaired.pruneError ? "warn" : "success",
    lines,
  });
}

function parseTicketsSetupArgs(opts: {
  readonly args: readonly string[];
}): TicketsSetupParseResult {
  let agents = false;
  let claude = false;
  let all = false;
  let global = false;
  let check = false;
  let remove = false;
  let json = false;

  for (const token of opts.args) {
    if (token === "--agents" || token === "--agents-md") {
      agents = true;
      continue;
    }

    if (token === "--claude" || token === "--claude-md") {
      claude = true;
      continue;
    }

    if (token === "--all") {
      all = true;
      continue;
    }

    if (token === "--global") {
      global = true;
      continue;
    }

    if (token === "--check") {
      check = true;
      continue;
    }

    if (token === "--remove") {
      remove = true;
      continue;
    }

    if (token === "--json") {
      json = true;
      continue;
    }

    if (token === "--help" || token === "help") {
      return {
        ok: false,
        error:
          "Usage: hack x tickets setup [--agents|--claude|--all] [--global] [--check|--remove] [--json]",
      };
    }

    return { ok: false, error: `Unknown option: ${token}` };
  }

  if (check && remove) {
    return { ok: false, error: "--check and --remove are mutually exclusive." };
  }

  return {
    ok: true,
    value: { agents, claude, all, global, check, remove, json },
  };
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
