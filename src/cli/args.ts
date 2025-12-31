export interface ParsedArgs {
  readonly positionals: readonly string[]
  readonly flags: ReadonlyMap<string, string | boolean>
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = []
  const flags = new Map<string, string | boolean>()

  let i = 0
  let parsingFlags = true

  while (i < argv.length) {
    const token = argv[i] ?? ""
    i += 1

    if (!parsingFlags) {
      positionals.push(token)
      continue
    }

    if (token === "--") {
      parsingFlags = false
      continue
    }

    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=")
      if (eqIdx !== -1) {
        const key = token.slice(0, eqIdx)
        const value = token.slice(eqIdx + 1)
        flags.set(key, value)
        continue
      }

      const key = token
      const next = argv[i]
      if (next && !next.startsWith("-")) {
        flags.set(key, next)
        i += 1
      } else {
        flags.set(key, true)
      }
      continue
    }

    if (token.startsWith("-") && token.length > 1) {
      // Support combined short flags, e.g. -fd
      const shortFlags = token.slice(1).split("")
      for (const sf of shortFlags) {
        flags.set(`-${sf}`, true)
      }
      continue
    }

    positionals.push(token)
  }

  return { positionals, flags }
}

export function getFlagBoolean(args: ParsedArgs, names: readonly string[]): boolean {
  for (const name of names) {
    const value = args.flags.get(name)
    if (value === true) return true
    if (typeof value === "string") {
      return value === "true" || value === "1" || value === "yes"
    }
  }
  return false
}

export function getFlagString(args: ParsedArgs, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = args.flags.get(name)
    if (typeof value === "string") return value
  }
  return undefined
}

export function getFlagInt(args: ParsedArgs, names: readonly string[]): number | undefined {
  const raw = getFlagString(args, names)
  if (!raw) return undefined
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : undefined
}
