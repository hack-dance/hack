import { isRecord } from "../../lib/guards.ts";
import {
  readHackEnvRuntimeConfig,
  removeDotEnvKey,
  resolveEnvFilePath,
  resolveEnvSecretKey,
  resolveHackEnv,
  upsertDotEnvValue,
  validateHackEnvMutationSource,
} from "../../lib/hack-env.ts";
import {
  describeEnvAggregateStatusForJson,
  describeValueStorageForJson,
  serializeEnvStorageForJson,
} from "../../lib/hack-env-status.ts";
import { parseEnvConfigSelection } from "../../lib/project.ts";
import type { RegisteredProject } from "../../lib/projects-registry.ts";
import {
  readProjectsRegistry,
  resolveRegisteredProjectById,
  resolveRegisteredProjectByName,
} from "../../lib/projects-registry.ts";
import { resolveSecretStore } from "../../lib/secret-store.ts";

const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export type EnvValueState = {
  readonly key: string;
  readonly required: boolean;
  readonly source: "plain_env" | "keychain";
  readonly services: readonly string[] | null;
  readonly description?: string;
  readonly resolvedFrom:
    | "dotenv"
    | "process"
    | "keychain"
    | "portable_backend"
    | null;
  readonly hasValue: boolean;
  readonly storage: ReturnType<typeof describeValueStorageForJson>;
};

export type EnvGetResponse = {
  readonly project: {
    readonly id: string;
    readonly name: string;
    readonly repoRoot: string;
    readonly projectDir: string;
  };
  readonly contract: {
    readonly path: string;
    readonly exists: boolean;
    readonly parseError?: string;
    readonly version: number;
    readonly vars: ReadonlyArray<{
      readonly key: string;
      readonly required: boolean;
      readonly source: "plain_env" | "keychain";
      readonly services: readonly string[] | null;
      readonly description?: string;
    }>;
  };
  readonly envSelection: {
    readonly requested: string | null;
    readonly default: string | null;
    readonly effective: string | null;
    readonly overlayPath: string | null;
    readonly overlayExists: boolean;
  };
  readonly status: ReturnType<typeof describeEnvAggregateStatusForJson>;
  readonly storage: ReturnType<typeof serializeEnvStorageForJson>;
  readonly values: readonly EnvValueState[];
  readonly missingRequired: readonly string[];
};

type EnvSetBody = {
  readonly project?: string;
  readonly projectId?: string;
  readonly env?: string | null;
  readonly key: string;
  readonly value: string;
  readonly secret?: boolean;
};

type EnvUnsetBody = {
  readonly project?: string;
  readonly projectId?: string;
  readonly env?: string | null;
  readonly key: string;
};

/**
 * Handles env API routes.
 *
 * Routes:
 * - GET /v1/env?project=<name>&project_id=<id> - Get env contract + resolution state (redacted values).
 * - POST /v1/env/set - Set env (.hack/.env) or secret (configured secret backend)
 * - POST /v1/env/unset - Unset env + secret backend entry
 *
 * @returns Response if route matched, null otherwise
 */
export async function handleEnvRoutes(opts: {
  readonly req: Request;
  readonly url: URL;
}): Promise<Response | null> {
  const segments = opts.url.pathname.split("/").filter(Boolean);
  if (segments[0] !== "v1" || segments[1] !== "env") {
    return null;
  }

  if (segments.length === 2 && opts.req.method === "GET") {
    return await handleGetEnv({ url: opts.url });
  }

  if (segments[2] === "set" && opts.req.method === "POST") {
    return await handleSetEnv({ req: opts.req });
  }

  if (segments[2] === "unset" && opts.req.method === "POST") {
    return await handleUnsetEnv({ req: opts.req });
  }

  return jsonResponse({ error: "not_found" }, 404);
}

