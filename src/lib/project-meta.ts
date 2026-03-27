import { dirname, resolve } from "node:path";
import { YAML } from "bun";
import type { MuxSession } from "../mux/mux-backend.ts";
import { getMuxBackends } from "../mux/mux-resolver.ts";
import { parseSessionBase } from "../mux/session-names.ts";
import type { BranchEntry } from "./branches.ts";
import { readBranchesFile } from "./branches.ts";
import { pathExists, readTextFile } from "./fs.ts";
import { isRecord } from "./guards.ts";
import type { HackEnvSource } from "./hack-env.ts";
import { resolveHackEnv } from "./hack-env.ts";
import type { ProjectOwnershipConfig } from "./project.ts";
import { readProjectConfig } from "./project.ts";
import {
  discoverComposeServiceNames,
  projectEnvConfigExists,
  resolveProjectEnvConfig,
} from "./project-env-config.ts";
import { exec } from "./shell.ts";

export type GitWorktreeMeta = {
  readonly path: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly detached: boolean;
};

export type GitMeta = {
  readonly isRepo: boolean;
  readonly head: string | null;
  readonly branch: string | null;
  readonly detached: boolean | null;
  readonly dirty: boolean | null;
  readonly localBranchCount: number | null;
  readonly worktrees: readonly GitWorktreeMeta[] | null;
  readonly error: string | null;
};

export type HackBranchesMeta = {
  readonly path: string;
  readonly parseError: string | null;
  readonly branches: readonly BranchEntry[];
};

export type EnvVarMeta = {
  readonly key: string;
  readonly required: boolean;
  readonly source: HackEnvSource;
  readonly services: readonly string[] | null;
  readonly description?: string;
  readonly resolvedFrom:
    | "dotenv"
    | "process"
    | "keychain"
    | "portable_backend"
    | null;
  readonly hasValue: boolean;
};

export type EnvMeta = {
  readonly contractPath: string;
  readonly contractExists: boolean;
  readonly contractParseError: string | null;
  readonly vars: readonly EnvVarMeta[];
  readonly missingRequired: readonly string[];
};

export type SessionsMeta = {
  readonly sessions: readonly MuxSession[];
};

export type ComposeBuildServiceMeta = {
  readonly service: string;
  readonly build: boolean;
  readonly context: string | null;
  readonly dockerfile: string | null;
  readonly dockerfilePath: string | null;
  readonly dockerfileExists: boolean | null;
};

export type ComposeBuildMeta = {
  readonly services: readonly ComposeBuildServiceMeta[];
};

export type ProjectMeta = {
  readonly ownership: ProjectOwnershipConfig | null;
  readonly configError: string | null;
  readonly git: GitMeta;
  readonly hackBranches: HackBranchesMeta;
  readonly env: EnvMeta;
  readonly sessions: SessionsMeta;
  readonly composeBuild: ComposeBuildMeta;
};

export async function resolveProjectMeta(opts: {
  readonly projectName: string;
  readonly repoRoot: string;
  readonly projectDir: string;
  readonly composeFile: string;
}): Promise<ProjectMeta> {
  const [config, git, hackBranches, env, sessions, composeBuild] =
    await Promise.all([
      readProjectConfig({
        projectRoot: opts.repoRoot,
        projectDirName: ".hack",
        projectDir: opts.projectDir,
        composeFile: opts.composeFile,
        envFile: resolve(opts.projectDir, "hack.env.json"),
        configFile: resolve(opts.projectDir, "hack.config.json"),
      }),
      resolveGitMeta({ repoRoot: opts.repoRoot }),
      resolveHackBranchesMeta({ projectDir: opts.projectDir }),
      resolveEnvMeta({
        projectRoot: opts.repoRoot,
        projectDir: opts.projectDir,
        composeFile: opts.composeFile,
        projectName: opts.projectName,
      }),
      resolveSessionsMeta({ projectName: opts.projectName }),
      resolveComposeBuildMeta({ composeFile: opts.composeFile }),
    ]);

  return {
    ownership: config.parseError ? null : config.ownership,
    configError: config.parseError ?? null,
    git,
    hackBranches,
    env,
    sessions,
    composeBuild,
  };
}

