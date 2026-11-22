import { createHash } from "node:crypto";
import { realpath, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import YAML from "yaml";
import { buildComposeArgs } from "../backends/runtime-backend.ts";
import { CliUsageError } from "../cli/command.ts";
import { resolveRegisteredProjectOption } from "../cli/project-selector.ts";
import { resolveEffectiveBranch } from "./branches.ts";
import { HackCliError } from "./cli-result.ts";
import { renderComposeEnvReferenceOverride } from "./compose-managed-env.ts";
import { parseComposePsJson } from "./compose-ps-result.ts";
import { dockerHelperRunEnvironment } from "./docker-helper-environment.ts";
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

/** Resolve interpolation against the managed environment of the selected instance. */
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
  return applyRemoteEnv(managed, opts.choices, { missing: opts.tolerant });
}

const REMOTE_INSTANCE_LABEL = "dev.hack.remote-instance";
const LEGACY_INSTANCE_LABEL = "dev.hack.remote.instance";

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

function excludedDependency(
  model: Record<string, unknown>,
  name: string,
  inactive: readonly string[],
  visited = new Set<string>()
): string | undefined {
  if (visited.has(name)) {
    return undefined;
  }
  visited.add(name);
  const service = model[name];
  if (!isRecord(service)) {
    return undefined;
  }
  const dependencies = [
    ...(isRecord(service.depends_on) ? Object.keys(service.depends_on) : []),
    ...implicitDependencies(service),
  ];
  for (const dependency of dependencies) {
    if (inactive.includes(dependency)) {
      return dependency;
    }
    const indirect = excludedDependency(model, dependency, inactive, visited);
    if (indirect) {
      return indirect;
    }
  }
  return undefined;
}

