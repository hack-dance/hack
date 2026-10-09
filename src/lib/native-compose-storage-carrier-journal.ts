import { createHash, randomBytes } from "node:crypto";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "./guards.ts";
import type {
  NativeComposeIdentity,
  NativeComposeMaterialBinding,
} from "./native-compose-generation.ts";
import {
  type HeldDirectory,
  holdDirectory,
  keys,
  parsePrivateJson,
  readPrivate,
  recheckDirectories,
  sameFile,
  writeExclusive,
} from "./native-compose-private-state.ts";
import { nativeComposeRetainedVolumesValid } from "./native-compose-retained-storage.ts";
import type { NativeComposeStorageWitnessState } from "./native-compose-storage-witness-state.ts";
import {
  type NativeComposeStorageXattrInvocation,
  nativeComposeStorageXattrArtifactValid,
} from "./native-compose-storage-witness-xattr-carrier.ts";
import { refuseNativeComposeStorageXattr as refuse } from "./native-compose-storage-witness-xattr-codec.ts";

const LIMIT = 16 * 1024;
const TOKEN = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const ENGINE = /^[a-zA-Z0-9][a-zA-Z0-9:-]{0,127}$/;
const RUNTIME = /^[a-z0-9][a-z0-9_-]{0,127}$/;
type Created = { readonly id: string; readonly createdAt: string };
type Intent = {
  readonly invocationId: string;
  readonly engineId: string;
  readonly runtimeIdentity: string;
  readonly ownerToken: string;
  readonly volume: NonNullable<
    NativeComposeStorageXattrInvocation["target"]["volume"]
  >;
  readonly artifact: NativeComposeStorageXattrInvocation["artifact"];
  readonly scope: NativeComposeStorageXattrInvocation["scope"];
  readonly operation: NativeComposeStorageXattrInvocation["request"]["operation"];
  readonly readonly: boolean;
  readonly uid: number;
  readonly gid: number;
  readonly created: Created | null;
};
type Journal = {
  readonly version: 1;
  readonly token: string;
  readonly revision: number;
  readonly intent: Intent | null;
};
type Bound = {
  readonly directory: HeldDirectory;
  readonly token: string;
  readonly check: () => Promise<unknown>;
};
/** Original completion only. A reader observation can never issue this handle. */
export type NativeComposeStorageCarrierCompletion = Readonly<
  Record<never, never>
>;
const completions = new WeakMap<
  NativeComposeStorageCarrierCompletion,
  {
    readonly invocationId: string;
    readonly check: () => Promise<void>;
  }
>();
export function consumeNativeComposeStorageCarrierCompletion(opts: {
  readonly completion: NativeComposeStorageCarrierCompletion;
  readonly invocationId: string;
}): () => Promise<void> {
  const selected = completions.get(opts.completion) ?? refuse();
  completions.delete(opts.completion);
  if (selected.invocationId !== opts.invocationId) {
    return refuse();
  }
  return selected.check;
}
/** Saved observation only. Neither this snapshot nor its check grants retirement
 * or completion authority for an original host command. */
