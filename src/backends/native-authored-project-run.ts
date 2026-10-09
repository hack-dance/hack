import { createHash } from "node:crypto";
import { link, lstat, mkdir, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../lib/guards.ts";
import {
  createNativeComposePrivateMutationLock,
  type HeldDirectory,
  hasCode,
  holdDirectory,
  keys,
  privateDirectory,
  privateIgnore,
  readPrivate,
  recheckDirectories,
  sameFile,
  synchronizeDirectories,
  token,
  writeExclusive,
} from "../lib/native-compose-private-state.ts";
import {
  type NativeEnvMetadata,
  parseNativeEnvMetadata,
} from "../lib/native-env-plan-protocol.ts";
import {
  type NativeAuthoredReceipt,
  type NativeAuthoredReview,
  nativeAuthoredReceiptBinding,
  parseNativeAuthoredReceipt,
  parseNativeAuthoredReview,
} from "./native-authored-graph-protocol.ts";

const LIMIT = 64 * 1024;
const SOURCE_LIMIT = 1024 * 1024;
const CONTROL = /\p{Cc}/u;
const HEX64 = /^[a-f0-9]{64}$/;
const HEX32 = /^[a-f0-9]{32}$/;
export type NativeAuthoredProjectRunScope = {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly nativeHome: string;
  readonly branch: string | null;
};
/** Match Candidate::plan_with_branch without acquiring or resolving authored inputs. */
export function nativeAuthoredProjectNamespace(
  scope: NativeAuthoredProjectRunScope
): string {
  const hash = createHash("sha256");
  if (scope.branch !== null) {
    hash.update("hack-native-branch-namespace-v1\0");
  }
  hash.update(scope.projectRoot);
  if (scope.branch !== null) {
    hash.update("\0").update(scope.branch);
  }
  return hash.digest("hex");
}
export type NativeAuthoredProjectRun = {
  readonly version: 2;
  readonly kind: "native-authored-project-run";
  readonly receipt: NativeAuthoredReceipt;
};
export type NativeAuthoredProjectRunSelection = {
  readonly record: NativeAuthoredProjectRun;
  readonly identity: {
    readonly dev: number;
    readonly ino: number;
    readonly sha256: string;
  };
};
export type NativeAuthoredProjectStart = {
  readonly version: 2;
  readonly kind: "native-authored-project-start";
  readonly review: NativeAuthoredReview;
};
export type NativeAuthoredProjectStartSelection = {
  readonly record: NativeAuthoredProjectStart;
  readonly identity: NativeAuthoredProjectRunSelection["identity"];
};
export type NativeAuthoredProjectSource = {
  readonly path: string;
  readonly assertFresh: () => Promise<void>;
  /** Start and ready must both be absent; retained attempts keep their source. */
  readonly remove: () => Promise<void>;
};
type SourceOptions = {
  readonly run: string;
  readonly metadata: NativeEnvMetadata;
  readonly profiles?: readonly string[];
  readonly overlay?: string | null;
};
export type NativeAuthoredProjectAdmission = {
  readonly assertHeld: () => Promise<void>;
  readonly loadStart: () => Promise<NativeAuthoredProjectStartSelection | null>;
  readonly prepareSource: (
    opts: SourceOptions
  ) => Promise<NativeAuthoredProjectSource>;
  readonly reserve: (opts: {
    readonly review: NativeAuthoredReview;
  }) => Promise<NativeAuthoredProjectStartSelection>;
  readonly publish: (opts: {
    readonly expectedStart: NativeAuthoredProjectStartSelection;
    readonly record: NativeAuthoredProjectRun;
    /** Synchronous owner/cancellation guard at the final publication boundary. */
    readonly assertReady?: () => undefined;
  }) => Promise<NativeAuthoredProjectRunSelection>;
  readonly retire: (opts: {
    readonly expectedStart: NativeAuthoredProjectStartSelection;
    readonly expectedRun?: NativeAuthoredProjectRunSelection;
    readonly cleaned: NativeAuthoredReceipt;
  }) => Promise<void>;
};
function refused(): never {
  throw new Error(
    "Native authored run artifact is unsafe, changed, or owned by another run; inspect native state before retrying. Values omitted."
  );
}
function selected(value: unknown): NativeAuthoredProjectRun {
  if (
    !(isRecord(value) && keys(value, "kind,receipt,version")) ||
    value.version !== 2 ||
    value.kind !== "native-authored-project-run"
  ) {
    return refused();
  }
  const receipt = parseNativeAuthoredReceipt(value.receipt);
  if (
    receipt.phase !== "ready-observed" ||
    receipt.failure !== undefined ||
    Object.values(receipt.resources).some((resource) => resource.id === null)
  ) {
    return refused();
  }
  return { version: 2, kind: "native-authored-project-run", receipt };
}
function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
function started(value: unknown): NativeAuthoredProjectStart {
  if (
    !(isRecord(value) && keys(value, "kind,review,version")) ||
    value.version !== 2 ||
    value.kind !== "native-authored-project-start"
  ) {
    return refused();
  }
  return {
    version: 2,
    kind: "native-authored-project-start",
    review: parseNativeAuthoredReview(value.review),
  };
}
function selection<T>(value: unknown, parse: (value: unknown) => T) {
  if (
    !(
      isRecord(value) &&
      keys(value, "identity,record") &&
      isRecord(value.identity) &&
      keys(value.identity, "dev,ino,sha256")
    )
  ) {
    return refused();
  }
  const identity = value.identity;
  if (
    typeof identity.dev !== "number" ||
    !Number.isSafeInteger(identity.dev) ||
    identity.dev < 0 ||
    typeof identity.ino !== "number" ||
    !Number.isSafeInteger(identity.ino) ||
    identity.ino < 1 ||
    typeof identity.sha256 !== "string" ||
    !HEX64.test(identity.sha256)
  ) {
    return refused();
  }
  return {
    record: parse(value.record),
    identity: { dev: identity.dev, ino: identity.ino, sha256: identity.sha256 },
  };
}
function selectedFile(value: unknown): NativeAuthoredProjectRunSelection {
  return selection(value, selected);
}
/** Copied data selectors used by the separately tagged explicit recovery intent. */
export function parseNativeAuthoredProjectRunSelection(value: unknown) {
  return selectedFile(value);
}
export function parseNativeAuthoredProjectStartSelection(value: unknown) {
  return selection(value, started);
}
function validBranch(branch: string | null): boolean {
  return (
    branch === null ||
    (branch.length > 0 &&
      branch.isWellFormed() &&
      Buffer.byteLength(branch) <= 256 &&
      !CONTROL.test(branch))
  );
}
function sourceOverlay(overlay: string | null | undefined) {
  if (overlay === undefined) {
    return "inherit";
  }
  if (overlay === null) {
    return "base";
  }
  return { named: overlay };
}
function sourceText(store: Store, input: SourceOptions) {
  // Only envelope projection is done here; authored grammar and capability
  // admission remain in the compiler and native runtime plan request.
  const run = input.run;
  const profiles = input.profiles === undefined ? [] : [...input.profiles];
  const overlay = input.overlay;
  const metadata = parseNativeEnvMetadata(input.metadata);
  if (
    typeof run !== "string" ||
    !HEX32.test(run) ||
    profiles.length > 64 ||
    profiles.some(
      (profile) => typeof profile !== "string" || !validBranch(profile)
    ) ||
    !(
      overlay === undefined ||
      overlay === null ||
      (typeof overlay === "string" && validBranch(overlay))
    ) ||
    !metadata
  ) {
    return refused();
  }
  const text = JSON.stringify({
    version: 2,
    kind: "native-graph-source",
    project: store.identity.projectRoot,
    branch: store.identity.branch,
    run,
    profiles,
    overlay: sourceOverlay(overlay),
    env_metadata: metadata,
  });
  if (Buffer.byteLength(text) > SOURCE_LIMIT) {
    return refused();
  }
  return { run, text };
}
async function storeDirectory(
  path: string,
  create: boolean,
  privateRoot: boolean
): Promise<HeldDirectory | undefined> {
  if (create) {
    if (privateRoot) {
      return await privateDirectory(path);
    }
    await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
      if (!hasCode(error, "EEXIST")) {
        throw error;
      }
    });
  } else {
    try {
      await lstat(path);
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    }
  }
  return await holdDirectory(path, privateRoot);
}
async function storage<T>(
  input: NativeAuthoredProjectRunScope,
  create: boolean,
  action: (
    store: Store | undefined,
    assertScope: () => Promise<void>
  ) => Promise<T>
): Promise<T> {
  const opts = {
    projectRoot: input.projectRoot,
    projectDir: input.projectDir,
    nativeHome: input.nativeHome,
    branch: input.branch,
  };
  const held: HeldDirectory[] = [];
  try {
    const projectRoot = await realpath(opts.projectRoot);
    const nativeHome = await realpath(opts.nativeHome);
    if (
      projectRoot !== opts.projectRoot ||
      nativeHome !== opts.nativeHome ||
      opts.projectDir !== join(projectRoot, ".hack") ||
      !validBranch(opts.branch)
    ) {
      return refused();
    }
    for (const path of [projectRoot, opts.projectDir, nativeHome]) {
      held.push(await holdDirectory(path, false));
    }
    const identity = {
      projectRoot,
      projectDir: opts.projectDir,
      nativeHome,
      branch: opts.branch,
      directories: held.map(({ info }) => ({ dev: info.dev, ino: info.ino })),
    };
    for (const [path, privateRoot] of [
      [join(opts.projectDir, ".internal"), false],
      [join(opts.projectDir, ".internal", "native-authored-runs"), true],
    ] as const) {
      const directory = await storeDirectory(path, create, privateRoot);
      if (!directory) {
        await recheckDirectories(held);
        return await action(undefined, async () => {
          await recheckDirectories(held);
          await absent(path);
        });
      }
      held.push(directory);
    }
    const root = held.at(-1);
    if (!root) {
      return refused();
    }
    await privateIgnore(join(root.path, ".gitignore"), create);
    const key = digest(JSON.stringify(opts.branch));
    const file = join(root.path, `${key}.json`);
    const check = () => recheckDirectories(held);
    const lock = createNativeComposePrivateMutationLock({
      lockPath: join(root.path, `${key}.lock`),
      recoveryPath: join(root.path, `${key}.recovery`),
      parent: root,
      check,
    });
    await check();
    return await action(
      {
        identity,
        root,
        held,
        file,
        mutationPath: join(root.path, `${key}.lock`),
        mutationRecovery: join(root.path, `${key}.recovery`),
        startFile: join(root.path, `${key}.start.json`),
        admissionPath: join(root.path, `${key}.admission.lock`),
        admissionRecovery: join(root.path, `${key}.admission.recovery`),
        check,
        withLock: lock.withLock,
        withHeldLock: lock.withHeldLock,
      },
      check
    );
  } catch {
    return refused();
  } finally {
    await Promise.all(held.map(({ file }) => file.close()));
  }
}
type Store = {
  readonly identity: {
    readonly projectRoot: string;
    readonly projectDir: string;
    readonly nativeHome: string;
    readonly branch: string | null;
    readonly directories: readonly {
      readonly dev: number;
      readonly ino: number;
    }[];
  };
  readonly root: HeldDirectory;
  readonly held: readonly HeldDirectory[];
  readonly file: string;
  readonly mutationPath: string;
  readonly mutationRecovery: string;
  readonly startFile: string;
  readonly admissionPath: string;
  readonly admissionRecovery: string;
  readonly check: () => Promise<void>;
  readonly withLock: <T>(action: () => Promise<T>) => Promise<T>;
  readonly withHeldLock: <T>(
    action: (assertHeld: () => Promise<void>) => Promise<T>
  ) => Promise<T>;
};

