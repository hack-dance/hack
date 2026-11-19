import { stat } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative } from "node:path";
import { containerPathFor, serviceMounts } from "./local-directories.ts";

/**
 * HACK-2358 doctor hint: a service whose source bind mount shows a
 * dependency or build directory that lives in the checkout, so installs and
 * builds there cross the host share (slow on Compose for macOS, much slower
 * on native). `localDirectories` keeps them on the runtime's disk.
 */

export const SHARED_SOURCE_INSTALLS_CHECK = "shared source installs";

/** Directories a container usually installs or builds into. */
const CANDIDATES = [
  "node_modules",
  ".venv",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
] as const;
/** `target` counts only beside a Cargo manifest; elsewhere it is often source. */
const CARGO_TARGET = "target";

export type SharedSourceInstallFinding = {
  readonly service: string;
  /** Checkout-relative directory. */
  readonly directory: string;
  /** Where the service sees it. */
  readonly target: string;
};

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function covered(entries: readonly string[], directory: string): boolean {
  return entries.some(
    (entry) => directory === entry || directory.startsWith(`${entry}/`)
  );
}

async function candidatesIn(source: string): Promise<string[]> {
  const names: string[] = [...CANDIDATES];
  if (await isDirectory(join(source, CARGO_TARGET))) {
    const manifest = await stat(join(source, "Cargo.toml")).catch(() => null);
    if (manifest?.isFile()) {
      names.push(CARGO_TARGET);
    }
  }
  return names;
}

/** Findings for every service; pure apart from reading the checkout. */
export async function findSharedSourceInstalls(opts: {
  readonly projectRoot: string;
  readonly composeFile: string;
  readonly services: ReadonlyMap<string, unknown>;
  readonly localDirectories: readonly string[];
}): Promise<SharedSourceInstallFinding[]> {
  const findings: SharedSourceInstallFinding[] = [];
  for (const [service, spec] of opts.services) {
    const mounts = serviceMounts(spec, dirname(opts.composeFile));
    for (const bind of mounts) {
      if (bind.type !== "bind" || bind.source === undefined) {
        continue;
      }
      const inCheckout = relative(opts.projectRoot, bind.source);
      if (inCheckout.startsWith("..") || isAbsolute(inCheckout)) {
        continue;
      }
      for (const name of await candidatesIn(bind.source)) {
        const host = join(bind.source, name);
        const directory = relative(opts.projectRoot, host);
        const target =
          containerPathFor(bind, host) ?? posix.join(bind.target, name);
        // A bind of this very directory is still the shared source.
        const mounted = mounts.some(
          (mount) =>
            mount !== bind &&
            mount.target === target &&
            !(mount.type === "bind" && mount.source === host)
        );
        if (
          mounted ||
          covered(opts.localDirectories, directory) ||
          !(await isDirectory(host)) ||
          findings.some(
            (item) => item.service === service && item.target === target
          )
        ) {
          continue;
        }
        findings.push({ service, directory, target });
      }
    }
  }
  return findings;
}

/** The note text, or null when nothing crosses the share. */
export function sharedSourceInstallsMessage(
  findings: readonly SharedSourceInstallFinding[]
): string | null {
  if (findings.length === 0) {
    return null;
  }
  const byDirectory = new Map<string, string[]>();
  for (const item of findings) {
    const services = byDirectory.get(item.directory) ?? [];
    services.push(`${item.service} at ${item.target}`);
    byDirectory.set(item.directory, services);
  }
  const directories = [...byDirectory.keys()];
  const listed = directories
    .map((dir) => `${dir} (${byDirectory.get(dir)?.join(", ")})`)
    .join("; ");
  return `Note: services see these checkout directories through the shared source, so installs and builds there cross the host share: ${listed}. To keep them on the runtime's own disk (a named volume on Compose, the VM disk on native), add "localDirectories": ${JSON.stringify(directories)} to .hack/hack.config.json. The checkout's copies stay where they are; run the install once more after the next hack up.`;
}
