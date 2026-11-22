import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import YAML from "yaml";
import { buildComposeArgs } from "../backends/runtime-backend.ts";
import { CliUsageError } from "../cli/command.ts";
import { resolveRegisteredProjectOption } from "../cli/project-selector.ts";
import { resolveEffectiveBranch } from "./branches.ts";
import { HackCliError } from "./cli-result.ts";
import { renderComposeEnvReferenceOverride } from "./compose-managed-env.ts";
import { parseComposePsJson } from "./compose-ps-result.ts";
import { ensureDir, writeTextFileAtomicIfChanged } from "./fs.ts";
import { isRecord } from "./guards.ts";
import { resolveHackEnv } from "./hack-env.ts";
import { resolveLifecycleComposeProjectName } from "./lifecycle-runtime.ts";
import { MissingProjectContextError } from "./missing-project-error.ts";
import {
  findProjectContext,
  type ProjectConfig,
  type ProjectContext,
  resolveWorktreeAutoBranch,
  sanitizeProjectSlug,
} from "./project.ts";
import {
  discoverComposeServiceNames,
  resolveProjectEnvConfig,
} from "./project-env-config.ts";
import {
  applyRemoteEnv,
  type EffectiveRemote,
  inactiveRemoteServices,
  prepareRemoteChoices,
  remoteSelectionLabels,
  remoteServiceTargets,
  runningRemoteTarget,
} from "./project-remote-selection.ts";
import { projectRemoteStatuses } from "./project-remote-status.ts";
import {
  readProjectRuntimeStateEntry,
  upsertProjectRuntimeStateEntry,
} from "./project-runtime-state.ts";
import { selectEnvForRunningInstance } from "./running-env-selection.ts";
import { exec } from "./shell.ts";
import { isHostControlEnvKey } from "./vetted-env.ts";

export async function resolveUseProject(opts: {
  readonly cwd: string;
  readonly path?: string;
  readonly project?: string;
}): Promise<ProjectContext> {
  if (opts.path && opts.project !== undefined) {
    throw new CliUsageError("Use either --path or --project (not both).");
  }
  if (opts.project !== undefined) {
    return await resolveRegisteredProjectOption({ projectOpt: opts.project });
  }
  const project = await findProjectContext(resolve(opts.cwd, opts.path ?? "."));
  if (!project) {
    throw new MissingProjectContextError();
  }
  return project;
}

export async function resolveUseInstance(opts: {
  readonly project: ProjectContext;
  readonly cfg: ProjectConfig;
  readonly base: string;
}) {
  const instance = await resolveEffectiveBranch({
    explicitBranch: null,
    projectRoot: opts.project.projectRoot,
    autoBranchEnabled: resolveWorktreeAutoBranch(opts.cfg),
  });
  if (instance.source === "detached-worktree") {
    throw new CliUsageError(
      "Detached linked worktree cannot auto-select an isolated instance. Set worktree.auto_branch=false to target the base instance explicitly."
    );
  }
  return {
    composeProjectName: instance.branch
      ? `${opts.base}--${instance.branch}`
      : null,
    lifecycleComposeProject: resolveLifecycleComposeProjectName({
      projectName: sanitizeProjectSlug(opts.base),
      branch: instance.branch,
    }),
  };
}

/** Read application interpolation values without adopting checkout client settings. */
export async function resolveRemoteInspectionEnv(opts: {
  readonly project: ProjectContext;
  readonly baseProjectName: string;
  readonly composeProject: string;
  readonly requestedEnvName: string | null | undefined;
  readonly choices: readonly EffectiveRemote[];
  readonly tolerant?: typeof warnMissingRemoteEnv;
}): Promise<Record<string, string>> {
  const { project } = opts;
  const envName = selectEnvForRunningInstance({
    requestedEnvName: opts.requestedEnvName,
    running: await readProjectRuntimeStateEntry({
      projectDir: project.projectDir,
      composeProject: opts.composeProject,
    }),
  });
  const modern = await resolveProjectEnvConfig({
    projectDir: project.projectDir,
    projectRoot: project.projectRoot,
    envName,
    serviceNames: await discoverComposeServiceNames({
      composeFile: project.composeFile,
    }),
  });
  const managed =
    modern?.globalEnv ??
    (
      await resolveHackEnv({
        projectDir: project.projectDir,
        projectName: sanitizeProjectSlug(opts.baseProjectName),
        envName,
      })
    ).envForCompose;
  return Object.fromEntries(
    Object.entries(
      applyRemoteEnv(managed, opts.choices, {
        missing: opts.tolerant,
      })
    ).filter(([key]) => !isHostControlEnvKey(key))
  );
}

