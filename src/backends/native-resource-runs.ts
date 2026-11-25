import { lstat, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  HACK_PROJECT_DIR_LEGACY,
  HACK_PROJECT_DIR_PRIMARY,
} from "../constants.ts";
import { isRecord } from "../lib/guards.ts";
import {
  readReplaceablePrivateFile,
  replacePrivateFileAtomic,
} from "../lib/private-file.ts";

const RUN = /^[a-f0-9]{32}$/;
const NAMESPACE = /^[a-f0-9]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const STORES = { runtime: "graphs", authored: "native-graphs" } as const;
type Store = keyof typeof STORES;

type Scope = {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly nativeHome: string;
  readonly branch: string | null;
};

function refused() {
  return new Error("Native inventory receipt is unavailable.");
}

async function privateDirectory(path: string) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  ) {
    throw refused();
  }
  return path;
}

function ownerFile(directories: readonly string[], run: string) {
  const root = join(directories.at(-1) ?? "", run);
  return {
    path: join(root, "inventory-owner.json"),
    directories: [...directories, root],
    staging: "sibling",
    refusal: refused,
  } as const;
}

async function storeDirectories(home: string, store: Store) {
  const root = join(await realpath(home), ".hack-local");
  const directories = [
    root,
    join(root, "run"),
    join(root, "run", STORES[store]),
  ];
  for (const dir of directories) {
    await privateDirectory(dir);
  }
  return directories;
}

/** Display metadata only. Existing graph journals and checkout mappings authorize status. */
export async function recordNativeResourceOwner(
  scope: Scope,
  store: Store,
  run: string
) {
  try {
    if (!RUN.test(run)) {
      return;
    }
    const directories = await storeDirectories(scope.nativeHome, store);
    const file = ownerFile(directories, run);
    await privateDirectory(join(directories.at(-1) ?? "", run));
    const projectRoot = await realpath(scope.projectRoot);
    const projectDir = await realpath(scope.projectDir);
    const { branch } = scope;
    await replacePrivateFileAtomic({
      ...file,
      text: JSON.stringify({
        version: 1,
        run,
        projectRoot,
        projectDir,
        branch,
      }),
    });
  } catch {
    // A display receipt may be missing without affecting a successful start.
  }
}

async function readOwner(
  directories: readonly string[],
  store: Store,
  run: string,
  nativeHome: string
) {
  const file = ownerFile(directories, run);
  await privateDirectory(join(directories.at(-1) ?? "", run));
  // The provider receipt binds the run to a checkout/branch namespace hash.
  const state = await readReplaceablePrivateFile({
    ...file,
    path: join(directories.at(-1) ?? "", run, "state.json"),
    maxBytes: 1024 * 1024,
  });
  const receipt: unknown = state ? JSON.parse(state.text) : null;
  const provenance =
    isRecord(receipt) && isRecord(receipt.review)
      ? receipt.review.provenance
      : receipt;
  if (
    isRecord(provenance) &&
    provenance.run === run &&
    isRecord(receipt) &&
    receipt.phase === "removed" &&
    isRecord(receipt.resources) &&
    Object.values(receipt.resources).every(
      (resource) => isRecord(resource) && resource.phase === "removed"
    )
  ) {
    const pending = await lstat(
      join(directories.at(-1) ?? "", run, "state.pending")
    ).catch((error: unknown) => {
      if (isRecord(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (!pending) {
      return null;
    }
  }
  const owner = await readReplaceablePrivateFile({ ...file, maxBytes: 16_384 });
  const value: unknown =
    owner && (owner.mode & 0o077) === 0 ? JSON.parse(owner.text) : null;
  if (
    !(
      isRecord(value) &&
      value.version === 1 &&
      value.run === run &&
      typeof value.projectRoot === "string" &&
      isAbsolute(value.projectRoot) &&
      !CONTROL.test(value.projectRoot) &&
      typeof value.projectDir === "string" &&
      (value.projectDir === join(value.projectRoot, HACK_PROJECT_DIR_PRIMARY) ||
        (store === "runtime" &&
          value.projectDir ===
            join(value.projectRoot, HACK_PROJECT_DIR_LEGACY))) &&
      (value.branch === null ||
        (typeof value.branch === "string" &&
          value.branch.length > 0 &&
          value.branch.length <= 256 &&
          !CONTROL.test(value.branch)))
    )
  ) {
    throw refused();
  }

  const hash = new Bun.CryptoHasher("sha256");
  if (value.branch !== null) {
    hash.update("hack-native-branch-namespace-v1\0");
  }
  hash.update(value.projectRoot);
  if (value.branch !== null) {
    hash.update("\0").update(value.branch);
  }
  if (
    !(
      isRecord(provenance) &&
      provenance.run === run &&
      typeof provenance.namespace === "string" &&
      NAMESPACE.test(provenance.namespace) &&
      provenance.namespace === hash.digest("hex")
    )
  ) {
    throw refused();
  }
  return {
    run,
    store,
    scope: {
      nativeHome,
      projectRoot: value.projectRoot,
      projectDir: value.projectDir,
      branch: value.branch,
    },
  };
}

async function scanStore(nativeHome: string, store: Store) {
  const runs: NonNullable<Awaited<ReturnType<typeof readOwner>>>[] = [];
  let missing = 0;
  let incomplete = false;
  let directories: string[];
  try {
    directories = await storeDirectories(nativeHome, store);
  } catch (error: unknown) {
    return {
      runs,
      missing,
      incomplete: !(isRecord(error) && error.code === "ENOENT"),
    };
  }
  try {
    const dir = await opendir(directories.at(-1) ?? "");
    let count = 0;
    for await (const entry of dir) {
      if (++count > 64) {
        incomplete = true;
        break;
      }
      if (!(entry.isDirectory() && RUN.test(entry.name))) {
        incomplete = true;
        continue;
      }
      try {
        const owner = await readOwner(
          directories,
          store,
          entry.name,
          nativeHome
        );
        if (owner) {
          runs.push(owner);
        }
      } catch {
        missing += 1;
      }
    }
  } catch {
    incomplete = true;
  }
  return { runs, missing, incomplete };
}

export async function readNativeResourceRuns(home: string) {
  const stores = await Promise.all([
    scanStore(home, "runtime"),
    scanStore(home, "authored"),
  ]);
  return {
    runs: stores.flatMap(({ runs }) => runs),
    missing: stores.reduce((sum, value) => sum + value.missing, 0),
    incomplete: stores.some(({ incomplete }) => incomplete),
  };
}
