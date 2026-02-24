import { resolve } from "node:path";
import { confirm, isCancel, password, text } from "@clack/prompts";

import { secrets } from "bun";
import type { CliContext, CommandHandlerFor } from "../cli/command.ts";
import {
  CliUsageError,
  defineCommand,
  defineOption,
  withHandler,
} from "../cli/command.ts";
import { optJson, optPath, optProject } from "../cli/options.ts";
import { PROJECT_ENV_FILENAME } from "../constants.ts";
import {
  removeDotEnvKey,
  resolveHackEnv,
  resolveKeychainServiceName,
  upsertDotEnvValue,
} from "../lib/hack-env.ts";
import type { ProjectContext } from "../lib/project.ts";
import {
  defaultProjectSlugFromPath,
  findProjectContext,
  readProjectConfig,
  sanitizeProjectSlug,
} from "../lib/project.ts";
import { resolveRegisteredProjectByName } from "../lib/projects-registry.ts";
import { logger } from "../ui/logger.ts";

const optShowSecrets = defineOption({
  name: "showSecrets",
  type: "boolean",
  long: "--show-secrets",
  description: "Print secret values (keychain) in plaintext",
} as const);

const optSecret = defineOption({
  name: "secret",
  type: "boolean",
  long: "--secret",
  description: "Store value in OS keychain (Bun.secrets) instead of .hack/.env",
} as const);

const listSpec = defineCommand({
  name: "list",
  summary: "List env contract vars and resolution state",
  group: "Project",
  options: [optPath, optProject, optJson, optShowSecrets],
  positionals: [],
  subcommands: [],
} as const);

const setSpec = defineCommand({
  name: "set",
  summary: "Set an env value (.hack/.env or keychain)",
  group: "Project",
  options: [optPath, optProject, optSecret],
  positionals: [{ name: "spec", required: false }],
  subcommands: [],
} as const);

const unsetSpec = defineCommand({
  name: "unset",
  summary: "Unset an env value (.hack/.env and keychain)",
  group: "Project",
  options: [optPath, optProject],
  positionals: [{ name: "key", required: false }],
  subcommands: [],
} as const);

const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

async function resolveProjectForEnv(opts: {
  readonly ctx: CliContext;
  readonly pathOpt: string | undefined;
  readonly projectOpt: string | undefined;
}): Promise<ProjectContext> {
  if (opts.pathOpt && opts.projectOpt) {
    throw new CliUsageError("Use either --path or --project (not both).");
  }

  if (opts.projectOpt) {
    const name = sanitizeProjectSlug(opts.projectOpt);
    if (!name) {
      throw new CliUsageError("Invalid --project value.");
    }
    const project = await resolveRegisteredProjectByName({ name });
    if (!project) {
      throw new CliUsageError(
        `Unknown project "${name}". Run 'hack init' in that repo (or run 'hack projects' to see registered projects).`
      );
    }
    return project;
  }

  const startDir = opts.pathOpt
    ? resolve(opts.ctx.cwd, opts.pathOpt)
    : opts.ctx.cwd;
  const project = await findProjectContext(startDir);
  if (!project) {
    throw new CliUsageError("No .hack/ found. Run: hack init");
  }
  return project;
}

async function resolveProjectName(project: ProjectContext): Promise<string> {
  const cfg = await readProjectConfig(project);
  const derived = defaultProjectSlugFromPath(project.projectRoot);
  const raw = (cfg.name ?? derived).trim();
  return sanitizeProjectSlug(raw.length > 0 ? raw : derived);
}