export async function resolveGitMeta(opts: {
  readonly repoRoot: string;
}): Promise<GitMeta> {
  const inside = await exec(
    ["git", "-C", opts.repoRoot, "rev-parse", "--is-inside-work-tree"],
    { stdin: "ignore" }
  );
  if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
    return {
      isRepo: false,
      head: null,
      branch: null,
      detached: null,
      dirty: null,
      localBranchCount: null,
      worktrees: null,
      error: null,
    };
  }

  const [headRes, branchRes, statusRes, branchesRes, worktreesRes] =
    await Promise.all([
      exec(["git", "-C", opts.repoRoot, "rev-parse", "HEAD"], {
        stdin: "ignore",
      }),
      exec(["git", "-C", opts.repoRoot, "branch", "--show-current"], {
        stdin: "ignore",
      }),
      exec(["git", "-C", opts.repoRoot, "status", "--porcelain"], {
        stdin: "ignore",
      }),
      exec(
        [
          "git",
          "-C",
          opts.repoRoot,
          "for-each-ref",
          "--format=%(refname:short)",
          "refs/heads",
        ],
        { stdin: "ignore" }
      ),
      exec(["git", "-C", opts.repoRoot, "worktree", "list", "--porcelain"], {
        stdin: "ignore",
      }),
    ]);

  const head = headRes.exitCode === 0 ? headRes.stdout.trim() : null;
  const branch = branchRes.exitCode === 0 ? branchRes.stdout.trim() : "";
  const detached = branch.length === 0;
  const dirty =
    statusRes.exitCode === 0 ? statusRes.stdout.trim().length > 0 : null;

  const localBranchCount =
    branchesRes.exitCode === 0
      ? branchesRes.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0).length
      : null;

  const worktrees =
    worktreesRes.exitCode === 0
      ? parseGitWorktreePorcelain(worktreesRes.stdout)
      : null;

  const error =
    headRes.exitCode !== 0 ||
    branchRes.exitCode !== 0 ||
    statusRes.exitCode !== 0 ||
    branchesRes.exitCode !== 0
      ? "git_command_failed"
      : null;

  return {
    isRepo: true,
    head,
    branch: branch.length > 0 ? branch : null,
    detached,
    dirty,
    localBranchCount,
    worktrees,
    error,
  };
}

function parseGitWorktreePorcelain(text: string): readonly GitWorktreeMeta[] {
  const lines = text.split("\n");
  const out: GitWorktreeMeta[] = [];

  let current: {
    path: string | null;
    head: string | null;
    branch: string | null;
    detached: boolean;
  } = { path: null, head: null, branch: null, detached: false };

  const flush = () => {
    if (current.path) {
      out.push({
        path: current.path,
        head: current.head,
        branch: current.branch,
        detached: current.detached,
      });
    }
    current = { path: null, head: null, branch: null, detached: false };
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      flush();
      continue;
    }
    if (trimmed.startsWith("worktree ")) {
      current.path = trimmed.slice("worktree ".length).trim();
      continue;
    }
    if (trimmed.startsWith("HEAD ")) {
      current.head = trimmed.slice("HEAD ".length).trim();
      continue;
    }
    if (trimmed.startsWith("branch ")) {
      const ref = trimmed.slice("branch ".length).trim();
      const prefix = "refs/heads/";
      current.branch = ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
      continue;
    }
    if (trimmed === "detached") {
      current.detached = true;
    }
  }
  flush();

  return out;
}

export async function resolveHackBranchesMeta(opts: {
  readonly projectDir: string;
}): Promise<HackBranchesMeta> {
  const read = await readBranchesFile({ projectDir: opts.projectDir });
  return {
    path: read.path,
    parseError: read.parseError ?? null,
    branches: read.file.branches,
  };
}

export async function resolveEnvMeta(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly composeFile: string;
  readonly projectName: string;
}): Promise<EnvMeta> {
  const modernEnvMeta = await resolveModernEnvMeta(opts);
  if (modernEnvMeta) {
    return modernEnvMeta;
  }

  const resolved = await resolveHackEnv({
    projectDir: opts.projectDir,
    projectName: opts.projectName,
  });

  const valuesByKey = new Map(resolved.values.map((v) => [v.key, v] as const));
  const vars: EnvVarMeta[] = [];
  for (const v of resolved.contract.vars) {
    const state = valuesByKey.get(v.key) ?? null;
    vars.push({
      key: v.key,
      required: v.required,
      source: v.source,
      services: v.services,
      ...(v.description ? { description: v.description } : {}),
      resolvedFrom: state?.resolvedFrom ?? null,
      hasValue: Boolean(state?.value),
    });
  }

  return {
    contractPath: resolved.contractPath,
    contractExists: resolved.contractExists,
    contractParseError: resolved.contractParseError ?? null,
    vars,
    missingRequired: resolved.missingRequired.map((v) => v.key),
  };
}

async function resolveModernEnvMeta(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly composeFile: string;
}): Promise<EnvMeta | null> {
  if (
    !(await projectEnvConfigExists({
      projectDir: opts.projectDir,
    }))
  ) {
    return null;
  }

  const serviceNames = await discoverComposeServiceNames({
    composeFile: opts.composeFile,
  });
  let resolved: Awaited<ReturnType<typeof resolveProjectEnvConfig>>;
  try {
    resolved = await resolveProjectEnvConfig({
      projectRoot: opts.projectRoot,
      projectDir: opts.projectDir,
      envName: undefined,
      serviceNames,
    });
  } catch (error: unknown) {
    return {
      contractPath: resolve(opts.projectDir, "hack.env.default.yaml"),
      contractExists: true,
      contractParseError:
        error instanceof Error ? error.message : "Invalid modern env config.",
      vars: [],
      missingRequired: [],
    };
  }
  if (!resolved) {
    return null;
  }

  return {
    contractPath: resolved.selection.defaultPath,
    contractExists: true,
    contractParseError: null,
    vars: buildModernEnvMetaVars({ resolved }),
    missingRequired: [],
  };
}

