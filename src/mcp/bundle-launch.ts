import { constants } from "node:fs";
import { access, lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { resolveGlobalHackDir } from "../lib/config-paths.ts";
import { isRecord } from "../lib/guards.ts";
import { verifyMcpBundle } from "./bundle.ts";

export type McpLaunch = {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
};

export type McpBundleSelection = {
  readonly directory: string;
  readonly cli: string;
  readonly runtimeDirectory?: string;
};

/** Validate before any configuration edits. Preview does not create runtime state. */
export async function prepareMcpBundleLaunch(opts: {
  readonly selection: McpBundleSelection;
  readonly createRuntime: boolean;
}): Promise<McpLaunch> {
  const bundle = await verifyMcpBundle({ directory: opts.selection.directory });
  const cli = await realpath(resolve(opts.selection.cli));
  if (!(await lstat(cli)).isFile()) {
    throw new Error("Candidate CLI must be an executable file");
  }
  await access(cli, constants.X_OK);
  const requested = resolve(
    opts.selection.runtimeDirectory ??
      join(resolveGlobalHackDir(), "mcp", bundle.manifest.bundleId.slice(0, 16))
  );
  // Reject a final-path alias before canonicalizing parents (e.g. macOS /tmp).
  const initial = await lstat(requested).catch((error: unknown) => {
    if (isRecord(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (
    initial &&
    (!initial.isDirectory() ||
      initial.uid !== process.getuid?.() ||
      (initial.mode & 0o077) !== 0)
  ) {
    throw new Error(
      "MCP runtime directory must be private and owned by this user"
    );
  }
  // Resolve the longest existing ancestor without creating anything for preview.
  let ancestor = requested;
  const suffix: string[] = [];
  for (;;) {
    try {
      ancestor = await realpath(ancestor);
      break;
    } catch (error: unknown) {
      if (!isRecord(error) || error.code !== "ENOENT") {
        throw error;
      }
      suffix.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
  const directory = join(ancestor, ...suffix);
  const socket = join(directory, "mcp.sock");
  if (Buffer.byteLength(socket) > 103) {
    throw new Error(
      "MCP socket path is too long; select a shorter --runtime-directory"
    );
  }
  if (opts.createRuntime) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (
      !stat.isDirectory() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0
    ) {
      throw new Error("MCP runtime directory changed or is not private");
    }
  }
  return {
    command: bundle.executables.adapter,
    args: [
      "--socket",
      socket,
      "--backend-id",
      bundle.manifest.bundleId,
      "--owner",
      bundle.executables.owner,
      "--backend",
      bundle.executables.backend,
    ],
    env: { HACK_MCP_COMMAND: cli },
  };
}