/** Internal frontend storage owner. The awaited callback retains the canonical
 * directory handles; no Rust journal/publication path is reconstructed here. */
export async function withNativeAuthoredProjectRecoveryStorage<T>(
  opts: NativeAuthoredProjectRunScope,
  action: (store: {
    readonly scope: string;
    readonly projectRoot: string;
    readonly root: HeldDirectory;
    readonly held: readonly HeldDirectory[];
    readonly ready: string;
    readonly start: string;
    readonly admission: string;
    readonly recovery: string;
    readonly mutation: string;
    readonly check: () => Promise<void>;
    readonly readReady: () => Promise<NativeAuthoredProjectRunSelection>;
    readonly readStart: () => Promise<NativeAuthoredProjectStartSelection>;
    readonly sourcePath: (run: string) => string;
    readonly readSource: (run: string) => Promise<{
      readonly dev: number;
      readonly ino: number;
      readonly sha256: string;
    }>;
  }) => Promise<T>
): Promise<T> {
  return await storage(opts, false, async (store) => {
    if (!store) {
      return refused();
    }
    const sourcePath = (run: string) => {
      if (!HEX32.test(run)) {
        return refused();
      }
      return join(store.root.path, `${run}.source.json`);
    };
    return await action({
      scope: JSON.stringify(store.identity),
      projectRoot: store.identity.projectRoot,
      root: store.root,
      held: store.held,
      ready: store.file,
      start: store.startFile,
      admission: store.admissionPath,
      recovery: store.admissionRecovery,
      mutation: store.mutationPath,
      check: store.check,
      readReady: () => read(store),
      readStart: () => readRecord(store, store.startFile, started),
      sourcePath,
      async readSource(run) {
        const current = await readPrivate(sourcePath(run), SOURCE_LIMIT);
        const value: unknown = JSON.parse(current.text);
        if (
          !(
            isRecord(value) &&
            keys(
              value,
              "branch,env_metadata,kind,overlay,profiles,project,run,version"
            )
          ) ||
          value.version !== 2 ||
          value.kind !== "native-graph-source" ||
          value.project !== store.identity.projectRoot ||
          value.branch !== store.identity.branch ||
          value.run !== run ||
          !Array.isArray(value.profiles) ||
          value.profiles.length > 64 ||
          value.profiles.some(
            (profile: unknown) =>
              typeof profile !== "string" || !validBranch(profile)
          ) ||
          !(
            value.overlay === "inherit" ||
            value.overlay === "base" ||
            (isRecord(value.overlay) &&
              keys(value.overlay, "named") &&
              typeof value.overlay.named === "string" &&
              validBranch(value.overlay.named))
          ) ||
          !parseNativeEnvMetadata(value.env_metadata)
        ) {
          return refused();
        }
        await store.check();
        return {
          dev: current.info.dev,
          ino: current.info.ino,
          sha256: digest(current.text),
        };
      },
    });
  });
}
async function read(store: Store): Promise<NativeAuthoredProjectRunSelection> {
  return await readRecord(store, store.file, selected);
}
async function readRecord<T>(
  store: Store,
  path: string,
  parse: (value: unknown) => T
) {
  const current = await readPrivate(path, LIMIT);
  const value: unknown = JSON.parse(current.text);
  if (
    !(isRecord(value) && keys(value, "record,scope")) ||
    JSON.stringify(value.scope) !== JSON.stringify(store.identity)
  ) {
    return refused();
  }
  const record = parse(value.record);
  await store.check();
  return {
    record,
    identity: {
      dev: current.info.dev,
      ino: current.info.ino,
      sha256: digest(current.text),
    },
  };
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
  return refused();
}
async function publish<T>(
  store: Store,
  path: string,
  record: T,
  parse: (value: unknown) => T,
  check = store.check,
  assertReady?: () => undefined
) {
  const text = JSON.stringify({ scope: store.identity, record });
  if (Buffer.byteLength(text) > LIMIT) {
    return refused();
  }
  const temporary = join(store.root.path, `${token()}.pending`);
  let written: { readonly dev: number; readonly ino: number } | undefined;
  try {
    const info = await writeExclusive(temporary, text);
    written = info;
    await check();
    const current = await readPrivate(temporary, LIMIT);
    if (!sameFile(info, current.info) || current.text !== text) {
      return refused();
    }
    await check();
    const guarded: unknown = assertReady?.();
    if (guarded !== undefined) {
      // Refuse accidental asynchronous guards and consume their eventual rejection
      // without exposing application details as an unhandled Promise diagnostic.
      void Promise.resolve(guarded).catch(() => undefined);
      return refused();
    }
    await link(temporary, path);
    await unlink(temporary);
    written = undefined;
    await synchronizeDirectories(store.held);
    return await readRecord(store, path, parse);
  } finally {
    if (written) {
      await store.check();
      const current = await readPrivate(temporary, LIMIT);
      if (!sameFile(current.info, written) || current.text !== text) {
        refused();
      }
      await unlink(temporary);
    }
  }
}

