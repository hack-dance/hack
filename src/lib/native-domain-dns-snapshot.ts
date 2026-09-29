import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { exec } from "./shell.ts";

const MAX_DNS_FILE_BYTES = 1_048_576;
const DNSMASQ_PROCESS = /(?:^|\/)dnsmasq$/;
const WHITESPACE = /\s+/;

export interface NativeDnsFileSnapshot {
  readonly path: string;
  readonly content: string;
}

export interface NativeDnsHostSnapshot {
  readonly mainConfig: NativeDnsFileSnapshot;
  readonly includeDir: string;
  readonly includeFiles: readonly NativeDnsFileSnapshot[];
  readonly resolverDir: string;
  readonly resolverFiles: readonly NativeDnsFileSnapshot[];
  readonly hosts: NativeDnsFileSnapshot;
  readonly dnsmasqArgs: readonly string[];
}

function missing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/** Read a bounded regular file through a non-following descriptor. */
export async function readStableNativeDnsFile(
  path: string
): Promise<string | null> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  ).catch((error: unknown) => {
    if (missing(error)) {
      return null;
    }
    throw new Error(`Unable to read DNS configuration safely: ${path}`);
  });
  if (!file) {
    return null;
  }
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size > MAX_DNS_FILE_BYTES
    ) {
      throw new Error("DNS configuration is not a bounded regular file");
    }
    const bytes = await file.readFile();
    const after = await file.stat();
    if (
      bytes.length !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error("DNS configuration changed during inspection");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    await file.close();
  }
}

async function readFilesInDirectory(
  directory: string,
  include: (name: string) => boolean
): Promise<readonly NativeDnsFileSnapshot[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: NativeDnsFileSnapshot[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!include(entry.name)) {
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(
        `DNS configuration entry is not a regular file: ${entry.name}`
      );
    }
    const path = join(directory, entry.name);
    const content = await readStableNativeDnsFile(path);
    if (content === null) {
      throw new Error("DNS configuration disappeared during inspection");
    }
    files.push({ path, content });
  }
  return files;
}

async function activeDnsmasqArgs(): Promise<readonly string[]> {
  const result = await exec(["/bin/ps", "-ww", "-axo", "command="], {
    stdin: "ignore",
    timeoutMs: 3000,
  });
  if (result.exitCode !== 0) {
    throw new Error("Unable to inspect the active dnsmasq process");
  }
  const commands = result.stdout
    .split("\n")
    .map((line) => line.trim().split(WHITESPACE))
    .filter((args) => DNSMASQ_PROCESS.test(args[0] ?? ""));
  if (commands.length !== 1) {
    throw new Error(
      "Native DNS activation requires one identifiable dnsmasq process"
    );
  }
  return commands[0] ?? [];
}

/** Snapshot only the host files and active process that a scoped DNS plan must check. */
export async function inspectNativeDnsHost(opts: {
  readonly brewPrefix: string;
  readonly resolverDir?: string;
  readonly hostsPath?: string;
}): Promise<NativeDnsHostSnapshot> {
  const mainPath = resolve(opts.brewPrefix, "etc", "dnsmasq.conf");
  const includeDir = resolve(opts.brewPrefix, "etc", "dnsmasq.d");
  const resolverDir = opts.resolverDir ?? "/etc/resolver";
  const hostsPath = opts.hostsPath ?? "/etc/hosts";
  const [main, includeFiles, resolverFiles, hosts, dnsmasqArgs] =
    await Promise.all([
      readStableNativeDnsFile(mainPath),
      readFilesInDirectory(includeDir, (name) => name.endsWith(".conf")),
      readFilesInDirectory(resolverDir, () => true),
      readStableNativeDnsFile(hostsPath),
      activeDnsmasqArgs(),
    ]);
  if (main === null || hosts === null) {
    throw new Error("Required host DNS configuration is missing");
  }
  return {
    mainConfig: { path: mainPath, content: main },
    includeDir,
    includeFiles,
    resolverDir,
    resolverFiles,
    hosts: { path: hostsPath, content: hosts },
    dnsmasqArgs,
  };
}