const REMOTE_INSTANCE_LABEL = "dev.hack.remote.instance";

async function remoteInstanceIdentity(
  project: ProjectContext,
  composeProject: string | null
): Promise<string> {
  const root = await realpath(project.projectDir);
  return createHash("sha256")
    .update(JSON.stringify([root, composeProject]))
    .digest("hex");
}

/** Docker-independent model metadata must never be persisted with resolved env. */
function readComposeModel(result: Awaited<ReturnType<typeof exec>>) {
  try {
    const model: unknown =
      result.exitCode === 0 ? JSON.parse(result.stdout) : null;
    if (isRecord(model) && isRecord(model.services)) {
      return model.services;
    }
  } catch {
    // Compose output can contain interpolated values.
  }
  throw new HackCliError({
    code: "E_CONFIG_INVALID",
    message:
      "Could not resolve Compose services and dependencies for remote selection.",
  });
}

function implicitDependencies(spec: Record<string, unknown>): string[] {
  const refs = [spec.network_mode, spec.ipc, spec.pid].flatMap((value) =>
    typeof value === "string" && value.startsWith("service:")
      ? [value.slice(8)]
      : []
  );
  for (const raw of [spec.links, spec.volumes_from]) {
    if (Array.isArray(raw)) {
      for (const value of raw) {
        if (typeof value === "string" && !value.startsWith("container:")) {
          refs.push(value.split(":")[0] ?? "");
        }
      }
    }
  }
  return refs;
}

async function observeRemoteInstance(opts: {
  readonly project: ProjectContext;
  readonly composeProjectName: string | null;
}) {
  const cwd = dirname(opts.project.composeFile);
  const identity = await remoteInstanceIdentity(
    opts.project,
    opts.composeProjectName
  ).catch(() => undefined);
  const filter = `${REMOTE_INSTANCE_LABEL}=${identity}`;
  const result = identity
    ? await exec(
        [
          "docker",
          "ps",
          "--all",
          "--filter",
          `label=${filter}`,
          "--format",
          "{{json .}}",
        ],
        { cwd, timeoutMs: 5000 }
      ).catch(() => undefined)
    : undefined;
  const rows =
    result?.exitCode === 0 ? (parseComposePsJson(result.stdout) ?? []) : [];
  return {
    rows: rows.filter(
      ({ Labels }) =>
        typeof Labels === "string" && Labels.split(",").includes(filter)
    ),
    filter,
    cwd,
  };
}

function dockerLabel(
  row: Record<string, unknown>,
  key: string
): string | undefined {
  const prefix = `${key}=`;
  return typeof row.Labels === "string"
    ? row.Labels.split(",")
        .find((label) => label.startsWith(prefix))
        ?.slice(prefix.length)
    : undefined;
}

async function recoveryComposeFile(
  project: ProjectContext,
  observation: Awaited<ReturnType<typeof observeRemoteInstance>>
) {
  const names = new Set(
    observation.rows.map((row) =>
      dockerLabel(row, "com.docker.compose.project")
    )
  );
  const name = [...names][0];
  if (names.size !== 1 || !name) {
    return undefined;
  }
  const result = await exec(
    [
      "docker",
      "ps",
      "--all",
      "--filter",
      `label=com.docker.compose.project=${name}`,
      "--format",
      "{{json .}}",
    ],
    {
      cwd: observation.cwd,
      timeoutMs: 5000,
    }
  );
  const peers =
    result.exitCode === 0 ? parseComposePsJson(result.stdout) : null;
  if (
    !peers?.length ||
    peers.some(
      (row) => !String(row.Labels).split(",").includes(observation.filter)
    )
  ) {
    return undefined;
  }
  const services = Object.fromEntries(
    peers.flatMap((row) => {
      const service = dockerLabel(row, "com.docker.compose.service");
      return service ? [[service, { image: "scratch" }]] : [];
    })
  );
  const path = resolve(
    project.projectDir,
    ".internal",
    "compose.remote-recovery.json"
  );
  await ensureDir(dirname(path));
  await writeTextFileAtomicIfChanged(path, JSON.stringify({ name, services }), {
    createMode: 0o600,
    noFollowTarget: true,
  });
  return path;
}