/** Prepare excluded native-only storage before reviewing source; never a Compose v1 mapping. */
export async function prepareNativeAuthoredProjectRunStorage(
  opts: NativeAuthoredProjectRunScope
): Promise<void> {
  await storage(opts, true, () => Promise.resolve());
}
/** This artifact selects an owner; every runtime operation still authenticates its native authority. */
export async function loadNativeAuthoredProjectRun(
  opts: NativeAuthoredProjectRunScope
): Promise<NativeAuthoredProjectRunSelection | null> {
  return await storage(opts, false, async (store) => {
    if (!store) {
      return null;
    }
    try {
      return await read(store);
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        return null;
      }
      throw error;
    }
  });
}

/** Read-only status selection. Held directories and exact saved incarnations survive
 * the awaited observation; no lock, source acquisition, publication or repair occurs. */
export async function withNativeAuthoredProjectStatus<T>(
  opts: NativeAuthoredProjectRunScope,
  action: (selected: {
    readonly ready: NativeAuthoredProjectRunSelection | null;
    readonly pending: boolean;
    readonly assertFresh: () => Promise<void>;
  }) => Promise<T>
): Promise<T> {
  const scope = { ...opts };
  const ready = await loadNativeAuthoredProjectRun(scope);
  return await storage(scope, false, async (store, assertScope) => {
    const readStart = async () => {
      if (!store) {
        return null;
      }
      try {
        return await readRecord(store, store.startFile, started);
      } catch (error) {
        if (hasCode(error, "ENOENT")) {
          return null;
        }
        throw error;
      }
    };
    const start = await readStart();
    if (
      ready &&
      start &&
      JSON.stringify(ready.record.receipt.review) !==
        JSON.stringify(start.record.review)
    ) {
      return refused();
    }
    const assertFresh = async () => {
      await assertScope();
      if (store) {
        await store.check();
        for (const path of [
          store.mutationPath,
          store.mutationRecovery,
          `${store.mutationPath}.recovery`,
          store.admissionRecovery,
          `${store.admissionRecovery}.recovery`,
          `${store.file}.recovery.json`,
          `${store.file}.recovery.json.pending`,
        ]) {
          await absent(path);
        }
        if (!(ready || start)) {
          await absent(store.admissionPath);
        }
      }
      if (
        JSON.stringify(await loadNativeAuthoredProjectRun(scope)) !==
          JSON.stringify(ready) ||
        JSON.stringify(await readStart()) !== JSON.stringify(start)
      ) {
        return refused();
      }
      await assertScope();
    };
    await assertFresh();
    const result = await action({
      ready,
      pending: !ready && start !== null,
      assertFresh,
    });
    await assertFresh();
    return result;
  });
}
/** Publish the authenticated admitted owner once. Interrupted publication never replaces an existing run. */
export async function saveNativeAuthoredProjectRun(
  opts: NativeAuthoredProjectRunScope & {
    readonly record: unknown;
  }
): Promise<NativeAuthoredProjectRunSelection> {
  const record = selected(opts.record);
  return await storage(opts, true, async (store) => {
    if (!store) {
      return refused();
    }
    return await store.withLock(async () => {
      await absent(store.startFile);
      return await publish(store, store.file, record, selected);
    });
  });
}
/** Retire only an unchanged selected file after the caller confirmed the exact durable Removed journal. */
export async function removeNativeAuthoredProjectRun(
  opts: NativeAuthoredProjectRunScope & {
    readonly expected: NativeAuthoredProjectRunSelection;
    readonly cleaned: NativeAuthoredReceipt;
  }
): Promise<void> {
  const expected = selectedFile(opts.expected);
  const cleaned = parseNativeAuthoredReceipt(opts.cleaned);
  if (
    cleaned.phase !== "removed" ||
    Object.values(cleaned.resources).some(
      (resource) => resource.phase !== "removed"
    ) ||
    nativeAuthoredReceiptBinding(cleaned) !==
      nativeAuthoredReceiptBinding(expected.record.receipt)
  ) {
    return refused();
  }
  await storage(opts, false, async (store) => {
    if (!store) {
      return refused();
    }
    await store.withLock(async () => {
      await absent(store.startFile);
      const current = await read(store);
      if (JSON.stringify(current) !== JSON.stringify(expected)) {
        return refused();
      }
      await store.check();
      await unlink(store.file);
      await synchronizeDirectories(store.held);
    });
  });
}

