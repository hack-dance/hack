function isTruthyEnv(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

export function isTty(): boolean {
  return process.stdout.isTTY === true
}

export function isColorEnabled(): boolean {
  if (!isTty()) return false
  return !isTruthyEnv(process.env.HACK_NO_COLOR)
}
