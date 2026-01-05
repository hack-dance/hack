import { resolve } from "node:path"

import { z } from "zod"

import { readTextFile } from "../../lib/fs.ts"
import { isRecord } from "../../lib/guards.ts"
import { PROJECT_CONFIG_FILENAME } from "../../constants.ts"

const ExtensionEnablementSchema = z.object({
  enabled: z.boolean().default(false),
  cliNamespace: z.string().min(1).optional(),
  config: z.record(z.string(), z.unknown()).default({})
})

const TicketsGitConfigSchema = z.object({
  enabled: z.boolean().default(true),
  branch: z.string().default("hack/tickets"),
  remote: z.string().default("origin"),
  forceBareClone: z.boolean().default(false)
})

const SupervisorConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxConcurrentJobs: z.number().int().positive().default(4),
  logsMaxBytes: z.number().int().positive().default(5_000_000)
})

const GatewayConfigSchema = z.object({
  enabled: z.boolean().default(false),
  bind: z.string().default("127.0.0.1"),
  port: z.number().int().positive().default(7788),
  allowWrites: z.boolean().default(false)
})

const ControlPlaneConfigSchema = z.object({
  extensions: z.record(z.string(), ExtensionEnablementSchema).default({}),
  tickets: z
    .object({
      git: TicketsGitConfigSchema
    })
    .default({ git: TicketsGitConfigSchema.parse({}) }),
  supervisor: SupervisorConfigSchema.default(SupervisorConfigSchema.parse({})),
  gateway: GatewayConfigSchema.default(GatewayConfigSchema.parse({}))
})

export type ControlPlaneConfig = z.infer<typeof ControlPlaneConfigSchema>

export type ControlPlaneConfigResult = {
  readonly config: ControlPlaneConfig
  readonly parseError?: string
}

/**
 * Load control-plane configuration from `hack.config.json`.
 *
 * @param opts.projectDir - Optional project directory to read from.
 * @returns Parsed control-plane config and optional parse error message.
 */
export async function readControlPlaneConfig(opts: {
  readonly projectDir?: string
}): Promise<ControlPlaneConfigResult> {
  if (!opts.projectDir) {
    return { config: ControlPlaneConfigSchema.parse({}) }
  }

  const configPath = resolve(opts.projectDir, PROJECT_CONFIG_FILENAME)
  const text = await readTextFile(configPath)
  if (text === null) {
    return { config: ControlPlaneConfigSchema.parse({}) }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid JSON"
    return { config: ControlPlaneConfigSchema.parse({}), parseError: message }
  }

  if (!isRecord(parsed)) {
    return { config: ControlPlaneConfigSchema.parse({}), parseError: "Invalid config shape" }
  }

  const controlPlaneRaw = parsed["controlPlane"]
  const result = ControlPlaneConfigSchema.safeParse(controlPlaneRaw ?? {})
  if (!result.success) {
    return {
      config: ControlPlaneConfigSchema.parse({}),
      parseError: result.error.message
    }
  }

  return { config: result.data }
}