function removed(value: unknown): NativeAuthoredReceipt {
  const receipt = parseNativeAuthoredReceipt(value);
  if (
    receipt.phase !== "removed" ||
    Object.values(receipt.resources).some(
      (resource) => resource.phase !== "removed"
    )
  ) {
    return refused();
  }
  return receipt;
}
async function unchanged<T>(
  store: Store,
  path: string,
  expected: {
    readonly record: T;
    readonly identity: NativeAuthoredProjectRunSelection["identity"];
  },
  parse: (value: unknown) => T
) {
  if (
    JSON.stringify(await readRecord(store, path, parse)) !==
    JSON.stringify(expected)
  ) {
    return refused();
  }
}

/**
 * Hold native startup admission through foreground ownership and retirement. Reserve
 * the hash-only intent before spawning a provider consumer. An interrupted or failed
 * start retains its intent; no timeout, dead PID, or missing ready mapping permits
 * replay. The caller must authenticate the exact durable Removed journal before
 * retirement, including failures before ready publication. Compose v1 stays separate.
 */
export async function withNativeAuthoredProjectAdmission<T>(
  opts: NativeAuthoredProjectRunScope,
  action: (admission: NativeAuthoredProjectAdmission) => Promise<T>
): Promise<T> {
  return await storage(opts, true, async (store) => {
    if (!store) {
      return refused();
    }
    const admission = createNativeComposePrivateMutationLock({
      lockPath: store.admissionPath,
      recoveryPath: store.admissionRecovery,
      parent: store.root,
      check: store.check,
    });
    return await admission.withLock(async (admissionLease) => {
      const verifyLock = admissionLease.assertHeld;
      // A completed explicit recovery is history, while an incomplete or pending
      // intent must block startup before compiler or private value acquisition.
      const { archiveCompletedNativeAuthoredRecovery } = await import(
        "./native-authored-project-recovery.ts"
      );
      await archiveCompletedNativeAuthoredRecovery({
        scope: opts,
        admission: admissionLease,
      });
      let active = true;
      const assertHeld = async () => {
        if (!active) {
          return refused();
        }
        try {
          await verifyLock();
        } catch {
          return refused();
        }
      };
      const withMutation = async <R>(
        run: (check: () => Promise<void>) => Promise<R>
      ) => {
        try {
          await assertHeld();
          return await store.withHeldLock(async (verifyMutation) => {
            await assertHeld();
            return await run(async () => {
              await verifyMutation();
              await assertHeld();
            });
          });
        } catch {
          return refused();
        }
      };
      const loadStart = async () => {
        await assertHeld();
        try {
          return await readRecord(store, store.startFile, started);
        } catch (error) {
          if (hasCode(error, "ENOENT")) {
            return null;
          }
          return refused();
        }
      };
      const capability: NativeAuthoredProjectAdmission = {
        assertHeld,
        loadStart,
        async prepareSource(input) {
          const { run, text } = sourceText(store, input);
          const path = join(store.root.path, `${run}.source.json`);
          const info = await withMutation(async (check) => {
            await absent(store.file);
            await absent(store.startFile);
            await check();
            const written = await writeExclusive(path, text);
            await check();
            await synchronizeDirectories(store.held);
            return written;
          });
          const unchangedSource = async () => {
            const current = await readPrivate(path, SOURCE_LIMIT);
            if (!sameFile(info, current.info) || current.text !== text) {
              return refused();
            }
          };
          const assertFresh = async () => {
            try {
              await assertHeld();
              await unchangedSource();
              await assertHeld();
            } catch {
              return refused();
            }
          };
          await assertFresh();
          return Object.freeze({
            path,
            assertFresh,
            remove: async () => {
              await withMutation(async (check) => {
                await absent(store.file);
                await absent(store.startFile);
                await unchangedSource();
                await check();
                await unlink(path);
                await synchronizeDirectories(store.held);
              });
            },
          });
        },
        async reserve(input) {
          const record = started({
            version: 2,
            kind: "native-authored-project-start",
            review: input.review,
          });
          return await withMutation(async (check) => {
            await absent(store.file);
            await absent(store.startFile);
            return await publish(
              store,
              store.startFile,
              record,
              started,
              check
            );
          });
        },
        async publish(input) {
          const expected = selection(input.expectedStart, started);
          const record = selected(input.record);
          const assertReady = input.assertReady;
          if (
            JSON.stringify(expected.record.review) !==
            JSON.stringify(record.receipt.review)
          ) {
            return refused();
          }
          return await withMutation(async (check) => {
            await unchanged(store, store.startFile, expected, started);
            return await publish(
              store,
              store.file,
              record,
              selected,
              async () => {
                await unchanged(store, store.startFile, expected, started);
                await check();
              },
              assertReady
            );
          });
        },
        async retire(input) {
          const expected = selection(input.expectedStart, started);
          const run =
            input.expectedRun === undefined
              ? undefined
              : selectedFile(input.expectedRun);
          const cleaned = removed(input.cleaned);
          if (
            JSON.stringify(expected.record.review) !==
              JSON.stringify(cleaned.review) ||
            (run !== undefined &&
              nativeAuthoredReceiptBinding(run.record.receipt) !==
                nativeAuthoredReceiptBinding(cleaned))
          ) {
            return refused();
          }
          await withMutation(async (check) => {
            await unchanged(store, store.startFile, expected, started);
            if (run === undefined) {
              await absent(store.file);
            } else {
              await unchanged(store, store.file, run, selected);
              await check();
              await unlink(store.file);
              await synchronizeDirectories(store.held);
            }
            // If retirement stops here, the durable start continues to block a new run.
            await unchanged(store, store.startFile, expected, started);
            await check();
            await unlink(store.startFile);
            await synchronizeDirectories(store.held);
          });
        },
      };
      try {
        return await action(Object.freeze(capability));
      } finally {
        active = false;
      }
    });
  });
}