async function handleGetEnv(opts: { readonly url: URL }): Promise<Response> {
  const projectId = normalizeQueryParam({
    value: opts.url.searchParams.get("project_id"),
  });
  const projectName = normalizeQueryParam({
    value: opts.url.searchParams.get("project"),
  });
  const envName = resolveRequestedEnvName({
    value: opts.url.searchParams.get("env"),
  });
  if (envName === undefined && opts.url.searchParams.has("env")) {
    return jsonResponse({ error: "invalid_env" }, 400);
  }

  const resolvedProject = await resolveProjectFromParams({
    projectId,
    projectName,
  });
  if (!resolvedProject.ok) {
    return jsonResponse({ error: resolvedProject.error }, 400);
  }

  const { project, registration } = resolvedProject.value;
  let resolved: Awaited<ReturnType<typeof resolveHackEnv>>;
  try {
    resolved = await resolveHackEnv({
      projectDir: project.projectDir,
      projectName: registration.name,
      envName,
    });
  } catch (error: unknown) {
    return secretStoreUnavailableResponse({ error });
  }

  const valuesByKey = new Map(resolved.values.map((v) => [v.key, v] as const));
  const contractVars = resolved.contract.vars.map((v) => ({
    key: v.key,
    required: v.required,
    source: v.source,
    services: v.services,
    ...(v.description ? { description: v.description } : {}),
  }));

  const values: EnvValueState[] = [];
  for (const v of resolved.contract.vars) {
    const state = valuesByKey.get(v.key) ?? null;
    values.push({
      key: v.key,
      required: v.required,
      source: v.source,
      services: v.services,
      ...(v.description ? { description: v.description } : {}),
      resolvedFrom: state?.resolvedFrom ?? null,
      hasValue: Boolean(state?.value),
      storage: describeValueStorageForJson({
        value: {
          source: v.source,
          resolvedFrom: state?.resolvedFrom ?? null,
        },
        storage: resolved.storage,
      }),
    });
  }

  const body: EnvGetResponse = {
    project: {
      id: registration.id,
      name: registration.name,
      repoRoot: registration.repoRoot,
      projectDir: registration.projectDir,
    },
    contract: {
      path: resolved.contractPath,
      exists: resolved.contractExists,
      ...(resolved.contractParseError
        ? { parseError: resolved.contractParseError }
        : {}),
      version: resolved.contract.version,
      vars: contractVars,
    },
    envSelection: {
      requested: resolved.envSelection.requestedEnv,
      default: resolved.envSelection.defaultEnv,
      effective: resolved.envSelection.effectiveEnv,
      overlayPath: resolved.envSelection.overlayPath,
      overlayExists: resolved.envSelection.overlayExists,
    },
    status: describeEnvAggregateStatusForJson({
      storage: resolved.storage,
    }),
    storage: serializeEnvStorageForJson({
      storage: resolved.storage,
    }),
    values,
    missingRequired: resolved.missingRequired.map((v) => v.key),
  };

  return jsonResponse(body as unknown as Record<string, unknown>);
}

