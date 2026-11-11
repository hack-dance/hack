import {
  buildComposeExecCommand,
  buildComposeRunCommand,
  composeRuntimeBackend,
  type RuntimeExecOptions,
  type RuntimeRunOptions,
} from "../backends/runtime-backend.ts";
import { defineOption } from "../cli/command.ts";
import {
  type BackgroundRequest,
  selfInvocation,
  startBackgroundCommand,
} from "../lib/background-command/launch.ts";
import { HackCliError } from "../lib/cli-result.ts";
import { resolveComposeProjectName } from "../lib/compose-project-name.ts";
import { selectLegacyComposeAdoptedRoot } from "../lib/native-compose-adoption-command.ts";
import { selectNativeComposeProject } from "../lib/native-compose-selection.ts";
import {
  type ProjectContext,
  readProjectConfig,
  sanitizeProjectSlug,
} from "../lib/project.ts";

/**
 * Background (`--detach`) flags shared by `hack exec` and `hack run`, and the
 * two calls their handlers make. Decision logic lives in
 * `src/lib/background-command/`; this file only adapts parsed CLI inputs.
 */

const optDetachCommand = defineOption({
  name: "detach",
  type: "boolean",
  long: "--detach",
  description:
    "Start in the background and print a command id at once; read it with `hack commands read <id>`",
} as const);

const optCommandJson = defineOption({
  name: "json",
  type: "boolean",
  long: "--json",
  description: "With --detach: print the start result as a JSON envelope",
} as const);

const optRequestKey = defineOption({
  name: "requestKey",
  type: "string",
  long: "--request-key",
  valueHint: "<key>",
  description:
    "With --detach: retrying the same key with the same inputs returns the existing command instead of running it again",
} as const);

const optTimeoutMs = defineOption({
  name: "timeoutMs",
  type: "number",
  long: "--timeout-ms",
  valueHint: "<ms>",
  description:
    "With --detach: stop the command after this long (default 1800000, maximum 21600000)",
} as const);

const optStallAfterMs = defineOption({
  name: "stallAfterMs",
  type: "number",
  long: "--stall-after-ms",
  valueHint: "<ms>",
  description:
    "With --detach: report an advisory stall after this long without output (default 120000, 0 turns it off)",
} as const);

const optCapture = defineOption({
  name: "capture",
  type: "string",
  long: "--capture",
  valueHint: "<full|metadata>",
  description:
    "With --detach: store output (full, the default) or only events and the outcome (metadata)",
} as const);

export const backgroundCommandOptions = [
  optDetachCommand,
  optCommandJson,
  optRequestKey,
  optTimeoutMs,
  optStallAfterMs,
  optCapture,
] as const;

/** Instance id recorded for a command; `@base` cannot collide with a branch slug. */
export function instanceIdFor(branch: string | null): string {
  return branch ?? "@base";
}

export async function resolveProjectId(
  project: ProjectContext
): Promise<string> {
  const cfg = await readProjectConfig(project);
  return sanitizeProjectSlug(await resolveComposeProjectName({ project, cfg }));
}

/** Values already resolved for this command's Compose environment. */
export function collectRedactionValues(opts: {
  readonly env: Readonly<Record<string, string>>;
  readonly serviceEnv: Readonly<Record<string, string>> | undefined;
}): string[] {
  return [
    ...new Set([
      ...Object.values(opts.env),
      ...Object.values(opts.serviceEnv ?? {}),
    ]),
  ].filter((value) => value.length > 0);
}

function spawnEnv(
  overrides: Readonly<Record<string, string>> | undefined
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  return { ...env, ...overrides };
}

/** Background form of the final `composeRuntimeBackend.exec|run` call. */
export async function startComposeBackgroundCommand(opts: {
  readonly request: BackgroundRequest;
  readonly project: ProjectContext;
  readonly branch: string | null;
  readonly compose:
    | { readonly operation: "exec"; readonly options: RuntimeExecOptions }
    | { readonly operation: "run"; readonly options: RuntimeRunOptions };
  readonly redactValues: readonly string[];
  readonly overlay: string | null;
}): Promise<number> {
  const { options } = opts.compose;
  const argv =
    opts.compose.operation === "exec"
      ? buildComposeExecCommand({
          options: opts.compose.options,
          disableTty: true,
        })
      : buildComposeRunCommand({
          options: opts.compose.options,
          disableTty: true,
        });
  return await startBackgroundCommand({
    request: opts.request,
    operation: opts.compose.operation,
    backend: "compose",
    projectId: await resolveProjectId(opts.project),
    projectRoot: opts.project.projectRoot,
    projectDir: opts.project.projectDir,
    instanceId: instanceIdFor(opts.branch),
    service: options.service,
    argv: [...options.cmdArgs],
    workdir: options.workdir ?? null,
    child: { argv, cwd: options.cwd, env: spawnEnv(options.env) },
    redactValues: opts.redactValues,
    overlay: opts.overlay,
  });
}

