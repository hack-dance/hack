import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isRecord } from "../lib/guards.ts";
import {
  LIFECYCLE_PROCESS_CLIENT,
  serveLifecycleProcessDelivery,
} from "../lib/lifecycle-process-delivery.ts";
import {
  type LifecycleStateEntry,
  resolveLifecycleStatePath,
} from "../lib/lifecycle-runtime.ts";
import {
  type HeldDirectory,
  hasCode,
  holdDirectory,
  keys,
  readPrivate,
  recheckDirectories,
  sameFile,
  synchronizeDirectories,
  writeExclusive,
} from "../lib/native-compose-private-state.ts";
import type { NativeEnvironmentPlan } from "../lib/native-env-plan-protocol.ts";
import {
  type NativeHostLifecycle,
  resolveNativeHostInvocationEnvironment,
} from "../lib/native-host-lifecycle-contract.ts";
import {
  createLifecycleProcessController,
  stopLifecycleProcessController,
} from "../lib/project-lifecycle-controller.ts";
import { inspectLifecycleSession } from "../lib/project-lifecycle-sessions.ts";
import { getMuxBackends, resolveMux } from "../mux/mux-resolver.ts";
import type { NativeHookFilePin } from "./native-authored-hook-journal.ts";
import type { NativeAuthoredProjectRunScope } from "./native-authored-project-run.ts";

const SHA = /^[a-f0-9]{64}$/;
const RUN = /^[a-f0-9]{32}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const LIMIT = 64 * 1024;
const issuedProofs = new WeakSet<object>();
export function nativeHostProcessProofIssued(pin: NativeHookFilePin): boolean {
  return issuedProofs.has(pin);
}
function refuse(): never {
  throw new Error(
    "Native host process ownership is retained or changed; values omitted. No process was replayed."
  );
}
function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
function mergedEnvironment(opts: {
  readonly inherited: Readonly<Record<string, string>>;
  readonly selected: Readonly<Record<string, string>>;
  readonly directives: Readonly<Record<string, unknown>> | undefined;
}): Record<string, string> {
  const env = { ...opts.inherited, ...opts.selected };
  for (const [name, directive] of Object.entries(opts.directives ?? {})) {
    if (isRecord(directive) && directive.unset === true) {
      delete env[name];
    }
  }
  return env;
}
function eraseEnvironments(
  environments: Map<string, Record<string, string>>
): void {
  for (const env of environments.values()) {
    for (const name of Object.keys(env)) {
      delete env[name];
    }
  }
  environments.clear();
}
async function capture(path: string) {
  const result = await readPrivate(path, LIMIT);
  return {
    ...result,
    pin: {
      path,
      dev: result.info.dev,
      ino: result.info.ino,
      sha256: digest(result.text),
    },
  };
}
async function unchanged(saved: Awaited<ReturnType<typeof capture>>) {
  const current = await capture(saved.pin.path);
  if (
    !sameFile(saved.info, current.info) ||
    saved.info.mtimeMs !== current.info.mtimeMs ||
    saved.info.ctimeMs !== current.info.ctimeMs ||
    saved.text !== current.text
  ) {
    return refuse();
  }
}
function absentGroup(group: number): void {
  try {
    process.kill(-group, 0);
  } catch (error) {
    if (hasCode(error, "ESRCH")) {
      return;
    }
    throw error;
  }
  refuse();
}
function entry(value: unknown): LifecycleStateEntry | null {
  if (value === null) {
    return null;
  }
  if (
    !(
      isRecord(value) &&
      keys(
        value,
        "backend,branch,composeProject,definitionHash,ownershipToken,processes,projectName,sessionName,updatedAt"
      )
    ) ||
    typeof value.composeProject !== "string" ||
    typeof value.projectName !== "string" ||
    typeof value.sessionName !== "string" ||
    !(value.branch === null || typeof value.branch === "string") ||
    !(value.backend === "tmux" || value.backend === "zellij") ||
    typeof value.ownershipToken !== "string" ||
    !UUID.test(value.ownershipToken) ||
    typeof value.definitionHash !== "string" ||
    !SHA.test(value.definitionHash) ||
    typeof value.updatedAt !== "string" ||
    !Array.isArray(value.processes)
  ) {
    return refuse();
  }
  const processes: LifecycleStateEntry["processes"][number][] = [];
  for (const process of value.processes) {
    if (
      !(
        isRecord(process) &&
        keys(process, "logPath,name,panePid,processGroupId,windowName")
      ) ||
      typeof process.name !== "string" ||
      typeof process.windowName !== "string" ||
      typeof process.logPath !== "string" ||
      typeof process.panePid !== "number" ||
      !Number.isSafeInteger(process.panePid) ||
      process.panePid < 2 ||
      typeof process.processGroupId !== "number" ||
      !Number.isSafeInteger(process.processGroupId) ||
      process.processGroupId < 2
    ) {
      return refuse();
    }
    processes.push({
      name: process.name,
      windowName: process.windowName,
      logPath: process.logPath,
      panePid: process.panePid,
      processGroupId: process.processGroupId,
    });
  }
  return {
    composeProject: value.composeProject,
    projectName: value.projectName,
    branch: value.branch,
    sessionName: value.sessionName,
    backend: value.backend,
    ownershipToken: value.ownershipToken,
    definitionHash: value.definitionHash,
    processes,
    updatedAt: value.updatedAt,
  };
}

