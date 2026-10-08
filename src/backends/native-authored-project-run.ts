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
  type NativeAuthoredReceipt,
  nativeAuthoredReceiptBinding,
  parseNativeAuthoredReceipt,
} from "./native-authored-graph-protocol.ts";

const LIMIT = 64 * 1024;
const CONTROL = /\p{Cc}/u;
export type NativeAuthoredProjectRunScope = {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly nativeHome: string;
  readonly branch: string | null;
};
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
function validBranch(branch: string | null): boolean {
  return (
    branch === null ||
    (branch.length > 0 &&
      branch.isWellFormed() &&
      Buffer.byteLength(branch) <= 256 &&
      !CONTROL.test(branch))
  );
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
  opts: NativeAuthoredProjectRunScope,
  create: boolean,
  action: (store: Store | undefined) => Promise<T>
): Promise<T> {
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
        return await action(undefined);
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
    return await action({
      identity,
      root,
      held,
      file,
      check,
      withLock: lock.withLock,
    });
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
  readonly check: () => Promise<void>;
  readonly withLock: <T>(action: () => Promise<T>) => Promise<T>;
};
async function read(store: Store): Promise<NativeAuthoredProjectRunSelection> {
  const current = await readPrivate(store.file, LIMIT);
  const value: unknown = JSON.parse(current.text);
  if (
    !(isRecord(value) && keys(value, "record,scope")) ||
    JSON.stringify(value.scope) !== JSON.stringify(store.identity)
  ) {
    return refused();
  }
  const record = selected(value.record);
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
      const text = JSON.stringify({ scope: store.identity, record });
      if (Buffer.byteLength(text) > LIMIT) {
        return refused();
      }
      const temporary = join(store.root.path, `${token()}.pending`);
      let written: { readonly dev: number; readonly ino: number } | undefined;
      try {
        const info = await writeExclusive(temporary, text);
        written = info;
        await store.check();
        const current = await readPrivate(temporary, LIMIT);
        if (!sameFile(info, current.info) || current.text !== text) {
          return refused();
        }
        await link(temporary, store.file);
        await unlink(temporary);
        written = undefined;
        await synchronizeDirectories(store.held);
        return await read(store);
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
  const expected = selected(opts.expected.record);
  const cleaned = parseNativeAuthoredReceipt(opts.cleaned);
  if (
    cleaned.phase !== "removed" ||
    Object.values(cleaned.resources).some(
      (resource) => resource.phase !== "removed"
    ) ||
    nativeAuthoredReceiptBinding(cleaned) !==
      nativeAuthoredReceiptBinding(expected.receipt)
  ) {
    return refused();
  }
  await storage(opts, false, async (store) => {
    if (!store) {
      return refused();
    }
    await store.withLock(async () => {
      const current = await read(store);
      if (JSON.stringify(current) !== JSON.stringify(opts.expected)) {
        return refused();
      }
      await store.check();
      await unlink(store.file);
      await synchronizeDirectories(store.held);
    });
  });
}
