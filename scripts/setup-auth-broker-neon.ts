#!/usr/bin/env bun

import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { parseDotEnv } from "../src/lib/env.ts";
import { getString, isRecord } from "../src/lib/guards.ts";
import { upsertDotEnvValue } from "../src/lib/hack-env.ts";

type ScriptArgs = {
  readonly neonProject: string;
  readonly neonBranch: string | null;
  readonly neonRole: string | null;
  readonly neonDatabase: string | null;
  readonly neonPooled: boolean;
  readonly localEnvFile: string;
  readonly skipLocal: boolean;
  readonly skipRailway: boolean;
  readonly railwayProject: string;
  readonly railwayService: string;
  readonly railwayEnvironment: string;
  readonly railwayWorkspace: string | null;
  readonly createRailwayService: boolean;
  readonly betterAuthSecret: string | null;
  readonly dryRun: boolean;
  readonly json: boolean;
};

type ParseOk = {
  readonly ok: true;
  readonly args: ScriptArgs;
};

type ParseErr = {
  readonly ok: false;
  readonly message: string;
  readonly exitCode: number;
};

type ParseResult = ParseOk | ParseErr;

type ArgsDraft = {
  neonProject: string;
  neonBranch: string | null;
  neonRole: string | null;
  neonDatabase: string | null;
  neonPooled: boolean;
  localEnvFile: string;
  skipLocal: boolean;
  skipRailway: boolean;
  railwayProject: string;
  railwayService: string;
  railwayEnvironment: string;
  railwayWorkspace: string | null;
  createRailwayService: boolean;
  betterAuthSecret: string | null;
  dryRun: boolean;
  json: boolean;
};

type FlagHandler = {
  readonly prefix: string;
  readonly apply: (input: {
    readonly draft: ArgsDraft;
    readonly arg: string;
  }) => void;
};

type CommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

type NeonProjectEntry = {
  readonly id: string;
  readonly name: string;
};

type NeonConnectionInfo = {
  readonly connectionString: string;
  readonly host: string | null;
  readonly role: string | null;
  readonly database: string | null;
};

type BetterAuthSecretResolution = {
  readonly value: string;
  readonly source: "arg" | "env" | "local-file" | "generated";
};

type RailwayApplyResult = {
  readonly linked: boolean;
  readonly createdService: boolean;
  readonly appliedKeys: readonly string[];
  readonly redeployAttempted: boolean;
  readonly redeploySucceeded: boolean;
};

const DEFAULT_LOCAL_ENV_FILE = "services/auth-broker/.env.local";
const DEFAULT_RAILWAY_PROJECT = "hack";
const DEFAULT_RAILWAY_SERVICE = "auth-broker";
const DEFAULT_RAILWAY_ENVIRONMENT = "production";

const BOOLEAN_FLAG_APPLIERS: Readonly<
  Record<string, (input: { readonly draft: ArgsDraft }) => void>
> = {
  "--neon-pooled": ({ draft }) => {
    draft.neonPooled = true;
  },
  "--skip-local": ({ draft }) => {
    draft.skipLocal = true;
  },
  "--skip-railway": ({ draft }) => {
    draft.skipRailway = true;
  },
  "--create-railway-service": ({ draft }) => {
    draft.createRailwayService = true;
  },
  "--dry-run": ({ draft }) => {
    draft.dryRun = true;
  },
  "--json": ({ draft }) => {
    draft.json = true;
  },
};

