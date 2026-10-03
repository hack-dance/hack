/** Explicit, conservative archival of a legacy shared HTTPS owner that never published an endpoint.
 *
 * The old creator PID is operator evidence: configuration.json did not record it. Current-source
 * ensure calls share an admission lock, while a legacy binary does not. The operator must keep
 * legacy startup quiescent; a pinned executable inventory refuses any live other caller.
 * This API never signals a process or removes Caddy data. An interrupted intent is retained.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
} from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../lib/guards.ts";
import { acquireNativeHttpsOwnerAdmission } from "./native-https-owner-admission.ts";
import {
  isNativeHttpsOwnerConfiguration,
  NATIVE_HTTPS_OWNER_ARGUMENT,
  type NativeHttpsOwnerConfiguration,
  nativeHttpsOwnerRefused,
} from "./native-https-owner-protocol.ts";
import {
  nativeHttpsExecutableSha256,
  nativeHttpsOwnerRoot,
  nativeHttpsPrivateDirectory,
  nativeHttpsReadFile,
  nativeHttpsWriteNew,
} from "./native-https-owner-storage.ts";
import { checkNativeHttpsPort } from "./native-https-port.ts";
import {
  invokeNativeRuntime,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

interface Identity {
  readonly dev: number;
  readonly ino: number;
}
const HEX32 = /^[a-f0-9]{32}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const PS_LINE = /^\s*(\d+)\s+(.+)$/;
interface SelectedOwner {
  readonly root: Identity;
  readonly configuration: Identity & { readonly sha256: string };
  readonly leases: Identity;
  readonly owner: NativeHttpsOwnerConfiguration;
}
export interface EmptyNativeHttpsOwnerSelection {
  readonly ownerGeneration: string;
  readonly configurationSha256: string;
  readonly runtime: NativeRuntimeSelection;
  readonly runtimeSha256: string;
  /** Observed when the legacy configuration was first written, not inferred from it. */
  readonly originalSpawnerPid: number;
}

/** Only effect-free external observations are replaceable in isolated tests. */
export interface EmptyNativeHttpsOwnerInspection {
  originalSpawnerAbsent(pid: number): Promise<boolean>;
  selectedOwnerProcessAbsent(opts: {
    readonly frontendBinary: string;
    readonly configurationPath: string;
  }): Promise<boolean>;
  selectedPortAbsent(port: number): Promise<boolean>;
  poolAndPublications(opts: {
    readonly runtime: NativeRuntimeSelection;
    readonly expectedOwner: string;
    readonly expectedBootId: string;
  }): Promise<boolean>;
}

