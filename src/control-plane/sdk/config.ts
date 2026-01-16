import { resolve } from "node:path"

import { z } from "zod"

import { resolveGlobalConfigPath } from "../../lib/config-paths.ts"
import { readTextFile } from "../../lib/fs.ts"
import { isRecord } from "../../lib/guards.ts"
import { GLOBAL_ONLY_EXTENSION_IDS, PROJECT_CONFIG_FILENAME } from "../../constants.ts"

const ExtensionEnablementInputSchema = z.object({
  enabled: z.boolean().optional(),
  cliNamespace: z.string().min(1).optional(),
  config: z.record(z.string(), z.unknown()).optional()
})

const ExtensionEnablementSchema = z.object({
  enabled: z.boolean().default(false),
  cliNamespace: z.string().min(1).optional(),
  config: z.record(z.string(), z.unknown()).default({})
})

const TicketsGitRefModeSchema = z.enum(["heads", "hidden"])

const TicketsGitConfigInputSchema = z.object({
  enabled: z.boolean().optional(),
  branch: z.string().optional(),
  remote: z.string().optional(),
  forceBareClone: z.boolean().optional(),
  refMode: TicketsGitRefModeSchema.optional()
})

const TicketsGitConfigSchema = z.object({
  enabled: z.boolean().default(true),
  branch: z.string().default("hack/tickets"),
  remote: z.string().default("origin"),
  forceBareClone: z.boolean().default(false),
  refMode: TicketsGitRefModeSchema.default("hidden")
})

const SupervisorConfigInputSchema = z.object({
  enabled: z.boolean().optional(),
  maxConcurrentJobs: z.number().int().positive().optional(),
  logsMaxBytes: z.number().int().positive().optional()
})

const SupervisorConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxConcurrentJobs: z.number().int().positive().default(4),
  logsMaxBytes: z.number().int().positive().default(5_000_000)
})

const TuiLogsConfigInputSchema = z.object({
  maxEntries: z.number().int().positive().optional(),
  maxLines: z.number().int().positive().optional(),
  historyTailStep: z.number().int().positive().optional()
})

const TuiLogsConfigSchema = z.object({
  maxEntries: z.number().int().positive().default(2000),
  maxLines: z.number().int().positive().default(400),
  historyTailStep: z.number().int().positive().default(200)
})

const TuiConfigInputSchema = z.object({
  logs: TuiLogsConfigInputSchema.optional()
})

const TuiConfigSchema = z.object({
  logs: TuiLogsConfigSchema.default(TuiLogsConfigSchema.parse({}))
})

const UsageConfigInputSchema = z.object({
  watchIntervalMs: z.number().int().positive().optional(),
  historySize: z.number().int().positive().optional()
})

const UsageConfigSchema = z.object({
  watchIntervalMs: z.number().int().positive().default(2000),
  historySize: z.number().int().positive().default(24)
})

const DaemonConfigInputSchema = z.object({
  autoStart: z.boolean().optional()
})

const DaemonConfigSchema = z.object({
  autoStart: z.boolean().default(true)
})

const GatewayConfigInputSchema = z.object({
  enabled: z.boolean().optional(),
  bind: z.string().optional(),
  port: z.number().int().positive().optional(),
  allowWrites: z.boolean().optional()
})

const GatewayConfigSchema = z.object({
  enabled: z.boolean().default(false),
  bind: z.string().default("127.0.0.1"),
  port: z.number().int().positive().default(7788),
  allowWrites: z.boolean().default(false)
})

const ControlPlaneConfigInputSchema = z.object({
  extensions: z.record(z.string(), ExtensionEnablementInputSchema).optional(),
  tickets: z
    .object({
      git: TicketsGitConfigInputSchema.optional()
    })
    .optional(),
  supervisor: SupervisorConfigInputSchema.optional(),
  tui: TuiConfigInputSchema.optional(),
  usage: UsageConfigInputSchema.optional(),
  daemon: DaemonConfigInputSchema.optional(),
  gateway: GatewayConfigInputSchema.optional()
})

const ControlPlaneConfigSchema = z.object({
  extensions: z.record(z.string(), ExtensionEnablementSchema).default({}),
  tickets: z
    .object({
      git: TicketsGitConfigSchema
    })
    .default({ git: TicketsGitConfigSchema.parse({}) }),
  supervisor: SupervisorConfigSchema.default(SupervisorConfigSchema.parse({})),
  tui: TuiConfigSchema.default(TuiConfigSchema.parse({})),
  usage: UsageConfigSchema.default(UsageConfigSchema.parse({})),
  daemon: DaemonConfigSchema.default(DaemonConfigSchema.parse({})),
  gateway: GatewayConfigSchema.default(GatewayConfigSchema.parse({}))
})

