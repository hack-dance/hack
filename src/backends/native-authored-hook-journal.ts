import { createHash } from "node:crypto";
import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../lib/guards.ts";
import {
  type HeldDirectory,
  hasCode,
  keys,
  readPrivate,
  sameFile,
  synchronizeDirectories,
  writeExclusive,
} from "../lib/native-compose-private-state.ts";
import {
  NATIVE_HOOK_PHASES,
  type NativeHookPhase,
  type NativeHookResult,
} from "../lib/native-host-hook-runner.ts";

const LIMIT = 8192;
const issuedPermits = new WeakSet<object>();
const pinMetadata = new WeakMap<
  object,
  Awaited<ReturnType<typeof readPrivate>>["info"]
>();
export function nativeHookPermitIssued(value: NativeHookFilePin): boolean {
  return issuedPermits.has(value);
}
const SHA = /^[a-f0-9]{64}$/;
const RUN = /^[a-f0-9]{32}$/;
export type NativeHookFilePin = {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly sha256: string;
};
type Store = {
  readonly root: HeldDirectory;
  readonly held: readonly HeldDirectory[];
  readonly key: string;
  readonly projectRoot: string;
  readonly branch: string | null;
  readonly check: () => Promise<void>;
};
type Owner = {
  readonly version: 1;
  readonly kind: "native-authored-hook-owner";
  readonly run: string;
  readonly project: string;
  readonly branch: string | null;
  readonly selection: string;
  readonly pid: number;
  readonly uid: number;
};
function refuse(): never {
  throw new Error(
    "Native hook ownership or completion is retained or changed; values omitted. No hook was replayed."
  );
}
function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
function parseOwner(value: unknown): Owner {
  if (
    !(
      isRecord(value) &&
      keys(value, "branch,kind,pid,project,run,selection,uid,version")
    ) ||
    value.version !== 1 ||
    value.kind !== "native-authored-hook-owner" ||
    typeof value.run !== "string" ||
    !RUN.test(value.run) ||
    typeof value.selection !== "string" ||
    !SHA.test(value.selection) ||
    typeof value.project !== "string" ||
    !(value.branch === null || typeof value.branch === "string") ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    typeof value.uid !== "number" ||
    !Number.isSafeInteger(value.uid) ||
    value.uid < 0
  ) {
    return refuse();
  }
  return {
    version: 1,
    kind: "native-authored-hook-owner",
    run: value.run,
    project: value.project,
    branch: value.branch,
    selection: value.selection,
    pid: value.pid,
    uid: value.uid,
  };
}
async function capture(path: string) {
  const current = await readPrivate(path, LIMIT);
  const pin = {
    path,
    dev: current.info.dev,
    ino: current.info.ino,
    sha256: digest(current.text),
  };
  pinMetadata.set(pin, current.info);
  return { pin, text: current.text };
}
async function unchanged(expected: NativeHookFilePin): Promise<void> {
  const current = await readPrivate(expected.path, LIMIT);
  const original = pinMetadata.get(expected);
  if (
    !(original && sameFile(original, current.info)) ||
    original.mtimeMs !== current.info.mtimeMs ||
    original.ctimeMs !== current.info.ctimeMs ||
    digest(current.text) !== expected.sha256
  ) {
    refuse();
  }
}
async function absent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  refuse();
}
function ownerPath(store: Store): string {
  return join(store.root.path, `${store.key}.hooks.json`);
}

