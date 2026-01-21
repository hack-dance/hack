import { readdir } from "node:fs/promises"
import { resolve } from "node:path"
import { hostname } from "node:os"
import { randomUUID } from "node:crypto"

import { isRecord } from "../../../lib/guards.ts"

import { createGitTicketsChannel } from "./tickets-git-channel.ts"
import { formatTicketId, normalizeTicketRefs, parseTicketNumber, unixSeconds } from "./util.ts"

import type { ControlPlaneConfig } from "../../sdk/config.ts"

export type TicketStatus = "open" | "in_progress" | "blocked" | "done"

export type TicketSummary = {
  readonly ticketId: string
  readonly title: string
  readonly body?: string
  readonly status: TicketStatus
  readonly createdAt: string
  readonly updatedAt: string
  readonly dependsOn: readonly string[]
  readonly blocks: readonly string[]
  readonly projectId?: string
  readonly projectName?: string
}

export type TicketEvent = {
  readonly eventId: string
  readonly ts: number
  readonly tsIso: string
  readonly actor: string
  readonly projectId?: string
  readonly projectName?: string
  readonly ticketId: string
  readonly type: string
  readonly payload: Record<string, unknown>
}

type CreateTicketResult =
  | { readonly ok: true; readonly ticket: TicketSummary }
  | { readonly ok: false; readonly error: string }

type SyncResult =
  | {
      readonly ok: true
      readonly branch: string
      readonly remote?: string
      readonly didCommit: boolean
      readonly didPush: boolean
    }
  | { readonly ok: false; readonly error: string }

