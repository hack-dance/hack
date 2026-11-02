import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { inspectActiveNativeHttpsOwner } from "../backends/native-project-https.ts";
import type { NativeRuntimeSelection } from "../backends/native-runtime-client.ts";
import { DEFAULT_HOST_DNS_IP } from "../constants.ts";
import {
  type AdministratorAuthorization,
  describeAdministratorAuthorizationFailure,
  requestAdministratorAuthorization,
} from "./admin-authorization.ts";
import { canPrompt, confirmSafe } from "./interactivity.ts";
import {
  type NativeDnsCommandRunner,
  runNativeDnsAttachedCommand,
  runPrivilegedResolverOperation,
} from "./native-domain-dns-host.ts";
import { prepareNativeDnsLaunchdRestart } from "./native-domain-dns-launchd.ts";
import {
  inspectNativeDnsHost,
  readStableNativeDnsFile,
} from "./native-domain-dns-snapshot.ts";
import {
  HACK_LOCAL_DOMAIN,
  type HackLocalRouteAuthorization,
  type HackLocalRouteDependencies,
  type HackLocalRouteReceipt,
} from "./native-hack-local-route.ts";
import { exec } from "./shell.ts";

const IDENTITY = /^\d+:\d+$/;
const IP_ADDRESS_LINE = /^ip_address:\s*(\S+)\s*$/gm;
const PROBE_TIMEOUT_MS = 1500;
const RECEIPT_FILENAME = "hack-local-route.json";
const LOCK_HOLDER = /^(\d+)\n$/;

/** Private receipt location under the native runtime home. */
export function hackLocalRouteReceiptPath(runtimeHome: string): string {
  return join(runtimeHome, "native-dns", RECEIPT_FILENAME);
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      throw error;
    }
  }
}

/** Read a small lock file without following links; null when it is gone. */
async function readLockFile(path: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
  try {
    const buffer = Buffer.alloc(32);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Write bytes to a fresh sibling and rename it over target only if `guard`
 * still passes immediately before publication. The rename is atomic, so an
 * interrupted write leaves either the old or the new complete file.
 */
async function replaceAtomically(opts: {
  readonly path: string;
  readonly content: string;
  readonly mode: number;
  readonly guard: () => Promise<void>;
}): Promise<void> {
  const temporary = join(
    dirname(opts.path),
    `.${basename(opts.path)}.hack-${randomUUID()}.tmp`
  );
  const handle = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    opts.mode
  );
  try {
    try {
      await handle.writeFile(opts.content, "utf8");
      await handle.chmod(opts.mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await opts.guard();
    await rename(temporary, opts.path);
    await syncDirectory(dirname(opts.path));
  } finally {
    await unlinkIfPresent(temporary);
  }
}

async function ensurePrivateDirectory(
  path: string,
  ownerUid: number | undefined
): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) {
      throw error;
    }
  }
  const details = await lstat(path);
  if (
    !details.isDirectory() ||
    (details.mode & 0o077) !== 0 ||
    details.uid !== ownerUid
  ) {
    throw new Error("hack.local repair receipt directory is not private");
  }
}

export interface HackLocalRouteFileOptions {
  readonly dnsmasqPath: string;
  readonly includeDir: string;
  readonly resolverPath: string;
  readonly receiptPath: string;
  /** Testing seam; production runs the bounded resolver script with sudo -n. */
  readonly runPrivileged?: NativeDnsCommandRunner;
  /** Testing seam for the required owner; defaults to the current user. */
  readonly ownerUid?: number;
}

/** True when a process with this pid exists (possibly another user's). */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

/**
 * Exclusive lock beside the receipt. The holder pid is written to a private
 * sibling first and published with link(), which never replaces an existing
 * lock, so a lock file is always complete. A lock whose holder no longer
 * exists is stale and is taken over once. Two runs that both find the same
 * stale lock could race; each run also needs an interactive prompt, so that
 * window is not reachable in practice.
 */