const PREFIX_FLAG_HANDLERS: readonly FlagHandler[] = [
  {
    prefix: "--neon-project=",
    apply: ({ draft, arg }) => {
      draft.neonProject = parseStringFlagValue({
        arg,
        prefix: "--neon-project=",
      });
    },
  },
  {
    prefix: "--neon-branch=",
    apply: ({ draft, arg }) => {
      draft.neonBranch = parseOptionalStringFlagValue({
        arg,
        prefix: "--neon-branch=",
      });
    },
  },
  {
    prefix: "--neon-role=",
    apply: ({ draft, arg }) => {
      draft.neonRole = parseOptionalStringFlagValue({
        arg,
        prefix: "--neon-role=",
      });
    },
  },
  {
    prefix: "--neon-database=",
    apply: ({ draft, arg }) => {
      draft.neonDatabase = parseOptionalStringFlagValue({
        arg,
        prefix: "--neon-database=",
      });
    },
  },
  {
    prefix: "--local-env-file=",
    apply: ({ draft, arg }) => {
      draft.localEnvFile = parseStringFlagValue({
        arg,
        prefix: "--local-env-file=",
      });
    },
  },
  {
    prefix: "--railway-project=",
    apply: ({ draft, arg }) => {
      draft.railwayProject = parseStringFlagValue({
        arg,
        prefix: "--railway-project=",
      });
    },
  },
  {
    prefix: "--railway-service=",
    apply: ({ draft, arg }) => {
      draft.railwayService = parseStringFlagValue({
        arg,
        prefix: "--railway-service=",
      });
    },
  },
  {
    prefix: "--railway-environment=",
    apply: ({ draft, arg }) => {
      draft.railwayEnvironment = parseStringFlagValue({
        arg,
        prefix: "--railway-environment=",
      });
    },
  },
  {
    prefix: "--railway-workspace=",
    apply: ({ draft, arg }) => {
      draft.railwayWorkspace = parseOptionalStringFlagValue({
        arg,
        prefix: "--railway-workspace=",
      });
    },
  },
  {
    prefix: "--better-auth-secret=",
    apply: ({ draft, arg }) => {
      draft.betterAuthSecret = parseOptionalStringFlagValue({
        arg,
        prefix: "--better-auth-secret=",
      });
    },
  },
] as const;

if (import.meta.main) {
  const parsed = parseArgs({ argv: Bun.argv.slice(2) });
  if (parsed.ok) {
    process.exitCode = await main({ args: parsed.args });
  } else {
    const writer = parsed.exitCode === 0 ? process.stdout : process.stderr;
    writer.write(`${parsed.message}\n`);
    process.exitCode = parsed.exitCode;
  }
}

/**
 * Entry point for one-time auth-broker Neon credential provisioning.
 */
