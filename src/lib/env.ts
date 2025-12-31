export interface EnvMap {
  readonly [key: string]: string
}

export function parseDotEnv(content: string): EnvMap {
  const out: Record<string, string> = {}

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    if (line.startsWith("#")) continue

    const eqIdx = line.indexOf("=")
    if (eqIdx <= 0) continue

    const key = line.slice(0, eqIdx).trim()
    const valueRaw = line.slice(eqIdx + 1).trim()
    if (key.length === 0) continue

    out[key] = stripQuotes(valueRaw)
  }

  return out
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === `"` && last === `"`) || (first === `'` && last === `'`)) {
      return value.slice(1, -1)
    }
  }
  return value
}

export function serializeDotEnv(env: EnvMap): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(env)) {
    lines.push(`${key}=${escapeEnvValue(value)}`)
  }
  return `${lines.join("\n")}\n`
}

function escapeEnvValue(value: string): string {
  const needsQuotes = value.includes(" ") || value.includes("\n") || value.includes('"')
  if (!needsQuotes) return value
  return `"${value.replaceAll('"', '\\"')}"`
}
