import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../lib/guards.ts";
import {
  resolveProjectEnvConfig,
  selectProjectEnvValuesForExecutionTarget,
} from "../lib/project-env-config.ts";

const LIMIT = 256 * 1024;
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type NativeProjectInput = {
  readonly originalSha256: string;
  readonly normalizedComposeJson: string;
  /** Private in-memory transport only. Never log or write this map to Compose. */
  readonly managedEnvironment: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  /** Private lifecycle environment; not container environment. */
  readonly lifecycleHostEnvironment: Readonly<Record<string, string>>;
  readonly effectiveEnvName: string | null;
  readonly environmentFiles: readonly string[];
  readonly serviceNames: readonly string[];
};

function refused(): Error {
  return new Error(
    "Native project input refused: unsupported or invalid Compose/environment configuration; values omitted"
  );
}

async function readCompose(path: string): Promise<Buffer> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
  );
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size === 0 || before.size > LIMIT) {
      throw refused();
    }
    const buffer = Buffer.alloc(LIMIT + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const after = await file.stat();
    if (
      bytesRead !== before.size ||
      after.size !== before.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw refused();
    }
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

function environment(value: unknown): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (isRecord(value)) {
    return { ...value };
  }
  if (!Array.isArray(value)) {
    throw refused();
  }
  const result: Record<string, unknown> = {};
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw refused();
    }
    const equal = entry.indexOf("=");
    const key = equal < 0 ? entry : entry.slice(0, equal);
    if (!KEY.test(key) || Object.hasOwn(result, key)) {
      throw refused();
    }
    result[key] = equal < 0 ? null : entry.slice(equal + 1);
  }
  return result;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function normalizeManagedEnvironment(
  services: Record<string, unknown>,
  resolved: Awaited<ReturnType<typeof resolveProjectEnvConfig>>
): Record<string, Record<string, string>> {
  const managedEnvironment: Record<string, Record<string, string>> = {};
  for (const name of Object.keys(services)) {
    const service = services[name];
    if (!isRecord(service)) {
      throw refused();
    }
    const managed = resolved
      ? selectProjectEnvValuesForExecutionTarget({
          resolved,
          scopeName: name,
          target: "compose",
        })
      : {};
    if (Object.keys(managed).length === 0) {
      continue;
    }
    const normalized = environment(service.environment);
    for (const key of Object.keys(managed)) {
      if (!KEY.test(key)) {
        throw refused();
      }
      normalized[key] = null;
    }
    service.environment = normalized;
    managedEnvironment[name] = managed;
  }
  return managedEnvironment;
}

/**
 * Prepare public normalization and separate private delivery without generating files.
 * Unrelated Compose fields remain intact for native capability admission to review;
 * this helper does not assert that the resulting project is runnable.
 */
export async function prepareNativeProjectInput(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly composeFile: string;
  readonly envName?: string | null;
}): Promise<NativeProjectInput> {
  try {
    const bytes = await readCompose(opts.composeFile);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const compose: unknown = Bun.YAML.parse(text);
    if (!(isRecord(compose) && isRecord(compose.services))) {
      throw refused();
    }
    const serviceNames = Object.keys(compose.services);
    // Refuse before resolving/decrypting any values. Never read env_file contents.
    for (const service of Object.values(compose.services)) {
      if (!isRecord(service) || Object.hasOwn(service, "env_file")) {
        throw refused();
      }
    }
    const resolved = await resolveProjectEnvConfig({ ...opts, serviceNames });
    if (
      !resolved &&
      ((await exists(join(opts.projectDir, ".env"))) ||
        (await exists(join(opts.projectRoot, ".env"))))
    ) {
      throw refused();
    }
    const managedEnvironment = normalizeManagedEnvironment(
      compose.services,
      resolved
    );
    const normalizedComposeJson = JSON.stringify(compose);
    if (Buffer.byteLength(normalizedComposeJson) > LIMIT) {
      throw refused();
    }
    return {
      originalSha256: createHash("sha256").update(bytes).digest("hex"),
      normalizedComposeJson,
      managedEnvironment,
      lifecycleHostEnvironment: resolved
        ? selectProjectEnvValuesForExecutionTarget({
            resolved,
            scopeName: "global",
            target: "host",
          })
        : {},
      effectiveEnvName: resolved?.selection.effectiveEnv ?? null,
      environmentFiles: resolved?.files ?? [],
      serviceNames,
    };
  } catch {
    throw refused();
  }
}
