import { createHash } from "node:crypto"

import { isRecord } from "../../lib/guards.ts"

import type { Logger } from "../../ui/logger.ts"
import type { ControlPlaneConfig } from "../sdk/config.ts"
import type {
  ExtensionCommand,
  ExtensionCommandInfo,
  ExtensionDefinition,
  ResolvedExtension
} from "./types.ts"

const RESERVED_NAMESPACES = new Set(["x", "help", "version"])

type NamespaceResolution = {
  readonly resolved: ResolvedExtension
  readonly warning?: string
}

/**
 * Manage extension definitions, namespace resolution, and command routing.
 */
export class ExtensionManager {
  private readonly definitions: ExtensionDefinition[] = []
  private readonly config: ControlPlaneConfig
  private readonly logger: Logger

  public constructor(opts: { readonly config: ControlPlaneConfig; readonly logger: Logger }) {
    this.config = opts.config
    this.logger = opts.logger
  }

  /**
   * Register a new extension definition.
   *
   * @param opts.extension - Extension manifest and command handlers.
   */
  public registerExtension(opts: { readonly extension: ExtensionDefinition }): void {
    const exists = this.definitions.some(def => def.manifest.id === opts.extension.manifest.id)
    if (exists) {
      this.logger.warn({
        message: `Extension already registered: ${opts.extension.manifest.id}`
      })
      return
    }
    this.definitions.push(opts.extension)
  }

  /**
   * List extensions with resolved namespaces and enablement status.
   *
   * @returns Resolved extension definitions.
   */
  public listExtensions(): readonly ResolvedExtension[] {
    return this.resolveAll().map(item => item.resolved)
  }

  /**
   * List commands for a namespace.
   *
   * @param opts.namespace - Resolved extension namespace.
   * @returns Extension command metadata.
   */
  public listCommands(opts: { readonly namespace: string }): readonly ExtensionCommandInfo[] {
    const resolved = this.findByNamespace({ namespace: opts.namespace })
    if (!resolved) return []
    return resolved.commands.map(cmd => ({
      name: cmd.name,
      summary: cmd.summary,
      commandId: `${resolved.manifest.id}:${cmd.name}`
    }))
  }

  /**
   * Resolve an extension definition by namespace.
   *
   * @param opts.namespace - Resolved extension namespace.
   * @returns Resolved extension or null when missing.
   */
  public getExtensionByNamespace(opts: {
    readonly namespace: string
  }): ResolvedExtension | null {
    return this.findByNamespace({ namespace: opts.namespace })
  }

  /**
   * Resolve a command by namespace and name.
   *
   * @param opts.namespace - Resolved extension namespace.
   * @param opts.commandName - Extension command name.
   * @returns Resolved command and extension or null.
   */
  public resolveCommand(opts: {
    readonly namespace: string
    readonly commandName: string
  }): { readonly extension: ResolvedExtension; readonly command: ExtensionCommand } | null {
    const resolved = this.findByNamespace({ namespace: opts.namespace })
    if (!resolved) return null
    const command = resolved.commands.find(cmd => cmd.name === opts.commandName) ?? null
    if (!command) return null
    return { extension: resolved, command }
  }

  /**
   * Resolve an extension command id (`extensionId:commandName`) to its namespace.
   *
   * @param opts.commandId - Fully-qualified command id.
   * @returns Resolved namespace and command name or null.
   */
  public resolveCommandId(opts: {
    readonly commandId: string
  }): { readonly namespace: string; readonly commandName: string } | null {
    const splitIdx = opts.commandId.indexOf(":")
    if (splitIdx === -1) return null
    const extensionId = opts.commandId.slice(0, splitIdx)
    const commandName = opts.commandId.slice(splitIdx + 1)
    const resolved = this.resolveByExtensionId({ extensionId })
    if (!resolved) return null
    return { namespace: resolved.namespace, commandName }
  }

  /**
   * Return namespace resolution warnings for registered extensions.
   *
   * @returns Warning messages.
   */
  public getWarnings(): readonly string[] {
    return this.resolveAll()
      .map(item => item.warning)
      .filter((warning): warning is string => typeof warning === "string")
  }

  private resolveAll(): readonly NamespaceResolution[] {
    const used = new Set<string>()
    const out: NamespaceResolution[] = []

    for (const def of this.definitions) {
      const resolution = resolveNamespace({
        extension: def,
        config: this.config,
        used
      })
      used.add(resolution.resolved.namespace)
      out.push(resolution)
    }

    return out
  }

  private resolveByExtensionId(opts: {
    readonly extensionId: string
  }): ResolvedExtension | null {
    for (const entry of this.resolveAll()) {
      if (entry.resolved.manifest.id === opts.extensionId) return entry.resolved
    }
    return null
  }

  private findByNamespace(opts: { readonly namespace: string }): ResolvedExtension | null {
    for (const entry of this.resolveAll()) {
      if (entry.resolved.namespace === opts.namespace) return entry.resolved
    }
    return null
  }
}

function resolveNamespace(opts: {
  readonly extension: ExtensionDefinition
  readonly config: ControlPlaneConfig
  readonly used: ReadonlySet<string>
}): NamespaceResolution {
  const preferred = opts.extension.manifest.cliNamespace
  const extensionConfig = opts.config.extensions?.[opts.extension.manifest.id]
  const override =
    isRecord(extensionConfig) && typeof extensionConfig["cliNamespace"] === "string" ?
      extensionConfig["cliNamespace"]
    : undefined
  const enabled =
    (isRecord(extensionConfig) && extensionConfig["enabled"] === true ? true : false) ||
    (opts.extension.manifest.id === "dance.hack.gateway" && opts.config.gateway.enabled === true)
  const desired = sanitizeNamespace(override ?? preferred)

  if (desired.length > 0 && !opts.used.has(desired) && !RESERVED_NAMESPACES.has(desired)) {
    return {
      resolved: { ...opts.extension, namespace: desired, enabled }
    }
  }

  const fallback = buildFallbackNamespace({
    base: desired.length > 0 ? desired : "ext",
    extensionId: opts.extension.manifest.id,
    used: opts.used
  })

  return {
    resolved: { ...opts.extension, namespace: fallback, enabled },
    warning:
      desired.length === 0 ?
        `Extension namespace missing for ${opts.extension.manifest.id}; using ${fallback}`
      : `Namespace "${desired}" already used; using ${fallback} for ${opts.extension.manifest.id}`
  }
}

function buildFallbackNamespace(opts: {
  readonly base: string
  readonly extensionId: string
  readonly used: ReadonlySet<string>
}): string {
  const hash = createHash("sha1").update(opts.extensionId).digest("hex").slice(0, 6)
  const fallback = `${opts.base}.${hash}`
  if (!opts.used.has(fallback) && !RESERVED_NAMESPACES.has(fallback)) {
    return fallback
  }
  return `${opts.base}.${hash}.${Date.now().toString(36)}`
}

function sanitizeNamespace(raw: string): string {
  const trimmed = raw.trim().toLowerCase()
  const replaced = trimmed.replaceAll("_", "-").replaceAll(" ", "-")
  const cleaned = replaced.replaceAll(/[^a-z0-9-]/g, "")
  return cleaned.replaceAll(/-+/g, "-").replaceAll(/^-|-$/g, "")
}
