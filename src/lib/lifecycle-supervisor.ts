import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { resolveGlobalHackDir } from "./config-paths.ts";
import { isRecord } from "./guards.ts";
import {
  readLifecycleState,
  resolveLifecycleLogPath,
} from "./lifecycle-runtime.ts";
import { ensurePrivateDirectory } from "./private-file.ts";
import { withProjectsRegistryLock } from "./projects-registry-lock.ts";

export type LifecycleSupervisorProcess = {
  readonly name: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
};

export type LifecycleSupervisorState = {
  readonly version: 1;
  readonly name: string;
  readonly ownerToken: string;
  readonly guardPid: number;
  readonly processGroupId: number;
  readonly guardStartTime: number;
  readonly bootId: string;
  readonly uid: number;
  readonly commandPid: number | null;
  readonly phase: string;
  readonly exitCode: number | null;
  readonly signal: number | null;
};

export type LifecycleSupervisorReceipt = {
  readonly version: 1;
  readonly supervisorPid: number;
  readonly outcome: "ready" | "observed" | "stopped" | "unknown" | "refused";
  readonly processes: readonly LifecycleSupervisorState[];
  readonly liveProcessNames: readonly string[];
  readonly unknownProcessNames: readonly string[];
};

type Instance = {
  readonly projectDir: string;
  readonly composeProject: string;
  readonly ownershipToken: string;
};

const LIMIT = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 35_000;

/** Control capabilities must never be published through checkout bind mounts. */
export function resolveLifecycleSupervisorRoot(opts: {
  readonly projectDir: string;
  readonly composeProject: string;
}): string {
  const hostRoot = canonicalPath(
    resolve(resolveGlobalHackDir(), "lifecycle-supervisors")
  );
  const inside = relative(dirname(realpathSync(opts.projectDir)), hostRoot);
  if (inside === "" || !(inside.startsWith("../") || isAbsolute(inside))) {
    throw new Error(
      "Lifecycle supervisor state must be outside the project checkout."
    );
  }
  const key = createHash("sha256")
    .update(
      JSON.stringify([realpathSync(opts.projectDir), opts.composeProject])
    )
    .digest("hex");
  return resolve(hostRoot, key);
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (
      !(isRecord(error) && error.code === "ENOENT") ||
      dirname(path) === path
    ) {
      throw error;
    }
    return resolve(canonicalPath(dirname(path)), basename(path));
  }
}

/** Resolve only the current installation or an explicit test executable. */
export function resolveLifecycleSupervisorBinary(): string {
  const selected = process.env.HACK_LIFECYCLE_SUPERVISOR_BINARY;
  if (selected !== undefined && !Bun.main.startsWith("/$bunfs/")) {
    if (
      !(selected.trim() && selected.startsWith("/")) ||
      selected.includes("\0")
    ) {
      throw new Error(
        "HACK_LIFECYCLE_SUPERVISOR_BINARY must name an absolute executable path."
      );
    }
    return selected;
  }
  return Bun.main.startsWith("/$bunfs/")
    ? resolve(dirname(process.execPath), "hack-lifecycle-supervisor")
    : resolve(import.meta.dir, "../../dist/hack-lifecycle-supervisor");
}

export const LIFECYCLE_SUPERVISOR_VERSION =
  "hack-lifecycle-supervisor 0.1.0 protocol=1 incremental=1";

/** Validate the public, value-free handshake before publishing any ownership. */
export async function preflightLifecycleSupervisor(): Promise<{
  path: string;
  version: string;
}> {
  const path = resolveLifecycleSupervisorBinary();
  try {
    await access(path, constants.X_OK);
    if (!(await lstat(realpathSync(path))).isFile()) {
      throw failure();
    }
    const child = Bun.spawn([path, "--version"], {
      env: {},
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: 2000,
    });
    const version = (await new Response(child.stdout).text()).trim();
    if (
      (await child.exited) !== 0 ||
      version !== LIFECYCLE_SUPERVISOR_VERSION
    ) {
      throw failure();
    }
    return { path, version };
  } catch {
    throw new Error(
      "Lifecycle supervisor executable is missing, incompatible or not executable; install the matching companion beside this CLI before opting in."
    );
  }
}

