#!/usr/bin/env bun

import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

interface Args {
  readonly version: string | null;
}

interface ParseOk {
  readonly ok: true;
  readonly args: Args;
}
interface ParseErr {
  readonly ok: false;
  readonly message: string;
}

const parsed = parseArgs({ argv: Bun.argv.slice(2) });
if (parsed.ok) {
  process.exitCode = await main({ args: parsed.args });
} else {
  process.stderr.write(`${parsed.message}\n`);
  process.exitCode = 1;
}

async function main({ args }: { readonly args: Args }): Promise<number> {
  const nextVersion = args.version?.trim() ?? "";
  if (nextVersion.length === 0) {
    process.stderr.write("Missing --version.\n");
    return 1;
  }

  const repoRoot = resolve(import.meta.dir, "..");

  // Update root package.json
  const packageJsonPath = resolve(repoRoot, "package.json");
  const pkg = await Bun.file(packageJsonPath).json();

  if (typeof pkg !== "object" || pkg === null) {
    process.stderr.write("Unable to read package.json.\n");
    return 1;
  }

  const currentVersion = typeof pkg.version === "string" ? pkg.version : null;
  if (currentVersion === null) {
    process.stderr.write("package.json is missing a string version.\n");
    return 1;
  }

  if (currentVersion !== nextVersion) {
    pkg.version = nextVersion;
    await Bun.write(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
    process.stdout.write(
      `Updated package.json: ${currentVersion} → ${nextVersion}\n`
    );
  }

  await syncWorkspacePackageVersions({
    repoRoot,
    nextVersion,
    rootPackageJson: pkg,
  });

  // Update macOS app version in Base.xcconfig
  const xconfigPath = resolve(repoRoot, "apps/macos/Config/Base.xcconfig");
  try {
    const xconfigContent = await Bun.file(xconfigPath).text();
    const updatedXconfig = xconfigContent.replace(
      /^MARKETING_VERSION = .*/m,
      `MARKETING_VERSION = ${nextVersion}`
    );
    if (updatedXconfig !== xconfigContent) {
      await Bun.write(xconfigPath, updatedXconfig);
      process.stdout.write(
        `Updated Base.xcconfig: MARKETING_VERSION → ${nextVersion}\n`
      );
    }
  } catch {
    // macOS config may not exist, that's fine
  }

  return 0;
}

/**
 * Keep workspace package versions aligned with the release version so monorepo
 * metadata remains coherent for CI/release tooling and downstream consumers.
 */
async function syncWorkspacePackageVersions(input: {
  readonly repoRoot: string;
  readonly nextVersion: string;
  readonly rootPackageJson: unknown;
}): Promise<void> {
  const workspacePackageJsonPaths = await collectWorkspacePackageJsonPaths({
    repoRoot: input.repoRoot,
    rootPackageJson: input.rootPackageJson,
  });

  for (const workspacePackageJsonPath of workspacePackageJsonPaths) {
    const packageJson = await Bun.file(workspacePackageJsonPath).json();
    if (!isRecord(packageJson)) {
      continue;
    }

    const currentVersion =
      typeof packageJson.version === "string" ? packageJson.version : null;
    if (currentVersion === input.nextVersion) {
      continue;
    }

    packageJson.version = input.nextVersion;
    await Bun.write(
      workspacePackageJsonPath,
      `${JSON.stringify(packageJson, null, 2)}\n`
    );

    const displayPath = workspacePackageJsonPath.replace(
      `${input.repoRoot}/`,
      ""
    );
    process.stdout.write(
      `Updated ${displayPath}: ${currentVersion ?? "(unset)"} → ${input.nextVersion}\n`
    );
  }
}

/**
 * Expand root workspace globs and return discovered package.json paths.
 */
async function collectWorkspacePackageJsonPaths(input: {
  readonly repoRoot: string;
  readonly rootPackageJson: unknown;
}): Promise<string[]> {
  if (!isRecord(input.rootPackageJson)) {
    return [];
  }

  const workspaces = input.rootPackageJson.workspaces;
  if (!Array.isArray(workspaces)) {
    return [];
  }

  const packageJsonPaths = new Set<string>();

  for (const entry of workspaces) {
    if (typeof entry !== "string" || !entry.endsWith("/*")) {
      continue;
    }
    const workspaceRoot = resolve(
      input.repoRoot,
      entry.slice(0, Math.max(entry.length - 2, 0))
    );

    let children: string[] = [];
    try {
      children = await readdir(workspaceRoot, {
        withFileTypes: false,
      });
    } catch {
      continue;
    }

    for (const child of children) {
      const packageJsonPath = resolve(workspaceRoot, child, "package.json");
      if (!(await fileExists(packageJsonPath))) {
        continue;
      }
      packageJsonPaths.add(packageJsonPath);
    }
  }

  return [...packageJsonPaths].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Bun.file(path).stat();
    return true;
  } catch {
    return false;
  }
}

function parseArgs({
  argv,
}: {
  readonly argv: readonly string[];
}): ParseOk | ParseErr {
  let version: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg.length === 0) {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      return {
        ok: false,
        message: [
          "Update package.json for a release version.",
          "",
          "Usage:",
          "  bun run scripts/prepare-release.ts --version=X.Y.Z",
          "  bun run scripts/prepare-release.ts --version X.Y.Z",
          "",
        ].join("\n"),
      };
    }

    if (arg === "--version") {
      const value = argv[index + 1]?.trim();
      if (!value) {
        return { ok: false, message: "Missing value for --version." };
      }
      version = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--version=")) {
      const value = arg.slice("--version=".length).trim();
      if (!value) {
        return { ok: false, message: "Missing value for --version." };
      }
      version = value;
      continue;
    }

    return { ok: false, message: `Unknown arg: ${arg}` };
  }

  if (!version) {
    return { ok: false, message: "Missing --version." };
  }

  return { ok: true, args: { version } };
}