async function recoverRemoteChoices(opts: {
  readonly project: ProjectContext;
  readonly cfg: ProjectConfig;
  readonly lifecycleComposeProject: string;
  readonly entries: readonly Record<string, unknown>[];
}): Promise<EffectiveRemote[]> {
  const defaults = opts.cfg.prerequisites?.config?.selected ?? [];
  const state = await readProjectRuntimeStateEntry({
    projectDir: opts.project.projectDir,
    composeProject: opts.lifecycleComposeProject,
  }).catch(() => null);
  return defaults.flatMap((remote) => {
    const observed = runningRemoteTarget(opts.entries, remote.remote);
    const name =
      observed === undefined
        ? state?.remoteTargets?.[remote.remote]?.split(":")[0]
        : observed;
    const target = name ? remote.targets.get(name) : undefined;
    if (!(name && target)) {
      process.stderr.write(
        `! ${remote.remote} · running target unavailable · bindings omitted · start with a declared target to restore them\n`
      );
      return [];
    }
    return [
      {
        ...remote,
        ...target,
        target: name,
        via: target.via,
        source: "default",
      },
    ];
  });
}

export function warnMissingRemoteEnv(remote: string, name: string): void {
  process.stderr.write(
    `! ${remote} · ${name} unavailable · bindings omitted · restore the managed variable\n`
  );
}

export async function wholeProjectRemoteChoices(
  project: ProjectContext,
  cfg: ProjectConfig,
  services: readonly string[],
  use: string | undefined
) {
  if (services.length && use !== undefined) {
    throw new CliUsageError("--use currently requires whole-project up.");
  }
  return services.length
    ? []
    : await prepareRemoteChoices({
        projectDir: project.projectDir,
        defaults: cfg.prerequisites?.config?.selected ?? [],
        use,
      });
}

export function remotePrerequisites(
  cfg: ProjectConfig,
  choices: readonly EffectiveRemote[]
) {
  const config = cfg.prerequisites?.config;
  return config && choices.length
    ? { config: { ...config, selected: choices } }
    : cfg.prerequisites;
}

export async function recordStartedRemotes(
  project: ProjectContext,
  composeProject: string,
  choices: readonly EffectiveRemote[]
): Promise<void> {
  if (choices.length) {
    const projectDir = project.projectDir;
    const entry = await readProjectRuntimeStateEntry({
      projectDir,
      composeProject,
    });
    if (entry) {
      const remoteTargets = Object.fromEntries(
        choices.map(({ remote, target, source }) => [
          remote,
          `${target}:${source}`,
        ])
      );
      await upsertProjectRuntimeStateEntry({
        projectDir,
        entry: { ...entry, remoteTargets },
      });
    }
  }
}

export async function runtimeRemoteEnv(
  input: {
    project: ProjectContext;
    cfg: ProjectConfig;
    baseProjectName: string;
    branch: string | null;
  },
  envName?: string | null
) {
  const composeProjectName = input.branch
    ? `${input.baseProjectName}--${input.branch}`
    : null;
  const lifecycleComposeProject = resolveLifecycleComposeProjectName({
    projectName: sanitizeProjectSlug(input.baseProjectName),
    branch: input.branch,
  });
  const defaults = input.cfg.prerequisites?.config?.selected ?? [];
  if (!defaults.length) {
    return { choices: [], env: undefined, recoveryFile: undefined };
  }
  const observation = await observeRemoteInstance({
    ...input,
    composeProjectName,
  });
  const choices = await recoverRemoteChoices({
    ...input,
    lifecycleComposeProject,
    entries: observation.rows,
  });
  let missing = choices.length < defaults.length;
  const env = await resolveRemoteInspectionEnv({
    project: input.project,
    baseProjectName: input.baseProjectName,
    composeProject: lifecycleComposeProject,
    requestedEnvName: envName,
    choices,
    tolerant: (remote, key) => {
      missing = true;
      warnMissingRemoteEnv(remote, key);
    },
  });
  const recoveryFile = missing
    ? await recoveryComposeFile(input.project, observation).catch(
        () => undefined
      )
    : undefined;
  return { choices, env, recoveryFile };
}

export function remoteRuntimeStatuses(
  cfg: ProjectConfig,
  choices: readonly EffectiveRemote[]
) {
  return projectRemoteStatuses(
    cfg.prerequisites?.config?.selected?.map(
      (remote) =>
        choices.find((choice) => choice.remote === remote.remote) ?? remote
    )
  );
}

export function teardownHookEnv(
  env: Readonly<Record<string, string>>,
  choices: readonly EffectiveRemote[]
) {
  return choices.length
    ? applyRemoteEnv(env, choices, { host: true, missing: () => undefined })
    : env;
}

export function extendRemoteEnv<
  T extends {
    readonly env: Readonly<Record<string, string>>;
    readonly lifecycleEnv: Readonly<Record<string, string>>;
    readonly composeFiles: readonly string[];
  },
