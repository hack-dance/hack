export function parseDurationMs(input: string): number | null {
  const raw = input.trim()
  const match = raw.match(/^(\d+)\s*([smhdw])$/i)
  if (!match) return null

  const numRaw = match[1]
  const unitRaw = match[2]?.toLowerCase()
  if (!numRaw || !unitRaw) return null

  const n = Number.parseInt(numRaw, 10)
  if (!Number.isFinite(n) || n <= 0) return null

  const unitMs =
    unitRaw === "s" ? 1000
    : unitRaw === "m" ? 60_000
    : unitRaw === "h" ? 3_600_000
    : unitRaw === "d" ? 86_400_000
    : unitRaw === "w" ? 604_800_000
    : null

  if (unitMs === null) return null

  const ms = n * unitMs
  return Number.isFinite(ms) ? ms : null
}