async function acquireRouteLock(opts: {
  readonly receiptPath: string;
  readonly ownerUid: number | undefined;
}): Promise<(() => Promise<void>) | null> {
  const directory = dirname(opts.receiptPath);
  await ensurePrivateDirectory(directory, opts.ownerUid);
  const lockPath = `${opts.receiptPath}.lock`;
  const staged = join(directory, `.${RECEIPT_FILENAME}.lock-${randomUUID()}`);
  const handle = await open(
    staged,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600
  );
  try {
    await handle.writeFile(`${process.pid}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await link(staged, lockPath);
        return async () => await unlinkIfPresent(lockPath);
      } catch (error) {
        if (!isErrno(error, "EEXIST")) {
          throw error;
        }
      }
      const holder = LOCK_HOLDER.exec((await readLockFile(lockPath)) ?? "");
      if (holder && processExists(Number(holder[1]))) {
        return null;
      }
      await unlinkIfPresent(lockPath);
    }
    return null;
  } finally {
    await unlinkIfPresent(staged);
  }
}

type FileDependencies = Pick<
  HackLocalRouteDependencies,
  | "paths"
  | "readReceipt"
  | "writeReceipt"
  | "readDnsmasq"
  | "readIncludeFiles"
  | "readResolver"
  | "replaceDnsmasq"
  | "createResolver"
  | "removeResolverIfOwned"
  | "acquireLock"
>;

/**
 * File effects rooted at explicit paths. The dnsmasq file must be a regular
 * single-link file owned by the caller (as Homebrew installs it); its mode is
 * preserved. Resolver changes use the existing privileged resolver script.
 */
export function createHackLocalRouteFileDependencies(
  opts: HackLocalRouteFileOptions
): FileDependencies {
  const ownerUid = opts.ownerUid ?? process.getuid?.();
  return {
    paths: {
      dnsmasqPath: opts.dnsmasqPath,
      includeDir: opts.includeDir,
      resolverPath: opts.resolverPath,
      receiptPath: opts.receiptPath,
    },
    readReceipt: async () => await readStableNativeDnsFile(opts.receiptPath),
    async writeReceipt(receipt: HackLocalRouteReceipt) {
      await ensurePrivateDirectory(dirname(opts.receiptPath), ownerUid);
      await replaceAtomically({
        path: opts.receiptPath,
        content: `${JSON.stringify(receipt, null, 2)}\n`,
        mode: 0o600,
        guard: async () => undefined,
      });
    },
    readDnsmasq: async () => await readStableNativeDnsFile(opts.dnsmasqPath),
    async readIncludeFiles() {
      let names: string[];
      try {
        names = await readdir(opts.includeDir);
      } catch (error) {
        if (isErrno(error, "ENOENT")) {
          return [];
        }
        throw error;
      }
      const files: { path: string; content: string }[] = [];
      for (const name of names
        .filter((entry) => entry.endsWith(".conf"))
        .sort()) {
        const path = join(opts.includeDir, name);
        const content = await readStableNativeDnsFile(path);
        if (content !== null) {
          files.push({ path, content });
        }
      }
      return files;
    },
    readResolver: async () => await readStableNativeDnsFile(opts.resolverPath),
    async replaceDnsmasq({ expected, next }) {
      const details = await lstat(opts.dnsmasqPath);
      if (
        !details.isFile() ||
        details.nlink !== 1 ||
        details.uid !== ownerUid
      ) {
        throw new Error(
          `${opts.dnsmasqPath} is not a regular file owned by the current user; refusing to rewrite it`
        );
      }
      await replaceAtomically({
        path: opts.dnsmasqPath,
        content: next,
        mode: details.mode & 0o7777,
        guard: async () => {
          const current = await readStableNativeDnsFile(opts.dnsmasqPath);
          if (current !== expected) {
            throw new Error(
              "dnsmasq configuration changed before replacement; nothing was written"
            );
          }
        },
      });
      if ((await readStableNativeDnsFile(opts.dnsmasqPath)) !== next) {
        throw new Error(
          "dnsmasq configuration did not contain the written bytes"
        );
      }
    },
    async createResolver(content) {
      const identity = await runPrivilegedResolverOperation({
        action: "create",
        file: { path: opts.resolverPath, content },
        runPrivileged: opts.runPrivileged,
      });
      if (!IDENTITY.test(identity)) {
        throw new Error("Resolver create returned no valid ownership identity");
      }
      return identity;
    },
    acquireLock: async () =>
      await acquireRouteLock({ receiptPath: opts.receiptPath, ownerUid }),
    async removeResolverIfOwned({ identity, content }) {
      const result = await runPrivilegedResolverOperation({
        action: "remove",
        file: { path: opts.resolverPath, content, identity },
        runPrivileged: opts.runPrivileged,
      });
      if (result !== "0" && result !== "1") {
        throw new Error("Resolver remove returned an invalid result");
      }
      return result === "1";
    },
  };
}

/** Bounded TCP connect; any error or timeout means the target did not answer. */
export async function probeTcp(opts: {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs?: number;
}): Promise<boolean> {
  return await new Promise((resolvePromise) => {
    const socket = createConnection({
      host: opts.host,
      port: opts.port,
      timeout: opts.timeoutMs ?? PROBE_TIMEOUT_MS,
    });
    const finish = (answered: boolean) => {
      socket.destroy();
      resolvePromise(answered);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

async function runCommand(command: readonly string[]) {
  return await exec(command, { stdin: "ignore", timeoutMs: 5000 });
}

async function resolveBrewPrefix(): Promise<string> {
  const result = await exec(["brew", "--prefix"], { stdin: "ignore" });
  const prefix = result.exitCode === 0 ? result.stdout.trim() : "";
  return prefix.length > 0 ? prefix : "/opt/homebrew";
}

async function privileged(command: readonly string[], action: string) {
  const result = await runNativeDnsAttachedCommand({ command });
  if (result.exitCode !== 0) {
    throw new Error(`${action} failed (exit ${result.exitCode})`);
  }
}

async function verifyLiveHackLocalDns(): Promise<void> {
  const name = `hack-probe-${randomUUID().replaceAll("-", "")}.${HACK_LOCAL_DOMAIN}`;
  const direct = await runCommand([
    "/usr/bin/dig",
    "+short",
    "+time=2",
    "+tries=1",
    `@${DEFAULT_HOST_DNS_IP}`,
    name,
    "A",
  ]);
  if (direct.exitCode !== 0 || direct.stdout.trim() !== DEFAULT_HOST_DNS_IP) {
    throw new Error(
      `dnsmasq did not answer ${name} with ${DEFAULT_HOST_DNS_IP}`
    );
  }
  const system = await runCommand([
    "/usr/bin/dscacheutil",
    "-q",
    "host",
    "-a",
    "name",
    name,
  ]);
  const addresses = [...system.stdout.matchAll(IP_ADDRESS_LINE)].map(
    (match) => match[1]
  );
  if (
    system.exitCode !== 0 ||
    addresses.length === 0 ||
    addresses.some((address) => address !== DEFAULT_HOST_DNS_IP)
  ) {
    throw new Error(`macOS did not resolve ${name} to ${DEFAULT_HOST_DNS_IP}`);
  }
}

/**
 * Confirmation first, then the native administrator prompt. A "no" never
 * reaches sudo; an approved change whose prompt fails is reported as
 * `authorization-failed`, never as a decline.
 */
export function createHackLocalRouteAuthorizer(deps: {
  readonly confirm: (message: string) => Promise<boolean>;
  readonly requestAdministrator: () => Promise<AdministratorAuthorization>;
}): (message: string) => Promise<HackLocalRouteAuthorization> {
  return async (message) => {
    if (!(await deps.confirm(message))) {
      return { outcome: "declined" };
    }
    const result = await deps.requestAdministrator();
    if (result.status === "authorized") {
      return { outcome: "approved" };
    }
    return {
      outcome: "authorization-failed",
      detail: describeAdministratorAuthorizationFailure(result),
    };
  };
}

async function confirmRouteChange(message: string): Promise<boolean> {
  return await confirmSafe({
    message,
    initialValue: false,
    nonInteractive: "decline",
  });
}

/**
 * Production wiring for the native macOS host: Homebrew dnsmasq, the
 * /etc/resolver directory, the verified native relay owner, the system
 * launchd dnsmasq job and the native administrator prompt.
 */
export async function createNativeHackLocalRouteDependencies(opts: {
  readonly runtime: NativeRuntimeSelection;
}): Promise<HackLocalRouteDependencies> {
  const prefix = await resolveBrewPrefix();
  const dnsmasqPath = resolve(prefix, "etc", "dnsmasq.conf");
  const includeDir = resolve(prefix, "etc", "dnsmasq.d");
  const files = createHackLocalRouteFileDependencies({
    dnsmasqPath,
    includeDir,
    resolverPath: join("/etc/resolver", HACK_LOCAL_DOMAIN),
    receiptPath: hackLocalRouteReceiptPath(opts.runtime.home),
  });
  return {
    ...files,
    async verifyRelay() {
      try {
        const owner = await inspectActiveNativeHttpsOwner({
          runtime: opts.runtime,
        });
        const listening = await probeTcp({
          host: DEFAULT_HOST_DNS_IP,
          port: owner.httpsPort,
        });
        return listening ? { port: owner.httpsPort } : null;
      } catch {
        return null;
      }
    },
    probeTarget: async (target) => await probeTcp({ host: target, port: 443 }),
    canPrompt: () => canPrompt(),
    authorize: createHackLocalRouteAuthorizer({
      confirm: confirmRouteChange,
      requestAdministrator: async () =>
        await requestAdministratorAuthorization(),
    }),
    confirm: confirmRouteChange,
    async prepareRestart() {
      const host = await inspectNativeDnsHost({ brewPrefix: prefix });
      if (host.mainConfig.path !== dnsmasqPath) {
        throw new Error(
          "Running dnsmasq does not load the inspected configuration"
        );
      }
      return await prepareNativeDnsLaunchdRestart({
        dnsmasqBinary: host.dnsmasqArgs[0] ?? "",
        mainConfigPath: host.mainConfig.path,
        includeDir: host.includeDir,
        inspectedArgs: host.dnsmasqArgs,
      });
    },
    async flushDnsCache() {
      await privileged(
        ["sudo", "-n", "/usr/bin/dscacheutil", "-flushcache"],
        "dscacheutil -flushcache"
      );
      await privileged(
        ["sudo", "-n", "/usr/bin/killall", "-HUP", "mDNSResponder"],
        "killall -HUP mDNSResponder"
      );
    },
    verifyLiveDns: verifyLiveHackLocalDns,
    now: () => new Date(),
  };
}