/**
 * The last step of Compose `hack exec`/`hack run`: run in the foreground, or,
 * with `--detach`, start in the background with the same Compose argv and env.
 */
export async function runOrStartComposeCommand(opts: {
  readonly background: BackgroundRequest | null;
  readonly project: ProjectContext;
  readonly branch: string | null;
  readonly compose:
    | { readonly operation: "exec"; readonly options: RuntimeExecOptions }
    | { readonly operation: "run"; readonly options: RuntimeRunOptions };
  readonly envOverrides: {
    readonly effectiveEnvName: string | null;
    readonly env: Readonly<Record<string, string>>;
    readonly preflightEnvByService: Readonly<
      Record<string, Readonly<Record<string, string>>>
    >;
  };
}): Promise<number> {
  const { compose } = opts;
  if (!opts.background) {
    return compose.operation === "exec"
      ? await composeRuntimeBackend.exec(compose.options)
      : await composeRuntimeBackend.run(compose.options);
  }
  return await startComposeBackgroundCommand({
    request: opts.background,
    project: opts.project,
    branch: opts.branch,
    compose,
    overlay: opts.envOverrides.effectiveEnvName,
    redactValues: collectRedactionValues({
      env: opts.envOverrides.env,
      serviceEnv:
        opts.envOverrides.preflightEnvByService[compose.options.service],
    }),
  });
}

/**
 * Native backend: the supervisor runs this same CLI in the foreground. Native
 * output arrives in one batch when the command ends, so live output and stall
 * detection are reported unavailable; Hack resolved no values here, so nothing
 * is redacted.
 */
export async function startNativeBackgroundCommand(opts: {
  readonly request: BackgroundRequest;
  readonly operation: "exec" | "run";
  readonly project: ProjectContext;
  readonly branch: string | null;
  readonly cwd: string;
  readonly service: string;
  readonly cmdArgs: readonly string[];
  readonly options: {
    readonly env?: string;
    readonly branch?: string;
    readonly workdir?: string;
    readonly profile?: string;
  };
}): Promise<number> {
  return await startBackgroundCommand({
    request: opts.request,
    operation: opts.operation,
    backend: "native",
    projectId: await resolveProjectId(opts.project),
    projectRoot: opts.project.projectRoot,
    projectDir: opts.project.projectDir,
    instanceId: instanceIdFor(opts.branch),
    service: opts.service,
    argv: [...opts.cmdArgs],
    workdir: opts.options.workdir ?? null,
    child: {
      argv: [
        ...selfInvocation(),
        ...buildForegroundCliArgs({
          operation: opts.operation,
          projectRoot: opts.project.projectRoot,
          options: opts.options,
          service: opts.service,
          cmdArgs: opts.cmdArgs,
        }),
      ],
      cwd: opts.cwd,
      env: spawnEnv({ HACK_NO_INTERACTIVE: "1" }),
    },
    redactValues: [],
    overlay: opts.options.env ?? null,
  });
}

/** Foreground `hack exec|run` argv; values are fused and `--` ends hack options. */
export function buildForegroundCliArgs(opts: {
  readonly operation: "exec" | "run";
  readonly projectRoot: string;
  readonly options: {
    readonly env?: string;
    readonly branch?: string;
    readonly workdir?: string;
    readonly profile?: string;
  };
  readonly service: string;
  readonly cmdArgs: readonly string[];
}): string[] {
  const { options } = opts;
  return [
    opts.operation,
    `--path=${opts.projectRoot}`,
    ...(options.env === undefined ? [] : [`--env=${options.env}`]),
    ...(options.branch === undefined ? [] : [`--branch=${options.branch}`]),
    ...(options.workdir === undefined ? [] : [`--workdir=${options.workdir}`]),
    ...(options.profile === undefined ? [] : [`--profile=${options.profile}`]),
    "--",
    opts.service,
    ...opts.cmdArgs,
  ];
}

/**
 * Authored (`.hack/hack.project.json`) and adopted projects run `exec` and
 * `run` through their own dispatch, which has no background mode yet. Refuse
 * `--detach` for them, so it is never accepted and then run in the
 * foreground.
 */
export async function refuseDetachForAuthoredProject(opts: {
  readonly cwd: string;
  readonly path?: string;
  readonly project?: string;
  /** Test seams. */
  readonly selectAuthored?: typeof selectNativeComposeProject;
  readonly selectAdopted?: typeof selectLegacyComposeAdoptedRoot;
}): Promise<void> {
  const selection = { cwd: opts.cwd, path: opts.path, project: opts.project };
  const authored = await (opts.selectAuthored ?? selectNativeComposeProject)(
    selection
  );
  const adopted =
    authored ??
    (await (opts.selectAdopted ?? selectLegacyComposeAdoptedRoot)(selection));
  if (authored || adopted) {
    throw new HackCliError({
      code: "E_USAGE",
      message:
        "--detach is not supported yet for projects with native or adopted configuration; run the command in the foreground.",
    });
  }
}
