import { defineCommand, defineOption, withHandler } from "../cli/command.ts";
import { optJson } from "../cli/options.ts";
import { emitCliResult, HackCliError } from "../lib/cli-result.ts";
import { confirmSafe } from "../lib/interactivity.ts";
import { MACHINE_SCHEMAS, machineSuccess } from "../lib/machine-output.ts";
import {
  planResourceRemoval,
  removeResource,
} from "../lib/resource-removal.ts";
import { listResources } from "../lib/resources-inventory.ts";
import { withComposeNameLock } from "./project-autostart-intent.ts";

const listSpec = defineCommand({
  name: "list",
  group: "Global",
  summary: "List observed Hack resources and disk use",
  options: [optJson],
  positionals: [],
  subcommands: [],
} as const);

const list = withHandler(listSpec, async ({ ctx, args }) => {
  const data = await listResources(ctx.cwd);
  if (args.options.json) {
    emitCliResult({
      result: machineSuccess({ schema: MACHINE_SCHEMAS.resources, data }),
    });
  } else {
    for (const row of data.rows) {
      process.stdout.write(
        `${row.backend} ${row.kind} ${JSON.stringify(row.name)} · ${row.bytes ?? "unknown"} bytes${row.owners.some((owner) => owner.detached) ? " · detached" : ""}\n`
      );
    }
    if (!(data.composeComplete && data.nativeComplete)) {
      process.stdout.write("Some resource observations were unavailable.\n");
    }
  }
  return 0;
});

const removeSpec = defineCommand({
  name: "remove",
  group: "Global",
  summary: "Preview or confirm removal of a verified unused resource",
  options: [
    optJson,
    defineOption({
      name: "dryRun",
      long: "--dry-run",
      type: "boolean",
      description:
        "Show exactly what would be removed without changing anything",
    }),
    defineOption({
      name: "confirm",
      long: "--confirm",
      type: "string",
      valueHint: "<token>",
      description: "Confirm the exact removal reviewed with --dry-run",
    }),
  ],
  positionals: [
    {
      name: "id",
      required: true,
      description: "A container:<id> or volume:<name> from resources list",
    },
  ],
  subcommands: [],
} as const);

const remove = withHandler(removeSpec, async ({ ctx, args }) => {
  const id = args.positionals.id;
  const plan = await planResourceRemoval({ id, cwd: ctx.cwd });
  let removed = false;
  if (!args.options.dryRun) {
    const token = args.options.confirm;
    if (token === undefined && args.options.json) {
      throw new HackCliError({
        code: "E_INTERACTIVE_REQUIRED",
        message:
          "Review resources remove --dry-run, then pass its token with --confirm.",
      });
    }
    if (
      token === undefined &&
      !(await confirmSafe({
        message: plan.message,
        initialValue: false,
        nonInteractive: "fail",
        hint: "Review resources remove --dry-run, then pass the reviewed token with --confirm.",
      }))
    ) {
      return 1;
    }
    await withComposeNameLock(plan.composeProject, () =>
      removeResource({ id, cwd: ctx.cwd, token: token ?? plan.token })
    );
    removed = true;
  }
  const data = { id, message: plan.message, token: plan.token, removed };
  if (args.options.json) {
    emitCliResult({
      result: machineSuccess({ schema: MACHINE_SCHEMAS.resourceRemoval, data }),
    });
  } else {
    process.stdout.write(
      removed
        ? `Removed ${id}.\n`
        : `${plan.message}\nConfirmation token: ${plan.token}\n`
    );
  }
  return 0;
});

export const resourcesCommand = defineCommand({
  name: "resources",
  group: "Global",
  summary: "Inspect and clean up Hack-managed resources",
  options: [],
  positionals: [],
  subcommands: [list, remove],
} as const);