async function main({ args }: { readonly args: ScriptArgs }): Promise<number> {
  if (args.skipLocal && args.skipRailway) {
    process.stderr.write(
      "Both --skip-local and --skip-railway are set; there is nothing to do.\n"
    );
    return 1;
  }

  const repoRoot = resolve(import.meta.dir, "..");
  const localEnvFile = resolve(repoRoot, args.localEnvFile);
  const existingLocalEnv = await readDotEnvFile({ filePath: localEnvFile });

  const neonProject = await resolveNeonProject({
    selector: args.neonProject,
  });
  if (!neonProject.ok) {
    process.stderr.write(`${neonProject.error}\n`);
    return 1;
  }

  const neonConnection = await fetchNeonConnectionString({
    projectId: neonProject.project.id,
    branch: args.neonBranch,
    roleName: args.neonRole,
    databaseName: args.neonDatabase,
    pooled: args.neonPooled,
  });
  if (!neonConnection.ok) {
    process.stderr.write(`${neonConnection.error}\n`);
    return 1;
  }

  const betterAuthSecret = resolveBetterAuthSecret({
    explicit: args.betterAuthSecret,
    envValue: process.env.BETTER_AUTH_SECRET,
    localValue: existingLocalEnv.BETTER_AUTH_SECRET,
  });

  const valuesToApply: Readonly<Record<string, string>> = {
    DATABASE_URL: neonConnection.info.connectionString,
    NEON_PROJECT_ID: neonProject.project.id,
    BETTER_AUTH_SECRET: betterAuthSecret.value,
  };

  let localChangedKeys: readonly string[] = [];
  if (!args.skipLocal) {
    const localWrite = await applyLocalEnvValues({
      envFile: localEnvFile,
      values: valuesToApply,
      dryRun: args.dryRun,
    });
    if (!localWrite.ok) {
      process.stderr.write(`${localWrite.error}\n`);
      return 1;
    }
    localChangedKeys = localWrite.changedKeys;
  }

  let railwayResult: RailwayApplyResult = {
    linked: false,
    createdService: false,
    appliedKeys: [],
    redeployAttempted: false,
    redeploySucceeded: false,
  };
  if (!args.skipRailway) {
    const railwayApply = await applyRailwayVariables({
      project: args.railwayProject,
      service: args.railwayService,
      environment: args.railwayEnvironment,
      workspace: args.railwayWorkspace,
      createService: args.createRailwayService,
      values: valuesToApply,
      dryRun: args.dryRun,
    });
    if (!railwayApply.ok) {
      process.stderr.write(`${railwayApply.error}\n`);
      return 1;
    }
    railwayResult = railwayApply.result;
  }

  const output = {
    ok: true,
    neon: {
      projectId: neonProject.project.id,
      projectName: neonProject.project.name,
      host: neonConnection.info.host,
      role: neonConnection.info.role,
      database: neonConnection.info.database,
    },
    local: {
      skipped: args.skipLocal,
      envFile: localEnvFile,
      changedKeys: localChangedKeys,
    },
    railway: {
      skipped: args.skipRailway,
      project: args.railwayProject,
      service: args.railwayService,
      environment: args.railwayEnvironment,
      workspace: args.railwayWorkspace,
      linked: railwayResult.linked,
      createdService: railwayResult.createdService,
      appliedKeys: railwayResult.appliedKeys,
      redeployAttempted: railwayResult.redeployAttempted,
      redeploySucceeded: railwayResult.redeploySucceeded,
    },
    betterAuthSecret: {
      source: betterAuthSecret.source,
    },
    dryRun: args.dryRun,
  } as const;

  if (args.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(
    [
      "Auth broker bootstrap complete.",
      `- Neon project: ${neonProject.project.name} (${neonProject.project.id})`,
      `- Neon host: ${neonConnection.info.host ?? "unknown"}`,
      `- Better Auth secret source: ${betterAuthSecret.source}`,
      args.skipLocal
        ? "- Local env: skipped"
        : `- Local env: ${localEnvFile} (${renderKeySummary({
            keys: localChangedKeys,
            emptyLabel: "no key changes",
          })})`,
      args.skipRailway
        ? "- Railway: skipped"
        : `- Railway ${args.railwayProject}/${args.railwayService}@${args.railwayEnvironment} (${renderKeySummary(
            {
              keys: railwayResult.appliedKeys,
              emptyLabel: args.dryRun ? "dry-run only" : "no key changes",
            }
          )})`,
      args.dryRun ? "- Mode: dry-run (no writes performed)" : "- Mode: apply",
      "",
      "Secrets were written without printing values.",
    ].join("\n")
  );

  return 0;
}

/**
 * Parse script flags for Neon + auth-broker setup.
 */
function parseArgs({
  argv,
}: {
  readonly argv: readonly string[];
}): ParseResult {
  const draft = createDefaultArgsDraft();

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      return {
        ok: false,
        exitCode: 0,
        message: renderHelp(),
      };
    }
    const booleanApplier = BOOLEAN_FLAG_APPLIERS[arg];
    if (booleanApplier) {
      booleanApplier({ draft });
      continue;
    }
    const prefixedApplied = applyPrefixedFlag({ draft, arg });
    if (prefixedApplied) {
      continue;
    }

    return {
      ok: false,
      exitCode: 1,
      message: `Unknown flag: ${arg}`,
    };
  }

  if (!draft.neonProject) {
    return {
      ok: false,
      exitCode: 1,
      message: "Missing required flag: --neon-project=<id|name>",
    };
  }

  return {
    ok: true,
    args: {
      neonProject: draft.neonProject,
      neonBranch: draft.neonBranch,
      neonRole: draft.neonRole,
      neonDatabase: draft.neonDatabase,
      neonPooled: draft.neonPooled,
      localEnvFile: draft.localEnvFile,
      skipLocal: draft.skipLocal,
      skipRailway: draft.skipRailway,
      railwayProject: draft.railwayProject,
      railwayService: draft.railwayService,
      railwayEnvironment: draft.railwayEnvironment,
      railwayWorkspace: draft.railwayWorkspace,
      createRailwayService: draft.createRailwayService,
      betterAuthSecret: draft.betterAuthSecret,
      dryRun: draft.dryRun,
      json: draft.json,
    },
  };
}

