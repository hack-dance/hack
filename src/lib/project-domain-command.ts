import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { YAML } from "bun";
import { CliUsageError } from "../cli/command.ts";
import { GLOBAL_PROJECTS_REGISTRY_FILENAME } from "../constants.ts";
import { resolveGlobalHackDir } from "./config-paths.ts";
import { isRecord } from "./guards.ts";
import { findProjectContext } from "./project.ts";
import {
  applyProjectDomainMigration,
  previewProjectDomainMigration,
  rollbackProjectDomainMigration,
} from "./project-domain-migration.ts";

const MAX_CONFIG_BYTES = 1_048_576;
const ROUTE_LABEL = /^caddy(?:_\d+)?$/;
const LITERAL_HOST =
  /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.?$/i;
const TRAILING_DOT = /\.$/;

function missing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

/** Read a stable, bounded descriptor; never expose configuration in errors. */
async function readClaimFile(path: string): Promise<string | null> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  ).catch((error: unknown) => {
    if (missing(error)) {
      return null;
    }
    throw new Error("Unable to open registered route configuration safely");
  });
  if (!file) {
    return null;
  }
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > MAX_CONFIG_BYTES) {
      throw new Error("Invalid file");
    }
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        size,
        buffer.length - size,
        size
      );
      if (bytesRead === 0) {
        break;
      }
      size += bytesRead;
    }
    const after = await file.stat();
    if (
      size > MAX_CONFIG_BYTES ||
      size !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error("Changed file");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, size)
    );
  } catch {
    throw new Error(
      "Registered route configuration must be a stable regular bounded file"
    );
  } finally {
    await file.close();
  }
}

function labelEntries(labels: unknown): readonly [string, unknown][] {
  if (labels === undefined) {
    return [];
  }
  if (isRecord(labels)) {
    return Object.entries(labels);
  }
  if (!Array.isArray(labels)) {
    throw new Error("Registered labels require manual collision review");
  }
  return labels.map((entry) => {
    if (typeof entry !== "string") {
      throw new Error("Registered labels require manual collision review");
    }
    const equal = entry.indexOf("=");
    return equal < 0
      ? [entry, undefined]
      : [entry.slice(0, equal), entry.slice(equal + 1)];
  });
}

function serviceClaims(service: unknown): string[] {
  if (!isRecord(service) || Object.hasOwn(service, "extends")) {
    throw new Error("Registered service requires manual collision review");
  }
  const hosts: string[] = [];
  const seen = new Set<string>();
  for (const [key, value] of labelEntries(service.labels)) {
    if (key.includes("$")) {
      throw new Error(
        "Dynamic registered labels require manual collision review"
      );
    }
    if (!ROUTE_LABEL.test(key)) {
      continue;
    }
    if (seen.has(key)) {
      throw new Error(
        "Duplicate registered Caddy labels require manual collision review"
      );
    }
    seen.add(key);
    if (typeof value !== "string") {
      throw new Error(
        "Dynamic registered routes require manual collision review"
      );
    }
    for (const host of value.split(",").map((part) => part.trim())) {
      if (!LITERAL_HOST.test(host)) {
        throw new Error(
          "Dynamic registered routes require manual collision review"
        );
      }
      hosts.push(host.toLowerCase().replace(TRAILING_DOT, ""));
    }
  }
  return hosts;
}

function parseClaims(text: string): string[] {
  let value: unknown;
  try {
    value = YAML.parse(text);
  } catch {
    throw new Error("Unable to parse registered route configuration");
  }
  if (
    !(isRecord(value) && isRecord(value.services)) ||
    Object.hasOwn(value, "include")
  ) {
    throw new Error(
      "Registered route configuration requires manual collision review"
    );
  }
  return Object.values(value.services).flatMap(serviceClaims);
}

function registeredPath(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new Error("Invalid registered path; refusing domain migration");
  }
  return resolve(value);
}

function projectDirectories(entry: unknown): string[] {
  if (!isRecord(entry)) {
    throw new Error("Invalid registered project; refusing domain migration");
  }
  const primary = registeredPath(entry.projectDir);
  if (
    entry.projectDirName !== undefined &&
    entry.projectDirName !== ".hack" &&
    entry.projectDirName !== ".dev"
  ) {
    throw new Error(
      "Invalid registered project directory name; refusing domain migration"
    );
  }
  if (entry.worktrees === undefined) {
    return [primary];
  }
  if (!Array.isArray(entry.worktrees) || entry.worktrees.length > 256) {
    throw new Error("Invalid registered worktrees; refusing domain migration");
  }
  const worktrees = entry.worktrees.map((worktree) => {
    if (!isRecord(worktree)) {
      throw new Error("Invalid registered worktree; refusing domain migration");
    }
    return join(
      registeredPath(worktree.path),
      entry.projectDirName === ".dev" ? ".dev" : ".hack"
    );
  });
  return [primary, ...worktrees];
}

