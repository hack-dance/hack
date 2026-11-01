import { lstat, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { ClosedCliError } from "./cli-result.ts";
import { isRecord } from "./guards.ts";

/**
 * Resolve links component by component, including missing targets. Unlike lexical
 * normalization, this preserves the meaning of `link/..` in a link target.
 * Existing directories are canonicalized for case-insensitive filesystems.
 * File leaves need no canonical spelling for containment; on macOS realpath
 * can require read access, which belongs to the layer reader instead.
 * Missing components are allowed so new layers and in-project dangling links
 * keep the atomic writer's existing behavior. Forty hops bound loops and work.
 */
async function resolveLayerPath(path: string): Promise<string> {
  let current: string = sep;
  const pending = resolve(path).split(sep).filter(Boolean);
  let hops = 0;
  while (pending.length > 0) {
    const component = pending.shift();
    if (!component || component === ".") {
      continue;
    }
    if (component === "..") {
      current = dirname(current);
      continue;
    }
    const candidate = resolve(current, component);
    const entry = await lstat(candidate).catch((error: unknown) => {
      if (isRecord(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (!entry?.isSymbolicLink()) {
      current = entry?.isDirectory() ? await realpath(candidate) : candidate;
      continue;
    }
    hops += 1;
    if (hops > 40) {
      throw new Error("Env layer link resolution limit");
    }
    const target = await readlink(candidate);
    if (isAbsolute(target)) {
      current = sep;
    }
    pending.unshift(...target.split(sep));
  }
  return current;
}

/**
 * Admit only layer paths inside the real project root. No filesystem error,
 * target name or contents crosses this boundary. This is a path-based check,
 * not an atomic fence against a concurrent ancestor-directory replacement.
 */
export async function assertProjectEnvLayerPath(opts: {
  readonly projectRoot: string;
  readonly path: string;
}): Promise<void> {
  try {
    const root = await realpath(opts.projectRoot);
    const target = await resolveLayerPath(opts.path);
    const within = relative(root, target);
    if (
      within !== ".." &&
      !within.startsWith(`..${sep}`) &&
      !isAbsolute(within)
    ) {
      return;
    }
  } catch {
    // Fail closed, including dangling outside links, loops and inspection errors.
  }
  throw new ClosedCliError(
    "Refused env layer: its path must resolve inside the project and be inspectable (values omitted)."
  );
}