/**
 * Resolve a Neon project by ID or exact name.
 */
async function resolveNeonProject({
  selector,
}: {
  readonly selector: string;
}): Promise<
  | { readonly ok: true; readonly project: NeonProjectEntry }
  | { readonly ok: false; readonly error: string }
> {
  const list = await runCommand({
    cmd: [
      "bunx",
      "neonctl",
      "projects",
      "list",
      "--org-id",
      "org-sparkling-brook-90879554",
      "--output",
      "json",
    ],
  });
  if (list.exitCode !== 0) {
    const detail = firstNonEmptyLine({ value: list.stderr || list.stdout });
    return {
      ok: false,
      error: `Failed to query Neon projects: ${detail ?? `exit ${list.exitCode}`}`,
    };
  }

  const parsed = parseJsonOutput({ text: list.stdout });
  if (!parsed.ok) {
    return {
      ok: false,
      error: `Neon projects output was not valid JSON: ${parsed.error}`,
    };
  }

  const projects = parsed.value as { id: string; name: string }[];
  if (projects.length === 0) {
    return {
      ok: false,
      error: `No Neon projects were returned by neonctl. ${JSON.stringify(parsed, null, 2)}`,
    };
  }

  const normalizedSelector = selector.trim();
  const byId = projects.find((project) => project.id === normalizedSelector);
  if (byId) {
    return { ok: true, project: byId };
  }

  const byName = projects.filter(
    (project) => project.name.toLowerCase() === normalizedSelector.toLowerCase()
  );
  if (byName.length === 1) {
    const [singleMatch] = byName;
    if (singleMatch) {
      return { ok: true, project: singleMatch };
    }
  }
  if (byName.length > 1) {
    return {
      ok: false,
      error: `Neon project name "${selector}" is ambiguous. Use an id instead: ${byName
        .map((project) => `${project.name} (${project.id})`)
        .join(", ")}`,
    };
  }

  return {
    ok: false,
    error: `Neon project "${selector}" was not found. Available projects: ${projects
      .map((project) => `${project.name} (${project.id})`)
      .join(", ")}`,
  };
}

/**
 * Query Neon for the broker DB connection string and metadata.
 */
async function fetchNeonConnectionString(input: {
  readonly projectId: string;
  readonly branch: string | null;
  readonly roleName: string | null;
  readonly databaseName: string | null;
  readonly pooled: boolean;
}): Promise<
  | { readonly ok: true; readonly info: NeonConnectionInfo }
  | { readonly ok: false; readonly error: string }
> {
  const args = [
    "bunx",
    "neonctl",
    "connection-string",
    ...(input.branch ? [input.branch] : []),
    "--project-id",
    input.projectId,
    "--org-id",
    "org-sparkling-brook-90879554",
    "--extended",
    "--output",
    "json",
    ...(input.roleName ? ["--role-name", input.roleName] : []),
    ...(input.databaseName ? ["--database-name", input.databaseName] : []),
    ...(input.pooled ? ["--pooled"] : []),
  ];
  const result = await runCommand({ cmd: args });
  if (result.exitCode !== 0) {
    const detail = firstNonEmptyLine({ value: result.stderr || result.stdout });
    return {
      ok: false,
      error: `Failed to read Neon connection string: ${detail ?? `exit ${result.exitCode}`}`,
    };
  }

  const parsed = parseJsonOutput({ text: result.stdout });
  if (!parsed.ok) {
    return {
      ok: false,
      error: `Neon connection-string output was not valid JSON: ${parsed.error}`,
    };
  }

  const info = parseNeonConnectionInfo({ value: parsed.value });
  if (!info) {
    return {
      ok: false,
      error:
        "Neon connection-string output did not include a usable connection string.",
    };
  }

  return {
    ok: true,
    info,
  };
}

