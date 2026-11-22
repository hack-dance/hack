import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { YAML } from "bun";
import { isRecord } from "./guards.ts";
import { serviceMounts } from "./local-directories.ts";
import { quoteShellWord } from "./logs.ts";

export const ROOT_OWNED_CHECK = "root-owned checkout files";
const ENTRY_LIMIT = 4096;
const REPORT_LIMIT = 12;
const LINE_BREAK = /[\n\r]/;
const WALK_MS = 500;
const DIRECTORY_FLAGS =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/** Linux directory descriptors keep traversals pinned across renames. */
export async function findCheckoutFilesOwnedBy(opts: {
  readonly root: string;
  readonly uid: number;
}): Promise<{ paths: string[]; incomplete: boolean }> {
  const deadline = performance.now() + WALK_MS;
  let remaining = ENTRY_LIMIT;
  let incomplete = false;
  const paths: string[] = [];

  function withinBudget() {
    return (
      remaining > 0 &&
      paths.length < REPORT_LIMIT &&
      performance.now() < deadline
    );
  }

  async function walk(path: string, displayPath: string, depth: number) {
    if (depth >= 32) {
      incomplete = true;
      return;
    }
    const handle = await open(path, DIRECTORY_FLAGS);
    try {
      const base = `/proc/self/fd/${handle.fd}`;
      const dir = await opendir(base);
      try {
        while (withinBudget()) {
          const entry = await dir.read();
          if (!entry) {
            return;
          }
          remaining -= 1;
          const source = join(base, entry.name);
          const shown = join(displayPath, entry.name);
          await visit(source, shown, depth);
        }
        incomplete = true;
      } finally {
        await dir.close();
      }
    } finally {
      await handle.close();
    }
  }

  async function visit(source: string, shown: string, depth: number) {
    try {
      const stat = await lstat(source);
      if (stat.uid === opts.uid && (stat.isDirectory() || stat.isFile())) {
        paths.push(shown);
      }
      if (stat.isDirectory() && withinBudget()) {
        await walk(source, shown, depth + 1);
      }
    } catch {
      incomplete = true;
    }
  }

  await walk(opts.root, opts.root, 0).catch(() => {
    incomplete = true;
  });
  return { paths, incomplete };
}

export async function checkRootOwnedCheckout(opts: {
  readonly projectRoot: string;
  readonly composeFile: string;
}) {
  const observed = await findCheckoutFilesOwnedBy({
    root: opts.projectRoot,
    uid: 0,
  });
  if (observed.paths.length === 0) {
    return {
      name: ROOT_OWNED_CHECK,
      status: observed.incomplete ? ("warn" as const) : ("ok" as const),
      message: observed.incomplete
        ? "No root-owned checkout paths found in the bounded scan. The scan did not cover the entire checkout."
        : "No root-owned checkout paths found.",
    };
  }
  const compose: unknown = await Bun.file(opts.composeFile)
    .text()
    .then((text) => YAML.parse(text))
    .catch(() => null);
  const services =
    isRecord(compose) && isRecord(compose.services)
      ? Object.entries(compose.services)
      : [];
  const paths = observed.paths.map((path) => {
    const owners = services
      .filter(
        ([, spec]) =>
          isRecord(spec) &&
          !Object.hasOwn(spec, "user") &&
          serviceMounts(spec, dirname(opts.composeFile)).some(
            (mount) =>
              mount.type === "bind" &&
              !mount.readOnly &&
              mount.source !== undefined &&
              (path === mount.source || path.startsWith(`${mount.source}/`))
          )
      )
      .map(([name]) => name);
    return `${JSON.stringify(relative(opts.projectRoot, path))}${owners.length ? ` (possible services: ${owners.join(", ")})` : ""}`;
  });
  const safePaths = observed.paths.filter((path) => !LINE_BREAK.test(path));
  return {
    name: ROOT_OWNED_CHECK,
    status: "warn" as const,
    message: [
      `Root-owned checkout paths: ${paths.join(", ")}.`,
      observed.incomplete ? "The scan did not cover the entire checkout." : "",
      `Set user: "${process.getuid?.()}:${process.getgid?.()}" in the Compose service definition.`,
      safePaths.length
        ? `To return these paths to your user: sudo chown -h -- "$(id -u):$(id -g)" ${safePaths.map(quoteShellWord).join(" ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}