export async function createTicketsStore(opts: {
  readonly projectRoot: string
  readonly projectId?: string
  readonly projectName?: string
  readonly controlPlaneConfig: ControlPlaneConfig
  readonly logger: { info: (input: { message: string }) => void; warn: (input: { message: string }) => void }
}): Promise<{
  readonly createTicket: (input: {
    readonly title: string
    readonly body?: string
    readonly dependsOn?: readonly string[]
    readonly blocks?: readonly string[]
    readonly actor?: string
  }) => Promise<CreateTicketResult>
  readonly updateTicket: (input: {
    readonly ticketId: string
    readonly title?: string
    readonly body?: string
    readonly dependsOn?: readonly string[]
    readonly blocks?: readonly string[]
    readonly actor?: string
  }) => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>
  readonly listTickets: () => Promise<readonly TicketSummary[]>
  readonly getTicket: (input: { readonly ticketId: string }) => Promise<TicketSummary | null>
  readonly listEvents: (input: { readonly ticketId: string }) => Promise<readonly TicketEvent[]>
  readonly readSnapshot: () => Promise<{
    readonly tickets: readonly TicketSummary[]
    readonly eventsByTicket: ReadonlyMap<string, readonly TicketEvent[]>
  }>
  readonly setStatus: (input: {
    readonly ticketId: string
    readonly status: TicketStatus
    readonly actor?: string
  }) => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>
  readonly sync: () => Promise<SyncResult>
}> {
  const git = await createGitTicketsChannel({
    projectRoot: opts.projectRoot,
    config: opts.controlPlaneConfig.tickets.git,
    logger: opts.logger
  })

  const resolveActor = (override?: string): string => {
    const trimmed = (override ?? "").trim()
    if (trimmed) return trimmed
    const user = (process.env.USER ?? "").trim() || "unknown"
    return `${user}@${hostname()}`
  }

  const buildEvent = (input: {
    readonly ticketId: string
    readonly type: string
    readonly payload: Record<string, unknown>
    readonly actor?: string
  }): TicketEvent => {
    const ts = unixSeconds()
    return {
      eventId: randomUUID(),
      ts,
      tsIso: new Date(ts * 1000).toISOString(),
      actor: resolveActor(input.actor),
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      ...(opts.projectName ? { projectName: opts.projectName } : {}),
      ticketId: input.ticketId,
      type: input.type,
      payload: input.payload
    }
  }

  const readAllEvents = async (): Promise<readonly TicketEvent[]> => {
    const root = await git.ensureCheckedOut()
    const eventsDir = resolve(root, ".hack/tickets/events")

    let entries: string[] = []
    try {
      entries = (await readdir(eventsDir)).filter(f => f.endsWith(".jsonl"))
    } catch {
      return []
    }

    const events: TicketEvent[] = []
    for (const filename of entries.sort()) {
      const path = resolve(eventsDir, filename)
      const text = await Bun.file(path).text().catch(() => "")
      for (const line of text.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const parsed = safeJsonParse(trimmed)
        const event = parseEvent(parsed)
        if (event) events.push(event)
      }
    }

    events.sort((a, b) => {
      if (a.ts !== b.ts) return a.ts - b.ts
      return a.eventId.localeCompare(b.eventId)
    })
    return events
  }

  const materializeTickets = async (): Promise<Map<string, TicketSummary>> => {
    const events = await readAllEvents()
    return materializeTicketsFromEvents({ events })
  }

  const materializeTicketsFromEvents = (opts: {
    readonly events: readonly TicketEvent[]
  }): Map<string, TicketSummary> => {
    const tickets = new Map<string, TicketSummary>()

    for (const event of opts.events) {
      if (event.type === "ticket.created") {
        const title = typeof event.payload["title"] === "string" ? event.payload["title"] : ""
        const body = typeof event.payload["body"] === "string" ? event.payload["body"] : undefined
        const dependsOn = parseDependencyList({ value: event.payload["dependsOn"] })
        const blocks = parseDependencyList({ value: event.payload["blocks"] })

        tickets.set(event.ticketId, {
          ticketId: event.ticketId,
          title,
          body,
          status: "open",
          createdAt: event.tsIso,
          updatedAt: event.tsIso,
          dependsOn,
          blocks,
          ...(event.projectId ? { projectId: event.projectId } : {}),
          ...(event.projectName ? { projectName: event.projectName } : {})
        })
        continue
      }

      if (event.type === "ticket.status_changed") {
        const current = tickets.get(event.ticketId)
        if (!current) continue

        const next = typeof event.payload["status"] === "string" ? event.payload["status"] : ""
        if (next === "open" || next === "in_progress" || next === "blocked" || next === "done") {
          tickets.set(event.ticketId, {
            ...current,
            status: next,
            updatedAt: event.tsIso
          })
        }
        continue
      }

      if (event.type === "ticket.updated") {
        const current = tickets.get(event.ticketId)
        if (!current) continue

        const title = typeof event.payload["title"] === "string" ? event.payload["title"] : undefined
        const body = typeof event.payload["body"] === "string" ? event.payload["body"] : undefined
        const dependsOn = readDependencyUpdate({ payload: event.payload, key: "dependsOn" })
        const blocks = readDependencyUpdate({ payload: event.payload, key: "blocks" })

        tickets.set(event.ticketId, {
          ...current,
          ...(title ? { title } : {}),
          ...(body !== undefined ? { body } : {}),
          ...(dependsOn !== null ? { dependsOn } : {}),
          ...(blocks !== null ? { blocks } : {}),
          updatedAt: event.tsIso
        })
      }
    }

    return applyDerivedBlocks(tickets)
  }

  const groupEventsByTicket = (opts: {
    readonly events: readonly TicketEvent[]
  }): Map<string, TicketEvent[]> => {
    const grouped = new Map<string, TicketEvent[]>()
    for (const event of opts.events) {
      const list = grouped.get(event.ticketId) ?? []
      list.push(event)
      grouped.set(event.ticketId, list)
    }
    return grouped
  }

  const sortTickets = (opts: { readonly tickets: Iterable<TicketSummary> }): TicketSummary[] => {
    const out = [...opts.tickets]
    out.sort((a, b) => (parseTicketNumber(a.ticketId) ?? 0) - (parseTicketNumber(b.ticketId) ?? 0))
    return out
  }

  const computeNextTicketId = async (): Promise<string> => {
    const events = await readAllEvents()
    const tickets = materializeTicketsFromEvents({ events })
    let max = 0
    for (const ticketId of tickets.keys()) {
      const n = parseTicketNumber(ticketId)
      if (n !== null && n > max) max = n
    }
    return formatTicketId(max + 1)
  }

  const setStatus = async (input: {
    readonly ticketId: string
    readonly status: TicketStatus
    readonly actor?: string
  }): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> => {
    const tickets = await materializeTickets()
    const current = tickets.get(input.ticketId)
    if (!current) return { ok: false, error: `Ticket not found: ${input.ticketId}` }

    const event = buildEvent({
      ticketId: input.ticketId,
      type: "ticket.status_changed",
      payload: { status: input.status },
      actor: input.actor
    })

    return await git.appendEvents({ events: [event] })
  }

  return {
    createTicket: async input => {
      const ticketId = await computeNextTicketId()
      const dependsOn = normalizeTicketRefs(input.dependsOn ?? [])
      const blocks = normalizeTicketRefs(input.blocks ?? [])
      const event = buildEvent({
        ticketId,
        type: "ticket.created",
        payload: {
          title: input.title,
          ...(input.body ? { body: input.body } : {}),
          ...(dependsOn.length > 0 ? { dependsOn } : {}),
          ...(blocks.length > 0 ? { blocks } : {}),
          status: "open"
        },
        actor: input.actor
      })

      const wrote = await git.appendEvents({ events: [event] })
      if (!wrote.ok) return wrote

      return {
        ok: true,
        ticket: {
          ticketId,
          title: input.title,
          ...(input.body ? { body: input.body } : {}),
          status: "open",
          createdAt: event.tsIso,
          updatedAt: event.tsIso,
          dependsOn,
          blocks,
          ...(opts.projectId ? { projectId: opts.projectId } : {}),
          ...(opts.projectName ? { projectName: opts.projectName } : {})
        }
      }
    },

    updateTicket: async input => {
      const tickets = await materializeTickets()
      const current = tickets.get(input.ticketId)
      if (!current) return { ok: false, error: `Ticket not found: ${input.ticketId}` }

      const payload: Record<string, unknown> = {}
      if (input.title !== undefined) {
        const title = input.title.trim()
        if (!title) return { ok: false, error: "Title cannot be empty." }
        payload["title"] = title
      }
      if (input.body !== undefined) {
        payload["body"] = input.body
      }
      if (input.dependsOn !== undefined) {
        payload["dependsOn"] = normalizeTicketRefs(input.dependsOn)
      }
      if (input.blocks !== undefined) {
        payload["blocks"] = normalizeTicketRefs(input.blocks)
      }

      if (Object.keys(payload).length === 0) {
        return { ok: false, error: "No updates provided." }
      }

      const event = buildEvent({
        ticketId: input.ticketId,
        type: "ticket.updated",
        payload,
        actor: input.actor
      })

      return await git.appendEvents({ events: [event] })
    },

    listTickets: async () => {
      const events = await readAllEvents()
      const tickets = materializeTicketsFromEvents({ events })
      return sortTickets({ tickets: tickets.values() })
    },

    getTicket: async ({ ticketId }) => {
      const events = await readAllEvents()
      const tickets = materializeTicketsFromEvents({ events })
      return tickets.get(ticketId) ?? null
    },

    listEvents: async ({ ticketId }) => {
      const events = await readAllEvents()
      return events.filter(e => e.ticketId === ticketId)
    },

    readSnapshot: async () => {
      const events = await readAllEvents()
      const tickets = materializeTicketsFromEvents({ events })
      const eventsByTicket = groupEventsByTicket({ events })
      return {
        tickets: sortTickets({ tickets: tickets.values() }),
        eventsByTicket
      }
    },

    sync: async () => {
      return await git.sync()
    },

    setStatus
  }
}

