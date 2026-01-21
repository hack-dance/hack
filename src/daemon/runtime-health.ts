import { exec } from "../lib/shell.ts"

export type RuntimeIdentity = {
  readonly dockerHost: string | null
  readonly socketPath: string | null
  readonly socketInode: number | null
  readonly engineId: string | null
  readonly engineName: string | null
  readonly engineVersion: string | null
}

export type RuntimeIdentityResult =
  | { readonly ok: true; readonly identity: RuntimeIdentity }
  | { readonly ok: false; readonly error: string }

export async function readRuntimeIdentity(opts?: {
  readonly env?: Record<string, string | undefined>
}): Promise<RuntimeIdentityResult> {
  const env = opts?.env ?? process.env
  const host = resolveDockerHost({ env })
  const socketInode = await readSocketInode({ socketPath: host.socketPath })
  const info = await readDockerInfo({ env })
  if (!info.ok) {
    return { ok: false, error: info.error }
  }

  return {
    ok: true,
    identity: {
      dockerHost: host.dockerHost,
      socketPath: host.socketPath,
      socketInode,
      engineId: info.engineId,
      engineName: info.engineName,
      engineVersion: info.engineVersion
    }
  }
}

export function buildRuntimeFingerprint(opts: {
  readonly identity: RuntimeIdentity
}): string {
  const dockerHost = opts.identity.dockerHost ?? "default"
  const socketPath = opts.identity.socketPath ?? "none"
  const socketInode =
    typeof opts.identity.socketInode === "number" ? String(opts.identity.socketInode) : "none"
  const engineId = opts.identity.engineId ?? "unknown"
  return [dockerHost, socketPath, socketInode, engineId].join("|")
}

function resolveDockerHost(opts: {
  readonly env: Record<string, string | undefined>
}): { readonly dockerHost: string | null; readonly socketPath: string | null } {
  const raw = (opts.env.DOCKER_HOST ?? "").trim()
  if (raw.length === 0) {
    return { dockerHost: null, socketPath: "/var/run/docker.sock" }
  }
  if (raw.startsWith("unix://")) {
    const socketPath = raw.slice("unix://".length)
    return { dockerHost: raw, socketPath: socketPath.length > 0 ? socketPath : null }
  }
  if (raw.startsWith("unix:")) {
    const socketPath = raw.slice("unix:".length)
    return { dockerHost: raw, socketPath: socketPath.length > 0 ? socketPath : null }
  }
  return { dockerHost: raw, socketPath: null }
}

async function readSocketInode(opts: {
  readonly socketPath: string | null
}): Promise<number | null> {
  if (!opts.socketPath) return null
  try {
    const stats = await Bun.file(opts.socketPath).stat()
    return typeof stats.ino === "number" ? stats.ino : null
  } catch {
    return null
  }
}

async function readDockerInfo(opts: {
  readonly env: Record<string, string | undefined>
}): Promise<{
  readonly ok: boolean
  readonly engineId: string | null
  readonly engineName: string | null
  readonly engineVersion: string | null
  readonly error: string
}> {
  const env = normalizeEnv({ env: opts.env })
  const res = await exec(
    ["docker", "info", "--format", "{{.ID}}|{{.Name}}|{{.ServerVersion}}"],
    { stdin: "ignore", env }
  )
  if (res.exitCode !== 0) {
    return {
      ok: false,
      engineId: null,
      engineName: null,
      engineVersion: null,
      error: formatDockerError({ stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode })
    }
  }

  const trimmed = res.stdout.trim()
  if (trimmed.length === 0) {
    return {
      ok: false,
      engineId: null,
      engineName: null,
      engineVersion: null,
      error: "docker info returned empty output"
    }
  }

  const [engineIdRaw, engineNameRaw, engineVersionRaw] = trimmed.split("|")
  const engineId = engineIdRaw?.trim() ?? ""
  const engineName = engineNameRaw?.trim() ?? ""
  const engineVersion = engineVersionRaw?.trim() ?? ""
  return {
    ok: true,
    engineId: engineId.length > 0 ? engineId : null,
    engineName: engineName.length > 0 ? engineName : null,
    engineVersion: engineVersion.length > 0 ? engineVersion : null,
    error: ""
  }
}

function normalizeEnv(opts: {
  readonly env: Record<string, string | undefined>
}): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  let hasValue = false
  for (const [key, value] of Object.entries(opts.env)) {
    if (typeof value === "string") {
      out[key] = value
      hasValue = true
    }
  }
  return hasValue ? out : undefined
}

function formatDockerError(opts: {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}): string {
  const stderr = opts.stderr.trim()
  if (stderr.length > 0) return stderr
  const stdout = opts.stdout.trim()
  if (stdout.length > 0) return stdout
  return `docker info failed (exit ${opts.exitCode})`
}
