import { YAML } from "bun"

import { DEFAULT_INGRESS_NETWORK } from "../constants.ts"

export type PlannedServiceRole = "http" | "internal"

export interface PlannedService {
  readonly name: string // docker compose service key
  readonly role: PlannedServiceRole
  readonly image: string
  readonly workingDir: string
  readonly command: string
  readonly env: ReadonlyMap<string, string>
  readonly labels: ReadonlyMap<string, string>
  readonly networks: readonly string[]
}

export interface ComposePlan {
  readonly name?: string
  readonly services: readonly PlannedService[]
}

export function renderCompose(plan: ComposePlan): string {
  const services: Record<string, ComposeServiceSpec> = {}

  for (const svc of plan.services) {
    services[svc.name] = {
      image: svc.image,
      working_dir: svc.workingDir,
      volumes: ["..:/app"],
      command: svc.command,
      ...(svc.env.size > 0 ? { environment: recordFromMap(svc.env) } : {}),
      ...(svc.labels.size > 0 ? { labels: recordFromMap(svc.labels) } : {}),
      ...(svc.networks.length > 0 ? { networks: [...svc.networks] } : {})
    }
  }

  const compose: ComposeFileSpec = {
    ...(plan.name ? { name: plan.name } : {}),
    services,
    networks: {
      [DEFAULT_INGRESS_NETWORK]: { external: true }
    }
  }

  const yaml = YAML.stringify(compose, null, 2)
  return ensureTrailingNewline(cleanupYaml(yaml))
}

type ComposeServiceSpec = {
  readonly image: string
  readonly working_dir?: string
  readonly volumes?: readonly string[]
  readonly command?: string
  readonly environment?: Record<string, string>
  readonly labels?: Record<string, string>
  readonly networks?: readonly string[]
}

type ComposeFileSpec = {
  readonly name?: string
  readonly services: Record<string, ComposeServiceSpec>
  readonly networks: Record<string, { readonly external: boolean }>
}

function recordFromMap(map: ReadonlyMap<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of map.entries()) out[k] = v
  return out
}

function cleanupYaml(yaml: string): string {
  // Bun.YAML.stringify currently emits `key: ` (space before newline) for nested maps.
  // Clean it up to a more conventional `key:` format.
  let out = yaml.replaceAll(/: \n/g, ":\n")

  return out
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`
}
