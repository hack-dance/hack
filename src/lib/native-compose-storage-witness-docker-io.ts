import { constants, fstatSync, lstatSync, readSync, type Stats } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import {
  type HeldDirectory,
  sameFile,
} from "./native-compose-private-state.ts";
import { refuseNativeComposeStorageXattr as refuse } from "./native-compose-storage-witness-xattr-codec.ts";

type Leaf = { readonly path: string; readonly info: Stats };
type HeldLeaf = Leaf & { readonly file: FileHandle };
// Unknown child disposition cannot authorize closing its inherited descriptors.
// Retention is not a reaper or recovery authority; the private journal stays pending.
const unsettledDescriptors = new Set<readonly HeldLeaf[]>();

function checkLeaf(leaf: HeldLeaf, limit: number): Stats {
  try {
    const info = fstatSync(leaf.file.fd), named = lstatSync(leaf.path);
    if (!(info.isFile() && named.isFile() && sameFile(info, leaf.info) && sameFile(info, named) &&
      info.nlink === 1 && named.nlink === 1 && info.uid === process.getuid?.() && named.uid === info.uid &&
      (info.mode & 0o777) === 0o600 && (named.mode & 0o777) === 0o600 && info.size <= limit)) return refuse();
    return info;
  } catch { return refuse(); }
}
function readLeaf(leaf: HeldLeaf, limit: number): string {
  const before = checkLeaf(leaf, limit), bytes = Buffer.alloc(before.size + 1);
  const count = readSync(leaf.file.fd, bytes, 0, bytes.length, 0);
  const after = checkLeaf(leaf, limit);
  if (!(count === before.size && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs)) return refuse();
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, count));
}

/** Empty command leaves are not receipts: the shared receipt writer deliberately
 * requires nonempty bytes. This separate create-only leaf keeps that invariant. */
export async function createNativeComposeStorageDockerEmptyLeaf(path: string): Promise<Stats> {
  const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await file.sync();
    const info = await file.stat();
    return checkLeaf({ path, info, file }, 0);
  } catch { return refuse(); } finally { await file.close(); }
}

/** Holds exact no-follow leaves through shared run() and owned group settlement.
 * Child writes are separately quota-limited by the fixed shell wrapper; reads
 * accept at most limit bytes. No named path is reopened or truncated by the child. */
export async function holdNativeComposeStorageDockerIo(opts: {
  readonly directories: readonly HeldDirectory[];
  readonly input: Leaf & { readonly text: string };
  readonly stdout: Leaf;
  readonly stderr: Leaf;
  readonly limit: number;
}) {
  const directories = [...opts.directories];
  const input = { ...opts.input }, stdout = { ...opts.stdout }, stderr = { ...opts.stderr };
  const limit = opts.limit;
  if (!(Number.isSafeInteger(limit) && limit > 0 && limit <= 4096 && Buffer.byteLength(input.text) <= limit)) return refuse();
  const held: HeldLeaf[] = [];
  try {
    for (const [leaf, flags] of [[input, constants.O_RDONLY], [stdout, constants.O_RDWR], [stderr, constants.O_RDWR]] as const) {
      const file = await open(leaf.path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      held.push({ ...leaf, file });
    }
    const source = held[0] ?? refuse(), out = held[1] ?? refuse(), err = held[2] ?? refuse();
    const assertFresh = () => { try {
      for (const directory of directories) {
        const info = fstatSync(directory.file.fd), named = lstatSync(directory.path);
        if (!(info.isDirectory() && named.isDirectory() && sameFile(info, directory.info) && sameFile(info, named) &&
          info.uid === process.getuid?.() && named.uid === info.uid && (info.mode & 0o022) === 0 &&
          (!directory.private || (info.mode & 0o777) === 0o700))) return refuse();
      }
      if (readLeaf(source, limit) !== input.text || checkLeaf(out, limit).size !== 0 || checkLeaf(err, limit).size !== 0) return refuse();
    } catch { return refuse(); } };
    assertFresh();
    return {
      descriptors: { stdin: source.file.fd, stdout: out.file.fd, stderr: err.file.fd },
      assertFresh,
      read: () => { try { return { stdout: readLeaf(out, limit), stderr: readLeaf(err, limit) }; } catch { return refuse(); } },
      close: async () => { await Promise.all(held.map((leaf) => leaf.file.close())); },
      retainUnsettled: () => { unsettledDescriptors.add(held); },
    };
  } catch {
    await Promise.allSettled(held.map((leaf) => leaf.file.close()));
    return refuse();
  }
}