export type ControlPlaneConfig = z.infer<typeof ControlPlaneConfigSchema>
export type TicketsGitConfig = z.infer<typeof TicketsGitConfigSchema>
export type TicketsGitRefMode = z.infer<typeof TicketsGitRefModeSchema>

type ControlPlaneConfigInput = z.infer<typeof ControlPlaneConfigInputSchema>

export type ControlPlaneConfigResult = {
  readonly config: ControlPlaneConfig
  readonly parseError?: string
}

/**
 * Load control-plane configuration from global config plus optional project overrides.
 *
 * @param opts.projectDir - Optional project directory to read overrides from.
 * @returns Parsed control-plane config and optional parse error message.
 */
export async function readControlPlaneConfig(opts: {
  readonly projectDir?: string
}): Promise<ControlPlaneConfigResult> {
  const globalLayer = await readControlPlaneLayer({
    path: resolveGlobalConfigPath(),
    label: "Global config"
  })

  const projectLayer =
    opts.projectDir ?
      await readControlPlaneLayer({
        path: resolve(opts.projectDir, PROJECT_CONFIG_FILENAME),
        label: "Project config"
      })
    : { config: {} }

  const config = mergeControlPlaneLayers({
    global: globalLayer.config,
    project: projectLayer.config
  })

  const parseError = joinParseErrors({
    errors: [globalLayer.parseError, projectLayer.parseError]
  })

  return parseError ? { config, parseError } : { config }
}

type ControlPlaneConfigLayer = {
  readonly config: ControlPlaneConfigInput
  readonly parseError?: string
}

async function readControlPlaneLayer(opts: {
  readonly path: string
  readonly label: string
}): Promise<ControlPlaneConfigLayer> {
  const text = await readTextFile(opts.path)
  if (text === null) {
    return { config: {} }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid JSON"
    return {
      config: {},
      parseError: `${opts.label} parse error (${opts.path}): ${message}`
    }
  }

  if (!isRecord(parsed)) {
    return {
      config: {},
      parseError: `${opts.label} parse error (${opts.path}): invalid config shape`
    }
  }

  const controlPlaneRaw = parsed["controlPlane"]
  const result = ControlPlaneConfigInputSchema.safeParse(controlPlaneRaw ?? {})
  if (!result.success) {
    return {
      config: {},
      parseError: `${opts.label} controlPlane error (${opts.path}): ${result.error.message}`
    }
  }

  return { config: result.data }
}

function mergeControlPlaneLayers(opts: {
  readonly global: ControlPlaneConfigInput
  readonly project: ControlPlaneConfigInput
}): ControlPlaneConfig {
  const merged = mergeRecords({
    base: opts.global as Record<string, unknown>,
    override: opts.project as Record<string, unknown>
  })

  const mergedExtensions = mergeExtensions({
    global: opts.global.extensions,
    project: opts.project.extensions
  })
  merged.extensions = mergedExtensions

  const globalGateway = isRecord(opts.global.gateway) ? opts.global.gateway : {}
  const projectGateway = isRecord(opts.project.gateway) ? opts.project.gateway : {}
  const projectEnabled = projectGateway.enabled
  const gatewayEnabled = typeof projectEnabled === "boolean" ? projectEnabled : false
  merged.gateway = { ...globalGateway, enabled: gatewayEnabled }

  return ControlPlaneConfigSchema.parse(merged)
}

function mergeExtensions(opts: {
  readonly global: ControlPlaneConfigInput["extensions"]
  readonly project: ControlPlaneConfigInput["extensions"]
}): Record<string, unknown> {
  const globalExtensions = isRecord(opts.global) ? opts.global : {}
  const projectExtensions = isRecord(opts.project) ? opts.project : {}
  const merged = mergeRecords({
    base: globalExtensions,
    override: projectExtensions
  })

  const globalOnlyIds = new Set(GLOBAL_ONLY_EXTENSION_IDS)
  for (const extensionId of globalOnlyIds) {
    if (extensionId in globalExtensions) {
      merged[extensionId] = globalExtensions[extensionId]
    } else if (extensionId in merged) {
      delete merged[extensionId]
    }
  }

  return merged
}

function mergeRecords(opts: {
  readonly base: Record<string, unknown>
  readonly override: Record<string, unknown>
}): Record<string, unknown> {
  const out: Record<string, unknown> = { ...opts.base }
  for (const [key, value] of Object.entries(opts.override)) {
    if (value === undefined) continue
    const existing = out[key]
    if (isRecord(existing) && isRecord(value)) {
      out[key] = mergeRecords({
        base: existing,
        override: value
      })
      continue
    }
    out[key] = value
  }
  return out
}

function joinParseErrors(opts: { readonly errors: readonly (string | undefined)[] }): string | undefined {
  const parts = opts.errors.filter((value): value is string => typeof value === "string")
  if (parts.length === 0) return undefined
  return parts.join(" | ")
}
