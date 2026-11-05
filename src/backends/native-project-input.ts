import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import {
  PROJECT_ENV_SECRET_KEY_ENV,
  ProjectEnvKeyMissingError,
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

const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/**
 * Closed input refusal naming the cause and, where known, the service and Compose
 * field. Service names print only when they are plain Compose identifiers; values,
 * file contents and parser excerpts never do.
 */
class NativeProjectInputRefusal extends HackCliError {}

function refused(
  cause = "unsupported or invalid Compose/environment configuration",
  code:
    | "E_NATIVE_PROJECT_UNSUPPORTED"
    | "E_CONFIG_INVALID" = "E_NATIVE_PROJECT_UNSUPPORTED"
): Error {
  return new NativeProjectInputRefusal({
    code,
    message: `Native project input refused: ${cause}; values omitted`,
  });
}

function serviceLabel(name: string): string {
  return SERVICE_NAME.test(name) ? `service ${name}` : "a service";
}

function composeFileRefused(): Error {
  return refused(
    "the Compose file must be a regular, non-empty file of at most 256 KiB that does not change while it is read"
  );
}

/**
 * Env resolution refusals keep their cause without values. A missing project
 * secret key names the next action; any other failure stays generic because env
 * layer diagnostics may quote file contents.
 */
function environmentRefused(error: unknown): Error {
  if (error instanceof ProjectEnvKeyMissingError) {
    return refused(
      `Hack managed env has secret entries but the project env key is missing. Run "hack env add --secret ..." to generate it, restore the key file, or set ${PROJECT_ENV_SECRET_KEY_ENV}`,
      "E_CONFIG_INVALID"
    );
  }
  return refused(
    'Hack managed env could not be read or decrypted. Run "hack env list" to inspect it',
    "E_CONFIG_INVALID"
  );
}

async function readCompose(path: string): Promise<Buffer> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
  ).catch(() => {
    throw composeFileRefused();
  });
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size === 0 || before.size > LIMIT) {
      throw composeFileRefused();
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
      throw composeFileRefused();
    }
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

function environment(value: unknown, service: string): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (isRecord(value)) {
    return { ...value };
  }
  const invalid = () =>
    refused(
      `${serviceLabel(service)} field environment must be a mapping or a list of unique NAME or NAME=value entries`
    );
  if (!Array.isArray(value)) {
    throw invalid();
  }
  const result: Record<string, unknown> = {};
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw invalid();
    }
    const equal = entry.indexOf("=");
    const key = equal < 0 ? entry : entry.slice(0, equal);
    if (!KEY.test(key) || Object.hasOwn(result, key)) {
      throw invalid();
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
      throw refused(`${serviceLabel(name)} must be a mapping`);
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
    const normalized = environment(service.environment, name);
    for (const key of Object.keys(managed)) {
      if (!KEY.test(key)) {
        throw refused(
          `Hack managed env for ${serviceLabel(name)} has a variable name that is not a valid environment name`,
          "E_CONFIG_INVALID"
        );
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
    let compose: unknown;
    try {
      compose = Bun.YAML.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      );
    } catch {
      throw refused("the Compose file is not valid UTF-8 YAML");
    }
    if (!(isRecord(compose) && isRecord(compose.services))) {
      throw refused("the Compose file has no services mapping");
    }
    const serviceNames = Object.keys(compose.services);
    // Refuse before resolving/decrypting any values. Never read env_file contents.
    for (const [name, service] of Object.entries(compose.services)) {
      if (!isRecord(service)) {
        throw refused(`${serviceLabel(name)} must be a mapping`);
      }
      if (Object.hasOwn(service, "env_file")) {
        throw refused(
          `${serviceLabel(name)} field env_file is not supported by native up; move its variables into Hack managed env with hack env set --service`
        );
      }
    }
    const resolved = await resolveProjectEnvConfig({
      ...opts,
      serviceNames,
    }).catch((error: unknown) => {
      throw environmentRefused(error);
    });
    if (
      !resolved &&
      ((await exists(join(opts.projectDir, ".env"))) ||
        (await exists(join(opts.projectRoot, ".env"))))
    ) {
      throw refused(
        "a project .env file is present without Hack managed env; native up does not read .env files. Migrate it with hack doctor --migrate-env-config or remove it"
      );
    }
    const managedEnvironment = normalizeManagedEnvironment(
      compose.services,
      resolved
    );
    const normalizedComposeJson = JSON.stringify(compose);
    if (Buffer.byteLength(normalizedComposeJson) > LIMIT) {
      throw refused("the normalized Compose project exceeds 256 KiB");
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
  } catch (error: unknown) {
    // Only this module's closed refusals carry a cause; anything else stays generic.
    throw error instanceof NativeProjectInputRefusal ? error : refused();
  }
}
