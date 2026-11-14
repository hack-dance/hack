import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import {
  missingProjectEnvKeyHint,
  ProjectEnvKeyMissingError,
  resolveProjectEnvConfig,
  resolveProjectEnvSelection,
  selectProjectEnvValuesForExecutionTarget,
} from "../lib/project-env-config.ts";
import {
  type NativeComposeEnvironmentService,
  normalizeNativeComposeEnvironment,
} from "./native-compose-environment.ts";
import { NativeEnvFileRefusal } from "./native-env-file-source.ts";
import {
  MAX_NATIVE_PRIVATE_INPUT_BYTES,
  nativePrivateEnvironmentPayload,
} from "./native-private-environment-payload.ts";
import type { NativeEmulationPolicy } from "./native-project-platform.ts";
import { shellDeliveryProblem } from "./native-shell-environment.ts";

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

/** One value-free note about a service's `environment`: names only. */
export type NativeEnvironmentNotice = {
  readonly service?: string;
  readonly line: string;
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
   * Private in-memory disclosure guard: nonempty values explicitly marked secret
   * in managed env. Plain file and shell inputs have no secret metadata here.
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
  /** Names-only activation expectation, checked against the runtime before effects. */
  readonly environmentFileServices?: Readonly<Record<string, boolean>>;
  /**
   * Private in-memory transport only: file and caller-shell values for service
   * environment inputs. Kept apart from
   * `managedEnvironment` so they are never fingerprinted or treated as values
   * Hack stores; see {@link mergeNativeShellEnvironment}. Never log this map.
   */
  readonly shellEnvironment?: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  /** Services receiving ephemeral file/shell values, once merged. */
  readonly shellServices?: readonly string[];
  /** Forwarded source names by service, for value-free operator notices only. */
  readonly forwardedShellVariables?: Readonly<
    Record<string, readonly string[]>
  >;
  /**
   * Value-free notes about shell references in service `environment`, such as
   * a referenced variable that is not set. Names only.
   */
  readonly environmentNotices?: readonly NativeEnvironmentNotice[];
  readonly ignoredRootDotenv?: boolean;
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

/** Only this boundary's closed messages may reach a preflight finding. */
export function nativeProjectInputRefusalMessage(
  error: unknown
): string | undefined {
  return error instanceof NativeProjectInputRefusal ? error.message : undefined;
}

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
      `Hack managed env has secret entries but the project env key is missing. ${missingProjectEnvKeyHint()}`,
      "E_CONFIG_INVALID"
    );
  }
  return refused(
    'Hack managed env could not be read or decrypted. Run "hack env list" to inspect it',
    "E_CONFIG_INVALID"
  );
}