async function recordedRoot(
  opts: Instance
): Promise<{ root: string; neverStarted: boolean }> {
  const entry = (await readLifecycleState(opts)).find(
    (entry) => entry.composeProject === opts.composeProject
  );
  const root = entry?.supervisorRoot ?? resolveLifecycleSupervisorRoot(opts);
  const inside = relative(
    dirname(realpathSync(opts.projectDir)),
    canonicalPath(root)
  );
  if (inside === "" || !(inside.startsWith("../") || isAbsolute(inside))) {
    throw failure();
  }
  return {
    root,
    neverStarted:
      !entry ||
      (entry.supervisorLaunchAttempted === false &&
        !entry.supervisorPid &&
        entry.processes.length === 0),
  };
}

/** Native observations, never a persisted `running` phase, establish liveness. */
export async function inspectLifecycleSupervisor(
  opts: Instance
): Promise<LifecycleSupervisorReceipt> {
  if (await lifecycleSupervisorProvenUnstarted(opts)) {
    return {
      version: 1,
      supervisorPid: 0,
      outcome: "observed",
      processes: [],
      liveProcessNames: [],
      unknownProcessNames: [],
    };
  }
  return await request({ ...opts, action: "status" });
}

/** A failed or unknown stop keeps the caller's ownership and dependency records. */
export async function stopLifecycleSupervisor(
  opts: Instance
): Promise<LifecycleSupervisorReceipt> {
  if (await lifecycleSupervisorProvenUnstarted(opts)) {
    return {
      version: 1,
      supervisorPid: 0,
      outcome: "stopped",
      processes: [],
      liveProcessNames: [],
      unknownProcessNames: [],
    };
  }
  return await request({ ...opts, action: "stop" });
}

async function lifecycleSupervisorProvenUnstarted(
  opts: Instance
): Promise<boolean> {
  const recorded = await recordedRoot(opts);
  if (recorded.neverStarted) {
    return true;
  }
  try {
    await lstat(recorded.root);
    return false;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      // Never turn an earlier experimental checkout-local owner into absence.
      try {
        await lstat(`${resolveLifecycleLogPath(opts)}.supervisor`);
      } catch (legacyError) {
        if (isRecord(legacyError) && legacyError.code === "ENOENT") {
          throw failure();
        }
        throw failure();
      }
      throw new Error(
        "Stop the earlier experimental supervisor with its original CLI before upgrading."
      );
    }
    throw failure();
  }
}

/** First launch creates the project owner; later launches preserve hook ordering. */
export async function launchLifecycleSupervisorProcess(
  opts: Instance & {
    readonly action: "serve" | "add";
    readonly process: LifecycleSupervisorProcess;
  }
): Promise<LifecycleSupervisorReceipt> {
  return await request({ ...opts, processes: [opts.process] });
}

async function request(
  opts: Instance & {
    readonly action: "serve" | "add" | "status" | "stop";
    readonly processes?: readonly LifecycleSupervisorProcess[];
  }
): Promise<LifecycleSupervisorReceipt> {
  await preflightLifecycleSupervisor();
  const payload = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      root: (await recordedRoot(opts)).root,
      ownerToken: opts.ownershipToken,
      ...(opts.processes
        ? {
            processes: opts.processes.map((process) => ({
              ...process,
              name: `service-${createHash("sha256").update(process.name).digest("hex")}`,
              displayName: process.name,
            })),
            logPath: resolveLifecycleLogPath(opts),
          }
        : {}),
    })
  );
  if (payload.length > LIMIT) {
    payload.fill(0);
    throw failure();
  }
  const frame = new Uint8Array(payload.length + 4);
  new DataView(frame.buffer).setUint32(0, payload.length);
  frame.set(payload, 4);
  payload.fill(0);
  let child: Bun.Subprocess<"pipe", "pipe", "ignore">;
  try {
    // The Rust owner calls setsid. `detached: true` would make it a group
    // leader before that call and is deliberately absent here.
    child = Bun.spawn([resolveLifecycleSupervisorBinary(), opts.action], {
      env: {},
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    frame.fill(0);
    throw new Error(
      "Lifecycle supervisor is unavailable; build or install it alongside Hack."
    );
  }
  child.unref();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(failure()), REQUEST_TIMEOUT_MS);
  });
  const reader = child.stdout.getReader();
  try {
    const result = await Promise.race([
      (async () => {
        await child.stdin.write(frame);
        await child.stdin.end();
        const receipt = await readReceipt(reader);
        if (
          new Set(receipt.processes.map((state) => state.name)).size !==
            receipt.processes.length ||
          (opts.processes &&
            (receipt.supervisorPid <= 1 ||
              opts.processes.some(
                (process) =>
                  !receipt.processes.some(
                    (state) => state.name === process.name
                  )
              ))) ||
          (opts.action === "stop" &&
            (receipt.liveProcessNames.length > 0 ||
              receipt.unknownProcessNames.length > 0))
        ) {
          throw failure();
        }
        if (
          receipt.processes.some(
            (state) => state.ownerToken !== opts.ownershipToken
          ) ||
          receipt.liveProcessNames.some(
            (name) => !receipt.processes.some((state) => state.name === name)
          ) ||
          receipt.unknownProcessNames.some(
            (name) => !receipt.processes.some((state) => state.name === name)
          )
        ) {
          throw failure();
        }
        if (opts.action !== "serve") {
          const exitCode = await child.exited;
          if (exitCode !== 0) {
            throw failure();
          }
        }
        const expected = {
          status: "observed",
          stop: "stopped",
          serve: "ready",
          add: "ready",
        }[opts.action];
        if (receipt.outcome !== expected) {
          throw failure();
        }
        return receipt;
      })(),
      deadline,
    ]);
    return result;
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* The finite client may already have exited. */
    }
    throw failure();
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    frame.fill(0);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Frame completion is explicit; a caller never waits for a detached owner's EOF. */
async function readReceipt(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<LifecycleSupervisorReceipt> {
  let bytes = new Uint8Array(0);
  let length: number | undefined;
  for (;;) {
    const next = await reader.read();
    if (next.done || bytes.length + next.value.length > LIMIT + 4) {
      throw failure();
    }
    const combined = new Uint8Array(bytes.length + next.value.length);
    combined.set(bytes);
    combined.set(next.value, bytes.length);
    bytes = combined;
    if (length === undefined && bytes.length >= 4) {
      length = new DataView(bytes.buffer).getUint32(0);
      if (length === 0 || length > LIMIT) {
        throw failure();
      }
    }
    if (length !== undefined && bytes.length >= length + 4) {
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(4, length + 4)
        )
      );
      return parseReceipt(value);
    }
  }
}

