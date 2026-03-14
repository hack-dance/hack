import type { CliContext, CommandArgs } from "../cli/command.ts";
import { defineCommand, withHandler } from "../cli/command.ts";
import { loadExtensionManagerForCli } from "../control-plane/extensions/cli.ts";
import {
  buildEnableInstructions,
  maybeEnableExtension,
} from "../control-plane/extensions/enable.ts";
import { display } from "../ui/display.ts";
import { logger } from "../ui/logger.ts";

/**
 * Top-level Linear command that delegates to the linear extension.
 */
const linearSpec = defineCommand({
  name: "linear",
  summary: "Linear account connection and ticket sync",
  description: [
    "Usage:",
    "  hack linear status",
    "  hack linear connect --profile work --set-default",
    "  hack linear connect --profile default --stdin",
    "  hack linear oauth-connect --profile work --set-default",
    "  hack linear project-bind --project-id <linear-project-id>",
    "  hack linear sync-issue --from linear --issue ENG-123",
    "  hack linear sync-issue --from hack --ticket T-AB12CD34EF",
    "  hack linear sync-project --from linear --project-id <linear-project-id>",
    "",
    "Alias for `hack x linear <command>`. Requires extension enabled.",
  ].join("\n"),
  group: "Project",
  options: [],
  positionals: [{ name: "args", required: false, multiple: true }],
  subcommands: [],
} as const);

type LinearArgs = CommandArgs<readonly [], readonly []>;

export const linearCommand = withHandler(linearSpec, handleLinear);

async function handleLinear({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: LinearArgs;
}): Promise<number> {
  const invocation = parseInvocation({ argv: args.raw.argv });
  const allowWhenDisabled = shouldAllowWhenExtensionDisabled({
    command: invocation.command,
  });

  const loaded = await loadExtensionManagerForCli({ cwd: ctx.cwd });
  if (loaded.configError) {
    logger.warn({
      message: `Control plane config error: ${loaded.configError}`,
    });
  }
  for (const warning of loaded.warnings) {
    logger.warn({ message: warning });
  }

  const extension = loaded.manager.getExtensionByNamespace({
    namespace: "linear",
  });
  if (!extension) {
    logger.error({ message: "Linear extension not found. Is it registered?" });
    return 1;
  }

  if (!(extension.enabled || allowWhenDisabled)) {
    const instructions = buildEnableInstructions({
      extension,
      namespace: "linear",
      command: invocation.command,
      args: invocation.args,
    });
    await display.panel({
      title: "Extension disabled",
      tone: "warn",
      lines: instructions.lines,
    });

    const didEnable = await maybeEnableExtension({
      extension,
      namespace: "linear",
      command: invocation.command,
      args: invocation.args,
      projectDir: loaded.context.project?.projectDir,
    });
    if (!didEnable) {
      return 1;
    }
  }

  const reloaded = await loadExtensionManagerForCli({ cwd: ctx.cwd });
  const reloadedExtension = reloaded.manager.getExtensionByNamespace({
    namespace: "linear",
  });
  if (!reloadedExtension) {
    logger.error({ message: "Linear extension not found after reload." });
    return 1;
  }

  if (!invocation.command || invocation.command === "help") {
    await renderHelp({
      commands: reloaded.manager.listCommands({ namespace: "linear" }),
    });
    return 0;
  }

  const resolved = reloaded.manager.resolveCommand({
    namespace: "linear",
    commandName: invocation.command,
  });
  if (!resolved) {
    logger.error({ message: `Unknown linear command: ${invocation.command}` });
    await renderHelp({
      commands: reloaded.manager.listCommands({ namespace: "linear" }),
    });
    return 1;
  }

  return await resolved.command.handler({
    ctx: reloaded.context,
    args: invocation.args,
  });
}

function shouldAllowWhenExtensionDisabled(input: {
  readonly command?: string;
}): boolean {
  const command = input.command ?? "";
  return (
    command === "setup" ||
    command === "project-bind" ||
    command === "connect" ||
    command === "oauth-connect" ||
    command === "disconnect" ||
    command === "status" ||
    command === "profiles" ||
    command === "use" ||
    command === "projects"
  );
}

type Invocation = {
  readonly command?: string;
  readonly args: readonly string[];
};

function parseInvocation(input: {
  readonly argv: readonly string[];
}): Invocation {
  const index = input.argv.indexOf("linear");
  if (index === -1) {
    return { args: [] };
  }
  const command = input.argv[index + 1];
  const rawArgs = input.argv.slice(index + 2);
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  return { command, args };
}

async function renderHelp(input: {
  readonly commands: readonly {
    readonly name: string;
    readonly summary: string;
    readonly commandId: string;
  }[];
}): Promise<void> {
  if (input.commands.length === 0) {
    await display.panel({
      title: "Linear",
      tone: "info",
      lines: ["No commands available."],
    });
    return;
  }
  await display.table({
    columns: ["Command", "Summary"],
    rows: input.commands.map((cmd) => [`hack linear ${cmd.name}`, cmd.summary]),
  });
}