async function handleSetEnv(opts: {
  readonly req: Request;
}): Promise<Response> {
  const body = await readJsonBody(opts.req);
  if (!body) {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const parsed = parseEnvSetBody(body);
  if (!parsed.ok) {
    return jsonResponse({ error: parsed.error }, 400);
  }

  const resolvedProject = await resolveProjectFromParams({
    projectId: parsed.value.projectId ?? null,
    projectName: parsed.value.project ?? null,
  });
  if (!resolvedProject.ok) {
    return jsonResponse({ error: resolvedProject.error }, 400);
  }

  const { project, registration } = resolvedProject.value;
  const secret = parsed.value.secret === true;
  const sourceValidation = await validateHackEnvMutationSource({
    projectDir: project.projectDir,
    key: parsed.value.key,
    attemptedSource: secret ? "keychain" : "plain_env",
  });
  if (!sourceValidation.ok) {
    if (sourceValidation.kind === "contract_parse_error") {
      return jsonResponse(
        {
          error: "contract_parse_error",
          message: sourceValidation.message,
          contractPath: sourceValidation.contractPath,
          parseError: sourceValidation.parseError,
        },
        409
      );
    }
    return jsonResponse(
      {
        error: "contract_source_mismatch",
        message: sourceValidation.message,
        contractPath: sourceValidation.contractPath,
        expectedSource: sourceValidation.expectedSource,
        attemptedSource: sourceValidation.attemptedSource,
      },
      409
    );
  }

  const runtimeConfig = await readHackEnvRuntimeConfig({
    projectDir: project.projectDir,
  });
  if (secret) {
    let secretStore: Awaited<ReturnType<typeof resolveSecretStore>>;
    try {
      secretStore = await resolveSecretStore({
        projectName: registration.name,
        projectDir: project.projectDir,
      });
    } catch (error: unknown) {
      return secretStoreUnavailableResponse({ error });
    }
    try {
      await secretStore.set({
        key: resolveEnvSecretKey({
          key: parsed.value.key,
          envName: parsed.value.env,
        }),
        value: parsed.value.value,
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Secret backend error";
      return jsonResponse(
        {
          error: "secret_store_error",
          message,
          backend: secretStore.descriptor.backend,
          location: secretStore.descriptor.location,
        },
        500
      );
    }
    return jsonResponse(
      {
        status: "ok",
        stored: secretStore.descriptor.backend,
        location: secretStore.descriptor.location,
      },
      200
    );
  }

  const envFile = resolveEnvFilePath({
    projectDir: project.projectDir,
    envName: parsed.value.env,
  });
  await upsertDotEnvValue({
    envFile,
    key: parsed.value.key,
    value: parsed.value.value,
  });
  if (runtimeConfig.storePlaintextInBackend) {
    let secretStore: Awaited<ReturnType<typeof resolveSecretStore>>;
    try {
      secretStore = await resolveSecretStore({
        projectName: registration.name,
        projectDir: project.projectDir,
      });
    } catch (error: unknown) {
      return secretStoreUnavailableResponse({ error });
    }
    try {
      await secretStore.set({
        key: resolveEnvSecretKey({
          key: parsed.value.key,
          envName: parsed.value.env,
        }),
        value: parsed.value.value,
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Secret backend error";
      return jsonResponse(
        {
          error: "secret_store_error",
          message,
          backend: secretStore.descriptor.backend,
          location: secretStore.descriptor.location,
        },
        500
      );
    }
  }
  return jsonResponse({ status: "ok", stored: "dotenv" }, 200);
}

async function handleUnsetEnv(opts: {
  readonly req: Request;
}): Promise<Response> {
  const body = await readJsonBody(opts.req);
  if (!body) {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const parsed = parseEnvUnsetBody(body);
  if (!parsed.ok) {
    return jsonResponse({ error: parsed.error }, 400);
  }

  const resolvedProject = await resolveProjectFromParams({
    projectId: parsed.value.projectId ?? null,
    projectName: parsed.value.project ?? null,
  });
  if (!resolvedProject.ok) {
    return jsonResponse({ error: resolvedProject.error }, 400);
  }

  const { project, registration } = resolvedProject.value;
  let secretStore: Awaited<ReturnType<typeof resolveSecretStore>>;
  try {
    secretStore = await resolveSecretStore({
      projectName: registration.name,
      projectDir: project.projectDir,
    });
  } catch (error: unknown) {
    return secretStoreUnavailableResponse({ error });
  }

  const envFile = resolveEnvFilePath({
    projectDir: project.projectDir,
    envName: parsed.value.env,
  });
  const dotenvResult = await removeDotEnvKey({
    envFile,
    key: parsed.value.key,
  });
  let secretDeleted: boolean | null = null;
  try {
    secretDeleted = await secretStore.delete({
      key: resolveEnvSecretKey({
        key: parsed.value.key,
        envName: parsed.value.env,
      }),
    });
  } catch {
    secretDeleted = null;
  }

  return jsonResponse(
    {
      status: "ok",
      dotenvChanged: dotenvResult.changed,
      secretDeleted,
      backend: secretStore.descriptor.backend,
      location: secretStore.descriptor.location,
    },
    200
  );
}

async function resolveProjectFromParams(opts: {
  readonly projectId: string | null;
  readonly projectName: string | null;
}): Promise<
  ParseResult<{
    readonly project: NonNullable<
      Awaited<ReturnType<typeof resolveRegisteredProjectByName>>
    >;
    readonly registration: RegisteredProject;
  }>
> {
  if (opts.projectId) {
    const byId = await resolveRegisteredProjectById({ id: opts.projectId });
    if (!byId) {
      return { ok: false, error: "project_not_found" };
    }
    return { ok: true, value: byId };
  }

  const name = opts.projectName?.trim() ?? "";
  if (name.length === 0) {
    return { ok: false, error: "missing_project" };
  }

  const registry = await readProjectsRegistry();
  const registration = registry.projects.find((p) => p.name === name) ?? null;
  if (!registration) {
    return { ok: false, error: "project_not_found" };
  }

  const project = await resolveRegisteredProjectByName({ name });
  if (!project) {
    return { ok: false, error: "project_not_found" };
  }

  return { ok: true, value: { project, registration } };
}

function parseEnvSetBody(
  body: Record<string, unknown>
): ParseResult<EnvSetBody> {
  const key = body.key;
  const value = body.value;
  if (typeof key !== "string" || key.trim().length === 0) {
    return { ok: false, error: "missing_key" };
  }
  const trimmedKey = key.trim();
  if (!ENV_KEY_PATTERN.test(trimmedKey)) {
    return { ok: false, error: "invalid_key" };
  }
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, error: "missing_value" };
  }

  const project =
    typeof body.project === "string" ? body.project.trim() : undefined;
  const projectId =
    typeof body.projectId === "string" ? body.projectId.trim() : undefined;
  const env = resolveRequestedEnvName({
    value: typeof body.env === "string" ? body.env : null,
  });
  if (typeof body.env === "string" && env === undefined) {
    return { ok: false, error: "invalid_env" };
  }
  const secret = body.secret === true ? true : undefined;

  return {
    ok: true,
    value: {
      ...(project && project.length > 0 ? { project } : {}),
      ...(projectId && projectId.length > 0 ? { projectId } : {}),
      ...(env !== undefined ? { env } : {}),
      key: trimmedKey,
      value,
      ...(secret ? { secret } : {}),
    },
  };
}

function parseEnvUnsetBody(
  body: Record<string, unknown>
): ParseResult<EnvUnsetBody> {
  const key = body.key;
  if (typeof key !== "string" || key.trim().length === 0) {
    return { ok: false, error: "missing_key" };
  }
  const trimmedKey = key.trim();
  if (!ENV_KEY_PATTERN.test(trimmedKey)) {
    return { ok: false, error: "invalid_key" };
  }

  const project =
    typeof body.project === "string" ? body.project.trim() : undefined;
  const projectId =
    typeof body.projectId === "string" ? body.projectId.trim() : undefined;
  const env = resolveRequestedEnvName({
    value: typeof body.env === "string" ? body.env : null,
  });
  if (typeof body.env === "string" && env === undefined) {
    return { ok: false, error: "invalid_env" };
  }

  return {
    ok: true,
    value: {
      ...(project && project.length > 0 ? { project } : {}),
      ...(projectId && projectId.length > 0 ? { projectId } : {}),
      ...(env !== undefined ? { env } : {}),
      key: trimmedKey,
    },
  };
}

function resolveRequestedEnvName(opts: {
  readonly value: string | null;
}): string | null | undefined {
  if (opts.value === null) {
    return undefined;
  }
  return parseEnvConfigSelection(opts.value);
}

function normalizeQueryParam(opts: {
  readonly value: string | null;
}): string | null {
  const trimmed = (opts.value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function readJsonBody(
  req: Request
): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await req.json();
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  const payload = JSON.stringify(body, null, 2);
  return new Response(payload, {
    status,
    headers: {
      "content-type": "application/json",
      "content-length": `${Buffer.byteLength(payload)}`,
    },
  });
}

function secretStoreUnavailableResponse(input: {
  readonly error: unknown;
}): Response {
  const message =
    input.error instanceof Error
      ? input.error.message
      : "Secret backend is unavailable.";
  return jsonResponse(
    {
      error: "secret_store_unavailable",
      message,
    },
    503
  );
}
