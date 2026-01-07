import { readdir } from "node:fs/promises"
import { resolve } from "node:path"
import { hostname } from "node:os"
import { randomUUID } from "node:crypto"

import { isRecord } from "../../../lib/guards.ts"

import { createGitTicketsChannel } from "./tickets-git-channel.ts"
import { formatTicketId, parseTicketNumber, unixSeconds } from "./util.ts"

import type { ControlPlaneConfig } from "../../sdk/config.ts"

export type TicketStatus = "open" | "in_progress" | "blocked" | "done"

export type TicketSummary = {
  readonly ticketId: string
  readonly title: string
  readonly body?: string
  readonly status: TicketStatus
  readonly createdAt: string
  readonly updatedAt: string
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
    readonly actor?: string
  }) => Promise<CreateTicketResult>
  readonly listTickets: () => Promise<readonly TicketSummary[]>
  readonly getTicket: (input: { readonly ticketId: string }) => Promise<TicketSummary | null>
  readonly listEvents: (input: { readonly ticketId: string }) => Promise<readonly TicketEvent[]>
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
    const tickets = new Map<string, TicketSummary>()

    for (const event of events) {
      if (event.type === "ticket.created") {
        const title = typeof event.payload["title"] === "string" ? event.payload["title"] : ""
        const body = typeof event.payload["body"] === "string" ? event.payload["body"] : undefined

        tickets.set(event.ticketId, {
          ticketId: event.ticketId,
          title,
          body,
          status: "open",
          createdAt: event.tsIso,
          updatedAt: event.tsIso,
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

        tickets.set(event.ticketId, {
          ...current,
          ...(title ? { title } : {}),
          ...(body !== undefined ? { body } : {}),
          updatedAt: event.tsIso
        })
      }
    }

    return tickets
  }

  const computeNextTicketId = async (): Promise<string> => {
    const tickets = await materializeTickets()
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
      const event = buildEvent({
        ticketId,
        type: "ticket.created",
        payload: {
          title: input.title,
          ...(input.body ? { body: input.body } : {}),
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
          ...(opts.projectId ? { projectId: opts.projectId } : {}),
          ...(opts.projectName ? { projectName: opts.projectName } : {})
        }
      }
    },

    listTickets: async () => {
      const tickets = await materializeTickets()
      const out = [...tickets.values()]
      out.sort((a, b) => (parseTicketNumber(a.ticketId) ?? 0) - (parseTicketNumber(b.ticketId) ?? 0))
      return out
    },

    getTicket: async ({ ticketId }) => {
      const tickets = await materializeTickets()
      return tickets.get(ticketId) ?? null
    },

    listEvents: async ({ ticketId }) => {
      const events = await readAllEvents()
      return events.filter(e => e.ticketId === ticketId)
    },

    sync: async () => {
      return await git.sync()
    },

    setStatus
  }
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
