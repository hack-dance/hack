import { display } from "../../../ui/display.ts"
import { gumConfirm, isGumAvailable } from "../../../ui/gum.ts"
import { isTty } from "../../../ui/terminal.ts"
import { runTicketsTui } from "../../../tui/tickets-tui.ts"

import { createTicketsStore } from "./store.ts"
import { checkTicketsAgentDocs, removeTicketsAgentDocs, upsertTicketsAgentDocs } from "./agent-docs.ts"
import { createGitTicketsChannel } from "./tickets-git-channel.ts"
import {
  checkTicketsRepoState,
  ensureTicketsGitignore,
  untrackTicketsRepo,
  type TicketsRepoGitignoreFixStatus,
  type TicketsRepoGitignoreStatus,
  type TicketsRepoTrackedStatus,
  type TicketsRepoUntrackStatus
} from "./repo-state.ts"
import { checkTicketsSkill, installTicketsSkill, removeTicketsSkill } from "./tickets-skill.ts"
import { normalizeTicketRef, normalizeTicketRefs } from "./util.ts"

import type { ExtensionCommand, ExtensionCommandContext } from "../types.ts"

let didPromptTicketsGitHealth = false

export const TICKETS_COMMANDS: readonly ExtensionCommand[] = [
  {
    name: "setup",
    summary: "Install tickets integrations (skill + agent docs)",
    scope: "project",
    handler: async ({ ctx, args }) => {
      if (!ctx.project) {
        ctx.logger.error({ message: "No project found. Run inside a repo." })
        return 1
      }

      const parsed = parseTicketsSetupArgs({ args })
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error })
        return 1
      }

      const targets =
        parsed.value.all ? ([
          "agents",
          "claude"
        ] as const)
        : (
            [
              ...(parsed.value.agents ? (["agents"] as const) : []),
              ...(parsed.value.claude ? (["claude"] as const) : [])
            ] as const
          )

      const resolvedTargets = targets.length > 0 ? targets : (["agents", "claude"] as const)

      const scope = parsed.value.global ? "user" : "project"
      const projectRoot = ctx.project.projectRoot

      const action = parsed.value.remove ? "remove" : parsed.value.check ? "check" : "install"
      const repoState = await checkTicketsRepoState({ projectRoot })

      let repoGitignore: {
        status: TicketsRepoGitignoreStatus | TicketsRepoGitignoreFixStatus
        path: string
        message?: string
      } = {
        status: repoState.gitignore.status,
        path: repoState.gitignore.path,
        message: repoState.gitignore.message
      }
      let repoTracking: {
        status: TicketsRepoTrackedStatus | TicketsRepoUntrackStatus
        message?: string
      } = {
        status: repoState.tracked.status,
        message: repoState.tracked.message
      }

      if (action === "install") {
        if (repoState.gitignore.status === "missing") {
          repoGitignore = await ensureTicketsGitignore({ projectRoot })
        } else if (repoState.gitignore.status === "present") {
          repoGitignore = { status: "noop", path: repoState.gitignore.path }
        }

        if (repoState.tracked.status === "tracked") {
          const canPrompt = isTty() && isGumAvailable() && !parsed.value.json
          if (canPrompt) {
            const confirmed = await gumConfirm({
              prompt: "Untrack .hack/tickets from the main branch? (keeps files on disk)",
              default: true
            })
            if (confirmed.ok && confirmed.value) {
              repoTracking = await untrackTicketsRepo({ projectRoot })
            } else {
              repoTracking = { status: "skipped", message: "Skipped untracking .hack/tickets." }
            }
          } else {
            repoTracking = {
              status: "skipped",
              message: "Run: git rm -r --cached .hack/tickets"
            }
          }
        }
      }

      const skill =
        action === "check" ?
          await checkTicketsSkill({ scope, projectRoot: scope === "project" ? projectRoot : undefined })
        : action === "remove" ?
          await removeTicketsSkill({ scope, projectRoot: scope === "project" ? projectRoot : undefined })
        : await installTicketsSkill({ scope, projectRoot: scope === "project" ? projectRoot : undefined })

      const docs =
        action === "check" ?
          await checkTicketsAgentDocs({ projectRoot, targets: resolvedTargets })
        : action === "remove" ?
          await removeTicketsAgentDocs({ projectRoot, targets: resolvedTargets })
        : await upsertTicketsAgentDocs({ projectRoot, targets: resolvedTargets })

      if (parsed.value.json) {
        process.stdout.write(
          `${JSON.stringify({ skill, docs, repo: { gitignore: repoGitignore, tracking: repoTracking } }, null, 2)}\n`
        )
        return 0
      }

      await display.panel({
        title: "Tickets setup",
        tone: "success",
        lines: [
          `skill: ${skill.status} (${skill.path})`,
          ...docs.map(r => `${r.target}: ${r.status} (${r.path})`),
          `repo.gitignore: ${repoGitignore.status} (${repoGitignore.path})`,
          `repo.tracking: ${repoTracking.status}${
            repoTracking.message ? ` (${repoTracking.message})` : ""
          }`
        ]
      })

      if (action === "install") {
        await maybeEnsureTicketsGitHealth({ ctx, json: parsed.value.json })
      }

      return docs.some(r => r.status === "error") || skill.status === "error" ? 1 : 0
    }
  },
  {
    name: "create",
    summary: "Create a new ticket",
    scope: "project",
    handler: async ({ ctx, args }) => {
      if (!ctx.project) {
        ctx.logger.error({ message: "No project found. Run inside a repo." })
        return 1
      }

      const parsed = parseTicketsArgs({ args })
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error })
        return 1
      }

      const title = (parsed.value.title ?? "").trim()
      if (!title) {
        ctx.logger.error({ message: "Usage: hack x tickets create --title \"...\"" })
        return 1
      }

      await maybeEnsureTicketsSetup({ ctx, json: parsed.value.json })

      const store = await createTicketsStore({
        projectRoot: ctx.project.projectRoot,
        projectId: ctx.projectId,
        projectName: ctx.projectName,
        controlPlaneConfig: ctx.controlPlaneConfig,
        logger: ctx.logger
      })

      const body = await resolveTicketBody({
        body: parsed.value.body,
        bodyFile: parsed.value.bodyFile,
        bodyStdin: parsed.value.bodyStdin
      })

      const dependsOnResult = resolveTicketRefs({
        values: parsed.value.dependsOn,
        label: "--depends-on"
      })
      if (!dependsOnResult.ok) {
        ctx.logger.error({ message: dependsOnResult.error })
        return 1
      }

      const blocksResult = resolveTicketRefs({
        values: parsed.value.blocks,
        label: "--blocks"
      })
      if (!blocksResult.ok) {
        ctx.logger.error({ message: blocksResult.error })
        return 1
      }

      const created = await store.createTicket({
        title,
        body,
        ...(dependsOnResult.refs.length > 0 ? { dependsOn: dependsOnResult.refs } : {}),
        ...(blocksResult.refs.length > 0 ? { blocks: blocksResult.refs } : {}),
        actor: parsed.value.actor
      })

      if (!created.ok) {
        ctx.logger.error({ message: created.error })
        return 1
      }

      if (parsed.value.json) {
        process.stdout.write(`${JSON.stringify({ ticket: created.ticket }, null, 2)}\n`)
        return 0
      }

      await display.kv({
        title: "Ticket created",
        entries: [
          ["ticket_id", created.ticket.ticketId],
          ["title", created.ticket.title],
          ["status", created.ticket.status],
          ["created_at", created.ticket.createdAt],
          ["updated_at", created.ticket.updatedAt]
        ]
      })
      return 0
    }
  },
  {
    name: "update",
    summary: "Update a ticket",
    scope: "project",
    handler: async ({ ctx, args }) => {
      if (!ctx.project) {
        ctx.logger.error({ message: "No project found. Run inside a repo." })
        return 1
      }

      const parsed = parseTicketsArgs({ args })
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error })
        return 1
      }

      const ticketId = (parsed.value.rest[0] ?? "").trim()
      if (!ticketId) {
        ctx.logger.error({
          message:
            "Usage: hack x tickets update <ticket-id> [--title \"...\"] [--body \"...\"] [--body-file <path>] [--body-stdin] [--depends-on \"...\"] [--blocks \"...\"] [--clear-depends-on] [--clear-blocks] [--json]"
        })
        return 1
      }

      const title = parsed.value.title?.trim()
      if (parsed.value.title !== undefined && !title) {
        ctx.logger.error({ message: "Title cannot be empty." })
        return 1
      }

      if (parsed.value.clearDependsOn && parsed.value.dependsOn.length > 0) {
        ctx.logger.error({ message: "--clear-depends-on cannot be combined with --depends-on." })
        return 1
      }

      if (parsed.value.clearBlocks && parsed.value.blocks.length > 0) {
        ctx.logger.error({ message: "--clear-blocks cannot be combined with --blocks." })
        return 1
      }

      const bodyRequested =
        parsed.value.body !== undefined ||
        parsed.value.bodyFile !== undefined ||
        parsed.value.bodyStdin

      const body = bodyRequested ?
          await resolveTicketBody({
            body: parsed.value.body,
            bodyFile: parsed.value.bodyFile,
            bodyStdin: parsed.value.bodyStdin,
            allowEmpty: true
          })
        : undefined

      const dependsOnResult = parsed.value.dependsOn.length > 0 ?
          resolveTicketRefs({ values: parsed.value.dependsOn, label: "--depends-on" })
        : { ok: true as const, refs: [] }

      if (!dependsOnResult.ok) {
        ctx.logger.error({ message: dependsOnResult.error })
        return 1
      }

      const blocksResult = parsed.value.blocks.length > 0 ?
          resolveTicketRefs({ values: parsed.value.blocks, label: "--blocks" })
        : { ok: true as const, refs: [] }

      if (!blocksResult.ok) {
        ctx.logger.error({ message: blocksResult.error })
        return 1
      }

      const dependsOn = parsed.value.clearDependsOn ?
          []
        : parsed.value.dependsOn.length > 0 ?
          dependsOnResult.refs
        : undefined

      const blocks = parsed.value.clearBlocks ?
          []
        : parsed.value.blocks.length > 0 ?
          blocksResult.refs
        : undefined

      const hasUpdates =
        title !== undefined ||
        bodyRequested ||
        dependsOn !== undefined ||
        blocks !== undefined

      if (!hasUpdates) {
        ctx.logger.error({ message: "No updates provided." })
        return 1
      }

      await maybeEnsureTicketsSetup({ ctx, json: parsed.value.json })

      const store = await createTicketsStore({
        projectRoot: ctx.project.projectRoot,
        projectId: ctx.projectId,
        projectName: ctx.projectName,
        controlPlaneConfig: ctx.controlPlaneConfig,
        logger: ctx.logger
      })

      const updated = await store.updateTicket({
        ticketId,
        ...(title !== undefined ? { title } : {}),
        ...(bodyRequested ? { body } : {}),
        ...(dependsOn !== undefined ? { dependsOn } : {}),
        ...(blocks !== undefined ? { blocks } : {}),
        actor: parsed.value.actor
      })

      if (!updated.ok) {
        ctx.logger.error({ message: updated.error })
        return 1
      }

      if (parsed.value.json) {
        process.stdout.write(`${JSON.stringify({ ok: true, ticketId }, null, 2)}\n`)
        return 0
      }

      await display.panel({
        title: "Ticket updated",
        tone: "success",
        lines: [`${ticketId} updated`]
      })

      return 0
    }
  },
  {
    name: "list",
    summary: "List tickets",
    scope: "project",
    handler: async ({ ctx, args }) => {
      if (!ctx.project) {
        ctx.logger.error({ message: "No project found. Run inside a repo." })
        return 1
      }

      const parsed = parseTicketsArgs({ args })
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error })
        return 1
      }

      await maybeEnsureTicketsSetup({ ctx, json: parsed.value.json })

      const store = await createTicketsStore({
        projectRoot: ctx.project.projectRoot,
        projectId: ctx.projectId,
        projectName: ctx.projectName,
        controlPlaneConfig: ctx.controlPlaneConfig,
        logger: ctx.logger
      })

      const tickets = await store.listTickets()

      if (parsed.value.json) {
        process.stdout.write(`${JSON.stringify({ tickets }, null, 2)}\n`)
        return 0
      }

      if (tickets.length === 0) {
        await display.panel({
          title: "Tickets",
          tone: "info",
          lines: ["No tickets found."]
        })
        return 0
      }

      await display.table({
        columns: ["Id", "Title", "Status", "Updated"],
        rows: tickets.map(ticket => [ticket.ticketId, ticket.title, ticket.status, ticket.updatedAt])
      })
      return 0
    }
  },
  {
    name: "tui",
    summary: "Open tickets TUI",
    scope: "project",
    handler: async ({ ctx, args }) => {
      if (!ctx.project) {
        ctx.logger.error({ message: "No project found. Run inside a repo." })
        return 1
      }

      if (args.length > 0) {
        ctx.logger.error({ message: "Usage: hack x tickets tui" })
        return 1
      }

      await maybeEnsureTicketsSetup({ ctx, json: false })

      return await runTicketsTui({
        projectRoot: ctx.project.projectRoot,
        projectId: ctx.projectId,
        projectName: ctx.projectName,
        controlPlaneConfig: ctx.controlPlaneConfig,
        logger: ctx.logger
      })
    }
  },
  {
    name: "show",
    summary: "Show a ticket",
    scope: "project",
    handler: async ({ ctx, args }) => {
      if (!ctx.project) {
        ctx.logger.error({ message: "No project found. Run inside a repo." })
        return 1
      }

      const parsed = parseTicketsArgs({ args })
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error })
        return 1
      }

      const ticketId = (parsed.value.rest[0] ?? "").trim()
      if (!ticketId) {
        ctx.logger.error({ message: "Usage: hack x tickets show <ticket-id>" })
        return 1
      }

      await maybeEnsureTicketsSetup({ ctx, json: parsed.value.json })

      const store = await createTicketsStore({
        projectRoot: ctx.project.projectRoot,
        projectId: ctx.projectId,
        projectName: ctx.projectName,
        controlPlaneConfig: ctx.controlPlaneConfig,
        logger: ctx.logger
      })

      const ticket = await store.getTicket({ ticketId })
      if (!ticket) {
        ctx.logger.error({ message: `Ticket not found: ${ticketId}` })
        return 1
      }

      const events = await store.listEvents({ ticketId })

      if (parsed.value.json) {
        process.stdout.write(`${JSON.stringify({ ticket, events }, null, 2)}\n`)
        return 0
      }

      await display.kv({
        title: `Ticket ${ticket.ticketId}`,
        entries: [
          ["title", ticket.title],
          ["status", ticket.status],
          ["depends_on", ticket.dependsOn.join(", ")],
          ["blocks", ticket.blocks.join(", ")],
          ["created_at", ticket.createdAt],
          ["updated_at", ticket.updatedAt],
          ["project_id", ticket.projectId ?? ""],
          ["project_name", ticket.projectName ?? ""]
        ]
      })

      if (ticket.body) {
        await display.panel({
          title: "Body",
          tone: "info",
          lines: ticket.body.split("\n")
        })
      }

      await display.table({
        columns: ["ts", "type", "event_id"],
        rows: events.map(event => [event.tsIso, event.type, event.eventId])
      })
      return 0
    }
  },
  {
    name: "status",
    summary: "Change ticket status",
    scope: "project",
    handler: async ({ ctx, args }) => {
      if (!ctx.project) {
        ctx.logger.error({ message: "No project found. Run inside a repo." })
        return 1
      }

      const parsed = parseTicketsArgs({ args })
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error })
        return 1
      }

      const ticketId = (parsed.value.rest[0] ?? "").trim()
      const status = (parsed.value.rest[1] ?? "").trim()
      if (!ticketId || !status) {
        ctx.logger.error({ message: "Usage: hack x tickets status <ticket-id> <open|in_progress|blocked|done>" })
        return 1
      }

      if (status !== "open" && status !== "in_progress" && status !== "blocked" && status !== "done") {
        ctx.logger.error({ message: `Invalid status: ${status}` })
        return 1
      }

      await maybeEnsureTicketsSetup({ ctx, json: parsed.value.json })

      const store = await createTicketsStore({
        projectRoot: ctx.project.projectRoot,
        projectId: ctx.projectId,
        projectName: ctx.projectName,
        controlPlaneConfig: ctx.controlPlaneConfig,
        logger: ctx.logger
      })

      const updated = await store.setStatus({
        ticketId,
        status,
        actor: parsed.value.actor
      })

      if (!updated.ok) {
        ctx.logger.error({ message: updated.error })
        return 1
      }

      if (parsed.value.json) {
        process.stdout.write(`${JSON.stringify({ ok: true, ticketId, status }, null, 2)}\n`)
        return 0
      }

      await display.panel({
        title: "Ticket status",
        tone: "success",
        lines: [`${ticketId} → ${status}`]
      })

      return 0
    }
  },
  {
    name: "sync",
    summary: "Sync ticket events with git remote",
    scope: "project",
    handler: async ({ ctx, args }) => {
      if (!ctx.project) {
        ctx.logger.error({ message: "No project found. Run inside a repo." })
        return 1
      }

      const parsed = parseTicketsArgs({ args })
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error })
        return 1
      }

      await maybeEnsureTicketsSetup({ ctx, json: parsed.value.json })

      const store = await createTicketsStore({
        projectRoot: ctx.project.projectRoot,
        projectId: ctx.projectId,
        projectName: ctx.projectName,
        controlPlaneConfig: ctx.controlPlaneConfig,
        logger: ctx.logger
      })

      const synced = await store.sync()
      if (!synced.ok) {
        ctx.logger.error({ message: synced.error })
        return 1
      }

      if (parsed.value.json) {
        process.stdout.write(`${JSON.stringify({ sync: synced }, null, 2)}\n`)
        return 0
      }

      await display.panel({
        title: "Tickets sync",
        tone: "success",
        lines: [
          `branch: ${synced.branch}`,
          `remote: ${synced.remote ?? "(none)"}`,
          `committed: ${synced.didCommit ? "yes" : "no"}`,
          `pushed: ${synced.didPush ? "yes" : "no"}`
        ]
      })
      return 0
    }
  }
]

