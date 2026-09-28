import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  NativeDnsActivationDependencies,
  NativeDnsOwnedFile,
} from "./native-domain-dns-activate.ts";
import { NativeDnsUncertainEffectError } from "./native-domain-dns-activate.ts";
import type { NativeDnsReceipt } from "./native-domain-dns-plan.ts";
import { type ExecResult, exec } from "./shell.ts";

const MAX_FILE_BYTES = 1024 * 1024;
const IDENTITY = /^\d+:\d+$/;
const IP_ADDRESS_LINE = /^ip_address:\s*(\S+)\s*$/gm;
const PRIVILEGED_RESOLVER_SCRIPT = `import os, stat, sys
action, path, content, expected = sys.argv[1:5]
if os.path.dirname(path) != '/etc/resolver' or os.path.basename(path) in ('', '.', '..'):
    raise ValueError('resolver path is outside /etc/resolver')
name = os.path.basename(path)
data = content.encode('utf-8')
if len(data) > 1048576:
    raise ValueError('resolver content exceeds limit')
directory = os.open('/etc/resolver', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    if action == 'create':
        file = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=directory)
        created = os.fstat(file)
        try:
            with os.fdopen(file, 'wb', closefd=False) as output:
                output.write(data)
                output.flush()
            os.fsync(file)
            os.fsync(directory)
            print(str(created.st_dev) + ':' + str(created.st_ino))
        except BaseException:
            current = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if (current.st_dev, current.st_ino) == (created.st_dev, created.st_ino):
                os.unlink(name, dir_fd=directory)
                os.fsync(directory)
            raise
        finally:
            os.close(file)
    elif action == 'remove':
        try:
            file = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        except FileNotFoundError:
            print('0')
        else:
            try:
                owned = os.fstat(file)
                identity = str(owned.st_dev) + ':' + str(owned.st_ino)
                if not stat.S_ISREG(owned.st_mode) or owned.st_nlink != 1 or identity != expected or os.read(file, len(data) + 1) != data:
                    print('0')
                else:
                    current = os.stat(name, dir_fd=directory, follow_symlinks=False)
                    if (current.st_dev, current.st_ino) != (owned.st_dev, owned.st_ino):
                        print('0')
                    else:
                        os.unlink(name, dir_fd=directory)
                        os.fsync(directory)
                        print('1')
            finally:
                os.close(file)
    else:
        raise ValueError('unknown resolver operation')
finally:
    os.close(directory)
`;

export type NativeDnsCommandRunner = (
  command: readonly string[]
) => Promise<ExecResult>;

export interface NativeDnsHostDependenciesOptions {
  readonly receiptPath: string;
  readonly dnsmasqPath: string;
  readonly resolverPath: string;
  readonly dnsmasqBinary: string;
  readonly dnsmasqMainConfigPath: string;
  readonly dnsmasqIncludeDir: string;
  readonly inspectPlan: NativeDnsActivationDependencies["inspectPlan"];
  readonly authorize: NativeDnsActivationDependencies["authorize"];
  readonly restartDnsmasq: NativeDnsActivationDependencies["restartDnsmasq"];
  readonly flushDnsCache: NativeDnsActivationDependencies["flushDnsCache"];
  /** Testing seam; production uses bounded, noninteractive subprocesses. */
  readonly runCommand?: NativeDnsCommandRunner;
  /** Testing seam; production uses sudo -n after the caller's native authorization. */
  readonly runPrivileged?: NativeDnsCommandRunner;
}

export interface NativeDnsHostDependencies
  extends NativeDnsActivationDependencies {
  readonly adoptReceipt: (
    receipt: NativeDnsReceipt
  ) => Promise<NativeDnsOwnedFile>;
  readonly inspectOwnedFile: (
    path: string
  ) => Promise<NativeDnsOwnedFile | null>;
  readonly verifyDeactivatedDns: (plan: {
    readonly domain: string;
    readonly parentAddress: string | null;
  }) => Promise<void>;
}

async function defaultRunner(command: readonly string[]): Promise<ExecResult> {
  return await exec(command, { stdin: "ignore", timeoutMs: 15_000 });
}