/**
 * Persist broker secrets into local `.env.local`.
 */
async function applyLocalEnvValues(input: {
  readonly envFile: string;
  readonly values: Readonly<Record<string, string>>;
  readonly dryRun: boolean;
}): Promise<
  | { readonly ok: true; readonly changedKeys: readonly string[] }
  | { readonly ok: false; readonly error: string }
> {
  if (input.dryRun) {
    return {
      ok: true,
      changedKeys: Object.keys(input.values).sort((a, b) => a.localeCompare(b)),
    };
  }

  const changedKeys: string[] = [];
  for (const [key, value] of Object.entries(input.values)) {
    const write = await upsertDotEnvValue({
      envFile: input.envFile,
      key,
      value,
    });
    if (write.changed) {
      changedKeys.push(key);
    }
  }
  return {
    ok: true,
    changedKeys,
  };
}

/**
 * Link Railway context, optionally create service, and set broker variables.
 */
async function applyRailwayVariables(input: {
  readonly project: string;
  readonly service: string;
  readonly environment: string;
  readonly workspace: string | null;
  readonly createService: boolean;
  readonly values: Readonly<Record<string, string>>;
  readonly dryRun: boolean;
}): Promise<
  | { readonly ok: true; readonly result: RailwayApplyResult }
  | { readonly ok: false; readonly error: string }
