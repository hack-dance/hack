import { resolve } from "node:path";

const manifestPath = resolve(import.meta.dir, "../../package.json");

export function parsePinnedBun(packageManager: unknown): string {
  const match =
    typeof packageManager === "string"
      ? /^bun@(\d+\.\d+\.\d+)$/.exec(packageManager)
      : null;
  if (!match?.[1]) {
    throw new Error(
      `package.json must pin packageManager to an exact bun@x.y.z; found ${String(packageManager)}.`
    );
  }
  return match[1];
}

/**
 * Formal checks stay single-version: evidence is only accepted from the runtime the
 * repository pins. Returns that version. package.json is the one source of truth, so
 * a repository Bun upgrade moves these checks with it and they must pass again there.
 */
export async function assertPinnedBun(
  running: string = Bun.version
): Promise<string> {
  const manifest: { readonly packageManager?: unknown } =
    await Bun.file(manifestPath).json();
  const pinned = parsePinnedBun(manifest.packageManager);
  if (running !== pinned) {
    throw new Error(`Use the pinned Bun ${pinned}; running ${running}.`);
  }
  return pinned;
}

/** Unanchored source for the exact `bun test` banner printed by that version. */
export function bunTestBannerPattern(version: string): string {
  return `bun test v${version.replaceAll(".", "\\.")} \\([a-z0-9]+\\)`;
}