/** Bounded, nonblocking regular Compose snapshot shared by start and preflight. */
export async function readNativeComposeBytes(path: string): Promise<Buffer> {
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

/** Parse Compose environment syntax without resolving values; null is an empty declaration. */
export function nativeServiceEnvironment(
  value: unknown,
  service: string
): Record<string, unknown> {
  if (value === undefined || value === null) {
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
  const result: Record<string, unknown> = Object.create(null);
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

function normalizeManagedEnvironment(
  services: Record<string, unknown>,
  resolved: Awaited<ReturnType<typeof resolveProjectEnvConfig>>
): Record<string, Record<string, string>> {
  const managedEnvironment: Record<
    string,
    Record<string, string>
  > = Object.create(null);
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
    const normalized = nativeServiceEnvironment(service.environment, name);
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
 * Adds ephemeral file/shell values to the private delivery. Native
 * start and restart call this once, after the env fingerprints are taken, so a
 * value is delivered to its service and never digested to disk. Commands
 * Fresh exec also calls this after preparing its selected service. Metadata-only
 * stale-env checks never acquire or merge these values. Calling it again changes nothing.
 */
export function mergeNativeShellEnvironment(
  input: NativeProjectInput
): NativeProjectInput {
  const shell = input.shellEnvironment ?? {};
  const fromShell = Object.keys(shell).filter(
    (name) => Object.keys(shell[name] ?? {}).length > 0
  );
  if (fromShell.length === 0) {
    return input;
  }
  const managedEnvironment: Record<string, Readonly<Record<string, string>>> = {
    ...input.managedEnvironment,
  };
  for (const name of fromShell) {
    managedEnvironment[name] = {
      ...(input.managedEnvironment[name] ?? {}),
      ...shell[name],
    };
  }
  return {
    ...input,
    managedEnvironment,
    shellEnvironment: {},
    shellServices: fromShell,
  };
}

/**
 * Refuses when a delivery containing shell values exceeds the runtime's service
 * limits or complete stdin limit. Service-level refusals name the service.
 * Call it on the input that is about to be delivered: after the credential adapters added
 * theirs, and after {@link selectActiveNativeProjectInput}, because the runtime
 * receives nothing for a service the selected profiles leave out.
 */
export function requireNativeShellDeliveryFits(
  input: NativeProjectInput
): void {
  const fromShell = new Set(
    (input.shellServices ?? []).filter((name) =>
      Object.hasOwn(input.managedEnvironment, name)
    )
  );
  const problem = shellDeliveryProblem({
    services: input.managedEnvironment,
    fromShell,
  });
  if (problem !== null) {
    throw refused(shellDeliveryRefusal(problem));
  }
  if (
    fromShell.size > 0 &&
    nativePrivateEnvironmentPayload({
      services: input.managedEnvironment,
      files: input.managedFiles,
      planId: "0".repeat(64),
      run: "0".repeat(32),
    }).byteLength > MAX_NATIVE_PRIVATE_INPUT_BYTES
  ) {
    throw refused(
      "the complete private environment delivery, counting values read from your shell, is over 256 KiB"
    );
  }
}

function shellDeliveryRefusal(
  problem: NonNullable<ReturnType<typeof shellDeliveryProblem>>
): string {
  if (problem.kind === "services") {
    return "more than 32 services receive private environment values, counting those read from your shell";
  }
  const label = serviceLabel(problem.service);
  if (problem.kind === "value") {
    return `${label} field environment: a value read from your shell contains a NUL byte`;
  }
  return problem.kind === "keys"
    ? `${label} field environment: more than 256 variables are delivered privately, counting those read from your shell`
    : `${label} field environment: the values delivered privately, counting those read from your shell, are over 32 KiB together`;
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
 * services outside the selected profiles. File declarations follow the selected
 * profiles; the runtime's active set must not require any unprepared file inputs.
 * The runtime refuses managed
 * values for a service it will not schedule, so an optional disabled service
 * must not receive them and block the selected graph.
 */
export function selectActiveNativeProjectInput(opts: {
  readonly input: NativeProjectInput;
  readonly reviewedPlan: unknown;
}): NativeProjectInput {
  const active = nativeReviewedActiveServices(opts.reviewedPlan);
  for (const name of active) {
    if (opts.input.environmentFileServices?.[name] === false) {
      throw refused(
        `${serviceLabel(name)} env_file activation differs from the reviewed runtime; retry with a matching CLI/runtime`
      );
    }
  }
  return {
    ...opts.input,
    managedEnvironment: Object.fromEntries(
      Object.entries(opts.input.managedEnvironment).filter(([service]) =>
        active.has(service)
      )
    ),
    ...(opts.input.managedFiles === undefined
      ? {}
      : {
          managedFiles: Object.fromEntries(
            Object.entries(opts.input.managedFiles).filter(([service]) =>
              active.has(service)
            )
          ),
        }),
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
  readonly profiles?: readonly string[];
  /** Fresh exec restricts file acquisition to the selected running service. */
  readonly selectedServices?: readonly string[];
  /** Advisory managed fingerprints do not acquire ephemeral file/shell inputs. */
  readonly managedOnly?: boolean;
  /**
   * The caller's environment, read only for the variables that service
   * `environment` entries reference. Omitted, nothing is read and a shell
   * reference resolves as unset. Start, preflight and fresh exec pass the
   * same allowed caller context.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}): Promise<NativeProjectInput> {
  try {
    const bytes = await readNativeComposeBytes(opts.composeFile);
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
    const services: Record<string, NativeComposeEnvironmentService> =
      Object.create(null);
    for (const [name, service] of Object.entries(compose.services)) {
      if (!isRecord(service)) {
        throw refused(`${serviceLabel(name)} must be a mapping`);
      }
      services[name] = { document: service, environment: {} };
    }
    const resolved = await resolveProjectEnvConfig({
      ...opts,
      serviceNames,
    }).catch((error: unknown) => {
      throw environmentRefused(error);
    });
    const managedEnvironment = normalizeManagedEnvironment(
      compose.services,
      resolved
    );
    for (const [name, service] of Object.entries(services)) {
      services[name] = {
        document: service.document,
        environment: nativeServiceEnvironment(
          service.document.environment,
          name
        ),
      };
    }
    const shell = opts.managedOnly
      ? {
          shellEnvironment: {},
          notices: [],
          forwardedNames: {},
          fileServices: {},
          ignoredRootDotenv: false,
        }
      : await normalizeNativeComposeEnvironment({
          ...opts,
          compose,
          services,
          managed: managedEnvironment,
          global: resolved
            ? selectProjectEnvValuesForExecutionTarget({
                resolved,
                scopeName: "global",
                target: "compose",
              })
            : {},
          env: opts.env,
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
      environmentFileServices: shell.fileServices,
      shellEnvironment: shell.shellEnvironment,
      forwardedShellVariables: shell.forwardedNames,
      environmentNotices: shell.notices,
      ignoredRootDotenv: shell.ignoredRootDotenv,
    };
  } catch (error: unknown) {
    // Only this module's closed refusals carry a cause; anything else stays generic.
    throw error instanceof NativeProjectInputRefusal ||
      error instanceof NativeEnvFileRefusal
      ? error
      : refused();
  }
}
