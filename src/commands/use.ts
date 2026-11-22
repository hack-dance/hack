import { dirname } from "node:path";
import { composeRuntimeBackend } from "../backends/runtime-backend.ts";
import { CliUsageError, defineCommand, withHandler } from "../cli/command.ts";
import { resolveRequestedEnvName } from "../cli/env-selection.ts";
import { optPath, optProject } from "../cli/options.ts";
import { HackCliError } from "../lib/cli-result.ts";
import { resolveComposeProjectName } from "../lib/compose-project-name.ts";
import { readComposePs } from "../lib/compose-ps-result.ts";
import { readProjectConfig } from "../lib/project.ts";
import {
  resolveRemoteInspectionEnv,
  resolveUseInstance,
} from "../lib/project-remote-compose.ts";
import {
  parseRemoteChoices,
  readRemoteChoices,
  resolveRemoteChoices,
  runningRemoteIdentity,
  saveRemoteChoices,
} from "../lib/project-remote-selection.ts";
import { formatProjectRemoteAddress } from "../lib/project-remote-status.ts";
import { readProjectRuntimeStateEntry } from "../lib/project-runtime-state.ts";
import { isHostControlEnvKey } from "../lib/vetted-env.ts";

import { resolveProjectForArgs } from "./project.ts";

const COMPOSE_INSPECTION_TRANSPORT =
  /^(?:DOCKER_HOST|DOCKER_CONTEXT|DOCKER_TLS_VERIFY|DOCKER_CERT_PATH|COMPOSE_PROJECT_NAME|COMPOSE_PROFILES)$/;

const spec = defineCommand({
  name: "use",
  group: "Project",
  summary: "List remote selections or save a target for the next Compose start",
  options: [optPath, optProject],
  positionals: [{ name: "selection", required: false }],
  subcommands: [],
} as const);

export const useCommand = withHandler(spec, async ({ ctx, args }) => {
  if (process.env.HACK_RUNTIME_BACKEND === "native") {
    throw new HackCliError({
      code: "E_NATIVE_PROJECT_UNSUPPORTED",
      message: "Remote selection currently requires the Compose backend.",
    });
  }
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
    touchRegistration: false,
  });
  const cfg = await readProjectConfig(project);
  if (cfg.prerequisites?.error) {
    throw cfg.prerequisites.error;
  }
  const defaults = cfg.prerequisites?.config?.selected ?? [];
  const changes = parseRemoteChoices(args.positionals.selection);
  const pending = resolveRemoteChoices(
    defaults,
    await readRemoteChoices(project.projectDir),
    changes
  );
  if (!pending.length) {
    process.stdout.write("No remotes declared for this project.\n");
    return 0;
  }
  const base = await resolveComposeProjectName({ project, cfg });
  const { composeProjectName, lifecycleComposeProject } =
    await resolveUseInstance({ project, cfg, base });
  const readActive = async () => {
    const managed = await resolveRemoteInspectionEnv({
      project,
      baseProjectName: base,
      composeProject: lifecycleComposeProject,
      requestedEnvName: resolveRequestedEnvName({ envOption: undefined }),
    });
    if (
      ["DOCKER_CONFIG", "HOME", "PATH", "COMPOSE_ENV_FILES"].some(
        (key) =>
          Object.hasOwn(managed, key) && managed[key] !== process.env[key]
      )
    ) {
      throw new CliUsageError(
        "Run hack use with the same Compose client settings in the caller environment."
      );
    }
    const env = Object.fromEntries(
      Object.entries(managed).filter(
        ([key]) =>
          !isHostControlEnvKey(key) || COMPOSE_INSPECTION_TRANSPORT.test(key)
      )
    );
    const result = await readComposePs({
      redactValues: Object.values(env),
      run: () =>
        composeRuntimeBackend.psJson({
          composeFiles: [project.composeFile],
          composeProject: composeProjectName,
          env,
          profiles: ["*"],
          cwd: dirname(project.composeFile),
          all: true,
        }),
    });
    if (!result.ok) {
      throw result.error;
    }
    return result.entries.filter(
      ({ State }) => State !== "exited" && State !== "dead"
    );
  };
  if (args.positionals.selection === undefined) {
    const active = await readActive().catch(() => null);
    const runtime = await readProjectRuntimeStateEntry({
      projectDir: project.projectDir,
      composeProject: lifecycleComposeProject,
    });
    for (const choice of pending) {
      const identity = active && runningRemoteIdentity(active, choice.remote);
      const running = identity?.split(":")[0];
      const [target, digest, source] =
        runtime?.remoteTargets?.[choice.remote]?.split(":") ?? [];
      const fallback = active?.length === 0 ? "stopped" : "unknown";
      const description = running
        ? `${running} (${identity === `${target}:${digest}` && source ? source : "source unknown"})`
        : fallback;
      process.stdout.write(
        `${choice.remote} · running: ${description} · pending: ${choice.target} (${choice.source}) · ${formatProjectRemoteAddress({ ...choice.address, port: choice.port })}${choice.via ? " · tunnel not started by this version" : ""}\n`
      );
    }
    return 0;
  }

  await saveRemoteChoices({
    projectDir: project.projectDir,
    defaults,
    changes,
    assertStopped: async () => {
      if ((await readActive()).length) {
        throw new HackCliError({
          code: "E_USAGE",
          message:
            "The Compose copy is active. Stop it before saving a remote selection.",
        });
      }
    },
  });
  for (const choice of pending.filter(({ source }) => source === "--use")) {
    process.stdout.write(
      `✓ ${choice.remote} → ${choice.target} · saved for this checkout · applies on the next up${choice.via ? " · tunnel not started by this version" : ""}\n`
    );
  }
  return 0;
});