/** Strict bounded read of the shared metadata-only controller file. Legacy files
 * may be0644; no permissions are changed or values stored. The exact selected
 * entry, token and live mux session are re-admitted before destructive cleanup.
 */
async function currentEntry(
  scope: NativeAuthoredProjectRunScope,
  name: string
) {
  const path = resolveLifecycleStatePath({ projectDir: scope.projectDir });
  const before = await lstat(path).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  });
  if (!before) {
    return null;
  }
  if (
    !before.isFile() ||
    before.uid !== process.getuid?.() ||
    before.nlink !== 1 ||
    before.size > LIMIT ||
    ![0o600, 0o644].includes(before.mode & 0o777)
  ) {
    return refuse();
  }
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const held = await file.stat();
    if (!sameFile(before, held)) {
      return refuse();
    }
    const bytes = Buffer.alloc(LIMIT + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > LIMIT) {
      return refuse();
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, bytesRead)
    );
    const after = await lstat(path);
    if (
      Buffer.byteLength(text) > LIMIT ||
      !sameFile(held, after) ||
      after.mtimeMs !== held.mtimeMs ||
      after.ctimeMs !== held.ctimeMs
    ) {
      return refuse();
    }
    const raw: unknown = JSON.parse(text);
    if (
      !(isRecord(raw) && keys(raw, "entries") && Array.isArray(raw.entries))
    ) {
      return refuse();
    }
    const selected = raw.entries.filter(
      (candidate) => isRecord(candidate) && candidate.composeProject === name
    );
    if (selected.length > 1) {
      return refuse();
    }
    return selected.length === 0 ? null : entry(selected[0]);
  } finally {
    await file.close();
  }
}

