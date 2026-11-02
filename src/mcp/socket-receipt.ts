import { constants, fstatSync } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { join } from "node:path";

/** Persist only filesystem identities, never session context. The native exec
 * launcher owns the retained lease; an ordinary unwrapped backend has no receipt.
 */
export async function recordMcpSocketReceipt(opts: {
  directory: string;
  claim: { dev: number; ino: number };
  socket: { dev: number; ino: number };
}): Promise<() => Promise<void>> {
  const descriptor = process.env.HACK_MCP_LEASE_FD;
  const suppliedDirectory = process.env.HACK_MCP_LEASE_DIRECTORY;
  if (descriptor === undefined && suppliedDirectory === undefined) {
    return async () => undefined;
  }
  const fd = Number(descriptor);
  if (
    !(descriptor && Number.isSafeInteger(fd)) ||
    fd < 0 ||
    suppliedDirectory !== opts.directory
  ) {
    throw new Error("Invalid MCP ownership handoff");
  }
  const lease = fstatSync(fd, { bigint: true });
  const atPath = await lstat(join(opts.directory, ".mcp-lease"), {
    bigint: true,
  });
  if (
    !lease.isFile() ||
    lease.nlink !== 1n ||
    lease.uid !== BigInt(process.getuid?.() ?? -1) ||
    (lease.mode & 0o077n) !== 0n ||
    lease.size !== 0n ||
    lease.dev !== atPath.dev ||
    lease.ino !== atPath.ino ||
    !atPath.isFile()
  ) {
    throw new Error("MCP ownership lease identity changed");
  }
  const directory = await lstat(opts.directory, { bigint: true });
  const identity = (value: { dev: bigint; ino: bigint }) => ({
    dev: String(value.dev),
    ino: String(value.ino),
  });
  const known = (value: { dev: number; ino: number }) => {
    if (!(Number.isSafeInteger(value.dev) && Number.isSafeInteger(value.ino))) {
      throw new Error("Unrepresentable MCP filesystem identity");
    }
    return { dev: String(value.dev), ino: String(value.ino) };
  };
  const path = join(opts.directory, ".mcp-receipt.json");
  const file = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600
  );
  const owned = await file.stat({ bigint: true });
  try {
    const receipt = {
      version: 1,
      directory: identity(directory),
      lease: identity(lease),
      claim: known(opts.claim),
      socket: known(opts.socket),
    };
    await file.writeFile(`${JSON.stringify(receipt)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  return async () => {
    const current = await lstat(path, { bigint: true }).catch(() => null);
    if (current?.dev === owned.dev && current.ino === owned.ino) {
      await unlink(path);
    }
  };
}
