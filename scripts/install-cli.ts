#!/usr/bin/env bun

import { lstat, readlink, rm, symlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { ensureDir, readTextFile, writeTextFile } from "../src/lib/fs.ts";

type InstallMode = "dev" | "bin";

const CLI_NAME = "hack" as const;
const DEFAULT_INSTALL_DIR_RELATIVE = ".hack/bin" as const;

interface ParseOk {
  readonly ok: true;
  readonly mode: InstallMode;
  readonly installDirRaw: string | null;
  readonly force: boolean;
}

interface ParseErr {
  readonly ok: false;
  readonly message: string;
}

const parsed = parseArgs(Bun.argv.slice(2));
if (parsed.ok) {
  process.exitCode = await main(parsed);
} else {
  process.stderr.write(`${parsed.message}\n`);
  process.exitCode = 1;
}

async function main(parsed: ParseOk): Promise<number> {
  const repoRoot = resolve(import.meta.dir, "..");

  const home = (process.env.HOME ?? "").trim();
  if (home.length === 0) {
    process.stderr.write(
      "HOME is not set; cannot determine install directory.\n"
    );
    return 1;
  }

  const installDir = resolveInstallDir({
    home,
    installDirRaw: parsed.installDirRaw,
  });
  await ensureDir(installDir);

  const targetPath = resolve(installDir, CLI_NAME);
  let desired: DesiredInstall;
  try {
    desired = await desiredInstall({
      mode: parsed.mode,
      repoRoot,
      installDir,
      targetPath,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    process.stderr.write(`${message}\n`);
    return 1;
  }

  const current = await readCurrentInstall(targetPath);
  if (current.status === "present" && isSameInstall({ current, desired })) {
    printSuccess({
      mode: parsed.mode,
      installDir,
      targetPath,
      repoRoot,
      note: "Already installed",
    });
    return 0;
  }

  if (current.status === "present" && !parsed.force) {
    process.stderr.write(`Refusing to overwrite existing '${CLI_NAME}' at:\n`);
    process.stderr.write(`  ${targetPath}\n`);
    process.stderr.write("Re-run with --force to replace it.\n");
    return 1;
  }

  if (current.status === "present") {
    await rm(targetPath, { force: true });
  }

  await applyInstall({ desired });
  printSuccess({ mode: parsed.mode, installDir, targetPath, repoRoot });
  return 0;
}

function parseArgs(argv: readonly string[]): ParseOk | ParseErr {
  let mode: InstallMode = "dev";
  let installDirRaw: string | null = null;
  let force = false;

  for (const arg of argv) {
    if (arg === "--force") {
      force = true;
      continue;
    }

    if (arg.startsWith("--mode=")) {
      const v = arg.slice("--mode=".length).trim();
      if (v === "dev" || v === "bin") {
        mode = v;
        continue;
      }
      return { ok: false, message: `Invalid --mode: ${v} (expected dev|bin)` };
    }

    if (arg.startsWith("--dir=")) {
      const v = arg.slice("--dir=".length).trim();
      if (v.length === 0) {
        return { ok: false, message: "Invalid --dir (empty)" };
      }
      installDirRaw = v;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      return {
        ok: false,
        message: [
          "Install hack-cli as a global `hack` command (writes into ~/.hack/bin by default).",
          "",
          "Usage:",
          "  bun run scripts/install-cli.ts [--mode=dev|bin] [--dir=/path] [--force]",
          "",
          "Modes:",
          "  --mode=dev  Install a wrapper that runs this repo's source via Bun (fastest iteration).",
          "  --mode=bin  Install a symlink to dist/hack (compiled binary).",
          "",
        ].join("\n"),
      };
    }

    return { ok: false, message: `Unknown arg: ${arg}` };
  }

  return { ok: true, mode, installDirRaw, force };
}

function resolveInstallDir(opts: {
  readonly home: string;
  readonly installDirRaw: string | null;
}): string {
  if (opts.installDirRaw && opts.installDirRaw.trim().length > 0) {
    return resolve(opts.installDirRaw);
  }
  return resolve(opts.home, DEFAULT_INSTALL_DIR_RELATIVE);
}

type DesiredInstall =
  | {
      readonly kind: "wrapper";
      readonly mode: "dev";
      readonly installDir: string;
      readonly targetPath: string;
      readonly content: string;
    }
  | {
      readonly kind: "symlink";
      readonly mode: "bin";
      readonly installDir: string;
      readonly targetPath: string;
      readonly linkTarget: string;
    };

async function desiredInstall(opts: {
  readonly mode: InstallMode;
  readonly repoRoot: string;
  readonly installDir: string;
  readonly targetPath: string;
}): Promise<DesiredInstall> {
  if (opts.mode === "dev") {
    const content = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "# hack-cli local-dev shim (auto-generated)",
      "",
      `exec bun ${shellQuote(resolve(opts.repoRoot, "index.ts"))} "$@"`,
      "",
    ].join("\n");

    return {
      kind: "wrapper",
      mode: "dev",
      installDir: opts.installDir,
      targetPath: opts.targetPath,
      content,
    };
  }

  const linkTarget = resolve(opts.repoRoot, "dist/hack");
  const exists = await fileExists(linkTarget);
  if (!exists) {
    throw new Error(
      `Missing compiled binary at ${linkTarget}\nRun: bun run build`
    );
  }

  return {
    kind: "symlink",
    mode: "bin",
    installDir: opts.installDir,
    targetPath: opts.targetPath,
    linkTarget,
  };
}

type CurrentInstall =
  | { readonly status: "missing" }
  | {
      readonly status: "present";
      readonly kind: "symlink";
      readonly linkTarget: string;
    }
  | {
      readonly status: "present";
      readonly kind: "file";
      readonly content: string;
    };

async function readCurrentInstall(targetPath: string): Promise<CurrentInstall> {
  try {
    const stat = await lstat(targetPath);
    if (stat.isSymbolicLink()) {
      const linkTargetRaw = await readlink(targetPath);
      const linkTarget = resolve(dirname(targetPath), linkTargetRaw);
      return { status: "present", kind: "symlink", linkTarget };
    }

    const content = await readTextFile(targetPath);
    return { status: "present", kind: "file", content: content ?? "" };
  } catch {
    return { status: "missing" };
  }
}

function isSameInstall(opts: {
  readonly current: CurrentInstall;
  readonly desired: DesiredInstall;
}): boolean {
  if (opts.current.status !== "present") {
    return false;
  }

  if (opts.desired.kind === "symlink") {
    if (opts.current.kind !== "symlink") {
      return false;
    }
    return (
      resolve(opts.current.linkTarget) === resolve(opts.desired.linkTarget)
    );
  }

  if (opts.current.kind !== "file") {
    return false;
  }
  return opts.current.content === opts.desired.content;
}

async function applyInstall(opts: {
  readonly desired: DesiredInstall;
}): Promise<void> {
  if (opts.desired.kind === "wrapper") {
    await writeTextFile(opts.desired.targetPath, opts.desired.content);
    await chmodExecutable(opts.desired.targetPath);
    return;
  }

  await symlink(opts.desired.linkTarget, opts.desired.targetPath);
}

async function chmodExecutable(path: string): Promise<void> {
  const proc = Bun.spawn(["chmod", "+x", path], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Bun.file(path).stat();
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  // Minimal safe quoting for bash.
  return `"${value.replaceAll("\\\\", "\\\\\\\\").replaceAll('"', '\\\\"')}"`;
}

function printSuccess(opts: {
  readonly mode: InstallMode;
  readonly installDir: string;
  readonly targetPath: string;
  readonly repoRoot: string;
  readonly note?: string;
}): void {
  const note = opts.note ? `${opts.note}. ` : "";
  process.stdout.write(
    `${note}Installed '${CLI_NAME}' (${opts.mode}) to:\n  ${opts.targetPath}\n\n`
  );

  const isOnPath = (process.env.PATH ?? "")
    .split(":")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .some((p) => resolve(p) === resolve(opts.installDir));

  if (!isOnPath) {
    process.stdout.write("Add this to your shell config (e.g. ~/.zshrc):\n");
    process.stdout.write(`  export PATH="${opts.installDir}:$PATH"\n\n`);
  }

  if (opts.mode === "dev") {
    process.stdout.write("Dev workflow:\n");
    process.stdout.write(`  hack --help   # runs from ${opts.repoRoot}\n\n`);
  } else {
    process.stdout.write("Binary workflow:\n");
    process.stdout.write("  bun run build && hack --help\n\n");
  }
}
