import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import YAML from "yaml";
import {
  buildComposeArgs,
  composeRuntimeBackend,
} from "../backends/runtime-backend.ts";
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
  remoteSelectionLabels,
  remoteServiceTargets,
  runningRemoteTarget,
} from "./project-remote-selection.ts";
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
  return (
    modern?.globalEnv ??
    (
      await resolveHackEnv({
        projectDir: project.projectDir,
        projectName: sanitizeProjectSlug(opts.baseProjectName),
        envName,
      })
    ).envForCompose
  );
}

const REQUIRED_COMPOSE_VARIABLE =
  /required variable ([A-Za-z_][A-Za-z0-9_]*) is missing a value/;
const REMOTE_INSTANCE_LABEL = "dev.hack.remote-instance";

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
  const names = [spec.network_mode, spec.ipc, spec.pid].flatMap((value) =>
    typeof value === "string" && value.startsWith("service:")
      ? [value.slice(8)]
      : []
  );
  return names.concat(
    [spec.links, spec.volumes_from].flatMap((value: unknown) =>
      Array.isArray(value)
        ? value.flatMap((ref: unknown) =>
            typeof ref === "string" && !ref.startsWith("container:")
              ? [ref.split(":")[0] ?? ""]
              : []
          )
        : []
    )
  );
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

export async function observedRemoteChoices(
  project: ProjectContext,
  cfg: ProjectConfig,
  composeProject: string | null,
  rows: readonly Record<string, unknown>[],
  recorded?: Readonly<Record<string, string>>
): Promise<EffectiveRemote[]> {
  const defaults = cfg.prerequisites?.config?.selected ?? [];
  if (!defaults.length) {
    return [];
  }
  const label = `${REMOTE_INSTANCE_LABEL}=${await remoteInstanceIdentity(project, composeProject)}`;
  const owned = rows.filter(
    ({ Labels }) =>
      typeof Labels === "string" && Labels.split(",").includes(label)
  );
  return defaults.flatMap((remote) => {
    const observed = runningRemoteTarget(owned, remote.remote);
    const name =
      observed === undefined
        ? recorded?.[remote.remote]?.split(":")[0]
        : observed;
    const target = name ? remote.targets.get(name) : undefined;
    return name && target
      ? [{ ...remote, ...target, target: name, source: "default" as const }]
      : [];
  });
}

export async function prepareRemoteDown(opts: {
  readonly project: ProjectContext;
  readonly cfg: ProjectConfig;
  readonly composeProjectName: string | null;
  readonly lifecycleComposeProject: string;
  readonly env: Readonly<Record<string, string>>;
}) {
  const { project, cfg, composeProjectName, lifecycleComposeProject, env } =
    opts;
  const defaults = cfg.prerequisites?.config?.selected ?? [];
  if (!defaults.length) {
    return env;
  }
  const result = await composeRuntimeBackend
    .psJson({
      composeFiles: [project.composeFile],
      composeProject: composeProjectName,
      cwd: dirname(project.composeFile),
      env,
      all: true,
    })
    .catch(() => undefined);
  const record = await readProjectRuntimeStateEntry({
    projectDir: project.projectDir,
    composeProject: lifecycleComposeProject,
  }).catch(() => null);
  const choices = await observedRemoteChoices(
    project,
    cfg,
    composeProjectName,
    result?.exitCode === 0 ? (parseComposePsJson(result.stdout) ?? []) : [],
    record?.remoteTargets
  );
  for (const { remote } of defaults) {
    if (!choices.some((choice) => choice.remote === remote)) {
      process.stderr.write(
        `! ${remote} · running target unavailable · bindings omitted\n`
      );
    }
  }
  return applyRemoteEnv(env, choices, {
    host: true,
    missing: warnMissingRemoteEnv,
  });
}

export function warnMissingRemoteEnv(remote: string, name: string): void {
  process.stderr.write(
    `! ${remote} · ${name} unavailable · bindings omitted · restore the managed variable\n`
  );
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
  projectDir: string,
  composeProject: string,
  choices: readonly EffectiveRemote[]
): Promise<void> {
  if (!choices.length) {
    return;
  }
  const entry = await readProjectRuntimeStateEntry({
    projectDir,
    composeProject,
  });
  if (!entry) {
    return;
  }
  const remoteTargets = Object.fromEntries(
    choices.map(({ remote, target, source }) => [remote, `${target}:${source}`])
  );
  await upsertProjectRuntimeStateEntry({
    projectDir,
    entry: { ...entry, remoteTargets },
  });
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
  const managed = await resolveRemoteInspectionEnv({
    ...opts,
    composeProject: "",
    requestedEnvName: opts.envName,
  });
  const env = applyRemoteEnv(managed, opts.choices, {
    missing: () => undefined,
  });
  const command = (
    profiles: readonly string[],
    args: readonly string[],
    environment = env
  ) =>
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
      { cwd, env: environment, timeoutMs: 15_000, forwardSignals: true }
    );
  const withoutBindings = await command(
    ["*"],
    ["config", "--format", "json"],
    managed
  );
  if (withoutBindings.exitCode !== 0) {
    const name = withoutBindings.stderr.match(REQUIRED_COMPOSE_VARIABLE)?.[1];
    if (
      name &&
      opts.choices.some(({ bindings }) => Object.hasOwn(bindings, name))
    ) {
      throw new HackCliError({
        code: "E_CONFIG_INVALID",
        message: `Compose requires remote binding ${name}. Give it a default (\${${name}:-}) because the binding is unavailable at hack down.`,
      });
    }
    readComposeModel(withoutBindings);
  }
  const model = readComposeModel(
    await command(["*"], ["config", "--format", "json"])
  );
  const active = await command(opts.profiles, ["config", "--services"]);
  if (active.exitCode !== 0) {
    readComposeModel(active);
  }
  const names = active.stdout.trim().split("\n").filter(Boolean);
  const { targets, inactive } = remoteServiceTargets(opts.choices, names);
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
          const choice = opts.choices.flatMap(({ remote, targets }) =>
            [...targets].flatMap(([target, { address }]) =>
              address.kind === "service" && address.service === dependency
                ? [`${remote}=${target}`]
                : []
            )
          )[0];
          throw new HackCliError({
            code: "E_CONFIG_INVALID",
            message: `Compose service ${name} requires excluded backing service ${dependency}. Run hack up --use ${choice}.`,
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
  const path = resolve(
    opts.project.projectDir,
    ".internal",
    `compose.remote.override.${identity}.yml`
  );
  await ensureDir(dirname(path));
  await writeTextFileAtomicIfChanged(path, doc.toString(), {
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