/** Called only inside the frontend's held admission. Unknown intent is not replay authority. */
export async function loadNativeAuthoredHookOwner(
  store: Store
): Promise<Owner | null> {
  let current: Awaited<ReturnType<typeof readPrivate>>;
  try {
    current = await readPrivate(ownerPath(store), LIMIT);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
  const owner = parseOwner(JSON.parse(current.text));
  if (owner.project !== store.projectRoot || owner.branch !== store.branch) {
    return refuse();
  }
  await store.check();
  return owner;
}

export type NativeAuthoredHookOwner = {
  readonly assertFresh: () => Promise<void>;
  readonly permit: (opts: {
    readonly role: "preflight" | "execution";
    readonly semanticHash: string;
  }) => Promise<NativeHookFilePin>;
  readonly phase: (opts: {
    readonly phase: NativeHookPhase;
    readonly prepare: () => Promise<() => Promise<NativeHookResult>>;
    readonly assertFresh: () => Promise<void>;
    readonly beforeSpawn: () => void;
  }) => Promise<NativeHookResult>;
  readonly child: (group: number) => Promise<void>;
  readonly publishStop: (endpoint: {
    readonly port: number;
    readonly token: string;
  }) => Promise<void>;
  readonly graphEntered: () => Promise<void>;
  readonly graphRemoved: () => Promise<void>;
  readonly graphChild: (group: number) => Promise<void>;
  readonly graphSettled: () => void;
  /** Only a known nonpending journal and separately proven graph absence may retire. */
  readonly retire: () => Promise<void>;
};

/** The owner is issued under the shared frontend admission, never from a public report.
 * Append-only intent/completion files preserve interrupted windows without normalization.
 * No command text, environment value or arbitrary subprocess error is persisted here.
 */
export async function createNativeAuthoredHookOwner(
  store: Store,
  input: {
    readonly run: string;
    readonly selectionHash: string;
  }
): Promise<NativeAuthoredHookOwner> {
  const run = input.run;
  const selection = input.selectionHash;
  if (!(RUN.test(run) && SHA.test(selection))) {
    return refuse();
  }
  const record: Owner = {
    version: 1,
    kind: "native-authored-hook-owner",
    run,
    project: store.projectRoot,
    branch: store.branch,
    selection,
    pid: process.pid,
    uid: process.getuid?.() ?? refuse(),
  };
  const path = ownerPath(store);
  await store.check();
  await absent(path);
  const written = await writeExclusive(path, JSON.stringify(record));
  await synchronizeDirectories(store.held);
  const captured = await capture(path);
  const observed = pinMetadata.get(captured.pin);
  if (
    !(observed && sameFile(written, observed)) ||
    captured.text !== JSON.stringify(record)
  ) {
    return refuse();
  }
  const owner = captured.pin;
  const pins: NativeHookFilePin[] = [owner];
  const completed = new Set<NativeHookPhase>();
  const succeeded = new Set<NativeHookPhase>();
  let entered = false;
  let removed = false;
  let graphGroup: number | undefined;
  let pending:
    | {
        readonly phase: NativeHookPhase;
        readonly intent: NativeHookFilePin;
        children: number;
      }
    | undefined;
  let active = true;
  const assertFresh = async () => {
    if (!active) {
      return refuse();
    }
    await store.check();
    for (const expected of pins) {
      await unchanged(expected);
    }
    await store.check();
  };
  const append = async (suffix: string, value: unknown) => {
    const target = join(store.root.path, `${run}.hook-${suffix}.json`);
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > LIMIT) {
      return refuse();
    }
    await assertFresh();
    await absent(target);
    const info = await writeExclusive(target, text);
    const read = await capture(target);
    const observed = pinMetadata.get(read.pin);
    if (!(observed && sameFile(info, observed)) || read.text !== text) {
      return refuse();
    }
    pins.push(read.pin);
    await synchronizeDirectories(store.held);
    await assertFresh();
    return pins.at(-1) ?? refuse();
  };
  const capability: NativeAuthoredHookOwner = {
    assertFresh,
    async permit(opts) {
      const role = opts.role;
      const semanticHash = opts.semanticHash;
      if (
        !SHA.test(semanticHash) ||
        (role === "execution" && !succeeded.has("up.before")) ||
        pending
      ) {
        return refuse();
      }
      const permit = await append(`${role}-permit`, {
        version: 1,
        kind: "native-authored-finite-hook-permit",
        role,
        run,
        project: record.project,
        branch: record.branch,
        semantic_hash: semanticHash,
        owner,
        pid: record.pid,
        uid: record.uid,
      });
      Object.freeze(permit);
      issuedPermits.add(permit);
      return permit;
    },
    async phase(opts) {
      const phase = opts.phase;
      if (
        !NATIVE_HOOK_PHASES.includes(phase) ||
        pending ||
        completed.has(phase)
      ) {
        return refuse();
      }
      if (
        (phase === "up.after" && !(entered && succeeded.has("up.before"))) ||
        (phase === "down.before" &&
          !(entered && succeeded.has("up.after") && !removed)) ||
        (phase === "down.after" && !(removed && succeeded.has("down.before")))
      ) {
        return refuse();
      }
      await assertFresh();
      const execute = await opts.prepare();
      await opts.assertFresh();
      await assertFresh();
      const intent = await append(`${phase}-intent`, {
        version: 1,
        kind: "native-authored-hook-intent",
        run,
        phase,
        selection,
      });
      pending = { phase, intent, children: 0 };
      await opts.assertFresh();
      await assertFresh();
      opts.beforeSpawn();
      const result = await execute();
      await assertFresh();
      if (result.outcome === "complete") {
        await append(`${phase}-complete`, {
          version: 1,
          kind: "native-authored-hook-complete",
          run,
          phase,
          intent,
          result,
          children: pending.children,
        });
        completed.add(phase);
        if (result.exitCode === 0 && !result.timedOut && !result.canceled) {
          succeeded.add(phase);
        }
        pending = undefined;
      }
      return result;
    },
    async publishStop(endpoint) {
      if (
        !(
          entered &&
          succeeded.has("up.after") &&
          Number.isInteger(endpoint.port)
        ) ||
        endpoint.port < 1 ||
        endpoint.port > 65_535 ||
        !SHA.test(endpoint.token)
      ) {
        return refuse();
      }
      await append("stop", {
        version: 1,
        kind: "native-authored-hook-stop",
        run,
        port: endpoint.port,
        token: endpoint.token,
        owner,
      });
    },
    async graphEntered() {
      if (entered || pending || !succeeded.has("up.before")) {
        return refuse();
      }
      await append("graph-entered", {
        version: 1,
        kind: "native-authored-hook-graph",
        run,
        state: "entered",
      });
      entered = true;
    },
    async graphChild(group) {
      if (
        !entered ||
        graphGroup !== undefined ||
        !Number.isSafeInteger(group) ||
        group < 1
      ) {
        return refuse();
      }
      await append("graph-child", {
        version: 1,
        kind: "native-authored-hook-graph-child",
        run,
        group,
      });
      graphGroup = group;
    },
    graphSettled() {
      if (entered && graphGroup === undefined) {
        return refuse();
      }
      if (graphGroup !== undefined) {
        requireAbsentGroup(graphGroup);
      }
    },
    async graphRemoved() {
      if (!entered || removed) {
        return refuse();
      }
      await append("graph-removed", {
        version: 1,
        kind: "native-authored-hook-graph",
        run,
        state: "removed",
      });
      removed = true;
    },
    async child(group) {
      if (
        !(pending && Number.isSafeInteger(group)) ||
        group < 1 ||
        pending.children >= 1024
      ) {
        return refuse();
      }
      const ordinal = pending.children++;
      await append(`${pending.phase}-child-${ordinal}`, {
        version: 1,
        kind: "native-authored-hook-child",
        run,
        phase: pending.phase,
        group,
      });
    },
    async retire() {
      if (pending || (entered && !removed)) {
        return refuse();
      }
      capability.graphSettled();
      await assertFresh();
      await unchanged(owner);
      await store.check();
      capability.graphSettled();
      await unlink(path);
      await synchronizeDirectories(store.held);
      active = false;
    },
  };
  return Object.freeze(capability);
}