function buildModernEnvMetaVars(opts: {
  readonly resolved: NonNullable<
    Awaited<ReturnType<typeof resolveProjectEnvConfig>>
  >;
}): EnvVarMeta[] {
  const vars: EnvVarMeta[] = [];
  for (const [scope, scopeValues] of Object.entries(
    opts.resolved.merged.values
  )) {
    for (const [key, value] of Object.entries(scopeValues)) {
      vars.push({
        key,
        required: false,
        source:
          isRecord(value) && typeof value.secure === "string"
            ? "keychain"
            : "plain_env",
        services: scope === "global" ? null : [scope],
        resolvedFrom: "portable_backend",
        hasValue: true,
      });
    }
  }
  return vars;
}

export async function resolveSessionsMeta(opts: {
  readonly projectName: string;
}): Promise<SessionsMeta> {
  const backends = getMuxBackends();
  const sessions: MuxSession[] = [];

  for (const backend of backends.values()) {
    if (!backend.available) {
      continue;
    }
    const listed = await backend.listSessions();
    for (const s of listed) {
      const base = parseSessionBase({ name: s.name });
      if (base === opts.projectName) {
        sessions.push(s);
      }
    }
  }

  return {
    sessions: sessions.sort((a, b) =>
      a.name === b.name
        ? a.backend.localeCompare(b.backend)
        : a.name.localeCompare(b.name)
    ),
  };
}

export async function resolveComposeBuildMeta(opts: {
  readonly composeFile: string;
}): Promise<ComposeBuildMeta> {
  const text = await readTextFile(opts.composeFile);
  if (!text) {
    return { services: [] };
  }

  const parsed = parseComposeYaml({ text });
  if (!parsed) {
    return { services: [] };
  }

  const servicesRaw = readComposeServices({ parsed });
  if (!servicesRaw) {
    return { services: [] };
  }

  const composeDir = dirname(opts.composeFile);
  const out: ComposeBuildServiceMeta[] = [];

  for (const [service, raw] of Object.entries(servicesRaw)) {
    const meta = await resolveComposeBuildServiceMeta({
      service,
      raw,
      composeDir,
    });
    if (meta) {
      out.push(meta);
    }
  }

  return {
    services: out.sort((a, b) => a.service.localeCompare(b.service)),
  };
}

function parseComposeYaml(opts: {
  readonly text: string;
}): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = YAML.parse(opts.text);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

function readComposeServices(opts: {
  readonly parsed: Record<string, unknown>;
}): Record<string, unknown> | null {
  const services = opts.parsed.services;
  return isRecord(services) ? services : null;
}

async function resolveComposeBuildServiceMeta(opts: {
  readonly service: string;
  readonly raw: unknown;
  readonly composeDir: string;
}): Promise<ComposeBuildServiceMeta | null> {
  if (!isRecord(opts.raw)) {
    return null;
  }

  const buildRaw = opts.raw.build;
  const build = typeof buildRaw === "string" || isRecord(buildRaw);
  if (!build) {
    return {
      service: opts.service,
      build: false,
      context: null,
      dockerfile: null,
      dockerfilePath: null,
      dockerfileExists: null,
    };
  }

  const resolved = resolveComposeBuildInputs({ buildRaw });
  const dockerfilePath = resolved.context
    ? resolve(opts.composeDir, resolved.context, resolved.dockerfile)
    : resolve(opts.composeDir, resolved.dockerfile);
  const dockerfileExists = await pathExists(dockerfilePath);

  return {
    service: opts.service,
    build: true,
    context: resolved.context,
    dockerfile: resolved.dockerfile.length > 0 ? resolved.dockerfile : null,
    dockerfilePath,
    dockerfileExists,
  };
}

function resolveComposeBuildInputs(opts: { readonly buildRaw: unknown }): {
  readonly context: string | null;
  readonly dockerfile: string;
} {
  if (typeof opts.buildRaw === "string") {
    const context = opts.buildRaw.trim();
    return {
      context: context.length > 0 ? context : null,
      dockerfile: "Dockerfile",
    };
  }

  const contextRaw = isRecord(opts.buildRaw) ? opts.buildRaw.context : null;
  const context = typeof contextRaw === "string" ? contextRaw.trim() : "";
  const dockerfileRaw = isRecord(opts.buildRaw)
    ? opts.buildRaw.dockerfile
    : null;
  const dockerfile =
    typeof dockerfileRaw === "string" ? dockerfileRaw.trim() : "Dockerfile";

  return {
    context: context.length > 0 ? context : null,
    dockerfile,
  };
}
