import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, join } from "node:path";
import { isRecord } from "../lib/guards.ts";
import { checkNativeHttpsPort } from "./native-https-port.ts";
import { inspectNativeProjectGraph } from "./native-project-inspect.ts";
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
  readonly legacy: boolean;
  readonly invoke?: typeof invokeNativeRuntime;
  readonly inspect?: typeof inspectNativeProjectGraph;
  readonly checkPort?: typeof checkNativeHttpsPort;
  readonly inspectLegacyProcesses?: typeof noOtherHackFrontends;
};

async function verifyStoppedGraph(opts: RecoveryOptions): Promise<void> {
  const inspect = opts.inspect ?? inspectNativeProjectGraph;
  const result = await inspect({
    runtime: opts.runtime,
    projectRoot: opts.scope.projectRoot,
    run: opts.run.run,
    invoke: opts.invoke,
  });
  if (
    !isRecord(result) ||
    result.journal_incomplete !== false ||
    !isRecord(result.receipt) ||
    !isRecord(result.observations)
  ) {
    throw refused();
  }
  const { receipt, observations } = result;
  if (
    receipt.phase !== "stopped-data-retained" ||
    receipt.run !== opts.run.run ||
    receipt.owner !== opts.run.owner ||
    receipt.namespace !== opts.run.namespace ||
    receipt.plan_id !== opts.run.planId ||
    !isRecord(receipt.resources)
  ) {
    throw refused();
  }
  const expectedObservations = new Set<string>();
  for (const resource of Object.values(receipt.resources)) {
    if (
      !isRecord(resource) ||
      typeof resource.key !== "string" ||
      typeof resource.kind !== "string"
    ) {
      throw refused();
    }
    const key = `${resource.kind}:${resource.key}`;
    if (expectedObservations.has(key)) {
      throw refused();
    }
    expectedObservations.add(key);
    const observed = observations[key];
    if (
      !isRecord(observed) ||
      observed.state !== (resource.kind === "volume" ? "present" : "absent") ||
      !["container", "network", "volume"].includes(resource.kind)
    ) {
      throw refused();
    }
  }
  if (
    Object.keys(observations).length !== expectedObservations.size ||
    Object.keys(observations).some((key) => !expectedObservations.has(key))
  ) {
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
  if (opts.legacy) {
    await (opts.inspectLegacyProcesses ?? noOtherHackFrontends)();
  }
  await verifyStoppedGraph(opts);
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
  await absent(join(opts.runtime.home, "native-https/owner.lock"));
  if (opts.httpsPort !== null) {
    await (opts.checkPort ?? checkNativeHttpsPort)(opts.httpsPort);
  }
  await noLifecycleEntries(opts.scope.projectDir);
}
