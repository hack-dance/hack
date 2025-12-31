export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isString(value: unknown): value is string {
  return typeof value === "string"
}

export function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean"
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === "string")
}

export function getRecord(
  obj: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  const value = obj[key]
  return isRecord(value) ? value : undefined
}

export function getString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key]
  return typeof value === "string" ? value : undefined
}

export function getStringArray(obj: Record<string, unknown>, key: string): string[] | undefined {
  const value = obj[key]
  return isStringArray(value) ? value : undefined
}