type TicketsArgs = {
  readonly title?: string
  readonly body?: string
  readonly bodyFile?: string
  readonly bodyStdin: boolean
  readonly dependsOn: readonly string[]
  readonly blocks: readonly string[]
  readonly clearDependsOn: boolean
  readonly clearBlocks: boolean
  readonly actor?: string
  readonly json: boolean
  readonly rest: readonly string[]
}

type TicketsParseResult =
  | { readonly ok: true; readonly value: TicketsArgs }
  | { readonly ok: false; readonly error: string }

type TicketsSetupArgs = {
  readonly agents: boolean
  readonly claude: boolean
  readonly all: boolean
  readonly global: boolean
  readonly check: boolean
  readonly remove: boolean
  readonly json: boolean
}

type TicketsSetupParseResult =
  | { readonly ok: true; readonly value: TicketsSetupArgs }
  | { readonly ok: false; readonly error: string }

function parseTicketsArgs(opts: { readonly args: readonly string[] }): TicketsParseResult {
  const rest: string[] = []
  let title: string | undefined
  let body: string | undefined
  let bodyFile: string | undefined
  let bodyStdin = false
  const dependsOn: string[] = []
  const blocks: string[] = []
  let clearDependsOn = false
  let clearBlocks = false
  let actor: string | undefined
  let json = false

  const takeValue = (_flag: string, value: string | undefined): string | null => {
    if (!value || value.startsWith("-")) return null
    return value
  }

  for (let i = 0; i < opts.args.length; i += 1) {
    const token = opts.args[i] ?? ""

    if (token === "--") {
      rest.push(...opts.args.slice(i + 1))
      break
    }

    if (token === "--json") {
      json = true
      continue
    }

    if (token.startsWith("--title=")) {
      title = token.slice("--title=".length)
      continue
    }

    if (token === "--title") {
      const value = takeValue(token, opts.args[i + 1])
      if (!value) return { ok: false, error: "--title requires a value." }
      title = value
      i += 1
      continue
    }

    if (token.startsWith("--body=")) {
      body = token.slice("--body=".length)
      continue
    }

    if (token === "--body") {
      const value = takeValue(token, opts.args[i + 1])
      if (!value) return { ok: false, error: "--body requires a value." }
      body = value
      i += 1
      continue
    }

    if (token.startsWith("--body-file=")) {
      bodyFile = token.slice("--body-file=".length)
      continue
    }

    if (token === "--body-file") {
      const value = takeValue(token, opts.args[i + 1])
      if (!value) return { ok: false, error: "--body-file requires a value." }
      bodyFile = value
      i += 1
      continue
    }

    if (token === "--body-stdin") {
      bodyStdin = true
      continue
    }

    if (token === "--clear-depends-on") {
      clearDependsOn = true
      continue
    }

    if (token === "--clear-blocks") {
      clearBlocks = true
      continue
    }

    if (token.startsWith("--depends-on=")) {
      dependsOn.push(...splitTicketRefs(token.slice("--depends-on=".length)))
      continue
    }

    if (token === "--depends-on") {
      const value = takeValue(token, opts.args[i + 1])
      if (!value) return { ok: false, error: "--depends-on requires a value." }
      dependsOn.push(...splitTicketRefs(value))
      i += 1
      continue
    }

    if (token.startsWith("--blocks=")) {
      blocks.push(...splitTicketRefs(token.slice("--blocks=".length)))
      continue
    }

    if (token === "--blocks") {
      const value = takeValue(token, opts.args[i + 1])
      if (!value) return { ok: false, error: "--blocks requires a value." }
      blocks.push(...splitTicketRefs(value))
      i += 1
      continue
    }

    if (token.startsWith("--actor=")) {
      actor = token.slice("--actor=".length)
      continue
    }

    if (token === "--actor") {
      const value = takeValue(token, opts.args[i + 1])
      if (!value) return { ok: false, error: "--actor requires a value." }
      actor = value
      i += 1
      continue
    }

    if (token.startsWith("-")) {
      return { ok: false, error: `Unknown option: ${token}` }
    }

    rest.push(token)
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
      ...(actor ? { actor } : {}),
      json,
      rest
    }
  }
}

