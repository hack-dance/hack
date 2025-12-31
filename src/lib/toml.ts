import { isBoolean, isNumber, isRecord, isString } from "./guards.ts"

export type TomlPrimitive = string | number | boolean

export interface TomlTable {
  readonly [key: string]: TomlPrimitive
}

/**
 * Minimal TOML parser for our config needs:
 * - top-level key/value only
 * - string/number/boolean
 * - ignores comments and blank lines
 */
export function parseSimpleToml(content: string): TomlTable {
  const parsed: unknown = Bun.TOML.parse(content)
  if (!isRecord(parsed)) return {}

  const out: Record<string, TomlPrimitive> = {}
  for (const [key, value] of Object.entries(parsed)) {
    const primitive = coercePrimitive(value)
    if (primitive === null) continue
    out[key] = primitive
  }

  return out
}

function coercePrimitive(value: unknown): TomlPrimitive | null {
  if (isString(value)) return value
  if (isNumber(value)) return value
  if (isBoolean(value)) return value
  return null
}
