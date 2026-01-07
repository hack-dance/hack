import { mkdir, readdir, rm } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { isRecord } from "../../../lib/guards.ts"

import { stableStringify } from "./util.ts"

import type { TicketsGitConfig } from "../../sdk/config.ts"

export type TicketsGitChannel = {
  readonly ensureCheckedOut: () => Promise<string>
  readonly appendEvents: (input: { readonly events: readonly Record<string, unknown>[] }) => Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly error: string }
  >
  readonly sync: () => Promise<
    | {
        readonly ok: true
        readonly branch: string
        readonly remote?: string
        readonly didCommit: boolean
        readonly didPush: boolean
      }
    | { readonly ok: false; readonly error: string }
  >
}

export async function createGitTicketsChannel(opts: {
  readonly projectRoot: string
  readonly config: TicketsGitConfig
  readonly logger: { info: (input: { message: string }) => void; warn: (input: { message: string }) => void }
}): Promise<TicketsGitChannel> {
  const ticketsDir = resolve(opts.projectRoot, ".hack/tickets")
  const gitDir = resolve(ticketsDir, "git")
  const bareDir = resolve(gitDir, "bare.git")
  const worktreeDir = resolve(gitDir, "worktree")

  const branch = opts.config.branch
  const remoteName = (opts.config.remote ?? "origin").trim()

  const runGitDir = async (input: {
    readonly args: readonly string[]
  }): Promise<{ readonly ok: boolean; readonly stdout: string; readonly stderr: string }> => {
    return await runGit({
      cwd: opts.projectRoot,
      args: [`--git-dir=${bareDir}`, `--work-tree=${worktreeDir}`, ...input.args]
    })
  }

  const resolveRemoteUrl = async (): Promise<string | null> => {
    if (!remoteName) return null
    const result = await runGit({
      cwd: opts.projectRoot,
      args: ["remote", "get-url", remoteName]
    })
    if (!result.ok) return null
    const url = result.stdout.trim()
    return url.length > 0 ? url : null
  }

  const ensureDirs = async () => {
    await mkdir(gitDir, { recursive: true })
    await mkdir(worktreeDir, { recursive: true })
  }

  const ensureBareRepo = async () => {
    try {
      await Bun.file(resolve(bareDir, "HEAD")).stat()
      return
    } catch {
      // missing, create
    }

    await mkdir(dirname(bareDir), { recursive: true })
    const clone = await runGit({
      cwd: opts.projectRoot,
      args: ["clone", "--bare", opts.projectRoot, bareDir]
    })
    if (!clone.ok) {
      throw new Error(`Failed to create bare clone: ${clone.stderr.trim() || clone.stdout.trim()}`)
    }
  }

  const ensureSparseCheckout = async (): Promise<void> => {
    await mkdir(resolve(bareDir, "info"), { recursive: true })
    await Bun.write(resolve(bareDir, "info/sparse-checkout"), ".hack/tickets\n")
    await runGitDir({ args: ["config", "core.sparseCheckout", "true"] })
  }

  const ensureRemote = async (): Promise<{ readonly remoteUrl: string | null }> => {
    const remoteUrl = await resolveRemoteUrl()
    if (!remoteUrl) {
      await runGitDir({ args: ["remote", "remove", "origin"] }).catch(() => {})
      return { remoteUrl: null }
    }

    const set = await runGitDir({ args: ["remote", "set-url", "origin", remoteUrl] })
    if (!set.ok) {
      await runGitDir({ args: ["remote", "add", "origin", remoteUrl] }).catch(() => {})
    }

    return { remoteUrl }
  }

  const checkoutHead = async (input: {
    readonly remoteUrl: string | null
  }): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> => {
    await rm(worktreeDir, { recursive: true, force: true })
    await mkdir(worktreeDir, { recursive: true })

    if (input.remoteUrl) {
      const fetched = await runGitDir({
        args: ["fetch", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*"]
      })
      if (!fetched.ok) {
        return { ok: false, error: `git fetch failed: ${fetched.stderr.trim()}` }
      }

      const rev = await runGitDir({ args: ["rev-parse", "--verify", `origin/${branch}`] })
      if (rev.ok) {
        const checkout = await runGitDir({ args: ["checkout", "-B", branch, rev.stdout.trim()] })
        if (!checkout.ok) {
          return { ok: false, error: `git checkout failed: ${checkout.stderr.trim()}` }
        }

        const reset = await runGitDir({ args: ["reset", "--hard"] })
        if (!reset.ok) {
          return { ok: false, error: `git reset failed: ${reset.stderr.trim()}` }
        }

        return { ok: true }
      }
    }

    const localRef = await runGitDir({ args: ["rev-parse", "--verify", branch] })
    if (!localRef.ok) {
      const orphan = await runGitDir({ args: ["checkout", "--orphan", branch] })
      if (!orphan.ok) {
        return { ok: false, error: `git checkout --orphan failed: ${orphan.stderr.trim()}` }
      }

      await mkdir(resolve(worktreeDir, ".hack/tickets"), { recursive: true })
      await Bun.write(resolve(worktreeDir, ".hack/tickets/README.md"), "Tickets branch for hack-cli\n")

      const added = await runGitDir({ args: ["add", "-A"] })
      if (!added.ok) {
        return { ok: false, error: `git add failed: ${added.stderr.trim()}` }
      }
      const committed = await runGitDir({ args: ["commit", "-m", "init tickets"] })
      if (!committed.ok) {
        return { ok: false, error: `git commit failed: ${committed.stderr.trim()}` }
      }

      return { ok: true }
    }

    const checkout = await runGitDir({ args: ["checkout", branch] })
    if (!checkout.ok) {
      return { ok: false, error: `git checkout failed: ${checkout.stderr.trim()}` }
    }

    const reset = await runGitDir({ args: ["reset", "--hard"] })
    if (!reset.ok) {
      return { ok: false, error: `git reset failed: ${reset.stderr.trim()}` }
    }

    return { ok: true }
  }

  const ensureCheckedOut = async (): Promise<
    | { readonly ok: true; readonly remoteUrl: string | null }
    | { readonly ok: false; readonly error: string }
  > => {
    await ensureDirs()
    await ensureBareRepo()
    await ensureSparseCheckout()
    const { remoteUrl } = await ensureRemote()

    const checkedOut = await checkoutHead({ remoteUrl })
    if (!checkedOut.ok) return checkedOut

    return { ok: true, remoteUrl }
  }

  const resolveEventsPath = (tsSeconds: number): string => {
    const d = new Date(tsSeconds * 1000)
    const year = d.getUTCFullYear()
    const month = String(d.getUTCMonth() + 1).padStart(2, "0")
    return resolve(worktreeDir, `.hack/tickets/events/events-${year}-${month}.jsonl`)
  }

  const writeEvents = async (input: {
    readonly events: readonly Record<string, unknown>[]
  }): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> => {
    await mkdir(resolve(worktreeDir, ".hack/tickets/events"), { recursive: true })

    const grouped = new Map<string, Record<string, unknown>[]>()
    for (const ev of input.events) {
      const ts = typeof ev["ts"] === "number" ? (ev["ts"] as number) : Math.floor(Date.now() / 1000)
      const path = resolveEventsPath(ts)
      const list = grouped.get(path) ?? []
      list.push(ev)
      grouped.set(path, list)
    }

    for (const [path, events] of grouped) {
      const existing = await Bun.file(path).text().catch(() => "")
      const existingIds = new Set<string>()
      for (const line of existing.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const parsed = safeJsonParse(trimmed)
        if (isRecord(parsed) && typeof parsed["eventId"] === "string") {
          existingIds.add(parsed["eventId"])
        }
      }

      const lines: string[] = []
      for (const ev of events) {
        const id = typeof ev["eventId"] === "string" ? ev["eventId"] : ""
        if (!id || existingIds.has(id)) continue
        lines.push(stableStringify(ev))
      }

      if (lines.length > 0) {
        const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""
        await Bun.write(path, `${existing}${prefix}${lines.join("\n")}\n`)
      }
    }

    const normalized = await normalizeLogs()
    if (!normalized.ok) return normalized

    return { ok: true }
  }

  const normalizeLogs = async (): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> => {
    const eventsDir = resolve(worktreeDir, ".hack/tickets/events")
    let files: string[] = []
    try {
      files = (await readdir(eventsDir)).filter(f => f.endsWith(".jsonl"))
    } catch {
      return { ok: true }
    }

    for (const file of files.sort()) {
      const path = resolve(eventsDir, file)
      const text = await Bun.file(path).text().catch(() => "")
      const parsed: Record<string, unknown>[] = []
      const seen = new Set<string>()

      for (const line of text.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const value = safeJsonParse(trimmed)
        if (!isRecord(value)) continue
        const eventId = typeof value["eventId"] === "string" ? value["eventId"] : ""
        const ts = typeof value["ts"] === "number" ? value["ts"] : NaN
        if (!eventId || !Number.isFinite(ts)) continue
        if (seen.has(eventId)) continue
        seen.add(eventId)
        parsed.push(value)
      }

      parsed.sort((a, b) => {
        const aTs = typeof a["ts"] === "number" ? (a["ts"] as number) : 0
        const bTs = typeof b["ts"] === "number" ? (b["ts"] as number) : 0
        if (aTs !== bTs) return aTs - bTs
        const aId = typeof a["eventId"] === "string" ? (a["eventId"] as string) : ""
        const bId = typeof b["eventId"] === "string" ? (b["eventId"] as string) : ""
        return aId.localeCompare(bId)
      })

      const next = parsed.map(ev => stableStringify(ev)).join("\n")
      const normalized = next.length > 0 ? `${next}\n` : ""
      if (normalized !== text) {
        await Bun.write(path, normalized)
      }
    }

    return { ok: true }
  }

  const commitAll = async (message: string): Promise<
    | { readonly ok: true; readonly didCommit: boolean }
    | { readonly ok: false; readonly error: string }
  > => {
    const staged = await runGitDir({ args: ["add", "-A"] })
    if (!staged.ok) return { ok: false, error: `git add failed: ${staged.stderr.trim()}` }

    const commit = await runGitDir({ args: ["commit", "-m", message] })
    if (!commit.ok) {
      const msg = commit.stderr.trim()
      if (msg.includes("nothing to commit")) return { ok: true, didCommit: false }
      return { ok: false, error: `git commit failed: ${msg}` }
    }

    return { ok: true, didCommit: true }
  }

  const pushWithRetry = async (input: {
    readonly remoteUrl: string | null
    readonly pendingEvents?: readonly Record<string, unknown>[]
  }): Promise<{ readonly ok: true; readonly didPush: boolean } | { readonly ok: false; readonly error: string }> => {
    if (!input.remoteUrl) return { ok: true, didPush: false }

    const push = await runGitDir({ args: ["push", "origin", `${branch}:${branch}`] })
    if (push.ok) return { ok: true, didPush: true }

    opts.logger.warn({ message: `git push failed, retrying after fetch: ${push.stderr.trim()}` })

    const checkedOut = await checkoutHead({ remoteUrl: input.remoteUrl })
    if (!checkedOut.ok) return checkedOut

    if (input.pendingEvents && input.pendingEvents.length > 0) {
      const wrote = await writeEvents({ events: input.pendingEvents })
      if (!wrote.ok) return wrote
    }

    const committed = await commitAll("tickets: retry")
    if (!committed.ok) return committed

    const retry = await runGitDir({ args: ["push", "origin", `${branch}:${branch}`] })
    if (!retry.ok) return { ok: false, error: `git push failed: ${retry.stderr.trim()}` }

    return { ok: true, didPush: true }
  }

  const appendEvents = async (input: {
    readonly events: readonly Record<string, unknown>[]
  }): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> => {
    const checkedOut = await ensureCheckedOut()
    if (!checkedOut.ok) return checkedOut

    const wrote = await writeEvents({ events: input.events })
    if (!wrote.ok) return wrote

    const committed = await commitAll("tickets: append events")
    if (!committed.ok) return committed

    const pushed = await pushWithRetry({
      remoteUrl: checkedOut.remoteUrl,
      pendingEvents: input.events
    })
    if (!pushed.ok) return pushed

    return { ok: true }
  }

  const sync = async (): Promise<
    | {
        readonly ok: true
        readonly branch: string
        readonly remote?: string
        readonly didCommit: boolean
        readonly didPush: boolean
      }
    | { readonly ok: false; readonly error: string }
  > => {
    const checkedOut = await ensureCheckedOut()
    if (!checkedOut.ok) return checkedOut

    const normalized = await normalizeLogs()
    if (!normalized.ok) return normalized

    const committed = await commitAll("tickets: sync")
    if (!committed.ok) return committed

    const pushed = await pushWithRetry({ remoteUrl: checkedOut.remoteUrl })
    if (!pushed.ok) return pushed

    return {
      ok: true,
      branch,
      ...(checkedOut.remoteUrl ? { remote: remoteName } : {}),
      didCommit: committed.didCommit,
      didPush: pushed.didPush
    }
  }

  return {
    ensureCheckedOut: async () => {
      const checkedOut = await ensureCheckedOut()
      if (!checkedOut.ok) throw new Error(checkedOut.error)
      return worktreeDir
    },
    appendEvents,
    sync
  }
}

async function runGit(opts: {
  readonly cwd: string
  readonly args: readonly string[]
}): Promise<{ readonly ok: boolean; readonly stdout: string; readonly stderr: string }> {
  const proc = Bun.spawn(["git", ...opts.args], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore"
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  return { ok: exitCode === 0, stdout, stderr }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