type OwnerRecord = {
  readonly version: 1;
  readonly kind: "native-authored-host-process-owner";
  readonly run: string;
  readonly project: string;
  readonly branch: string | null;
  readonly semantic_hash: string;
  readonly pid: number;
  readonly uid: number;
  readonly names: readonly string[];
  readonly compose_project: string;
  readonly project_name: string;
};
function parseOwner(
  value: unknown,
  scope: NativeAuthoredProjectRunScope,
  run: string
): OwnerRecord {
  if (
    !(
      isRecord(value) &&
      keys(
        value,
        "branch,compose_project,kind,names,pid,project,project_name,run,semantic_hash,uid,version"
      )
    ) ||
    value.version !== 1 ||
    value.kind !== "native-authored-host-process-owner" ||
    value.run !== run ||
    value.project !== scope.projectRoot ||
    value.branch !== scope.branch ||
    typeof value.semantic_hash !== "string" ||
    !SHA.test(value.semantic_hash) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 2 ||
    value.uid !== process.getuid?.() ||
    !Array.isArray(value.names) ||
    !value.names.every((name) => typeof name === "string") ||
    new Set(value.names).size !== value.names.length ||
    typeof value.compose_project !== "string" ||
    typeof value.project_name !== "string"
  ) {
    return refuse();
  }
  const key = digest(
    `${scope.projectRoot}\0${JSON.stringify(scope.branch)}`
  ).slice(0, 24);
  if (
    value.compose_project !== `native-authored-${key}` ||
    !value.project_name.endsWith(`-${key.slice(0, 12)}`)
  ) {
    return refuse();
  }
  return value as OwnerRecord;
}
async function stopKnown(opts: {
  readonly scope: NativeAuthoredProjectRunScope;
  readonly owner: OwnerRecord;
  readonly savedEntry: LifecycleStateEntry | null;
  readonly check: () => Promise<void>;
}) {
  const current = async () => {
    await opts.check();
    if (
      JSON.stringify(
        await currentEntry(opts.scope, opts.owner.compose_project)
      ) !== JSON.stringify(opts.savedEntry)
    ) {
      return refuse();
    }
    if (
      JSON.stringify(
        await currentEntry(opts.scope, opts.owner.compose_project)
      ) !== JSON.stringify(opts.savedEntry)
    ) {
      return refuse();
    }
    await opts.check();
  };
  await current();
  if (opts.savedEntry) {
    const backend = getMuxBackends().get(opts.savedEntry.backend) ?? refuse();
    const inspected = await inspectLifecycleSession({
      backend,
      entry: opts.savedEntry,
      expectedSessionName: opts.savedEntry.sessionName,
      expectedProjectRoot: opts.scope.projectRoot,
      expectedDefinitionHash: opts.owner.semantic_hash,
    });
    // An absent mux session never grants PID/group-only kill authority.
    if (inspected.classification === "absent") {
      for (const process of opts.savedEntry.processes) {
        absentGroup(process.processGroupId ?? refuse());
      }
    } else if (inspected.decision.kind !== "adopt") {
      return refuse();
    }
    await current();
    await stopLifecycleProcessController({
      project: opts.scope,
      projectName: opts.owner.project_name,
      branch: opts.scope.branch,
      composeProject: opts.owner.compose_project,
      definitionHash: opts.owner.semantic_hash,
      assertFresh: current,
    });
    for (const process of opts.savedEntry.processes) {
      absentGroup(process.processGroupId ?? refuse());
    }
  }
  if ((await currentEntry(opts.scope, opts.owner.compose_project)) !== null) {
    return refuse();
  }
  await opts.check();
}

/** Recovery follows authenticated native Removed and the existing frontend lock.
 * Only a complete ready/state pair can authorize the ordinary token-bound stop.
 * Partial launch intent is retained, never replayed or converted to PID authority.
 */
