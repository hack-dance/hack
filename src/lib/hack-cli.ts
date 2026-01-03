import { resolve } from "node:path"

import { pathExists } from "./fs.ts"
import { findExecutableInPath } from "./shell.ts"

export interface HackInvocation {
  readonly bin: string
  readonly args: readonly string[]
}

export async function resolveHackInvocation(): Promise<HackInvocation> {
  const override = (process.env.HACK_MCP_COMMAND ?? "").trim()
  if (override.length > 0) return { bin: override, args: [] }

  const fromPath = await findExecutableInPath("hack")
  if (fromPath) return { bin: fromPath, args: [] }

  const argv0 = process.argv[0]
  const argv1 = process.argv[1]
  if (argv0 && argv1) {
    const candidate = await resolveArgvPath({ raw: argv1 })
    if (candidate) {
      return { bin: argv0, args: [candidate] }
    }
  }

  return { bin: "hack", args: [] }
}

async function resolveArgvPath({ raw }: { readonly raw: string }): Promise<string | null> {
  if (await pathExists(raw)) return raw
  const resolved = resolve(process.cwd(), raw)
  return (await pathExists(resolved)) ? resolved : null
}