function integer(value: unknown, minimum = 0): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
  );
}
function optionalInteger(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!integer(value)) {
    throw failure();
  }
  return value;
}
function strings(value: unknown): readonly string[] {
  if (
    !(Array.isArray(value) && value.every((item) => typeof item === "string"))
  ) {
    throw failure();
  }
  return value;
}
function state(value: unknown): LifecycleSupervisorState {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.name !== "string" ||
    typeof value.ownerToken !== "string" ||
    !integer(value.guardPid, 2) ||
    value.processGroupId !== value.guardPid ||
    !integer(value.guardStartTime, 1) ||
    typeof value.bootId !== "string" ||
    !integer(value.uid) ||
    typeof value.phase !== "string"
  ) {
    throw failure();
  }
  return {
    version: 1,
    name:
      typeof value.displayName === "string" ? value.displayName : value.name,
    ownerToken: value.ownerToken,
    guardPid: value.guardPid,
    processGroupId: value.guardPid,
    guardStartTime: value.guardStartTime,
    bootId: value.bootId,
    uid: value.uid,
    commandPid: optionalInteger(value.commandPid),
    phase: value.phase,
    exitCode: optionalInteger(value.exitCode),
    signal: optionalInteger(value.signal),
  };
}
function parseReceipt(value: unknown): LifecycleSupervisorReceipt {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !integer(value.supervisorPid) ||
    !Array.isArray(value.processes)
  ) {
    throw failure();
  }
  const outcome = value.outcome;
  if (
    outcome !== "ready" &&
    outcome !== "observed" &&
    outcome !== "stopped" &&
    outcome !== "unknown" &&
    outcome !== "refused"
  ) {
    throw failure();
  }
  return {
    version: 1,
    supervisorPid: value.supervisorPid,
    outcome,
    processes: value.processes.map(state),
    liveProcessNames: strings(value.liveProcessNames),
    unknownProcessNames: strings(value.unknownProcessNames),
  };
}
function failure(): Error {
  return new Error(
    "Lifecycle supervisor could not confirm the operation; ownership was retained. Values omitted."
  );
}

/** Serialize CLI publication and native effects for one instance. Native locks
 * remain independent and protect the binary's own state after CLI loss. */
export async function withLifecycleSupervisorControllerLock<T>(opts: {
  readonly projectDir: string;
  readonly composeProject: string;
  readonly run: () => Promise<T>;
}): Promise<T> {
  const logPath = resolveLifecycleLogPath(opts);
  await ensurePrivateDirectory(dirname(logPath));
  return await withProjectsRegistryLock({
    lockPath: `${logPath}.controller.lock`,
    label: "lifecycle supervisor controller",
    timeoutMs: 40_000,
    run: opts.run,
  });
}