>(
  managed: T,
  startup: Awaited<ReturnType<typeof prepareRemoteStartup>>,
  choices: readonly EffectiveRemote[]
): T {
  return startup
    ? {
        ...managed,
        env: { ...managed.env, ...startup.env },
        composeFiles: [...managed.composeFiles, startup.path],
        lifecycleEnv: applyRemoteEnv(managed.lifecycleEnv, choices, {
          host: true,
          missing: warnMissingRemoteEnv,
        }),
      }
    : managed;
}

export async function prepareRemoteStartup(opts: {
  readonly project: ProjectContext;
  readonly baseProjectName: string;
  readonly profiles: readonly string[];
  readonly composeProject: string | null;
  readonly envName: string | null | undefined;
  readonly choices: readonly EffectiveRemote[];
}) {
  if (!opts.choices.length) {
    return undefined;
  }
  const cwd = dirname(opts.project.composeFile);
  const env = await resolveRemoteInspectionEnv({
    ...opts,
    composeProject: "",
    requestedEnvName: opts.envName,
    choices: opts.choices,
    tolerant: () => undefined,
  });
  const command = (profiles: readonly string[], args: readonly string[]) =>
    exec(
      [
        ...buildComposeArgs({
          cwd,
          composeFiles: [opts.project.composeFile],
          composeProject: opts.composeProject,
          profiles,
        }),
        ...args,
      ],
      { cwd, env, timeoutMs: 15_000, forwardSignals: true }
    );
  const model = readComposeModel(
    await command(["*"], ["config", "--format", "json"])
  );
  const inactive = inactiveRemoteServices(opts.choices);
  const active = await command(opts.profiles, ["config", "--services"]);
  const names = active.stdout.trim().split("\n").filter(Boolean);
  const targets = remoteServiceTargets(opts.choices, names);
  if (
    active.exitCode !== 0 ||
    [...targets, ...inactive].some((name) => !Object.hasOwn(model, name))
  ) {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message:
        "Could not resolve active Compose services for remote selection.",
    });
  }
  const modern = await resolveProjectEnvConfig({
    projectDir: opts.project.projectDir,
    projectRoot: opts.project.projectRoot,
    envName: opts.envName,
    serviceNames: Object.keys(model),
  });
  const labels = {
    ...remoteSelectionLabels(opts.choices),
    [REMOTE_INSTANCE_LABEL]: await remoteInstanceIdentity(
      opts.project,
      opts.composeProject
    ),
  };
  const serviceEnv = Object.fromEntries(
    Object.entries(model).map(([name, spec]) => {
      if (targets.includes(name) && isRecord(spec)) {
        const explicit = isRecord(spec.depends_on)
          ? Object.keys(spec.depends_on)
          : [];
        const dependency = [...explicit, ...implicitDependencies(spec)].find(
          (dep) => inactive.includes(dep)
        );
        if (dependency) {
          const choice = opts.choices.find(({ targets }) =>
            [...targets.values()].some(
              ({ address }) =>
                address.kind === "service" && address.service === dependency
            )
          );
          const local =
            choice &&
            [...choice.targets].find(
              ([, target]) =>
                target.address.kind === "service" &&
                target.address.service === dependency
            )?.[0];
          throw new HackCliError({
            code: "E_CONFIG_INVALID",
            message: `Compose service ${name} requires excluded backing service ${dependency}. Run hack up --use ${choice?.remote}=${local}.`,
          });
        }
      }
      return [
        name,
        applyRemoteEnv(
          modern?.serviceEnv[name] ?? modern?.globalEnv ?? env,
          opts.choices,
          { bindingsOnly: true }
        ),
      ];
    })
  );
  const refs = renderComposeEnvReferenceOverride({
    targetServices: Object.keys(model),
    globalEnv: {},
    serviceEnv,
  });
  const doc = refs
    ? YAML.parseDocument(refs.text)
    : new YAML.Document({ services: {} });
  for (const name of Object.keys(model)) {
    doc.setIn(["services", name, "labels"], labels);
  }
  const text = doc.toString();
  const path = resolve(
    opts.project.projectDir,
    ".internal",
    "compose.remote.override.yml"
  );
  await ensureDir(dirname(path));
  await writeTextFileAtomicIfChanged(path, text, {
    createMode: 0o600,
    noFollowTarget: true,
  });
  return {
    path,
    targets,
    env: { ...env, ...refs?.env },
    stopInactive: async () => {
      if (
        inactive.length &&
        (await command(["*"], ["stop", ...inactive])).exitCode !== 0
      ) {
        throw new HackCliError({
          code: "E_COMPOSE_FAILED",
          message: "Could not stop unselected remote backing services.",
        });
      }
    },
  };
}