export type NativeComposeStorageReadonlyCarrierIntent = Intent & {
  readonly operation: "verify";
  readonly readonly: true;
  readonly created: Created;
};
export function captureNativeComposeStorageReadonlyCarrierIntent(
  value: unknown
): NativeComposeStorageReadonlyCarrierIntent {
  if (
    !intentValid(value) ||
    value.operation !== "verify" ||
    value.readonly !== true ||
    value.created === null
  ) {
    return refuse();
  }
  return Object.freeze({
    ...structuredClone(value),
    operation: "verify",
    readonly: true,
    created: Object.freeze({ ...value.created }),
  });
}
function created(value: unknown): Created {
  if (
    !(
      isRecord(value) &&
      keys(value, "createdAt,id") &&
      typeof value.id === "string" &&
      HASH.test(value.id) &&
      nativeComposeRetainedVolumesValid([
        { name: "carrier", storage: "carrier", createdAt: value.createdAt },
      ])
    )
  ) {
    return refuse();
  }
  return Object.freeze({ id: value.id, createdAt: String(value.createdAt) });
}
function scopeValid(value: unknown): boolean {
  return (
    isRecord(value) &&
    keys(
      value,
      "currentGenerationId,generationId,pendingGenerationId,pendingToken"
    ) &&
    typeof value.generationId === "string" &&
    TOKEN.test(value.generationId) &&
    [
      value.currentGenerationId,
      value.pendingGenerationId,
      value.pendingToken,
    ].every(
      (entry) =>
        entry === null || (typeof entry === "string" && TOKEN.test(entry))
    )
  );
}
function intentValid(value: unknown): value is Intent {
  return (
    isRecord(value) &&
    keys(
      value,
      "artifact,created,engineId,gid,invocationId,operation,ownerToken,readonly,runtimeIdentity,scope,uid,volume"
    ) &&
    typeof value.invocationId === "string" &&
    TOKEN.test(value.invocationId) &&
    typeof value.engineId === "string" &&
    ENGINE.test(value.engineId) &&
    typeof value.runtimeIdentity === "string" &&
    RUNTIME.test(value.runtimeIdentity) &&
    typeof value.ownerToken === "string" &&
    TOKEN.test(value.ownerToken) &&
    nativeComposeRetainedVolumesValid([value.volume]) &&
    nativeComposeStorageXattrArtifactValid(value.artifact) &&
    scopeValid(value.scope) &&
    ["root", "verify", "seed"].includes(String(value.operation)) &&
    value.readonly === (value.operation !== "seed") &&
    [value.uid, value.gid].every(
      (entry) =>
        typeof entry === "number" &&
        Number.isInteger(entry) &&
        entry >= 0 &&
        entry <= 4_294_967_295 &&
        !Object.is(entry, -0)
    ) &&
    (value.created === null || Boolean(created(value.created)))
  );
}
function decode(text: string, token: string): Journal {
  const value = parsePrivateJson(text);
  if (
    !(
      isRecord(value) &&
      keys(value, "intent,revision,token,version") &&
      value.version === 1 &&
      value.token === token &&
      TOKEN.test(token) &&
      typeof value.revision === "number" &&
      Number.isSafeInteger(value.revision) &&
      value.revision >= 0 &&
      (value.intent === null || intentValid(value.intent))
    )
  ) {
    return refuse();
  }
  return Object.freeze({
    version: 1,
    token,
    revision: value.revision,
    intent: value.intent === null ? null : value.intent,
  });
}
async function read(bound: Bound) {
  const value = await readPrivate(
    join(bound.directory.path, "carrier.json"),
    LIMIT
  );
  await recheckDirectories([bound.directory]);
  return { ...value, state: decode(value.text, bound.token) };
}
async function save(
  bound: Bound,
  prior: Awaited<ReturnType<typeof read>>,
  intent: Intent | null,
  beforeReplace?: () => Promise<void>
) {
  if (prior.state.revision >= Number.MAX_SAFE_INTEGER) {
    return refuse();
  }
  const text = JSON.stringify({
    version: 1,
    token: bound.token,
    revision: prior.state.revision + 1,
    intent,
  });
  decode(text, bound.token);
  const path = join(bound.directory.path, "carrier.json");
  const temporary = join(
    bound.directory.path,
    `.carrier-${randomBytes(16).toString("hex")}`
  );
  const written = await writeExclusive(temporary, text);
  const latest = await read(bound);
  if (!sameFile(latest.info, prior.info) || latest.text !== prior.text) {
    return refuse();
  }
  await bound.check();
  if (beforeReplace) {
    await beforeReplace();
  }
  // The authority check may await transport. Recheck the captured incarnation
  // after it, immediately before replacing only that exact journal.
  const final = await read(bound);
  if (!sameFile(final.info, prior.info) || final.text !== prior.text) {
    return refuse();
  }
  await rename(temporary, path);
  await bound.directory.file.sync();
  const published = await read(bound);
  if (!sameFile(published.info, written) || published.text !== text) {
    return refuse();
  }
  await bound.check();
  return published;
}
/** Required before any finite carrier effects. A missing or changed journal is never initialized on resume. */
export async function initializeNativeComposeStorageCarrierJournal(
  opts: Bound
): Promise<void> {
  const bound = Object.freeze({
    directory: Object.freeze({ ...opts.directory }),
    token: opts.token,
    check: opts.check,
  });
  if (!TOKEN.test(bound.token)) {
    return refuse();
  }
  await writeExclusive(
    join(bound.directory.path, "carrier.json"),
    JSON.stringify({
      version: 1,
      token: bound.token,
      revision: 0,
      intent: null,
    })
  );
  await bound.directory.file.sync();
  await read(bound);
  await bound.check();
}
/** The transport receives only created(), never the owner's completion authority. */
export async function beginNativeComposeStorageCarrierIntent(
  opts: Bound & {
    readonly input: Omit<NativeComposeStorageXattrInvocation, "recordCreated">;
  }
) {
  const input = structuredClone(opts.input);
  const bound = Object.freeze({
    directory: Object.freeze({ ...opts.directory }),
    token: opts.token,
    check: opts.check,
  });
  const prior = await read(bound);
  if (prior.state.intent !== null || input.target.volume === null) {
    return refuse();
  }
  const intent: Intent = Object.freeze({
    invocationId: input.invocationId,
    engineId: input.target.engineId,
    runtimeIdentity: input.target.runtimeIdentity,
    ownerToken: input.target.ownerToken,
    volume: input.target.volume,
    artifact: input.artifact,
    scope: input.scope,
    operation: input.request.operation,
    readonly: input.readonly,
    uid: input.uid,
    gid: input.gid,
    created: null,
  });
  await save(bound, prior, intent);
  let recorded: Created | null = null;
  let recording = false;
  let completing = false;
  const requireIntent = async () => {
    const latest = await read(bound);
    if (
      JSON.stringify(latest.state.intent) !==
      JSON.stringify({ ...intent, created: recorded })
    ) {
      return refuse();
    }
    return latest;
  };
  return Object.freeze({
    async recordCreated(value: Created): Promise<void> {
      // Consume before awaiting; copies, duplicate publication and concurrent callbacks refuse.
      if (recording || recorded) {
        return refuse();
      }
      recording = true;
      const selected = created(structuredClone(value));
      await bound.check();
      const latest = await requireIntent();
      await save(bound, latest, { ...intent, created: selected });
      recorded = selected;
    },
    async complete(
      value: Created
    ): Promise<NativeComposeStorageCarrierCompletion> {
      if (completing) {
        return refuse();
      }
      completing = true;
      const selected = created(structuredClone(value));
      if (!recorded || JSON.stringify(recorded) !== JSON.stringify(selected)) {
        return refuse();
      }
      await bound.check();
      const latest = await requireIntent();
      const published = await save(bound, latest, null);
      const completion = Object.freeze({});
      completions.set(completion, {
        invocationId: intent.invocationId,
        check: async () => {
          await bound.check();
          const selected = await read(bound);
          if (
            !sameFile(selected.info, published.info) ||
            selected.text !== published.text
          ) {
            return refuse();
          }
        },
      });
      return completion;
    },
  });
}