async function resolveTicketBody(opts: {
  readonly body?: string
  readonly bodyFile?: string
  readonly bodyStdin: boolean
  readonly allowEmpty?: boolean
}): Promise<string | undefined> {
  const allowEmpty = opts.allowEmpty ?? false
  if (opts.bodyStdin) {
    const text = await Bun.stdin.text()
    const trimmed = text.trimEnd()
    if (trimmed.length > 0) return trimmed
    return allowEmpty ? "" : undefined
  }

  const bodyFile = (opts.bodyFile ?? "").trim()
  if (bodyFile.length > 0) {
    const text = await Bun.file(bodyFile).text()
    const trimmed = text.trimEnd()
    if (trimmed.length > 0) return trimmed
    return allowEmpty ? "" : undefined
  }

  const body = (opts.body ?? "").trimEnd()
  if (body.length > 0) return body
  return allowEmpty ? "" : undefined
}

function splitTicketRefs(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map(part => part.trim())
    .filter(part => part.length > 0)
}

function resolveTicketRefs(opts: {
  readonly values: readonly string[]
  readonly label: string
}):
  | { readonly ok: true; readonly refs: string[] }
  | { readonly ok: false; readonly error: string } {
  if (opts.values.length === 0) {
    return { ok: true, refs: [] }
  }

  const invalid: string[] = []
  const normalized: string[] = []
  for (const value of opts.values) {
    const parsed = normalizeTicketRef(value)
    if (!parsed) {
      invalid.push(value)
    } else {
      normalized.push(parsed)
    }
  }

  if (invalid.length > 0) {
    return {
      ok: false,
      error: `Invalid ${opts.label} ticket(s): ${invalid.join(", ")}`
    }
  }

  return { ok: true, refs: normalizeTicketRefs(normalized) }
}

