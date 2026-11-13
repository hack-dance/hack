import { randomBytes } from "node:crypto";
import {
  buildComposeArgs,
  buildComposeExecCommand,
  buildComposeRunCommand,
  composeRuntimeBackend,
  type RuntimeExecOptions,
  type RuntimeRunOptions,
} from "../backends/runtime-backend.ts";
import { defineOption } from "../cli/command.ts";
import { GUEST_MARKER_ENV } from "../lib/background-command/container-stop.ts";
import {
  type BackgroundRequest,
  requestIdentity,
  selfInvocation,
  startBackgroundCommand,
  withoutBunRuntimeEnv,
} from "../lib/background-command/launch.ts";
import { pruneStore } from "../lib/background-command/store.ts";
import { childEnvironment } from "../lib/child-environment.ts";
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
  return childEnvironment(process.env, overrides);
}

function randomToken(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let token = "";
  for (const byte of randomBytes(20)) {
    token += alphabet[byte % alphabet.length];
  }
  return token;
}

/** The caller-supplied options of `hack exec|run` that define a request. */
export type CallerOptions = {
  readonly env?: string;
  readonly workdir?: string;
  readonly profile?: string;
};

/**
 * Request identity from what the caller typed (see `requestIdentity`). The
 * same function serves the early request-key lookup and the acceptance, so a
 * retry matches whatever the runtime state is now.
 */
export function callerIdentity(opts: {
  readonly request: BackgroundRequest;
  readonly operation: "exec" | "run";
  readonly projectRoot: string;
  readonly branch: string | null;
  readonly service: string;
  readonly cmdArgs: readonly string[];
  readonly options: CallerOptions;
}): Record<string, unknown> {
  const workdir = (opts.options.workdir ?? "").trim();
  return requestIdentity({
    request: opts.request,
    operation: opts.operation,
    projectRoot: opts.projectRoot,
    instanceId: instanceIdFor(opts.branch),
    service: opts.service.trim(),
    argv: opts.cmdArgs,
    workdir: workdir.length > 0 ? workdir : null,
    overlay: opts.options.env ?? null,
    profiles: opts.options.profile ?? null,
  });
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
  readonly identity: Record<string, unknown>;
}): Promise<number> {
  const { options } = opts.compose;
  // A `run` gets a named one-off container so a cancel or timeout can remove
  // it; stopping the Compose client alone leaves it running.
  const container =
    opts.compose.operation === "run"
      ? { name: `hack-bg-${randomToken()}`, service: options.service }
      : undefined;
  // An `exec` marks its process in the container so a stop can find and end
  // it; stopping the Compose client alone leaves it running.
  const guest =
    opts.compose.operation === "exec"
      ? {
          marker: randomToken(),
          service: options.service,
          compose: buildComposeArgs(options),
        }
      : undefined;
  const argv =
    opts.compose.operation === "exec"
      ? buildComposeExecCommand({
          options: opts.compose.options,
          disableTty: true,
          guestEnv: { [GUEST_MARKER_ENV]: guest?.marker ?? "" },
        })
      : buildComposeRunCommand({
          options: opts.compose.options,
          disableTty: true,
          containerName: container?.name,
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
    child: {
      argv,
      cwd: options.cwd,
      env: spawnEnv(options.env),
      ...(container ? { container } : {}),
      ...(guest ? { guest } : {}),
    },
    requestIdentity: opts.identity,
    redactValues: opts.redactValues,
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
  /** The caller's own options, for the request identity. */
  readonly callerOptions: CallerOptions;
  readonly envOverrides: {
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
    identity: callerIdentity({
      request: opts.background,
      operation: compose.operation,
      projectRoot: opts.project.projectRoot,
      branch: opts.branch,
      service: compose.options.service,
      cmdArgs: compose.options.cmdArgs,
      options: opts.callerOptions,
    }),
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
      // The native child is this hack binary: no Bun runtime settings.
      env: withoutBunRuntimeEnv(spawnEnv({ HACK_NO_INTERACTIVE: "1" })),
    },
    redactValues: [],
    requestIdentity: callerIdentity({
      request: opts.request,
      operation: opts.operation,
      projectRoot: opts.project.projectRoot,
      branch: opts.branch,
      service: opts.service,
      cmdArgs: opts.cmdArgs,
      options: opts.options,
    }),
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
        "--detach is not supported yet for projects with native (.hack/hack.project.json) or adopted configuration: their exec and run go through a separate dispatcher with its own generation store and ownership proofs, which the background launcher does not use. Run the command in the foreground.",
    });
  }
}

/**
 * `run --detach` with dependency-cache installers to run first is refused:
 * the installers would run before the request is accepted, deduplicated and
 * admitted, so a retry or a refused request could repeat them.
 */
export function refuseDetachedCacheBootstrap(opts: {
  readonly background: BackgroundRequest | null;
  readonly services: readonly string[];
}): void {
  if (opts.background && opts.services.length > 0) {
    throw new HackCliError({
      code: "E_USAGE",
      message:
        "run --detach is not supported for a service whose shared dependency cache has an installer that runs before it: the installer would run before the request is accepted and deduplicated. Run the command in the foreground, or use exec --detach against the running service.",
    });
  }
}

/**
 * Run the background-command retention sweep (best effort, never waiting on
 * a busy store) before a handler. Used for `hack up` and `hack down`, so
 * expired output is removed even when no background command is used again.
 */
export function withBackgroundSweep<Input, Result>(
  handler: (input: Input) => Promise<Result>
): (input: Input) => Promise<Result> {
  return async (input) => {
    await pruneStore();
    return await handler(input);
  };
}