function assertSuccess(result: ExecResult, action: string): string {
  if (result.exitCode !== 0) {
    throw new Error(`${action} failed (exit ${result.exitCode})`);
  }
  if (result.stdout.length > MAX_FILE_BYTES) {
    throw new Error(`${action} returned oversized output`);
  }
  return result.stdout.trim();
}

function fileIdentity(value: {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}): string {
  return `${value.dev}:${value.ino}`;
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

async function ensurePrivateReceiptDirectory(path: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
    if (
      !(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST"
      )
    ) {
      throw error;
    }
  });
  const details = await lstat(directory);
  const getuid = process.getuid;
  if (
    !details.isDirectory() ||
    (details.mode & 0o077) !== 0 ||
    typeof getuid !== "function" ||
    details.uid !== getuid()
  ) {
    throw new Error("Private DNS receipt directory is not owned privately");
  }
}

async function readOwnedFile(
  path: string
): Promise<{ readonly identity: string; readonly content: string } | null> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size > MAX_FILE_BYTES
    ) {
      throw new Error(`DNS file is not a bounded regular file: ${path}`);
    }
    const bytes = await file.readFile();
    const after = await file.stat();
    if (
      bytes.length !== before.size ||
      fileIdentity(before) !== fileIdentity(after) ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error(`DNS file changed while reading: ${path}`);
    }
    return {
      identity: fileIdentity(before),
      content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } finally {
    await file.close();
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
}

async function removeLocalIfOwned(file: NativeDnsOwnedFile): Promise<boolean> {
  const actual = await readOwnedFile(file.path);
  if (
    !actual ||
    actual.identity !== file.identity ||
    actual.content !== file.content
  ) {
    return false;
  }
  const current = await lstat(file.path, { bigint: true });
  if (fileIdentity(current) !== file.identity) {
    return false;
  }
  try {
    await unlink(file.path);
    await syncDirectory(dirname(file.path));
  } catch (error) {
    throw new NativeDnsUncertainEffectError(
      `DNS removal completion is uncertain: ${file.path}`,
      error
    );
  }
  return true;
}

async function createLocalExclusive(file: {
  readonly path: string;
  readonly content: string;
}): Promise<NativeDnsOwnedFile> {
  if (Buffer.byteLength(file.content, "utf8") > MAX_FILE_BYTES) {
    throw new Error("DNS file content exceeds limit");
  }
  const handle = await open(
    file.path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o644
  );
  let identity: string | null = null;
  try {
    identity = fileIdentity(await handle.stat());
    await handle.writeFile(file.content, "utf8");
    await handle.sync();
    await syncDirectory(dirname(file.path));
    await handle.close();
    return { ...file, identity };
  } catch (error) {
    await handle.close().catch(() => undefined);
    let removed = false;
    try {
      const partial = await readOwnedFile(file.path);
      removed =
        identity !== null &&
        partial?.identity === identity &&
        (await removeLocalIfOwned({
          ...file,
          content: partial.content,
          identity,
        }));
    } catch (cleanupError) {
      throw new NativeDnsUncertainEffectError(
        `DNS create cleanup could not confirm removal: ${file.path}`,
        cleanupError
      );
    }
    if (!removed) {
      throw new NativeDnsUncertainEffectError(
        `DNS create failed and cleanup is uncertain: ${file.path}`,
        error
      );
    }
    throw error;
  }
}

function receiptContent(receipt: NativeDnsReceipt): string {
  return `${JSON.stringify(receipt)}\n`;
}

function expectedPreviousReceipt(
  receipt: NativeDnsReceipt
): readonly NativeDnsReceipt[] {
  if (receipt.state === "pending") {
    return [
      { ...receipt, state: "active" },
      { ...receipt, state: "inactive" },
    ];
  }
  if (receipt.state === "removing") {
    return [{ ...receipt, state: "active" }];
  }
  if (receipt.state === "inactive") {
    return [{ ...receipt, state: "removing" }];
  }
  return [
    { ...receipt, state: "pending" },
    { ...receipt, state: "removing" },
  ];
}