/** Read an already recorded readonly verification without initializing, changing,
 * completing or replaying any journal. Exact original scope remains required. */
export async function readNativeComposeStorageReadonlyCarrierIntent(
  opts: Bound & {
    readonly current: NativeComposeMaterialBinding;
    readonly engineId: string;
    readonly volume: NativeComposeStorageXattrInvocation["target"]["volume"];
    readonly artifact: NativeComposeStorageXattrInvocation["artifact"];
  }
) {
  const bound = Object.freeze({
    directory: Object.freeze({ ...opts.directory }),
    token: opts.token,
    check: opts.check,
  });
  const expected = structuredClone({
    current: opts.current,
    engineId: opts.engineId,
    volume: opts.volume,
    artifact: opts.artifact,
  });
  await bound.check();
  const prior = await read(bound);
  const value = prior.state.intent;
  if (
    !value ||
    value.operation !== "verify" ||
    value.readonly !== true ||
    value.created === null ||
    value.engineId !== expected.engineId ||
    value.runtimeIdentity !== expected.current.identity.composeProject ||
    value.ownerToken !== expected.current.identity.ownerToken ||
    JSON.stringify(value.volume) !== JSON.stringify(expected.volume) ||
    JSON.stringify(value.artifact) !== JSON.stringify(expected.artifact) ||
    value.scope.generationId !== expected.current.generationId ||
    value.scope.currentGenerationId !== expected.current.currentGenerationId ||
    value.scope.pendingGenerationId !== expected.current.pendingGenerationId ||
    value.scope.pendingToken !== expected.current.pendingToken
  ) {
    return refuse();
  }
  const intent = captureNativeComposeStorageReadonlyCarrierIntent(value);
  const assertUnchanged = async () => {
    await bound.check();
    const latest = await read(bound);
    if (!sameFile(latest.info, prior.info) || latest.text !== prior.text) {
      return refuse();
    }
    await bound.check();
  };
  await assertUnchanged();
  let completing = false;
  return Object.freeze({
    intent,
    assertUnchanged,
    // Only the owning witness calls this after its fresh absent-work proof.
    // This is exact journal completion, never helper retirement authority.
    async completeRemoved(checkRemoved: () => Promise<void>): Promise<void> {
      if (completing) {
        return refuse();
      }
      completing = true;
      await assertUnchanged();
      await checkRemoved();
      await assertUnchanged();
      await save(bound, prior, null, checkRemoved);
    },
  });
}

/** Saved-only check. Broken anchors and unknown intent block admission/retirement but permit explicit saved stop. */
export async function nativeComposeStorageCarriersPending(opts: {
  readonly identity: NativeComposeIdentity;
  readonly states: readonly NativeComposeStorageWitnessState[] | undefined;
}): Promise<boolean> {
  for (const state of opts.states ?? []) {
    if (state.state === "expected") {
      return true;
    }
    if (state.reference.version !== 3) {
      continue;
    }
    const held: HeldDirectory[] = [];
    try {
      const parent = join(
        opts.identity.checkoutRoot,
        ".hack",
        ".internal",
        "native-compose",
        opts.identity.instanceId
      );
      held.push(await holdDirectory(parent, true));
      held.push(await holdDirectory(join(parent, "storage-witnesses"), true));
      held.push(
        await holdDirectory(
          join(
            held[1]?.path ?? refuse(),
            createHash("sha256").update(state.name).digest("hex")
          ),
          true
        )
      );
      const root = held[1] ?? refuse();
      const directory = held[2] ?? refuse();
      if (
        !(
          sameFile(root.info, state.reference.root) &&
          sameFile(directory.info, state.reference.directory)
        )
      ) {
        return true;
      }
      const current = await read({
        directory,
        token: state.reference.carrierJournalToken,
        check: async () => {
          // Saved status has no effect authority; private anchors are checked below.
        },
      });
      await recheckDirectories(held);
      if (current.state.intent !== null) {
        return true;
      }
    } catch {
      return true;
    } finally {
      await Promise.allSettled(held.map((entry) => entry.file.close()));
    }
  }
  return false;
}
