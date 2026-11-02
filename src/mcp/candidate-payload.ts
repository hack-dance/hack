import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../lib/guards.ts";
import { verifyMcpBundle } from "./bundle.ts";

const BUNDLE_ID = /^[a-f0-9]{64}$/;

/** Older native bundles have no MCP payload. New bundles contain exactly one
 * verified content-addressed selection; never recursively archive arbitrary files.
 */
export async function nativeCandidateMcpPayload(
  root: string
): Promise<string[]> {
  const directory = join(root, "mcp");
  const stat = await lstat(directory).catch((error: unknown) => {
    if (isRecord(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (!stat) {
    return [];
  }
  if (!stat.isDirectory()) {
    throw new Error("Native MCP payload must be a directory, not an alias");
  }
  const names = await readdir(directory);
  const id = names[0];
  if (names.length !== 1 || !id || !BUNDLE_ID.test(id)) {
    throw new Error("Native MCP payload must contain exactly one bundle ID");
  }
  const verified = await verifyMcpBundle({ directory: join(directory, id) });
  if (verified.manifest.bundleId !== id) {
    throw new Error("Native MCP directory must match its bundle identity");
  }
  return [
    "manifest.json",
    "hack-mcp-adapter",
    "hack-mcp-owner",
    "hack-mcp-backend",
  ].map((name) => `mcp/${id}/${name}`);
}
