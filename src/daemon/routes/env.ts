import { resolve } from "node:path";
import { secrets } from "bun";

import { PROJECT_ENV_FILENAME } from "../../constants.ts";
import { isRecord } from "../../lib/guards.ts";
import {
  removeDotEnvKey,
  resolveHackEnv,
  resolveKeychainServiceName,
  upsertDotEnvValue,
} from "../../lib/hack-env.ts";
import type { RegisteredProject } from "../../lib/projects-registry.ts";
import {
  readProjectsRegistry,
  resolveRegisteredProjectById,
  resolveRegisteredProjectByName,
} from "../../lib/projects-registry.ts";

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
  readonly resolvedFrom: "dotenv" | "process" | "keychain" | null;
  readonly hasValue: boolean;
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
  readonly values: readonly EnvValueState[];
  readonly missingRequired: readonly string[];
};

type EnvSetBody = {
  readonly project?: string;
  readonly projectId?: string;
  readonly key: string;
  readonly value: string;
  readonly secret?: boolean;
};

type EnvUnsetBody = {
  readonly project?: string;
  readonly projectId?: string;
  readonly key: string;
};

/**
 * Handles env API routes.
 *
 * Routes:
 * - GET /v1/env?project=<name>&project_id=<id> - Get env contract + resolution state (redacted values).
 * - POST /v1/env/set - Set env (.hack/.env) or secret (keychain)
 * - POST /v1/env/unset - Unset env + keychain entry
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

  const resolvedProject = await resolveProjectFromParams({
    projectId,
    projectName,
  });
  if (!resolvedProject.ok) {
    return jsonResponse({ error: resolvedProject.error }, 400);
  }

  const { project, registration } = resolvedProject.value;
  const resolved = await resolveHackEnv({
    projectDir: project.projectDir,
    projectName: registration.name,
  });

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
  const keychainService = resolveKeychainServiceName({
    projectName: registration.name,
  });

  const secret = parsed.value.secret === true;
  if (secret) {
    try {
      await secrets.set({
        service: keychainService,
        name: parsed.value.key,
        value: parsed.value.value,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Keychain error";
      return jsonResponse(
        { error: "keychain_error", message, service: keychainService },
        500
      );
    }
    return jsonResponse({ status: "ok", stored: "keychain" }, 200);
  }

  const envFile = resolve(project.projectDir, PROJECT_ENV_FILENAME);
  await upsertDotEnvValue({
    envFile,
    key: parsed.value.key,
    value: parsed.value.value,
  });
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
  const keychainService = resolveKeychainServiceName({
    projectName: registration.name,
  });

  const envFile = resolve(project.projectDir, PROJECT_ENV_FILENAME);
  const dotenvResult = await removeDotEnvKey({
    envFile,
    key: parsed.value.key,
  });
  let keychainDeleted: boolean | null = null;
  try {
    keychainDeleted = await secrets.delete({
      service: keychainService,
      name: parsed.value.key,
    });
  } catch {
    keychainDeleted = null;
  }

  return jsonResponse(
    {
      status: "ok",
      dotenvChanged: dotenvResult.changed,
      keychainDeleted,
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
  const secret = body.secret === true ? true : undefined;

  return {
    ok: true,
    value: {
      ...(project && project.length > 0 ? { project } : {}),
      ...(projectId && projectId.length > 0 ? { projectId } : {}),
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

  return {
    ok: true,
    value: {
      ...(project && project.length > 0 ? { project } : {}),
      ...(projectId && projectId.length > 0 ? { projectId } : {}),
      key: trimmedKey,
    },
  };
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
