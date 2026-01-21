export function unixSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

export function getMonthStamp(tsSeconds: number): string {
  const d = new Date(tsSeconds * 1000)
  const year = d.getUTCFullYear()
  const month = String(d.getUTCMonth() + 1).padStart(2, "0")
  return `${year}-${month}`
}

export function formatTicketId(n: number): string {
  const padded = String(n).padStart(5, "0")
  return `T-${padded}`
}

export function parseTicketNumber(ticketId: string): number | null {
  const trimmed = ticketId.trim()
  if (!trimmed.startsWith("T-")) return null
  const rest = trimmed.slice(2)
  const n = Number(rest)
  if (!Number.isFinite(n)) return null
  return Math.trunc(n)
}

export function normalizeTicketRef(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const raw = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed
  if (!raw) return null
  const upper = raw.toUpperCase()
  if (upper.startsWith("T-")) {
    const n = parseTicketNumber(upper)
    return n === null ? null : formatTicketId(n)
  }
  if (/^\d+$/.test(raw)) {
    return formatTicketId(Number(raw))
  }
  return null
}

export function normalizeTicketRefs(inputs: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of inputs) {
    const normalized = normalizeTicketRef(raw)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  out.sort((a, b) => {
    const an = parseTicketNumber(a) ?? 0
    const bn = parseTicketNumber(b) ?? 0
    if (an !== bn) return an - bn
    return a.localeCompare(b)
  })
  return out
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(stableSort(value))
}

function stableSort(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableSort)
  }
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(rec).sort()) {
      out[key] = stableSort(rec[key])
    }
    return out
  }
  return value
}