function parseDependencyList(opts: { readonly value: unknown }): string[] {
  if (!Array.isArray(opts.value)) return []
  const values = opts.value.filter((item): item is string => typeof item === "string")
  return normalizeTicketRefs(values)
}

function readDependencyUpdate(opts: {
  readonly payload: Record<string, unknown>
  readonly key: "dependsOn" | "blocks"
}): string[] | null {
  if (!Object.prototype.hasOwnProperty.call(opts.payload, opts.key)) {
    return null
  }
  return parseDependencyList({ value: opts.payload[opts.key] })
}

function applyDerivedBlocks(tickets: Map<string, TicketSummary>): Map<string, TicketSummary> {
  const derived = new Map<string, Set<string>>()
  for (const ticket of tickets.values()) {
    for (const dep of ticket.dependsOn) {
      const set = derived.get(dep) ?? new Set<string>()
      set.add(ticket.ticketId)
      derived.set(dep, set)
    }
  }

  for (const [ticketId, blockedBy] of derived) {
    const current = tickets.get(ticketId)
    if (!current) continue
    const merged = normalizeTicketRefs([...current.blocks, ...blockedBy])
    tickets.set(ticketId, {
      ...current,
      blocks: merged
    })
  }

  return tickets
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function parseEvent(value: unknown): TicketEvent | null {
  if (!isRecord(value)) return null
  const eventId = typeof value["eventId"] === "string" ? value["eventId"] : ""
  const ts = typeof value["ts"] === "number" ? value["ts"] : NaN
  const actor = typeof value["actor"] === "string" ? value["actor"] : ""
  const ticketId = typeof value["ticketId"] === "string" ? value["ticketId"] : ""
  const type = typeof value["type"] === "string" ? value["type"] : ""
  const payload = isRecord(value["payload"]) ? (value["payload"] as Record<string, unknown>) : null

  if (!eventId || !Number.isFinite(ts) || !actor || !ticketId || !type || !payload) return null

  const projectId = typeof value["projectId"] === "string" ? value["projectId"] : undefined
  const projectName = typeof value["projectName"] === "string" ? value["projectName"] : undefined

  return {
    eventId,
    ts,
    tsIso: new Date(ts * 1000).toISOString(),
    actor,
    ...(projectId ? { projectId } : {}),
    ...(projectName ? { projectName } : {}),
    ticketId,
    type,
    payload
  }
}