async function maybeEnsureTicketsSetup(opts: {
  readonly ctx: ExtensionCommandContext
  readonly json: boolean
}): Promise<void> {
  if (!opts.ctx.project) return
  if (opts.json) return

  const projectRoot = opts.ctx.project.projectRoot
  const repoState = await checkTicketsRepoState({ projectRoot })

  const skill = await checkTicketsSkill({ scope: "project", projectRoot })
  const docs = await checkTicketsAgentDocs({
    projectRoot,
    targets: ["agents", "claude"]
  })

  const needsGitignore = repoState.gitignore.status === "missing"
  const needsUntrack = repoState.tracked.status === "tracked"
  const needsSkill = skill.status === "missing" || skill.status === "error"
  const needsDocs = docs.some(doc => doc.status === "missing" || doc.status === "error")

  if (!(needsGitignore || needsUntrack || needsSkill || needsDocs)) return

  if (!isTty() || !isGumAvailable()) {
    const notices: string[] = []
    if (needsGitignore) {
      notices.push("add .hack/tickets/ to .gitignore")
    }
    if (needsUntrack) {
      notices.push("untrack .hack/tickets from main branch")
    }
    if (needsSkill || needsDocs) {
      notices.push("run tickets setup")
    }
    if (notices.length > 0) {
      opts.ctx.logger.warn({ message: `Tickets setup incomplete: ${notices.join("; ")}.` })
    }
    return
  }

  const confirmed = await gumConfirm({
    prompt: "Tickets setup is incomplete. Fix now?",
    default: true
  })
  if (!confirmed.ok || !confirmed.value) return

  const lines: string[] = []

  if (needsGitignore) {
    const gitignore = await ensureTicketsGitignore({ projectRoot })
    lines.push(`repo.gitignore: ${gitignore.status} (${gitignore.path})`)
  }

  if (needsUntrack) {
    const untrack = await untrackTicketsRepo({ projectRoot })
    lines.push(`repo.tracking: ${untrack.status}${untrack.message ? ` (${untrack.message})` : ""}`)
  }

  if (needsSkill) {
    const installed = await installTicketsSkill({ scope: "project", projectRoot })
    lines.push(`skill: ${installed.status} (${installed.path})`)
  }

  if (needsDocs) {
    const updatedDocs = await upsertTicketsAgentDocs({
      projectRoot,
      targets: ["agents", "claude"]
    })
    lines.push(...updatedDocs.map(doc => `${doc.target}: ${doc.status} (${doc.path})`))
  }

  if (lines.length > 0) {
    await display.panel({
      title: "Tickets setup",
      tone: "success",
      lines
    })
  }

  await maybeEnsureTicketsGitHealth({ ctx: opts.ctx, json: opts.json })
}

