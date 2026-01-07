import { display } from "../../../ui/display.ts"

import { createTicketsStore } from "./store.ts"
import { checkTicketsAgentDocs, removeTicketsAgentDocs, upsertTicketsAgentDocs } from "./agent-docs.ts"
import { checkTicketsSkill, installTicketsSkill, removeTicketsSkill } from "./tickets-skill.ts"

import type { ExtensionCommand } from "../types.ts"

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
        process.stdout.write(`${JSON.stringify({ skill, docs }, null, 2)}\n`)
        return 0
      }

      await display.panel({
        title: "Tickets setup",
        tone: "success",
        lines: [
          `skill: ${skill.status} (${skill.path})`,
          ...docs.map(r => `${r.target}: ${r.status} (${r.path})`)
        ]
      })

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

      const created = await store.createTicket({
        title,
        body,
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
}): Promise<string | undefined> {
  if (opts.bodyStdin) {
    const text = await Bun.stdin.text()
    const trimmed = text.trimEnd()
    return trimmed.length > 0 ? trimmed : undefined
  }

  const bodyFile = (opts.bodyFile ?? "").trim()
  if (bodyFile.length > 0) {
    const text = await Bun.file(bodyFile).text()
    const trimmed = text.trimEnd()
    return trimmed.length > 0 ? trimmed : undefined
  }

  const body = (opts.body ?? "").trimEnd()
  return body.length > 0 ? body : undefined
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

