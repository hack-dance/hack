import { constants } from "node:fs";
import { lstat, open, realpath, rmdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { isRecord } from "../lib/guards.ts";
import {
  isNativeHttpsLeaseIdentity,
  type NativeHttpsLeaseIdentity,
  recoverNativeHttpsLease,
} from "./native-https-owner.ts";
import { checkNativeHttpsPort } from "./native-https-port.ts";
import { inspectNativeProjectGraph } from "./native-project-inspect.ts";
import { confirmedNativeRetainedGraph } from "./native-project-retained.ts";
import type {
  NativeProjectRun,
  NativeProjectRunScope,
} from "./native-project-run.ts";
import {
  invokeNativeRuntime,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const PROCESS_LINE = /^\s*(\d+)\s+(.+?)\s*$/;

function refused(): Error {
  return new Error(
    "Native frontend recovery cannot prove the old owner and effects are gone; retained data was not changed."
  );
}

async function absent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return;
    }
    throw refused();
  }
  throw refused();
}

/** Retire only the empty HTTPS lock left by a verified dead frontend. The
 * caller has already checked the stopped graph, authority, port and hooks.
 */
async function retireOrphanedHttpsLock(path: string): Promise<void> {
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(path);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return;
    }
    throw refused();
  }
  let resolved: string;
  try {
    resolved = await realpath(path);
  } catch {
    throw refused();
  }
  if (
    !before.isDirectory() ||
    before.uid !== process.getuid?.() ||
    (before.mode & 0o777) !== 0o700 ||
    resolved !== path
  ) {
    throw refused();
  }
  const after = await lstat(path);
  if (
    !after.isDirectory() ||
    after.dev !== before.dev ||
    after.ino !== before.ino
  ) {
    throw refused();
  }
  try {
    await rmdir(path);
  } catch {
    throw refused();
  }
}

async function noLifecycleEntries(projectDir: string): Promise<void> {
  const path = join(projectDir, ".internal/lifecycle/state.json");
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
    );
  } catch {
    throw refused();
  }
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      stat.size < 1 ||
      stat.size > 65_536
    ) {
      throw refused();
    }
    const text = await file.readFile("utf8");
    const after = await file.stat();
    if (
      Buffer.byteLength(text) !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    ) {
      throw refused();
    }
    const state: unknown = JSON.parse(text);
    if (
      !(isRecord(state) && Array.isArray(state.entries)) ||
      state.entries.length !== 0
    ) {
      throw refused();
    }
  } catch {
    throw refused();
  } finally {
    await file.close();
  }
}

/** Legacy v1 markers did not persist their frontend PID. A previously observed
 * PID alone cannot prove it belonged to Hack, so also refuse if any other
 * packaged Hack frontend remains on this host.
 */
async function noOtherHackFrontends(): Promise<void> {
  const child = Bun.spawn(["/bin/ps", "-axo", "pid=,comm="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const [output, exit] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  if (exit !== 0 || Buffer.byteLength(output) > 2_000_000) {
    throw refused();
  }
  for (const line of output.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const match = PROCESS_LINE.exec(line);
    if (!match) {
      throw refused();
    }
    const pid = Number(match[1]);
    const executable = basename(match[2] ?? "");
    if (executable === "hack-cli" && pid !== process.pid) {
      throw refused();
    }
  }
}

type RecoveryOptions = {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeProjectRunScope;
  readonly run: NativeProjectRun;
  readonly httpsPort: number | null;
  readonly httpsLease?: NativeHttpsLeaseIdentity;
  readonly legacy: boolean;
  readonly invoke?: typeof invokeNativeRuntime;
  readonly inspect?: typeof inspectNativeProjectGraph;
  readonly checkPort?: typeof checkNativeHttpsPort;
  readonly recoverLease?: typeof recoverNativeHttpsLease;
  readonly inspectLegacyProcesses?: typeof noOtherHackFrontends;
  readonly cleanupLifecycle?: () => Promise<void>;
};

async function verifyStoppedGraph(opts: RecoveryOptions): Promise<void> {
  const inspect = opts.inspect ?? inspectNativeProjectGraph;
  const result = await inspect({
    runtime: opts.runtime,
    projectRoot: opts.scope.projectRoot,
    run: opts.run.run,
    invoke: opts.invoke,
  });
  if (!confirmedNativeRetainedGraph(result, opts.run)) {
    throw refused();
  }
}

/** Re-observe the stopped graph and all frontend side effects immediately
 * before recording recovery. The graph receipt retains volumes but requires
 * every container and network to be absent.
 */
export async function verifyNativeFrontendRecovery(
  opts: RecoveryOptions
): Promise<void> {
  if (
    opts.httpsLease !== undefined &&
    (opts.legacy ||
      !isNativeHttpsLeaseIdentity(opts.httpsLease) ||
      opts.httpsLease.run !== opts.run.run ||
      opts.httpsLease.owner !== opts.run.owner ||
      opts.httpsLease.namespace !== opts.run.namespace ||
      opts.httpsLease.planId !== opts.run.planId ||
      opts.httpsPort === null ||
      !Number.isSafeInteger(opts.httpsPort) ||
      opts.httpsPort < 1 ||
      opts.httpsPort > 65_535)
  ) {
    throw refused();
  }
  if (opts.legacy) {
    await (opts.inspectLegacyProcesses ?? noOtherHackFrontends)();
  }
  await verifyStoppedGraph(opts);
  if (opts.httpsLease !== undefined) {
    await (opts.recoverLease ?? recoverNativeHttpsLease)({
      runtime: opts.runtime,
      identity: opts.httpsLease,
    });
    await opts.cleanupLifecycle?.();
    await noLifecycleEntries(opts.scope.projectDir);
    return;
  }
  const invoke = opts.invoke ?? invokeNativeRuntime;
  const authority = await invoke({
    runtime: opts.runtime,
    cwd: opts.runtime.home,
    args: ["runtime", "managed-hostname-authority", "--json"],
    timeoutMs: 5000,
  });
  if (
    !(isRecord(authority) && isRecord(authority.authority)) ||
    authority.authority.present !== false
  ) {
    throw refused();
  }
  if (opts.httpsPort !== null) {
    await (opts.checkPort ?? checkNativeHttpsPort)(opts.httpsPort);
  }
  await opts.cleanupLifecycle?.();
  await noLifecycleEntries(opts.scope.projectDir);
  const lock = join(opts.runtime.home, "native-https/owner.lock");
  if (opts.httpsPort === null) {
    await absent(lock);
  } else {
    await retireOrphanedHttpsLock(lock);
  }
}

/** The backend performs its own completed-cleanup and inode proof before moving
 * the dead graph publisher's paths. A frontend marker alone is never authority.
 */
export async function retireNativeRecoveredPublisher(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeProjectRunScope;
  readonly run: NativeProjectRun;
  readonly invoke?: typeof invokeNativeRuntime;
}): Promise<void> {
  const result = await (opts.invoke ?? invokeNativeRuntime)({
    runtime: opts.runtime,
    cwd: opts.scope.projectRoot,
    args: [
      "graph",
      "retire-recovered-publisher",
      "--run-id",
      opts.run.run,
      "--expect-owner",
      opts.run.owner,
      "--json",
    ],
    timeoutMs: 30_000,
  });
  if (
    !isRecord(result) ||
    result.run !== opts.run.run ||
    result.publisher_retired !== true ||
    result.data_retained !== true
  ) {
    throw refused();
  }
}