export async function retireNativeAuthoredHostProcesses(opts: {
  readonly scope: NativeAuthoredProjectRunScope;
  readonly run: string;
  readonly assertFresh: () => Promise<void>;
}): Promise<void> {
  if (!RUN.test(opts.run)) {
    return refuse();
  }
  const root = join(opts.scope.projectDir, ".internal/native-authored-runs");
  const path = join(root, `${opts.run}.host-process-owner.json`);
  const saved = await capture(path).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  });
  if (!saved) {
    return;
  }
  const owner = parseOwner(JSON.parse(saved.text), opts.scope, opts.run);
  const ready = await capture(
    join(root, `${opts.run}.host-process-ready.json`)
  );
  const state = await capture(
    join(root, `${opts.run}.host-process-state.json`)
  );
  const stopped = await capture(
    join(root, `${opts.run}.host-process-stopped.json`)
  ).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  });
  const readyValue: unknown = JSON.parse(ready.text);
  const stateValue: unknown = JSON.parse(state.text);
  if (
    !(
      isRecord(readyValue) &&
      keys(
        readyValue,
        "branch,kind,owner,pid,project,run,semantic_hash,uid,version"
      )
    ) ||
    readyValue.version !== 1 ||
    readyValue.kind !== "native-authored-host-process-ready" ||
    readyValue.run !== owner.run ||
    readyValue.project !== owner.project ||
    readyValue.branch !== owner.branch ||
    readyValue.semantic_hash !== owner.semantic_hash ||
    readyValue.pid !== owner.pid ||
    readyValue.uid !== owner.uid ||
    JSON.stringify(readyValue.owner) !== JSON.stringify(saved.pin) ||
    !isRecord(stateValue) ||
    !keys(stateValue, "entry,kind,owner,run,version") ||
    stateValue.version !== 1 ||
    stateValue.kind !== "native-authored-host-process-state" ||
    stateValue.run !== owner.run ||
    JSON.stringify(stateValue.owner) !== JSON.stringify(saved.pin)
  ) {
    return refuse();
  }
  const savedEntry = entry(stateValue.entry);
  if (
    savedEntry &&
    (savedEntry.definitionHash !== owner.semantic_hash ||
      savedEntry.composeProject !== owner.compose_project ||
      savedEntry.projectName !== owner.project_name ||
      savedEntry.branch !== owner.branch ||
      savedEntry.processes.some(
        (process) => !owner.names.includes(process.name)
      ))
  ) {
    return refuse();
  }
  const check = async () => {
    await opts.assertFresh();
    for (const pin of [saved, state, ready, ...(stopped ? [stopped] : [])]) {
      await unchanged(pin);
    }
    await opts.assertFresh();
  };
  if (stopped) {
    const value: unknown = JSON.parse(stopped.text);
    if (
      !(isRecord(value) && keys(value, "kind,ready,run,version")) ||
      value.version !== 1 ||
      value.kind !== "native-authored-host-process-stopped" ||
      value.run !== owner.run ||
      JSON.stringify(value.ready) !== JSON.stringify(ready.pin) ||
      (await currentEntry(opts.scope, owner.compose_project)) !== null
    ) {
      return refuse();
    }
    for (const process of savedEntry?.processes ?? []) {
      absentGroup(process.processGroupId ?? refuse());
    }
  } else {
    await stopKnown({ scope: opts.scope, owner, savedEntry, check });
  }
  await check();
  await unlink(path);
  const held = await holdDirectory(root, false);
  try {
    await synchronizeDirectories([held]);
  } finally {
    await held.file.close();
  }
}
export type NativeAuthoredHostProcesses = {
  readonly proof: (execution: boolean) => Promise<NativeHookFilePin>;
  readonly start: () => Promise<void>;
  readonly assertReady: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly close: () => Promise<void>;
};

/** The ordinary Hack mux controller owns launch, singleton adoption and stop.
 * This adapter only binds its metadata to one held native frontend admission.
 */
