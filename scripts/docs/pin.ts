/**
 * Re-pin one published docs version to a Git ref.
 *
 *   bun scripts/docs/pin.ts --version v5 --ref v5.0.0-next.12 --label "v5 (next.12)" --dir next12
 *
 * For every manifest entry it snapshots the file at that ref into
 * `docs/versions/<version>/originals/<dir>/`, records the SHA-256, refreshes the
 * tracked public-file inventory used for link validation, and removes originals
 * directories of that version that no entry references any more. The editorial
 * pages are not touched; review them against the new ref by hand.
 */
import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import versions from "./versions.json";

const repositoryRoot = resolve(import.meta.dir, "../..");
const manifestPath = resolve(import.meta.dir, "versions.json");

interface PinOptions {
  readonly version: "v4" | "v5";
  readonly ref: string;
  readonly label: string;
  readonly dir: string;
}

function git(args: readonly string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`
    );
  }
  return result.stdout.toString();
}

function parseOptions(argv: readonly string[]): PinOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      version: { type: "string" },
      ref: { type: "string" },
      label: { type: "string" },
      dir: { type: "string" },
    },
    strict: true,
  });
  const { version, ref, label, dir } = values;
  if (version !== "v4" && version !== "v5") {
    throw new Error("--version must be v4 or v5");
  }
  if (!(ref && /^[A-Za-z0-9][A-Za-z0-9./_-]*$/.test(ref))) {
    throw new Error("--ref must name a tag, branch or commit");
  }
  if (!(label && /^[A-Za-z0-9][A-Za-z0-9 .()-]{0,119}$/.test(label))) {
    throw new Error("--label must be a short display label");
  }
  if (!(dir && /^[a-z\d][a-z\d-]*$/.test(dir))) {
    throw new Error("--dir must be a lowercase directory name");
  }
  return { version, ref, label, dir };
}

export async function pin(options: PinOptions): Promise<void> {
  const revision = git(["rev-parse", `${options.ref}^{commit}`]).trim();
  if (!/^[a-f0-9]{40}$/.test(revision)) {
    throw new Error(`Unresolved ref: ${options.ref}`);
  }
  const manifest = versions[options.version];
  const originalsRoot = resolve(
    repositoryRoot,
    "docs/versions",
    options.version,
    "originals"
  );
  const entries: (typeof manifest.entries)[number][] = [];
  for (const entry of manifest.entries) {
    const raw = git(["show", `${revision}:${entry.file}`]);
    const snapshot = `docs/versions/${options.version}/originals/${options.dir}/${entry.file}`;
    const target = resolve(repositoryRoot, snapshot);
    await mkdir(dirname(target), { recursive: true });
    await Bun.write(target, raw);
    entries.push({
      ...entry,
      snapshot,
      sha256: new Bun.CryptoHasher("sha256").update(raw).digest("hex"),
    });
  }
  const publicFiles = git(["ls-tree", "-r", "--name-only", revision])
    .split("\n")
    .filter((line) => line.length > 0)
    .sort();
  for (const name of await readdir(originalsRoot)) {
    if (name !== options.dir) {
      await rm(resolve(originalsRoot, name), { recursive: true, force: true });
    }
  }
  const next = {
    ...versions,
    [options.version]: {
      ...manifest,
      revision,
      label: options.label,
      entries,
      publicFiles,
    },
  };
  await Bun.write(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(
    `Pinned ${options.version} to ${options.ref} (${revision}); ${entries.length} snapshots under originals/${options.dir}, ${publicFiles.length} public files.`
  );
}

if (import.meta.main) {
  await pin(parseOptions(Bun.argv.slice(2)));
}