function parseRegistryDirectories(text: string): string[] {
  let registry: unknown;
  try {
    registry = JSON.parse(text);
  } catch {
    throw new Error("Invalid project registry; refusing domain migration");
  }
  if (
    !isRecord(registry) ||
    registry.version !== 1 ||
    !Array.isArray(registry.projects) ||
    registry.projects.length > 256
  ) {
    throw new Error("Unsupported project registry; refusing domain migration");
  }
  return [...new Set(registry.projects.flatMap(projectDirectories))];
}

async function regularDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Unsafe directory");
    }
    return true;
  } catch (error) {
    if (missing(error)) {
      return false;
    }
    throw new Error(
      "Registered project directory requires manual collision review"
    );
  }
}

async function directoryClaims(
  directory: string,
  target: string
): Promise<string[]> {
  // Check the checkout root too: a symlinked worktree parent must not silently
  // redirect its otherwise regular .hack child into another checkout.
  if (
    !(
      (await regularDirectory(dirname(directory))) &&
      (await regularDirectory(directory))
    )
  ) {
    return [];
  }
  if ((await realpath(directory)) === target) {
    return [];
  }
  const compose = await readClaimFile(join(directory, "docker-compose.yml"));
  return compose === null ? [] : parseClaims(compose);
}

/** Preflight registered static claims only; this is not a lock on running Caddy routes. */
export async function readDomainMigrationClaims(
  projectDir: string
): Promise<string[]> {
  const text = await readClaimFile(
    join(resolveGlobalHackDir(), GLOBAL_PROJECTS_REGISTRY_FILENAME)
  );
  if (text === null) {
    return [];
  }
  const target = await realpath(projectDir);
  const hosts: string[] = [];
  for (const directory of parseRegistryDirectories(text)) {
    hosts.push(...(await directoryClaims(directory, target)));
  }
  return [...new Set(hosts)];
}

/** Standalone project-only action: no global Doctor repair, runtime restart or native trust. */
export async function runProjectDomainCommand(opts: {
  readonly action: string;
  readonly startDir: string;
  readonly json: boolean;
}): Promise<number> {
  if (!["preview", "apply", "rollback"].includes(opts.action)) {
    throw new CliUsageError(
      "--domain-migration must be preview, apply, or rollback"
    );
  }
  const project = await findProjectContext(opts.startDir);
  if (!project) {
    throw new CliUsageError(
      "Domain migration requires an existing Hack project"
    );
  }
  if (opts.action === "rollback") {
    await rollbackProjectDomainMigration({ projectDir: project.projectDir });
    emit(
      {
        action: "rollback",
        status: "restored",
        message:
          "Original project files restored. Running services and host settings were not changed.",
      },
      opts.json
    );
    return 0;
  }
  const plan = await previewProjectDomainMigration({
    projectDir: project.projectDir,
    claimedHosts: await readDomainMigrationClaims(project.projectDir),
  });
  if (opts.action === "apply") {
    // Recheck registered claims at the effect boundary; file preconditions are enforced by the transaction.
    await previewProjectDomainMigration({
      projectDir: project.projectDir,
      claimedHosts: await readDomainMigrationClaims(project.projectDir),
    });
    await applyProjectDomainMigration({ projectDir: project.projectDir, plan });
  }
  emit(
    {
      action: opts.action,
      status: opts.action === "apply" ? "applied" : "preview",
      fromHost: plan.fromHost,
      toHost: plan.toHost,
      addedHosts: plan.addedHosts,
      message:
        "Old routes retained. Host DNS, running routes, TLS and application consumers require separate verification.",
      rollback: "hack doctor --domain-migration rollback --path <same-project>",
    },
    opts.json
  );
  return 0;
}

function emit(value: Record<string, unknown>, json: boolean): void {
  process.stdout.write(
    `${
      json
        ? JSON.stringify(value)
        : Object.entries(value)
            .map(
              ([key, item]) =>
                `${key}: ${Array.isArray(item) ? item.join(", ") : String(item)}`
            )
            .join("\n")
    }\n`
  );
}