function assertReceiptState(opts: {
  readonly receipt: NativeDnsReceipt;
  readonly existing: {
    readonly identity: string;
    readonly content: string;
  } | null;
  readonly ownedIdentity: string | null;
}): void {
  const { receipt, existing, ownedIdentity } = opts;
  if (receipt.state === "pending" && !existing && ownedIdentity !== null) {
    throw new Error("Expected owned receipt disappeared");
  }
  if (
    existing &&
    (existing.identity !== ownedIdentity ||
      !expectedPreviousReceipt(receipt).some(
        (previous) => existing.content === receiptContent(previous)
      ))
  ) {
    throw new Error("Private DNS receipt changed before publication");
  }
  if (!existing && receipt.state !== "pending") {
    throw new Error("Pending DNS receipt is missing");
  }
}

/**
 * Build the effect boundary for a previously validated native DNS plan. The
 * caller owns authorization, fresh inspection, service restart and cache flush.
 */
export function createNativeDnsHostDependencies(
  opts: NativeDnsHostDependenciesOptions
): NativeDnsHostDependencies {
  const runCommand = opts.runCommand ?? defaultRunner;
  const runPrivileged = opts.runPrivileged ?? defaultRunner;
  let receiptIdentity: string | null = null;

  async function privilegedResolver(
    action: "create" | "remove",
    file:
      | NativeDnsOwnedFile
      | { readonly path: string; readonly content: string }
  ): Promise<string> {
    const result = await runPrivileged([
      "sudo",
      "-n",
      "/usr/bin/python3",
      "-I",
      "-S",
      "-c",
      PRIVILEGED_RESOLVER_SCRIPT,
      action,
      file.path,
      file.content,
      "identity" in file ? file.identity : "",
    ]);
    return assertSuccess(result, `Resolver ${action}`);
  }

  return {
    inspectPlan: opts.inspectPlan,
    authorize: opts.authorize,
    restartDnsmasq: opts.restartDnsmasq,
    flushDnsCache: opts.flushDnsCache,
    async adoptReceipt(receipt) {
      const existing = await readOwnedFile(opts.receiptPath);
      if (!existing || existing.content !== receiptContent(receipt)) {
        throw new Error(
          "Private DNS receipt changed before ownership adoption"
        );
      }
      receiptIdentity = existing.identity;
      return { path: opts.receiptPath, ...existing };
    },
    async inspectOwnedFile(path) {
      if (
        path !== opts.receiptPath &&
        path !== opts.dnsmasqPath &&
        path !== opts.resolverPath
      ) {
        throw new Error("DNS file path is outside the validated plan");
      }
      const file = await readOwnedFile(path);
      return file ? { path, ...file } : null;
    },
    async writeReceipt(receipt) {
      await ensurePrivateReceiptDirectory(opts.receiptPath);
      const content = receiptContent(receipt);
      const existing = await readOwnedFile(opts.receiptPath);
      assertReceiptState({ receipt, existing, ownedIdentity: receiptIdentity });

      const temporaryPath = `${opts.receiptPath}.${randomUUID()}.tmp`;
      const temporary = await open(
        temporaryPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600
      );
      const identity = fileIdentity(await temporary.stat());
      let publicationStarted = false;
      try {
        try {
          await temporary.writeFile(content, "utf8");
          await temporary.sync();
          await temporary.close();
          if (existing) {
            const current = await readOwnedFile(opts.receiptPath);
            if (
              !current ||
              current.identity !== existing.identity ||
              current.content !== existing.content
            ) {
              throw new Error("Private DNS receipt changed before replacement");
            }
            publicationStarted = true;
            await rename(temporaryPath, opts.receiptPath);
          } else {
            publicationStarted = true;
            await link(temporaryPath, opts.receiptPath);
            await unlink(temporaryPath);
          }
          receiptIdentity = identity;
          await syncDirectory(dirname(opts.receiptPath));
        } finally {
          await temporary.close();
          await unlinkIfPresent(temporaryPath);
        }
      } catch (error) {
        if (publicationStarted) {
          throw new NativeDnsUncertainEffectError(
            "Private DNS receipt publication may have completed",
            error
          );
        }
        throw error;
      }
    },
    async clearPendingReceipt(receipt) {
      if (receipt.state !== "pending" || receiptIdentity === null) {
        return false;
      }
      const removed = await removeLocalIfOwned({
        path: opts.receiptPath,
        content: receiptContent(receipt),
        identity: receiptIdentity,
      });
      if (removed) {
        receiptIdentity = null;
      }
      return removed;
    },
    async createExclusive(file) {
      if (file.path === opts.dnsmasqPath) {
        return await createLocalExclusive(file);
      }
      if (file.path !== opts.resolverPath) {
        throw new Error("DNS output path is outside the validated plan");
      }
      let identity: string;
      try {
        identity = await privilegedResolver("create", file);
      } catch (error) {
        throw new NativeDnsUncertainEffectError(
          `Resolver create completion is uncertain: ${file.path}`,
          error
        );
      }
      if (!IDENTITY.test(identity)) {
        throw new NativeDnsUncertainEffectError(
          `Resolver create returned no valid ownership identity: ${file.path}`
        );
      }
      return { ...file, identity };
    },
    async removeIfOwned(file) {
      if (!IDENTITY.test(file.identity)) {
        return false;
      }
      if (file.path === opts.dnsmasqPath) {
        return await removeLocalIfOwned(file);
      }
      if (file.path !== opts.resolverPath) {
        return false;
      }
      let result: string;
      try {
        result = await privilegedResolver("remove", file);
      } catch (error) {
        throw new NativeDnsUncertainEffectError(
          `Resolver remove completion is uncertain: ${file.path}`,
          error
        );
      }
      if (result !== "0" && result !== "1") {
        throw new NativeDnsUncertainEffectError(
          "Resolver remove returned an invalid result"
        );
      }
      return result === "1";
    },
    async testConfig() {
      const result = await runCommand([
        opts.dnsmasqBinary,
        "--test",
        `--conf-file=${opts.dnsmasqMainConfigPath}`,
        `--conf-dir=${opts.dnsmasqIncludeDir},*.conf`,
      ]);
      assertSuccess(result, "dnsmasq configuration test");
    },
    async verifyLiveDns(plan) {
      if (
        plan.resolverPath !== opts.resolverPath ||
        plan.dnsmasqPath !== opts.dnsmasqPath
      ) {
        throw new Error(
          "Live DNS verification plan does not match validated paths"
        );
      }
      const name = `hack-probe-${randomUUID().replaceAll("-", "")}.${plan.domain}`;
      const direct = await runCommand([
        "/usr/bin/dig",
        "+short",
        "+time=2",
        "+tries=1",
        "@127.0.0.1",
        name,
        "A",
      ]);
      if (assertSuccess(direct, "Direct DNS verification") !== "127.0.0.1") {
        throw new Error(
          "Direct DNS did not resolve the custom domain to 127.0.0.1"
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
      const systemAddresses = [
        ...assertSuccess(system, "System DNS verification").matchAll(
          IP_ADDRESS_LINE
        ),
      ].map((match) => match[1]);
      if (
        systemAddresses.length === 0 ||
        systemAddresses.some((address) => address !== "127.0.0.1")
      ) {
        throw new Error(
          "System DNS did not resolve the custom domain to 127.0.0.1"
        );
      }
    },
    async verifyDeactivatedDns(plan) {
      const name = `hack-probe-${randomUUID().replaceAll("-", "")}.${plan.domain}`;
      const direct = await runCommand([
        "/usr/bin/dig",
        "+short",
        "+time=2",
        "+tries=1",
        "@127.0.0.1",
        name,
        plan.parentAddress?.includes(":") ? "AAAA" : "A",
      ]);
      const directAddresses = assertSuccess(
        direct,
        "Direct fallback DNS verification"
      )
        .split("\n")
        .filter(Boolean);
      const system = await runCommand([
        "/usr/bin/dscacheutil",
        "-q",
        "host",
        "-a",
        "name",
        name,
      ]);
      const systemAddresses = [
        ...assertSuccess(system, "System fallback DNS verification").matchAll(
          IP_ADDRESS_LINE
        ),
      ].map((match) => match[1]);
      if (plan.parentAddress) {
        if (
          directAddresses.length !== 1 ||
          directAddresses[0] !== plan.parentAddress ||
          systemAddresses.length !== 1 ||
          systemAddresses[0] !== plan.parentAddress
        ) {
          throw new Error("DNS did not return the verified parent fallback");
        }
      } else if (
        directAddresses.includes("127.0.0.1") ||
        systemAddresses.includes("127.0.0.1")
      ) {
        throw new Error("Native DNS claim still resolves after deactivation");
      }
    },
  };
}