async function maybeEnsureTicketsGitHealth(opts: {
  readonly ctx: ExtensionCommandContext
  readonly json: boolean
}): Promise<void> {
  if (!opts.ctx.project) return
  if (opts.json) return
  if (didPromptTicketsGitHealth) return
  didPromptTicketsGitHealth = true

  const gitConfig = opts.ctx.controlPlaneConfig.tickets.git
  if (!gitConfig.enabled) return

  const projectRoot = opts.ctx.project.projectRoot
  const channel = await createGitTicketsChannel({
    projectRoot,
    config: gitConfig,
    logger: opts.ctx.logger
  })

  const inspected = await channel.inspect()
  if (!inspected.ok) {
    opts.ctx.logger.warn({ message: `Tickets git health check failed: ${inspected.error}` })
    return
  }

  const health = inspected.health
  if (!health.hasLegacyRef && !health.hasNonTicketFiles) return

  const reasons: string[] = []
  if (health.hasLegacyRef && health.legacyRef) {
    reasons.push(`legacy ref ${health.legacyRef}`)
  }
  if (health.hasNonTicketFiles) {
    reasons.push("non-ticket files in tickets ref")
  }

  if (!isTty() || !isGumAvailable()) {
    opts.ctx.logger.warn({
      message: `Tickets git storage needs repair (${reasons.join("; ")}). Run: hack x tickets setup`
    })
    return
  }

  const confirmed = await gumConfirm({
    prompt: "Tickets git storage needs repair. Fix now?",
    default: true
  })
  if (!confirmed.ok || !confirmed.value) return

  let pruneLegacyRef = false
  if (health.hasLegacyRef && health.legacyRef) {
    const prune = await gumConfirm({
      prompt: `Remove legacy ref ${health.legacyRef} from the remote?`,
      default: true
    })
    pruneLegacyRef = prune.ok && prune.value
  }

  const repaired = await channel.repair({ pruneLegacyRef })
  if (!repaired.ok) {
    await display.panel({
      title: "Tickets repair",
      tone: "warn",
      lines: [`error: ${repaired.error}`]
    })
    return
  }

  const lines: string[] = []
  if (health.hasNonTicketFiles) {
    const sample = health.nonTicketPaths.slice(0, 5)
    const extra = health.nonTicketPaths.length - sample.length
    lines.push(`non-ticket files: ${health.nonTicketPaths.length}`)
    if (sample.length > 0) {
      lines.push(`sample: ${sample.join(", ")}${extra > 0 ? ` (+${extra} more)` : ""}`)
    }
  }
  if (health.hasLegacyRef && health.legacyRef) {
    lines.push(`legacy ref: ${health.legacyRef} ${pruneLegacyRef ? "pruned" : "left intact"}`)
  }
  lines.push(`commit: ${repaired.didCommit ? "created" : "noop"}`)
  lines.push(`push: ${repaired.didPush ? "pushed" : "skipped"}`)
  if (repaired.pruneError) {
    lines.push(`legacy prune error: ${repaired.pruneError}`)
  }

  await display.panel({
    title: "Tickets repair",
    tone: repaired.pruneError ? "warn" : "success",
    lines
  })
}

function parseTicketsSetupArgs(opts: { readonly args: readonly string[] }): TicketsSetupParseResult {
  let agents = false
  let claude = false
  let all = false
  let global = false
  let check = false
  let remove = false
  let json = false

  for (const token of opts.args) {
    if (token === "--agents" || token === "--agents-md") {
      agents = true
      continue
    }

    if (token === "--claude" || token === "--claude-md") {
      claude = true
      continue
    }

    if (token === "--all") {
      all = true
      continue
    }

    if (token === "--global") {
      global = true
      continue
    }

    if (token === "--check") {
      check = true
      continue
    }

    if (token === "--remove") {
      remove = true
      continue
    }

    if (token === "--json") {
      json = true
      continue
    }

    if (token === "--help" || token === "help") {
      return {
        ok: false,
        error:
          "Usage: hack x tickets setup [--agents|--claude|--all] [--global] [--check|--remove] [--json]"
      }
    }

    return { ok: false, error: `Unknown option: ${token}` }
  }

  if (check && remove) {
    return { ok: false, error: "--check and --remove are mutually exclusive." }
  }

  return { ok: true, value: { agents, claude, all, global, check, remove, json } }
}
