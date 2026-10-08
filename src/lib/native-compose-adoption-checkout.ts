import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "./guards.ts";
import {
  type HeldDirectory,
  holdDirectory,
  recheckDirectories,
} from "./native-compose-private-state.ts";
import { readNativeConfigImportSourceFile } from "./native-config-import-inputs.ts";
import { resolveVerifiedGitCheckoutLocation } from "./worktree-local-config.ts";

type Identity = { readonly dev: number; readonly ino: number };
type Source = Identity & { readonly hash: string };
export type LinkedAdoptionGitIdentity = {
  readonly kind: "linked-worktree";
  readonly marker: Source;
  readonly admin: Identity;
  readonly common: Identity;
  readonly primary: Identity;
  readonly backlink: Source;
  readonly commonLink: Source;
};
function refuse(): never {
  throw new Error(
    "Legacy adoption Git checkout is unsafe or changed; values omitted."
  );
}
function identity(info: Identity): Identity {
  return Object.freeze({ dev: info.dev, ino: info.ino });
}
function capability(opts: {
  readonly identity: Identity | LinkedAdoptionGitIdentity;
  readonly directories: readonly HeldDirectory[];
  readonly assertFresh: () => Promise<void>;
}) {
  const result = { ...opts, directories: Object.freeze([...opts.directories]) };
  for (const key of Object.keys(result)) {
    Object.defineProperty(result, key, { enumerable: false });
  }
  return Object.freeze(result);
}
async function source(path: string, signal?: AbortSignal): Promise<Source> {
  const read = await readNativeConfigImportSourceFile({ path, signal });
  if (read.info.uid !== process.getuid?.() || (read.info.mode & 0o022) !== 0) {
    refuse();
  }
  return Object.freeze({
    ...identity(read.info),
    hash: new Bun.CryptoHasher("sha256").update(read.bytes).digest("hex"),
  });
}

/**
 * Private checkout authority for the durable adoption owner and selector.
 * Directory receipts retain their original identity contract. Linked receipts
 * additionally bind the verified Git family and the raw pointer files; no path,
 * pointer content or digest belongs in public metadata. Checks cannot freeze Git.
 * The caller owns returned directory descriptors and must close them.
 */
export async function acquireLegacyComposeAdoptionCheckout(input: {
  readonly projectRoot: string;
  readonly signal?: AbortSignal;
}) {
  const directories: HeldDirectory[] = [];
  try {
    if (
      !isRecord(input) ||
      typeof input.projectRoot !== "string" ||
      !input.projectRoot.length ||
      input.projectRoot.includes("\0") ||
      (input.signal !== undefined && !(input.signal instanceof AbortSignal))
    ) {
      refuse();
    }
    const opts = { projectRoot: input.projectRoot, signal: input.signal };
    if (opts.signal?.aborted) {
      refuse();
    }
    const markerPath = join(opts.projectRoot, ".git");
    const marker = await lstat(markerPath);
    if (marker.isDirectory()) {
      const held = await holdDirectory(markerPath, false);
      directories.push(held);
      return capability({
        identity: identity(held.info),
        directories,
        assertFresh: async () => {
          try {
            if (opts.signal?.aborted) {
              refuse();
            }
            await recheckDirectories(directories);
          } catch {
            refuse();
          }
        },
      });
    }
    if (!marker.isFile() || marker.isSymbolicLink()) {
      refuse();
    }
    const location = await resolveVerifiedGitCheckoutLocation(opts);
    if (!location.primaryRoot || location.gitDir === location.commonDir) {
      refuse();
    }
    for (const path of [
      location.gitDir,
      location.commonDir,
      location.primaryRoot,
    ]) {
      directories.push(await holdDirectory(path, false));
    }
    const [admin, common, primary] = directories;
    if (!(admin && common && primary)) {
      refuse();
    }
    const read = async (): Promise<LinkedAdoptionGitIdentity> => {
      const backlinkPath = join(location.gitDir, "gitdir");
      const backlink = await readNativeConfigImportSourceFile({
        path: backlinkPath,
        signal: opts.signal,
      });
      const back = new TextDecoder("utf-8", { fatal: true }).decode(
        backlink.bytes
      );
      if (back !== `${markerPath}\n`) {
        refuse();
      }
      const result: LinkedAdoptionGitIdentity = {
        kind: "linked-worktree",
        marker: await source(markerPath, opts.signal),
        admin: identity(admin.info),
        common: identity(common.info),
        primary: identity(primary.info),
        backlink: await source(backlinkPath, opts.signal),
        commonLink: await source(
          join(location.gitDir, "commondir"),
          opts.signal
        ),
      };
      await recheckDirectories(directories);
      return Object.freeze(result);
    };
    const binding = await read();
    if (
      JSON.stringify(await resolveVerifiedGitCheckoutLocation(opts)) !==
      JSON.stringify(location)
    ) {
      refuse();
    }
    const assertFresh = async () => {
      try {
        if (JSON.stringify(await read()) !== JSON.stringify(binding)) {
          refuse();
        }
      } catch {
        refuse();
      }
    };
    await assertFresh();
    return capability({ identity: binding, directories, assertFresh });
  } catch {
    await Promise.all(directories.map((held) => held.file.close()));
    refuse();
  }
}