const handleEnvList: CommandHandlerFor<typeof listSpec> = async ({
  ctx,
  args,
}): Promise<number> => {
  const project = await resolveProjectForEnv({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
  });
  const projectName = await resolveProjectName(project);
  const showSecrets = args.options.showSecrets === true;
  const json = args.options.json === true;

  const resolved = await resolveHackEnv({
    projectDir: project.projectDir,
    projectName,
  });

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          project: projectName,
          vars: resolved.values.map((v) => ({
            key: v.key,
            required: v.required,
            source: v.source,
            services: v.services,
            resolved_from: v.resolvedFrom,
            value:
              v.source === "keychain" && !showSecrets && v.value !== null
                ? "***"
                : v.value,
          })),
          missing_required: resolved.missingRequired.map((v) => v.key),
        },
        null,
        2
      )}\n`
    );
    return resolved.missingRequired.length > 0 ? 1 : 0;
  }

  if (resolved.contract.vars.length === 0) {
    logger.info({
      message: `No ${project.projectDir}/hack.env.json contract found (or it has no vars).`,
    });
    return 0;
  }

  for (const v of resolved.values) {
    const value =
      v.source === "keychain" && !showSecrets && v.value !== null
        ? "***"
        : (v.value ?? "");
    const required = v.required ? "required" : "optional";
    const from = v.resolvedFrom ?? "missing";
    const services = v.services ? v.services.join(",") : "*";
    process.stdout.write(
      `${v.key}\t${required}\t${v.source}\t${from}\t${services}\t${value}\n`
    );
  }

  if (resolved.missingRequired.length > 0) {
    logger.warn({
      message: `Missing required env: ${resolved.missingRequired.map((v) => v.key).join(", ")}`,
    });
    return 1;
  }

  return 0;
};

const handleEnvSet: CommandHandlerFor<typeof setSpec> = async ({
  ctx,
  args,
}): Promise<number> => {
  const project = await resolveProjectForEnv({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
  });
  const projectName = await resolveProjectName(project);
  const service = resolveKeychainServiceName({ projectName });
  const storeInKeychain = args.options.secret === true;

  const spec = (args.positionals.spec ?? "").trim();
  const [keyFromSpec, valueFromSpec] = parseKeyValueSpec(spec);

  const key = await resolveEnvKey({ key: keyFromSpec });
  const value = await resolveEnvValue({
    key,
    value: valueFromSpec,
    secret: storeInKeychain,
  });

  if (storeInKeychain) {
    await secrets.set({ service, name: key, value });
    logger.success({
      message: `Stored secret "${key}" in keychain (${service})`,
    });
    return 0;
  }

  const envFile = resolve(project.projectDir, PROJECT_ENV_FILENAME);
  const result = await upsertDotEnvValue({ envFile, key, value });
  logger.success({
    message: result.changed ? `Updated ${envFile}` : "No changes needed.",
  });
  return 0;
};

const handleEnvUnset: CommandHandlerFor<typeof unsetSpec> = async ({
  ctx,
  args,
}): Promise<number> => {
  const project = await resolveProjectForEnv({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
  });
  const projectName = await resolveProjectName(project);
  const service = resolveKeychainServiceName({ projectName });

  const key = await resolveEnvKey({ key: (args.positionals.key ?? "").trim() });

  const ok = await confirm({
    message: `Unset "${key}" from ${project.projectDir}/.env and keychain (${service})?`,
    initialValue: true,
  });
  if (isCancel(ok)) {
    return 1;
  }
  if (!ok) {
    return 0;
  }

  const envFile = resolve(project.projectDir, PROJECT_ENV_FILENAME);
  const [dotenvResult, keychainDeleted] = await Promise.all([
    removeDotEnvKey({ envFile, key }),
    secrets.delete({ service, name: key }),
  ]);

  logger.success({
    message: [
      dotenvResult.changed ? `Updated ${envFile}` : `No ${key} in ${envFile}`,
      keychainDeleted
        ? `Deleted from keychain (${service})`
        : "No keychain entry",
    ].join(" • "),
  });
  return 0;
};

function parseKeyValueSpec(spec: string): readonly [string, string | null] {
  const trimmed = spec.trim();
  if (trimmed.length === 0) {
    return ["", null];
  }

  const idx = trimmed.indexOf("=");
  if (idx === -1) {
    return [trimmed, null];
  }

  const key = trimmed.slice(0, idx).trim();
  const value = trimmed.slice(idx + 1);
  return [key, value];
}

async function resolveEnvKey(opts: { readonly key: string }): Promise<string> {
  const fromPos = opts.key.trim();
  if (fromPos.length > 0) {
    if (!ENV_KEY_PATTERN.test(fromPos)) {
      throw new CliUsageError(`Invalid env key: ${fromPos}`);
    }
    return fromPos;
  }

  const key = await text({
    message: "Env key:",
    validate: (value) => {
      const v = value?.trim();
      if (!v) {
        return "Required";
      }
      if (!ENV_KEY_PATTERN.test(v)) {
        return "Use uppercase snake-case (e.g. AWS_PROFILE)";
      }
      return undefined;
    },
  });
  if (isCancel(key)) {
    throw new Error("Canceled");
  }
  return key.trim();
}

async function resolveEnvValue(opts: {
  readonly key: string;
  readonly value: string | null;
  readonly secret: boolean;
}): Promise<string> {
  const fromSpec = opts.value;
  if (typeof fromSpec === "string" && fromSpec.length > 0) {
    return fromSpec;
  }

  if (opts.secret) {
    const v = await password({
      message: `Value for secret "${opts.key}":`,
      validate: (value) =>
        !value || value.length === 0 ? "Required" : undefined,
    });
    if (isCancel(v)) {
      throw new Error("Canceled");
    }
    return v;
  }

  const v = await text({
    message: `Value for "${opts.key}":`,
    validate: (value) =>
      !value || value.length === 0 ? "Required" : undefined,
  });
  if (isCancel(v)) {
    throw new Error("Canceled");
  }
  return v;
}

export const envCommand = defineCommand({
  name: "env",
  summary: "Manage project environment variables and secrets",
  group: "Project",
  expandInRootHelp: true,
  options: [],
  positionals: [],
  subcommands: [
    withHandler(listSpec, handleEnvList),
    withHandler(setSpec, handleEnvSet),
    withHandler(unsetSpec, handleEnvUnset),
  ],
} as const);