function refused(): Error {
  return nativeHttpsOwnerRefused();
}
function isAbsent(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
async function absent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (isAbsent(error)) {
      return true;
    }
    throw refused();
  }
}
async function requireAbsent(path: string): Promise<void> {
  if (!(await absent(path))) {
    throw refused();
  }
}
async function directoryIdentity(path: string): Promise<Identity> {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700 ||
    (await realpath(path)) !== path
  ) {
    throw refused();
  }
  const after = await lstat(path);
  if (after.dev !== stat.dev || after.ino !== stat.ino) {
    throw refused();
  }
  return { dev: stat.dev, ino: stat.ino };
}
function sameIdentity(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
async function exactEntries(
  path: string,
  expected: readonly string[]
): Promise<void> {
  const entries = (await readdir(path)).sort();
  if (entries.join("\0") !== [...expected].sort().join("\0")) {
    throw refused();
  }
}
async function selectOwner(
  selection: EmptyNativeHttpsOwnerSelection
): Promise<SelectedOwner> {
  const home = selection.runtime.home;
  if (
    !Number.isSafeInteger(selection.originalSpawnerPid) ||
    selection.originalSpawnerPid <= 1 ||
    !HEX32.test(selection.ownerGeneration) ||
    !HEX64.test(selection.configurationSha256) ||
    !HEX64.test(selection.runtimeSha256) ||
    (await realpath(home)) !== home
  ) {
    throw refused();
  }
  await nativeHttpsPrivateDirectory(home);
  await nativeHttpsPrivateDirectory(join(home, "native-https"));
  const rootPath = nativeHttpsOwnerRoot(home);
  const root = await directoryIdentity(rootPath);
  await exactEntries(rootPath, ["configuration.json", "leases"]);
  const leases = await directoryIdentity(join(rootPath, "leases"));
  await exactEntries(join(rootPath, "leases"), []);
  const { bytes, identity } = await nativeHttpsReadFile(
    join(rootPath, "configuration.json")
  );
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  if (!isNativeHttpsOwnerConfiguration(parsed)) {
    throw refused();
  }
  if (
    parsed.ownerGeneration !== selection.ownerGeneration ||
    identity.sha256 !== selection.configurationSha256 ||
    parsed.binding.runtime.home !== home ||
    parsed.binding.runtime.binary !== selection.runtime.binary ||
    parsed.binding.runtimeSha256 !== selection.runtimeSha256 ||
    (await nativeHttpsExecutableSha256(selection.runtime.binary)) !==
      selection.runtimeSha256 ||
    (await nativeHttpsExecutableSha256(parsed.binding.frontend.binary)) !==
      parsed.binding.frontend.sha256 ||
    (await nativeHttpsExecutableSha256(parsed.binding.caddyBinary)) !==
      parsed.binding.caddySha256
  ) {
    throw refused();
  }
  return { root, leases, configuration: identity, owner: parsed };
}
async function sameSelected(
  selection: EmptyNativeHttpsOwnerSelection,
  before: SelectedOwner
): Promise<void> {
  const after = await selectOwner(selection);
  if (
    !(
      sameIdentity(before.root, after.root) &&
      sameIdentity(before.leases, after.leases) &&
      sameIdentity(before.configuration, after.configuration)
    ) ||
    before.configuration.sha256 !== after.configuration.sha256 ||
    JSON.stringify(before.owner) !== JSON.stringify(after.owner)
  ) {
    throw refused();
  }
}

async function boundedCommand(
  binary: string,
  args: readonly string[],
  acceptedExit: readonly number[]
): Promise<string> {
  const child = spawn(binary, args, {
    env: { PATH: "/usr/bin:/bin" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let diagnostics = "";
  let tooLarge = false;
  const take = (target: "output" | "diagnostics", chunk: Buffer) => {
    if (target === "output") {
      output += chunk.toString("utf8");
      tooLarge ||= Buffer.byteLength(output) > 1_048_576;
    } else {
      diagnostics += chunk.toString("utf8");
      tooLarge ||= Buffer.byteLength(diagnostics) > 4096;
    }
    if (tooLarge) {
      child.kill("SIGKILL");
    }
  };
  child.stdout.on("data", (chunk: Buffer) => take("output", chunk));
  child.stderr.on("data", (chunk: Buffer) => take("diagnostics", chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (value) => resolve(value ?? -1));
    });
    if (tooLarge || diagnostics !== "" || !acceptedExit.includes(code)) {
      throw refused();
    }
    return output;
  } finally {
    clearTimeout(timer);
  }
}

const productionInspection: EmptyNativeHttpsOwnerInspection = {
  originalSpawnerAbsent(pid) {
    try {
      process.kill(pid, 0);
      return Promise.resolve(false);
    } catch (error) {
      return Promise.resolve(isRecord(error) && error.code === "ESRCH");
    }
  },
  async selectedOwnerProcessAbsent(opts) {
    // Do not return raw process arguments: they can contain unrelated private data.
    const lines = (
      await boundedCommand("/bin/ps", ["-axo", "pid=,command=", "-ww"], [0])
    ).split("\n");
    for (const line of lines) {
      if (line.trim() === "") {
        continue;
      }
      const match = PS_LINE.exec(line);
      if (!match) {
        return false;
      }
      const pid = Number(match[1]);
      const command = match[2] ?? "";
      if (pid === process.pid) {
        continue;
      }
      // A legacy CLI ignores admission. Its exact executable may be live without
      // the internal-owner argument; HOME is not reliably present in ps output.
      if (
        command === opts.frontendBinary ||
        command.startsWith(`${opts.frontendBinary} `) ||
        (command.includes(NATIVE_HTTPS_OWNER_ARGUMENT) &&
          command.includes(opts.configurationPath))
      ) {
        return false;
      }
    }
    return true;
  },
  async selectedPortAbsent(port) {
    try {
      // The local bind probe catches listeners invisible to process inventory.
      await checkNativeHttpsPort(port);
    } catch {
      return false;
    }
    const lines = await boundedCommand(
      "/usr/sbin/lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"],
      [0, 1]
    );
    return lines.trim() === "";
  },
  async poolAndPublications(opts) {
    const { runtime, expectedOwner, expectedBootId } = opts;
    for (const dir of [
      join(runtime.home, ".hack-local"),
      join(runtime.home, ".hack-local", "run"),
      join(runtime.home, ".hack-local", "run", "smolvm"),
    ]) {
      await nativeHttpsPrivateDirectory(dir);
    }
    const ownerPath = join(runtime.home, ".hack-local/run/smolvm/owner.json");
    const { bytes: before, identity: beforeIdentity } =
      await nativeHttpsReadFile(ownerPath, 1_048_576);
    const owner: unknown = JSON.parse(before.toString("utf8"));
    if (
      !isRecord(owner) ||
      owner.token !== expectedOwner ||
      owner.guest_boot_id !== expectedBootId ||
      owner.checkout !== runtime.home ||
      (await absent(
        join(runtime.home, ".hack-local/run/smolvm/owner.pending")
      )) === false
    ) {
      return false;
    }
    const [status, authority, publications] = await Promise.all([
      invokeNativeRuntime({
        runtime,
        cwd: runtime.home,
        args: ["runtime", "status", "--json"],
        timeoutMs: 5000,
      }),
      invokeNativeRuntime({
        runtime,
        cwd: runtime.home,
        args: ["runtime", "managed-hostname-authority", "--json"],
        timeoutMs: 5000,
      }),
      invokeNativeRuntime({
        runtime,
        cwd: runtime.home,
        args: ["runtime", "publication-hostnames", "--json"],
        timeoutMs: 5000,
      }),
    ]);
    const { bytes: after, identity: afterIdentity } = await nativeHttpsReadFile(
      ownerPath,
      1_048_576
    );
    return (
      sameIdentity(beforeIdentity, afterIdentity) &&
      beforeIdentity.sha256 === afterIdentity.sha256 &&
      before.equals(after) &&
      isRecord(status) &&
      status.phase === "running" &&
      status.process_alive === true &&
      status.guest_boot_id === expectedBootId &&
      isRecord(authority) &&
      isRecord(authority.authority) &&
      authority.authority.present === false &&
      isRecord(publications) &&
      publications.scope === "durable-ownership-only" &&
      Array.isArray(publications.claims) &&
      publications.claims.length === 0
    );
  },
};

async function observe(
  selection: EmptyNativeHttpsOwnerSelection,
  owner: NativeHttpsOwnerConfiguration,
  inspection: EmptyNativeHttpsOwnerInspection,
  heldOwnerLock: Identity
): Promise<void> {
  const storage = join(selection.runtime.home, "native-https");
  for (const name of ["owner.sock", "active-owner.json"]) {
    if (!(await absent(join(storage, name)))) {
      throw refused();
    }
  }
  if (
    !sameIdentity(
      await directoryIdentity(join(storage, "owner.lock")),
      heldOwnerLock
    )
  ) {
    throw refused();
  }
  await exactEntries(join(storage, "owner.lock"), []);
  const checks = await Promise.all([
    inspection.originalSpawnerAbsent(selection.originalSpawnerPid),
    inspection.selectedOwnerProcessAbsent({
      frontendBinary: owner.binding.frontend.binary,
      configurationPath: join(
        nativeHttpsOwnerRoot(selection.runtime.home),
        "configuration.json"
      ),
    }),
    inspection.selectedPortAbsent(owner.binding.httpsPort),
    inspection.poolAndPublications({
      runtime: selection.runtime,
      expectedOwner: owner.binding.pool.owner,
      expectedBootId: owner.binding.pool.bootId,
    }),
  ]);
  if (checks.some((value) => value !== true)) {
    throw refused();
  }
}

async function noRecoveryClaims(
  storage: string,
  ownIntent?: string
): Promise<void> {
  const entries = await readdir(storage);
  for (const entry of entries) {
    if (
      (entry.startsWith("empty-owner-recovery-") ||
        entry.startsWith("archived-empty-owner-")) &&
      entry !== ownIntent
    ) {
      throw refused();
    }
  }
}
async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
async function removeExactEmptyLock(
  path: string,
  identity: Identity
): Promise<void> {
  if (!sameIdentity(await directoryIdentity(path), identity)) {
    throw refused();
  }
  await exactEntries(path, []);
  await rmdir(path);
}

/** Archive only a selected empty legacy owner. An existing intent or lock is never replayed. */
export async function archiveEmptyNativeHttpsOwner(opts: {
  readonly selection: EmptyNativeHttpsOwnerSelection;
  readonly acceptLegacyOwnerWithoutPid: true;
  /** Pure-test seam; production callers omit it and use native and OS observations. */
  readonly inspection?: EmptyNativeHttpsOwnerInspection;
  /** Pure-test fault seam; production uses the durable private-file publisher. */
  readonly writeJournal?: typeof nativeHttpsWriteNew;
}): Promise<{
  readonly archive: string;
  readonly configurationSha256: string;
}> {
  if (opts.acceptLegacyOwnerWithoutPid !== true) {
    throw refused();
  }
  const { selection } = opts;
  const storage = join(selection.runtime.home, "native-https");
  const root = nativeHttpsOwnerRoot(selection.runtime.home);
  await nativeHttpsPrivateDirectory(storage);
  const storageId = await directoryIdentity(storage);
  const admission = await acquireNativeHttpsOwnerAdmission({
    home: selection.runtime.home,
    waitMs: 0,
  });
  let ownerLockId: Identity | undefined;
  let intentAttempted = false;
  try {
    await noRecoveryClaims(storage);
    const selected = await selectOwner(selection);
    const ownerLock = join(storage, "owner.lock");
    if (!(await absent(ownerLock))) {
      throw refused();
    }
    // This is also the normal HTTPS startup exclusion lock. Losing its mkdir race refuses.
    await mkdir(ownerLock, { mode: 0o700 });
    ownerLockId = await directoryIdentity(ownerLock);
    const inspection = opts.inspection ?? productionInspection;
    await observe(selection, selected.owner, inspection, ownerLockId);
    await sameSelected(selection, selected);
    if (!sameIdentity(await directoryIdentity(storage), storageId)) {
      throw refused();
    }
    const stem = `${selection.ownerGeneration}-${selection.configurationSha256}`;
    const archive = join(storage, `archived-empty-owner-${stem}`);
    const intent = join(storage, `empty-owner-recovery-${stem}.intent.json`);
    const complete = join(
      storage,
      `empty-owner-recovery-${stem}.complete.json`
    );
    if (
      !(
        (await absent(archive)) &&
        (await absent(intent)) &&
        (await absent(complete))
      )
    ) {
      throw refused();
    }
    // Recheck directly at the effect boundary, after the operation and HTTPS locks are held.
    await observe(selection, selected.owner, inspection, ownerLockId);
    await sameSelected(selection, selected);
    await noRecoveryClaims(storage);
    const proof = {
      version: 1,
      action: "archive-empty-native-https-owner",
      home: selection.runtime.home,
      ownerGeneration: selection.ownerGeneration,
      configurationSha256: selection.configurationSha256,
      originalSpawnerPid: selection.originalSpawnerPid,
      root: selected.root,
      configuration: selected.configuration,
      leases: selected.leases,
      poolOwner: selected.owner.binding.pool.owner,
      poolBootId: selected.owner.binding.pool.bootId,
      runtimeSha256: selection.runtimeSha256,
    };
    // Publication can succeed before its writer fails during fsync/readback.
    intentAttempted = true;
    await (opts.writeJournal ?? nativeHttpsWriteNew)(intent, proof);
    await observe(selection, selected.owner, inspection, ownerLockId);
    await sameSelected(selection, selected);
    await noRecoveryClaims(storage, `empty-owner-recovery-${stem}.intent.json`);
    if (!((await absent(archive)) && (await absent(complete)))) {
      throw refused();
    }
    await rename(root, archive);
    await syncDirectory(storage);
    await requireAbsent(root);
    if (!sameIdentity(await directoryIdentity(archive), selected.root)) {
      throw refused();
    }
    await exactEntries(archive, ["configuration.json", "leases"]);
    await exactEntries(join(archive, "leases"), []);
    const archived = await nativeHttpsReadFile(
      join(archive, "configuration.json")
    );
    if (
      !sameIdentity(archived.identity, selected.configuration) ||
      archived.identity.sha256 !== selected.configuration.sha256 ||
      !sameIdentity(
        await directoryIdentity(join(archive, "leases")),
        selected.leases
      )
    ) {
      throw refused();
    }
    await (opts.writeJournal ?? nativeHttpsWriteNew)(complete, {
      ...proof,
      archive,
      intentSha256: createHash("sha256")
        .update((await nativeHttpsReadFile(intent)).bytes)
        .digest("hex"),
    });
    await requireAbsent(root);
    await removeExactEmptyLock(ownerLock, ownerLockId);
    ownerLockId = undefined;
    await admission.release();
    await syncDirectory(storage);
    return { archive, configurationSha256: selection.configurationSha256 };
  } catch (error) {
    // Before durable intent, owned empty locks can be released. After it, uncertainty stays.
    if (!intentAttempted) {
      if (ownerLockId) {
        await removeExactEmptyLock(
          join(storage, "owner.lock"),
          ownerLockId
        ).catch(() => undefined);
      }
      await admission.release().catch(() => undefined);
    }
    throw error;
  }
}