export async function createNativeAuthoredHostProcesses(input: {
  readonly scope: NativeAuthoredProjectRunScope;
  readonly run: string;
  readonly semanticHash: string;
  readonly projectName: string;
  readonly lifecycle: NativeHostLifecycle;
  readonly report: () => NativeEnvironmentPlan;
  readonly resolveValues: (
    name: string
  ) => Promise<Readonly<Record<string, string>>>;
  readonly assertFresh: () => Promise<void>;
  readonly signal: AbortSignal;
  readonly remaining: () => number;
}): Promise<NativeAuthoredHostProcesses> {
  const opts = {
    ...input,
    scope: { ...input.scope },
    lifecycle: structuredClone(input.lifecycle),
  };
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
  if (!(RUN.test(opts.run) && SHA.test(opts.semanticHash))) {
    return refuse();
  }
  const root = join(opts.scope.projectDir, ".internal/native-authored-runs");
  const held = await holdDirectory(root, true);
  try {
    const directories: HeldDirectory[] = [held];
    const key = digest(
      `${opts.scope.projectRoot}\0${JSON.stringify(opts.scope.branch)}`
    ).slice(0, 24);
    const projectName = `${opts.projectName}-${key.slice(0, 12)}`;
    const composeProject = `native-authored-${key}`;
    const owner: OwnerRecord = {
      version: 1,
      kind: "native-authored-host-process-owner",
      run: opts.run,
      project: opts.scope.projectRoot,
      branch: opts.scope.branch,
      semantic_hash: opts.semanticHash,
      pid: process.pid,
      uid: process.getuid?.() ?? refuse(),
      names: opts.lifecycle.processes.map((process) => process.name),
      compose_project: composeProject,
      project_name: projectName,
    };
    let active = true;
    let began = false;
    let launchIntent = false;
    let stopped = false;
    let ready: Awaited<ReturnType<typeof capture>> | undefined;
    let stateFile: Awaited<ReturnType<typeof capture>> | undefined;
    let stoppedFile: Awaited<ReturnType<typeof capture>> | undefined;
    let savedEntry: LifecycleStateEntry | null = null;
    const path = join(root, `${opts.run}.host-process-owner.json`);
    await opts.assertFresh();
    if (await currentEntry(opts.scope, composeProject)) {
      return refuse();
    }
    await writeExclusive(path, JSON.stringify(owner));
    await synchronizeDirectories(directories);
    const saved = await capture(path);
    const check = async () => {
      if (!active) {
        return refuse();
      }
      await opts.assertFresh();
      await recheckDirectories(directories);
      await unchanged(saved);
    };
    const deliveries = new Set<
      Awaited<ReturnType<typeof serveLifecycleProcessDelivery>>
    >();
    const environments = new Map<string, Record<string, string>>();
    const processes = opts.lifecycle.processes.map((process) => ({
      name: process.name,
      command: "native-host-process-delivery",
      cwd: process.cwd,
      ...(process.singleton ? { singleton: process.singleton } : {}),
    }));
    const controller = createLifecycleProcessController({
      project: opts.scope,
      projectName,
      branch: opts.scope.branch,
      composeProject,
      env: {},
      definitionHash: opts.semanticHash,
      assertFresh: async () => {
        await check();
        opts.remaining();
      },
      mux: async () => {
        const mux = await resolveMux({});
        // The shared zellij API has no captured group identity. Keep that explicit.
        const backend = mux.backends.get("tmux");
        if (!(backend?.available && ["auto", "tmux"].includes(mux.mode))) {
          return refuse();
        }
        return { mode: "tmux", backends: new Map([["tmux", backend]]) };
      },
      installSignalCleanup: () => ({ dispose: () => undefined }),
      prepareLaunch: async (definition) => {
        await check();
        opts.remaining();
        const invocation =
          opts.lifecycle.processes.find(
            (candidate) => candidate.name === definition.name
          ) ?? refuse();
        const env = environments.get(definition.name) ?? refuse();
        const delivery = await serveLifecycleProcessDelivery({
          root: await realpath("/tmp"),
          launch: {
            command:
              "exec" in invocation.command
                ? invocation.command.exec
                : ["/bin/sh", "-c", invocation.command.shell],
            cwd: resolve(opts.scope.projectRoot, invocation.cwd ?? "."),
            env,
          },
          signal: opts.signal,
          remaining: opts.remaining,
          assertFresh: check,
        });
        deliveries.add(delivery);
        const args = [
          process.execPath,
          ...(Bun.main.startsWith("/$bunfs/")
            ? []
            : ["--no-env-file", resolve(import.meta.dir, "../../index.ts")]),
          LIFECYCLE_PROCESS_CLIENT,
          delivery.path,
        ];
        return {
          command: args
            .map((part) => `'${part.replaceAll("'", "'\\''")}'`)
            .join(" "),
          started: async (value) => {
            if (!(value.processGroupId && value.panePid)) {
              return refuse();
            }
            await delivery.started();
            await check();
            opts.remaining();
            await controller.finalize();
            await delivery.close();
            deliveries.delete(delivery);
          },
        };
      },
    });
    const assertReady = async () => {
      await check();
      if (!ready || stopped) {
        return refuse();
      }
      await unchanged(ready);
      if (!stateFile) {
        return refuse();
      }
      await unchanged(stateFile);
      const current = await currentEntry(opts.scope, composeProject);
      if (JSON.stringify(current) !== JSON.stringify(savedEntry)) {
        return refuse();
      }
      if (savedEntry) {
        const backend = getMuxBackends().get(savedEntry.backend) ?? refuse();
        const inspection = await inspectLifecycleSession({
          backend,
          entry: savedEntry,
          expectedSessionName: savedEntry.sessionName,
          expectedProjectRoot: opts.scope.projectRoot,
          expectedDefinitionHash: opts.semanticHash,
        });
        if (inspection.decision.kind !== "adopt") {
          return refuse();
        }
      }
      await check();
    };
    return Object.freeze({
      async proof(execution: boolean) {
        if (execution) {
          await assertReady();
          const pin = ready?.pin ?? refuse();
          issuedProofs.add(pin);
          return pin;
        }
        await check();
        issuedProofs.add(saved.pin);
        return saved.pin;
      },
      async start() {
        if (began) {
          return refuse();
        }
        began = true;
        // Capture all values before the durable launch intent and any mux effect.
        for (const invocation of opts.lifecycle.processes) {
          const values = await opts.resolveValues(invocation.name);
          const selected = resolveNativeHostInvocationEnvironment({
            invocation,
            report: opts.report(),
            values,
          });
          const env = mergedEnvironment({
            inherited: inheritedEnvironment,
            selected,
            directives: invocation.environment,
          });
          environments.set(invocation.name, env);
          await check();
          opts.remaining();
        }
        launchIntent = true;
        await writeExclusive(
          join(root, `${opts.run}.host-process-intent.json`),
          JSON.stringify({
            version: 1,
            kind: "native-authored-host-process-intent",
            run: opts.run,
            owner: saved.pin,
          })
        );
        await synchronizeDirectories(directories);
        await check();
        opts.remaining();
        if (processes.length !== 0) {
          await controller.startMany({ processes });
        }
        await controller.finalize();
        savedEntry = await currentEntry(opts.scope, composeProject);
        if ((savedEntry !== null) !== controller.hasStarted()) {
          return refuse();
        }
        if (
          savedEntry &&
          (savedEntry.definitionHash !== opts.semanticHash ||
            savedEntry.projectName !== projectName ||
            savedEntry.processes.some(
              (process) => !owner.names.includes(process.name)
            ))
        ) {
          return refuse();
        }
        await check();
        opts.remaining();
        await writeExclusive(
          join(root, `${opts.run}.host-process-state.json`),
          JSON.stringify({
            version: 1,
            kind: "native-authored-host-process-state",
            run: opts.run,
            owner: saved.pin,
            entry: savedEntry,
          })
        );
        await writeExclusive(
          join(root, `${opts.run}.host-process-ready.json`),
          JSON.stringify({
            version: 1,
            kind: "native-authored-host-process-ready",
            run: opts.run,
            project: owner.project,
            branch: owner.branch,
            semantic_hash: owner.semantic_hash,
            owner: saved.pin,
            pid: owner.pid,
            uid: owner.uid,
          })
        );
        await synchronizeDirectories(directories);
        ready = await capture(
          join(root, `${opts.run}.host-process-ready.json`)
        );
        stateFile = await capture(
          join(root, `${opts.run}.host-process-state.json`)
        );
        await assertReady();
      },
      assertReady,
      async stop() {
        if (!launchIntent) {
          stopped = true;
          return;
        }
        await assertReady();
        await stopKnown({ scope: opts.scope, owner, savedEntry, check });
        await check();
        await writeExclusive(
          join(root, `${opts.run}.host-process-stopped.json`),
          JSON.stringify({
            version: 1,
            kind: "native-authored-host-process-stopped",
            run: opts.run,
            ready: ready?.pin,
          })
        );
        await synchronizeDirectories(directories);
        stoppedFile = await capture(
          join(root, `${opts.run}.host-process-stopped.json`)
        );
        stopped = true;
      },
      async close() {
        if (!active) {
          return;
        }
        try {
          for (const delivery of deliveries) {
            await delivery.close();
          }
          if (launchIntent && !stopped) {
            return refuse();
          }
          await check();
          for (const file of [ready, stateFile, stoppedFile]) {
            if (file) {
              await unchanged(file);
            }
          }
          if (
            launchIntent &&
            (await currentEntry(opts.scope, composeProject)) !== null
          ) {
            return refuse();
          }
          await unlink(path);
          await synchronizeDirectories(directories);
        } finally {
          eraseEnvironments(environments);
          active = false;
          await held.file.close();
        }
      },
    });
  } catch (error) {
    await held.file.close();
    throw error;
  }
}