function knownCompletion(
  value: unknown,
  intent: NativeHookFilePin,
  run: string,
  phase: NativeHookPhase
): number {
  if (
    !(
      isRecord(value) &&
      keys(value, "children,intent,kind,phase,result,run,version")
    ) ||
    value.version !== 1 ||
    value.kind !== "native-authored-hook-complete" ||
    value.run !== run ||
    value.phase !== phase ||
    JSON.stringify(value.intent) !== JSON.stringify(intent) ||
    !isRecord(value.result) ||
    !keys(value.result, "canceled,exitCode,outcome,timedOut") ||
    value.result.outcome !== "complete" ||
    typeof value.children !== "number" ||
    !Number.isSafeInteger(value.children) ||
    value.children < 0 ||
    value.children > 1024 ||
    typeof value.result.exitCode !== "number" ||
    !Number.isInteger(value.result.exitCode) ||
    typeof value.result.canceled !== "boolean" ||
    typeof value.result.timedOut !== "boolean"
  ) {
    return refuse();
  }
  return value.children;
}
function knownChild(
  value: unknown,
  run: string,
  phase: NativeHookPhase
): number {
  if (
    !(isRecord(value) && keys(value, "group,kind,phase,run,version")) ||
    value.version !== 1 ||
    value.kind !== "native-authored-hook-child" ||
    value.run !== run ||
    value.phase !== phase ||
    typeof value.group !== "number" ||
    !Number.isSafeInteger(value.group) ||
    value.group < 1
  ) {
    refuse();
  }
  requireAbsentGroup(value.group);
  return value.group;
}
function requireAbsentGroup(group: number): void {
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
async function recoverGraphChild(
  store: Store,
  run: string,
  groups: number[]
): Promise<NativeHookFilePin[]> {
  const entered = await optionalCapture(
    join(store.root.path, `${run}.hook-graph-entered.json`)
  );
  const path = join(store.root.path, `${run}.hook-graph-child.json`);
  if (!entered) {
    await absent(path);
    return [];
  }
  const value: unknown = JSON.parse(entered.text);
  if (
    !(isRecord(value) && keys(value, "kind,run,state,version")) ||
    value.version !== 1 ||
    value.kind !== "native-authored-hook-graph" ||
    value.run !== run ||
    value.state !== "entered"
  ) {
    return refuse();
  }
  const child = await capture(path);
  const record: unknown = JSON.parse(child.text);
  if (
    !(isRecord(record) && keys(record, "group,kind,run,version")) ||
    record.version !== 1 ||
    record.kind !== "native-authored-hook-graph-child" ||
    record.run !== run ||
    typeof record.group !== "number" ||
    !Number.isSafeInteger(record.group) ||
    record.group < 1
  ) {
    return refuse();
  }
  requireAbsentGroup(record.group);
  groups.push(record.group);
  return [entered.pin, child.pin];
}

async function optionalCapture(
  path: string
): Promise<Awaited<ReturnType<typeof capture>> | undefined> {
  try {
    return await capture(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}
async function recoverPhase(
  store: Store,
  owner: Owner,
  phase: NativeHookPhase,
  groups: number[]
): Promise<NativeHookFilePin[]> {
  const { run } = owner;
  const prefix = `${run}.hook-${phase}-child-`;
  const countChildren = async () =>
    (await readdir(store.root.path)).filter((name) => name.startsWith(prefix))
      .length;
  const intent = await optionalCapture(
    join(store.root.path, `${run}.hook-${phase}-intent.json`)
  );
  const completePath = join(
    store.root.path,
    `${run}.hook-${phase}-complete.json`
  );
  if (!intent) {
    await absent(completePath);
    if ((await countChildren()) !== 0) {
      return refuse();
    }
    return [];
  }
  const value: unknown = JSON.parse(intent.text);
  if (
    !(isRecord(value) && keys(value, "kind,phase,run,selection,version")) ||
    value.version !== 1 ||
    value.kind !== "native-authored-hook-intent" ||
    value.phase !== phase ||
    value.run !== run ||
    value.selection !== owner.selection
  ) {
    return refuse();
  }
  const complete = await capture(completePath);
  const count = knownCompletion(
    JSON.parse(complete.text),
    intent.pin,
    run,
    phase
  );
  const pins = [intent.pin, complete.pin];
  for (let ordinal = 0; ordinal < count; ordinal++) {
    const child = await capture(
      join(store.root.path, `${prefix}${ordinal}.json`)
    );
    groups.push(knownChild(JSON.parse(child.text), run, phase));
    pins.push(child.pin);
  }
  if ((await countChildren()) !== count) {
    return refuse();
  }
  return pins;
}
/** Called only after existing recovery authenticates exact native Removed.
 * Unknown host completion remains blocking evidence even when native resources are gone.
 * This never executes a hook or obtains environment values.
 */
export async function retireNativeAuthoredRecoveredHooks(
  store: Store,
  run: string
): Promise<void> {
  const saved = await optionalCapture(ownerPath(store));
  if (!saved) {
    return;
  }
  const owner = parseOwner(JSON.parse(saved.text));
  if (
    owner.run !== run ||
    owner.project !== store.projectRoot ||
    owner.branch !== store.branch
  ) {
    return refuse();
  }
  const groups: number[] = [];
  const pins = [saved.pin, ...(await recoverGraphChild(store, run, groups))];
  for (const phase of NATIVE_HOOK_PHASES) {
    pins.push(...(await recoverPhase(store, owner, phase, groups)));
  }
  await store.check();
  for (const current of pins) {
    await unchanged(current);
  }
  await unchanged(saved.pin);
  for (const group of groups) {
    requireAbsentGroup(group);
  }
  await unlink(ownerPath(store));
  await synchronizeDirectories(store.held);
}
