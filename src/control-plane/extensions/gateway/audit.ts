import { appendFile } from "node:fs/promises"
import { resolve } from "node:path"

import { ensureDir } from "../../../lib/fs.ts"

export type GatewayAuditEntry = {
  readonly ts: string
  readonly tokenId?: string
  readonly method: string
  readonly path: string
  readonly status: number
  readonly remoteAddress?: string
  readonly userAgent?: string
}

const GATEWAY_DIR = "gateway"
const AUDIT_FILENAME = "audit.jsonl"

/**
 * Append a gateway audit entry.
 *
 * @param opts.rootDir - Daemon root directory.
 * @param opts.entry - Audit entry to append.
 */
export async function appendGatewayAuditEntry(opts: {
  readonly rootDir: string
  readonly entry: GatewayAuditEntry
}): Promise<void> {
  try {
    const dir = resolve(opts.rootDir, GATEWAY_DIR)
    await ensureDir(dir)
    const path = resolve(dir, AUDIT_FILENAME)
    await appendFile(path, `${JSON.stringify(opts.entry)}\n`)
  } catch {
  }
}
