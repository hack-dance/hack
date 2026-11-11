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
  resolveProjectEnvSelection,
  selectProjectEnvValuesForExecutionTarget,
} from "../lib/project-env-config.ts";
import type { NativeEmulationPolicy } from "./native-project-platform.ts";
import { resolveShellEnvironment } from "./native-shell-environment.ts";

const LIMIT = 256 * 1024;
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * One private file member delivered into a service's environment allocation and
 * bound read-only at `target`. `content` is private; never log or persist it.
 */
export type NativeManagedFile = {
  readonly name: string;
  readonly target: string;
  readonly content: Buffer;
};

export type NativeProjectInput = {
  readonly originalSha256: string;
  readonly normalizedComposeJson: string;
  /** Private in-memory transport only. Never log or write this map to Compose. */
  readonly managedEnvironment: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  /** Private file members by service (credential adapters only); never logged. */
  readonly managedFiles?: Readonly<
    Record<string, readonly NativeManagedFile[]>
  >;
  /**
   * Private in-memory only: the values Hack stores as secrets for this project and
   * environment, so build arguments can refuse to carry one. Never log or write it.
   */
  readonly managedSecretValues?: readonly string[];
  /** Private lifecycle environment; not container environment. */
  readonly lifecycleHostEnvironment: Readonly<Record<string, string>>;
  /**
   * The requested env, else the project default env, else `null`. It is set even when
   * no managed env file exists, because it also selects the per-env native files.
   */
  readonly effectiveEnvName: string | null;
  readonly environmentFiles: readonly string[];
  readonly serviceNames: readonly string[];
  /**
   * Value-free notes about shell references in service `environment`, such as
   * a referenced variable that is not set. Names only.
   */
  readonly environmentNotices?: readonly string[];
  /**
   * Emulation policy of each service the native adaptation opted in to `linux/amd64`
   * (`amd64Emulation`); absent when none did. See `native-project-platform.ts`.
   */
  readonly amd64Emulation?: Readonly<Record<string, NativeEmulationPolicy>>;
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
 * Resolves the shell references in each service's `environment` and adds the
 * values to the private delivery map (see `native-shell-environment.ts`). The
 * public document keeps only bare references. Returns the value-free notices.
 */
function deliverShellEnvironment(opts: {
  readonly services: Record<string, unknown>;
  readonly managedEnvironment: Record<string, Record<string, string>>;
  readonly env: Readonly<Record<string, string | undefined>>;
}): string[] {
  const notices: string[] = [];
  for (const [name, service] of Object.entries(opts.services)) {
    if (!isRecord(service) || service.environment === undefined) {
      continue;
    }
    const managed = opts.managedEnvironment[name] ?? {};
    const resolution = resolveShellEnvironment({
      service: name,
      environment: environment(service.environment, name),
      env: opts.env,
      managed: new Set(Object.keys(managed)),
    });
    if (resolution === null) {
      continue;
    }
    if (resolution.refused !== undefined) {
      throw refused(
        `${serviceLabel(name)} field environment: the shell value of ${resolution.refused} contains a NUL byte or is over 32 KiB`
      );
    }
    service.environment = resolution.environment;
    if (Object.keys(resolution.delivered).length > 0) {
      opts.managedEnvironment[name] = { ...managed, ...resolution.delivered };
    }
    if (SERVICE_NAME.test(name)) {
      notices.push(...resolution.notices);
    }
  }
  return notices;
}

/** Every value the resolved project env stores as a secret, for any scope or target. */
function managedSecretValues(
  resolved: Awaited<ReturnType<typeof resolveProjectEnvConfig>>
): string[] {
  if (!resolved) {
    return [];
  }
  const values = new Set<string>();
  const collect = (
    metadata: typeof resolved.effectiveMetadata,
    valuesFor: (target: string) => Readonly<Record<string, string>> | undefined
  ) => {
    for (const [target, keys] of Object.entries(metadata)) {
      const resolvedValues = valuesFor(target);
      for (const [key, entry] of Object.entries(keys)) {
        const value = resolvedValues?.[key];
        if (entry.secret && typeof value === "string" && value !== "") {
          values.add(value);
        }
      }
    }
  };
  collect(resolved.effectiveMetadata, (target) =>
    target === "global" ? resolved.globalEnv : resolved.serviceEnv[target]
  );
  collect(
    resolved.hostEffectiveMetadata,
    (target) => resolved.hostTargetEnv[target]
  );
  return [...values];
}

/**
 * Services the reviewed native plan marks active for the selected profiles. A
 * malformed plan, or a service absent from it, selects nothing.
 */
export function nativeReviewedActiveServices(
  reviewedPlan: unknown
): ReadonlySet<string> {
  const services =
    isRecord(reviewedPlan) && isRecord(reviewedPlan.services)
      ? reviewedPlan.services
      : {};
  return new Set(
    Object.entries(services)
      .filter(([, service]) => isRecord(service) && service.active === true)
      .map(([name]) => name)
  );
}

/**
 * Restrict private delivery to the reviewed, profile-active service set.
 *
 * Normalization declares managed keys on every authored service, including
 * services outside the selected profiles, so public Compose and the reviewed
 * plan stay identical across profile selections. The runtime refuses managed
 * values for a service it will not schedule, so an optional disabled service
 * must not receive them and block the selected graph.
 */
export function selectActiveNativeProjectInput(opts: {
  readonly input: NativeProjectInput;
  readonly reviewedPlan: unknown;
}): NativeProjectInput {
  const active = nativeReviewedActiveServices(opts.reviewedPlan);
  return {
    ...opts.input,
    managedEnvironment: Object.fromEntries(
      Object.entries(opts.input.managedEnvironment).filter(([service]) =>
        active.has(service)
      )
    ),
  };
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
  /**
   * The caller's environment, read only for the variables that service
   * `environment` entries reference. Defaults to the process environment.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
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
    const environmentNotices = deliverShellEnvironment({
      services: compose.services,
      managedEnvironment,
      env: opts.env ?? process.env,
    });
    const normalizedComposeJson = JSON.stringify(compose);
    if (Buffer.byteLength(normalizedComposeJson) > LIMIT) {
      throw refused("the normalized Compose project exceeds 256 KiB");
    }
    // Without managed env files there are no values, but the selection still names
    // the env that picks `adaptation.<env>.json` and per-env dependencies.
    const selection =
      resolved?.selection ??
      (await resolveProjectEnvSelection({
        projectRoot: opts.projectRoot,
        projectDir: opts.projectDir,
        envName: opts.envName,
      }));
    return {
      originalSha256: createHash("sha256").update(bytes).digest("hex"),
      normalizedComposeJson,
      managedEnvironment,
      managedSecretValues: managedSecretValues(resolved),
      lifecycleHostEnvironment: resolved
        ? selectProjectEnvValuesForExecutionTarget({
            resolved,
            scopeName: "global",
            target: "host",
          })
        : {},
      effectiveEnvName: selection.effectiveEnv,
      environmentFiles: resolved?.files ?? [],
      serviceNames,
      environmentNotices,
    };
  } catch (error: unknown) {
    // Only this module's closed refusals carry a cause; anything else stays generic.
    throw error instanceof NativeProjectInputRefusal ? error : refused();
  }
}