async function observeRemoteInstance(opts: {
  readonly project: ProjectContext;
  readonly composeProjectName: string | null;
  readonly env: Readonly<Record<string, string>>;
}) {
  const cwd = dirname(opts.project.composeFile);
  const identity = await remoteInstanceIdentity(
    opts.project,
    opts.composeProjectName
  );
  const owns = (row: Record<string, unknown>) =>
    dockerLabel(row, REMOTE_INSTANCE_LABEL) === identity ||
    dockerLabel(row, LEGACY_INSTANCE_LABEL) === identity;
  const read = async (filter: string) => {
    const result = await exec(
      [
        "docker",
        "ps",
        "--all",
        "--filter",
        `label=${filter}`,
        "--format",
        "{{json .}}",
      ],
      { cwd, ...dockerHelperRunEnvironment(opts.env), timeoutMs: 5000 }
    ).catch(() => undefined);
    return result?.exitCode === 0 ? parseComposePsJson(result.stdout) : null;
  };
  const current = await read(`${REMOTE_INSTANCE_LABEL}=${identity}`);
  const legacy = current?.some(owns)
    ? []
    : await read(`${LEGACY_INSTANCE_LABEL}=${identity}`);
  return {
    rows:
      current || legacy
        ? [...(current ?? []), ...(legacy ?? [])].filter(
            (row) => owns(row) && !isOneOff(row)
          )
        : undefined,
    read,
    cwd,
    identity,
    owns,
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

function isOneOff(row: Record<string, unknown>): boolean {
  return (
    dockerLabel(row, "com.docker.compose.oneoff")?.toLowerCase() === "true"
  );
}

async function recoveryComposeFile(
  project: ProjectContext,
  observation: Awaited<ReturnType<typeof observeRemoteInstance>>,
  env: Readonly<Record<string, string>>
) {
  const names = new Set(
    (observation.rows ?? []).map((row) =>
      dockerLabel(row, "com.docker.compose.project")
    )
  );
  const name = [...names][0];
  if (names.size > 1 || !name) {
    return undefined;
  }
  const peers = (
    await observation.read(`com.docker.compose.project=${name}`)
  )?.filter((row) => !isOneOff(row));
  if (!peers?.length || peers.some((row) => !observation.owns(row))) {
    return undefined;
  }
  const serviceNames = peers.map((row) =>
    dockerLabel(row, "com.docker.compose.service")
  );
  if (serviceNames.some((service) => !service)) {
    return undefined;
  }
  const networksResult = await exec(
    [
      "docker",
      "network",
      "ls",
      "--filter",
      `label=com.docker.compose.project=${name}`,
      "--format",
      "{{json .}}",
    ],
    {
      cwd: observation.cwd,
      ...dockerHelperRunEnvironment(env),
      timeoutMs: 5000,
    }
  );
  const networkRows =
    networksResult.exitCode === 0
      ? parseComposePsJson(networksResult.stdout)
      : null;
  if (!networkRows) {
    return undefined;
  }
  const networks = Object.fromEntries(
    networkRows.flatMap((row) => {
      const key = dockerLabel(row, "com.docker.compose.network");
      return key &&
        dockerLabel(row, "com.docker.compose.project") === name &&
        typeof row.Name === "string"
        ? [[key, { name: row.Name }]]
        : [];
    })
  );
  const services = Object.fromEntries(
    serviceNames.map((service) => [
      service,
      {
        image: "scratch",
        ...(Object.keys(networks).length
          ? { networks: Object.keys(networks) }
          : {}),
      },
    ])
  );
  const path = resolve(
    project.projectDir,
    ".internal",
    `compose.remote-recovery.${observation.identity}.json`
  );
  await ensureDir(dirname(path));
  await writeTextFileAtomicIfChanged(
    path,
    JSON.stringify({ name, services, networks }),
    {
      createMode: 0o600,
      noFollowTarget: true,
    }
  );
  return { path, name };
}

async function recoverRemoteChoices(opts: {
  readonly project: ProjectContext;
  readonly cfg: ProjectConfig;
  readonly lifecycleComposeProject: string;
  readonly entries: readonly Record<string, unknown>[];
  readonly quiet?: boolean;
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
      if (!opts.quiet) {
        process.stderr.write(
          `! ${remote.remote} · running target unavailable · bindings omitted · start with a declared target to restore them\n`
        );
      }
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

export function refuseRemoteStart(cfg: ProjectConfig, command: string): void {
  if (cfg.prerequisites?.config?.selected?.length) {
    throw new HackCliError({
      code: "E_REMOTE_START_UNSUPPORTED",
      message: `${command} cannot start a project that declares remotes. Run hack up --detach for the whole project.`,
    });
  }
}

export async function wholeProjectRemoteChoices(
  project: ProjectContext,
  cfg: ProjectConfig,
  services: readonly string[],
  use: string | undefined
) {
  if (services.length) {
    refuseRemoteStart(cfg, "Service-scoped hack up");
    if (use !== undefined) {
      throw new CliUsageError("--use currently requires whole-project up.");
    }
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
    quiet?: boolean;
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
  const identity = await remoteInstanceIdentity(
    input.project,
    composeProjectName
  );
  const generated = resolve(
    input.project.projectDir,
    ".internal",
    `compose.remote.override.${identity}.yml`
  );
  if (!(defaults.length || (await stat(generated).catch(() => null)))) {
    return {
      choices: [],
      env: undefined,
      recover: undefined,
      bindingsMissing: false,
      cleanup: undefined,
      rows: undefined,
    };
  }
  const inspection = {
    ...input,
    composeProject: lifecycleComposeProject,
    requestedEnvName: envName,
  };
  const managed = await resolveRemoteInspectionEnv({
    ...inspection,
    choices: [],
  });
  const observation = await observeRemoteInstance({
    ...input,
    composeProjectName,
    env: managed,
  });
  const choices =
    input.quiet && !observation.rows?.length
      ? []
      : await recoverRemoteChoices({
          ...input,
          lifecycleComposeProject,
          entries: observation.rows ?? [],
        });
  let bindingsMissing = choices.length < defaults.length || !defaults.length;
  const env = applyRemoteEnv(managed, choices, {
    missing: (remote, key) => {
      bindingsMissing = true;
      if (!input.quiet) {
        warnMissingRemoteEnv(remote, key);
      }
    },
  });
  return {
    choices,
    env,
    rows: observation.rows,
    bindingsMissing,
    recover: () =>
      recoveryComposeFile(input.project, observation, managed).catch(
        () => undefined
      ),
    cleanup: () => rm(generated, { force: true }),
  };
}

export function remotePsRows(rows: readonly Record<string, unknown>[]) {
  return rows.map((row) => ({
    ...row,
    Service: dockerLabel(row, "com.docker.compose.service"),
    Name: row.Name ?? row.Names,
    Project: dockerLabel(row, "com.docker.compose.project"),
  }));
}

export function remoteRuntimeStatuses(
  cfg: ProjectConfig | null,
  choices: readonly EffectiveRemote[]
) {
  return (cfg?.prerequisites?.config?.selected ?? []).flatMap(({ remote }) => {
    const choice = choices.find((entry) => entry.remote === remote);
    return choice
      ? projectRemoteStatuses([choice])
      : [
          {
            service: remote,
            kind: "remote" as const,
            target: "unknown",
            address: null,
            via: null,
            state: "unknown" as const,
            probe: "not checked" as const,
          },
        ];
  });
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
  if (active.exitCode !== 0) {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message:
        "Could not resolve active Compose services for remote selection.",
    });
  }
  const names = active.stdout.trim().split("\n").filter(Boolean);
  const targets = remoteServiceTargets(opts.choices, names);
  if ([...targets, ...inactive].some((name) => !Object.hasOwn(model, name))) {
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
  const identity = await remoteInstanceIdentity(
    opts.project,
    opts.composeProject
  );
  const labels = {
    ...remoteSelectionLabels(opts.choices),
    [REMOTE_INSTANCE_LABEL]: identity,
  };
  const serviceEnv = Object.fromEntries(
    Object.entries(model).map(([name, spec]) => {
      if (targets.includes(name) && isRecord(spec)) {
        const dependency = excludedDependency(model, name, inactive);
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
    `compose.remote.override.${identity}.yml`
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
