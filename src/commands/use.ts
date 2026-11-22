import { dirname } from "node:path";
import { resolveNativeRuntimeSelection } from "../backends/native-runtime-client.ts";
import { composeRuntimeBackend } from "../backends/runtime-backend.ts";
import { defineCommand, withHandler } from "../cli/command.ts";
import { optPath, optProject } from "../cli/options.ts";
import { HackCliError } from "../lib/cli-result.ts";
import { resolveComposeProjectName } from "../lib/compose-project-name.ts";
import { readComposePs } from "../lib/compose-ps-result.ts";
import { readProjectConfig } from "../lib/project.ts";
import {
  parseRemoteChoices,
  readRemoteChoices,
  resolveRemoteChoices,
  saveRemoteChoices,
} from "../lib/project-remote-selection.ts";
import { formatProjectRemoteAddress } from "../lib/project-remote-status.ts";
import {
  resolveEffectiveBranchForCommand,
  resolveProjectForArgs,
} from "./project.ts";

const spec = defineCommand({
  name: "use",
  group: "Project",
  summary: "List remote selections or save a target for the next Compose start",
  options: [optPath, optProject],
  positionals: [{ name: "selection", required: false }],
  subcommands: [],
} as const);

export const useCommand = withHandler(spec, async ({ ctx, args }) => {
  if (resolveNativeRuntimeSelection()) {
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
  if (args.positionals.selection === undefined) {
    for (const choice of pending) {
      process.stdout.write(
        `${choice.remote} · running: unknown · pending: ${choice.target} (${choice.source}) · ${formatProjectRemoteAddress({ ...choice.address, port: choice.port })}${choice.via ? " · tunnel not started by this version" : ""}\n`
      );
    }
    return 0;
  }

  const branch = await resolveEffectiveBranchForCommand({
    project,
    branchOption: undefined,
  });
  const base = await resolveComposeProjectName({ project, cfg });
  await saveRemoteChoices({
    projectDir: project.projectDir,
    defaults,
    changes,
    assertStopped: async () => {
      const result = await readComposePs({
        run: () =>
          composeRuntimeBackend.psJson({
            composeFiles: [project.composeFile],
            composeProject: branch ? `${base}--${branch}` : base,
            profiles: ["*"],
            cwd: dirname(project.composeFile),
            all: true,
          }),
      });
      if (!result.ok) {
        throw result.error;
      }
      if (
        result.entries.some(
          (entry) => entry.State !== "exited" && entry.State !== "dead"
        )
      ) {
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