> {
  if (!Bun.which("railway")) {
    return {
      ok: false,
      error: "Railway CLI was not found in PATH.",
    };
  }

  if (input.dryRun) {
    return {
      ok: true,
      result: {
        linked: false,
        createdService: false,
        appliedKeys: Object.keys(input.values).sort((a, b) =>
          a.localeCompare(b)
        ),
        redeployAttempted: false,
        redeploySucceeded: false,
      },
    };
  }

  const tempDir = await mkdtemp(resolve(tmpdir(), "hack-auth-broker-"));
  try {
    const link = await runCommand({
      cmd: [
        "railway",
        "link",
        "--project",
        input.project,
        "--environment",
        input.environment,
        ...(input.workspace ? ["--workspace", input.workspace] : []),
        "--json",
      ],
      cwd: tempDir,
    });
    if (link.exitCode !== 0) {
      const detail = firstNonEmptyLine({ value: link.stderr || link.stdout });
      return {
        ok: false,
        error: `Railway link failed: ${detail ?? `exit ${link.exitCode}`}`,
      };
    }

    let createdService = false;
    if (input.createService) {
      const create = await runCommand({
        cmd: ["railway", "add", "--service", input.service, "--json"],
        cwd: tempDir,
      });
      if (create.exitCode !== 0) {
        const detail = firstNonEmptyLine({
          value: create.stderr || create.stdout,
        });
        return {
          ok: false,
          error: `Railway service creation failed: ${detail ?? `exit ${create.exitCode}`}`,
        };
      }
      createdService = true;
    }

    const keys = Object.keys(input.values).sort((a, b) => a.localeCompare(b));
    for (const key of keys) {
      const value = input.values[key];
      const set = await runCommand({
        cmd: [
          "railway",
          "variable",
          "set",
          "--service",
          input.service,
          "--environment",
          input.environment,
          "--skip-deploys",
          "--stdin",
          key,
        ],
        cwd: tempDir,
        stdinText: value,
      });
      if (set.exitCode !== 0) {
        const detail = firstNonEmptyLine({ value: set.stderr || set.stdout });
        return {
          ok: false,
          error: `Failed to set Railway variable ${key}: ${detail ?? `exit ${set.exitCode}`}`,
        };
      }
    }

    const redeploy = await runCommand({
      cmd: [
        "railway",
        "service",
        "redeploy",
        "--service",
        input.service,
        "--yes",
      ],
      cwd: tempDir,
    });

    return {
      ok: true,
      result: {
        linked: true,
        createdService,
        appliedKeys: keys,
        redeployAttempted: true,
        redeploySucceeded: redeploy.exitCode === 0,
      },
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Spawn a command and capture stdout/stderr for structured error handling.
 */
async function runCommand(input: {
  readonly cmd: readonly string[];
  readonly cwd?: string;
  readonly stdinText?: string;
}): Promise<CommandResult> {
  const proc = Bun.spawn({
    cmd: [...input.cmd],
    ...(input.cwd ? { cwd: input.cwd } : {}),
    env: {
      ...process.env,
    },
    stdin: input.stdinText ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (input.stdinText && proc.stdin) {
    proc.stdin.write(input.stdinText);
    proc.stdin.end();
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    proc.stdout.text(),
    proc.stderr.text(),
    proc.exited,
  ]);
  return {
    stdout,
    stderr,
    exitCode,
  };
}

/**
 * Parse JSON, including mixed terminal output that embeds a JSON payload.
 */
function parseJsonOutput(input: {
  readonly text: string;
}):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string } {
  const trimmed = input.text.trim();
  if (!trimmed) {
    return { ok: false, error: "empty output" };
  }

  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    const objectStart = trimmed.indexOf("{");
    const arrayStart = trimmed.indexOf("[");
    const starts = [objectStart, arrayStart].filter((index) => index >= 0);
    if (starts.length === 0) {
      return { ok: false, error: "no JSON frame detected" };
    }
    const start = Math.min(...starts);
    const opener = trimmed[start];
    const closer = opener === "{" ? "}" : "]";
    const end = trimmed.lastIndexOf(closer);
    if (end <= start) {
      return { ok: false, error: "invalid JSON framing" };
    }
    const candidate = trimmed.slice(start, end + 1);
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      return { ok: false, error: "unable to parse framed JSON payload" };
    }
  }
}

/**
 * Extract Neon projects from neonctl output.
 */
function extractNeonProjects(input: {
  readonly value: unknown;
}): readonly NeonProjectEntry[] {
  if (!isRecord(input.value)) {
    return [];
  }
  const projectsValue = input.value.projects;
  if (!Array.isArray(projectsValue)) {
    return [];
  }
  const entries: NeonProjectEntry[] = [];
  for (const entry of projectsValue) {
    if (!isRecord(entry)) {
      continue;
    }
    const id = getString(entry, "id")?.trim() ?? "";
    const name = getString(entry, "name")?.trim() ?? "";
    if (!(id && name)) {
      continue;
    }
    entries.push({ id, name });
  }
  return entries;
}

/**
 * Normalize Neon connection-string output into a single shape.
 */
function parseNeonConnectionInfo(input: {
  readonly value: unknown;
}): NeonConnectionInfo | null {
  if (typeof input.value === "string") {
    const connectionString = input.value.trim();
    return connectionString
      ? {
          connectionString,
          host: null,
          role: null,
          database: null,
        }
      : null;
  }
  if (!isRecord(input.value)) {
    return null;
  }
  const connectionString =
    getString(input.value, "connection_string")?.trim() ?? "";
  if (!connectionString) {
    return null;
  }
  return {
    connectionString,
    host: getString(input.value, "host")?.trim() ?? null,
    role: getString(input.value, "role")?.trim() ?? null,
    database: getString(input.value, "database")?.trim() ?? null,
  };
}

/**
 * Read a dotenv-style file if present.
 */
async function readDotEnvFile(input: {
  readonly filePath: string;
}): Promise<Readonly<Record<string, string>>> {
  const file = Bun.file(input.filePath);
  if (!(await file.exists())) {
    return {};
  }
  const text = await file.text();
  return parseDotEnv(text);
}

/**
 * Pick a Better Auth secret from explicit arg/env/file, or generate one.
 */
function resolveBetterAuthSecret(input: {
  readonly explicit: string | null;
  readonly envValue: string | undefined;
  readonly localValue: string | undefined;
}): BetterAuthSecretResolution {
  const explicit = input.explicit?.trim() ?? "";
  if (explicit) {
    return { value: explicit, source: "arg" };
  }
  const fromEnv = (input.envValue ?? "").trim();
  if (fromEnv) {
    return { value: fromEnv, source: "env" };
  }
  const fromLocal = (input.localValue ?? "").trim();
  if (fromLocal) {
    return { value: fromLocal, source: "local-file" };
  }
  return {
    value: randomBytes(48).toString("base64url"),
    source: "generated",
  };
}

function createDefaultArgsDraft(): ArgsDraft {
  return {
    neonProject: "",
    neonBranch: null,
    neonRole: null,
    neonDatabase: null,
    neonPooled: false,
    localEnvFile: DEFAULT_LOCAL_ENV_FILE,
    skipLocal: false,
    skipRailway: false,
    railwayProject: DEFAULT_RAILWAY_PROJECT,
    railwayService: DEFAULT_RAILWAY_SERVICE,
    railwayEnvironment: DEFAULT_RAILWAY_ENVIRONMENT,
    railwayWorkspace: null,
    createRailwayService: false,
    betterAuthSecret: null,
    dryRun: false,
    json: false,
  };
}

function applyPrefixedFlag(input: {
  readonly draft: ArgsDraft;
  readonly arg: string;
}): boolean {
  const match = PREFIX_FLAG_HANDLERS.find(({ prefix }) =>
    input.arg.startsWith(prefix)
  );
  if (!match) {
    return false;
  }
  match.apply({
    draft: input.draft,
    arg: input.arg,
  });
  return true;
}

function parseStringFlagValue(input: {
  readonly arg: string;
  readonly prefix: string;
}): string {
  return input.arg.slice(input.prefix.length).trim();
}

function parseOptionalStringFlagValue(input: {
  readonly arg: string;
  readonly prefix: string;
}): string | null {
  const value = parseStringFlagValue(input);
  return value ? value : null;
}

function firstNonEmptyLine(input: { readonly value: string }): string | null {
  for (const line of input.value.split("\n")) {
    const normalized = line.trim();
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function renderKeySummary(input: {
  readonly keys: readonly string[];
  readonly emptyLabel: string;
}): string {
  if (input.keys.length === 0) {
    return input.emptyLabel;
  }
  return `keys: ${input.keys.join(", ")}`;
}

function renderHelp(): string {
  return [
    "One-time Neon bootstrap for auth-broker local env + Railway vars.",
    "",
    "Usage:",
    "  bun run scripts/setup-auth-broker-neon.ts --neon-project=<id|name> [options]",
    "",
    "Required:",
    "  --neon-project=<id|name>      Neon project id or exact project name",
    "",
    "Neon options:",
    "  --neon-branch=<branch>        Optional branch id/name",
    "  --neon-role=<role>            Optional role name",
    "  --neon-database=<db>          Optional database name",
    "  --neon-pooled                 Use pooled Neon connection",
    "",
    "Local env options:",
    `  --local-env-file=<path>       Default: ${DEFAULT_LOCAL_ENV_FILE}`,
    "  --skip-local                  Do not write local env file",
    "",
    "Railway options:",
    `  --railway-project=<id|name>   Default: ${DEFAULT_RAILWAY_PROJECT}`,
    `  --railway-service=<id|name>   Default: ${DEFAULT_RAILWAY_SERVICE}`,
    `  --railway-environment=<name>  Default: ${DEFAULT_RAILWAY_ENVIRONMENT}`,
    "  --railway-workspace=<id|name> Optional Railway workspace selector",
    "  --create-railway-service      Create service before setting vars",
    "  --skip-railway                Skip Railway variable provisioning",
    "",
    "Secrets:",
    "  --better-auth-secret=<value>  Optional explicit BETTER_AUTH_SECRET",
    "",
    "Execution:",
    "  --dry-run                     Show what would be written without writes",
    "  --json                        Machine-readable summary output",
  ].join("\n");
}

export const __testOnlyAuthBrokerNeonSetup = {
  parseArgs,
  parseJsonOutput,
  extractNeonProjects,
  parseNeonConnectionInfo,
  resolveBetterAuthSecret,
};
