import type { CliContext, CommandArgs } from "../cli/command.ts";
import { CliUsageError, defineCommand, withHandler } from "../cli/command.ts";
import { loadExtensionManagerForCli } from "../control-plane/extensions/cli.ts";
import {
  buildEnableInstructions,
  maybeEnableExtension,
} from "../control-plane/extensions/enable.ts";
import type {
  ExtensionCommandInfo,
  ResolvedExtension,
} from "../control-plane/extensions/types.ts";
import { display } from "../ui/display.ts";
import { logger } from "../ui/logger.ts";

const xSpec = defineCommand({
  name: "x",
  summary: "Run extension commands",
  description: [
    "Usage:",
    "  hack x list",
    "  hack x <namespace> help",
    "  hack x <namespace> <command> [args...]",
    "",
    "Extension commands accept their own flags and arguments.",
    "Use `hack x <namespace> help` to see available commands.",
  ].join("\n"),
  group: "Extensions",
  options: [],
  positionals: [{ name: "args", required: false, multiple: true }],
  subcommands: [],
} as const);

type XArgs = CommandArgs<readonly [], readonly []>;

export const xCommand = withHandler(xSpec, handleX);

async function handleX({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: XArgs;
}): Promise<number> {
  const invocation = parseExtensionInvocation({ argv: args.raw.argv });
  if (!invocation) {
    throw new CliUsageError("Unable to parse extension command.");
  }

  const loaded = await loadExtensionManagerForCli({ cwd: ctx.cwd });
  if (loaded.configError) {
    logger.warn({
      message: `Control plane config error: ${loaded.configError}`,
    });
  }
  for (const warning of loaded.warnings) {
    logger.warn({ message: warning });
  }

  if (!invocation.namespace) {
    await renderDispatcherHelp({ extensions: loaded.manager.listExtensions() });
    return 1;
  }

  if (invocation.namespace === "list") {
    await renderExtensionList({ extensions: loaded.manager.listExtensions() });
    return 0;
  }

  if (invocation.namespace === "resolve") {
    const commandId = invocation.command ?? "";
    if (!commandId) {
      throw new CliUsageError(
        "Missing commandId for `hack x resolve <commandId>`"
      );
    }
    const resolved = loaded.manager.resolveCommandId({ commandId });
    if (!resolved) {
      logger.error({ message: `Unknown commandId: ${commandId}` });
      return 1;
    }
    process.stdout.write(
      `hack x ${resolved.namespace} ${resolved.commandName}\n`
    );
    return 0;
  }

  const extension = loaded.manager.getExtensionByNamespace({
    namespace: invocation.namespace,
  });
  if (!extension) {
    logger.error({
      message: `Unknown extension namespace: ${invocation.namespace}`,
    });
    return 1;
  }

  if (!extension.enabled) {
    const instructions = buildEnableInstructions({
      extension,
      namespace: invocation.namespace ?? "",
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
      namespace: invocation.namespace ?? "",
      command: invocation.command,
      args: invocation.args,
      projectDir: loaded.context.project?.projectDir,
    });

    if (didEnable) {
      const reloaded = await loadExtensionManagerForCli({ cwd: ctx.cwd });
      const nextExtension = reloaded.manager.getExtensionByNamespace({
        namespace: invocation.namespace,
      });
      if (!nextExtension?.enabled) {
        logger.warn({
          message: "Extension still disabled after enable attempt.",
        });
        return 1;
      }

      if (!invocation.command || invocation.command === "help") {
        await renderExtensionHelp({
          extension: nextExtension,
          commands: reloaded.manager.listCommands({
            namespace: nextExtension.namespace,
          }),
        });
        return 0;
      }

      const resolved = reloaded.manager.resolveCommand({
        namespace: nextExtension.namespace,
        commandName: invocation.command,
      });
      if (!resolved) {
        logger.error({
          message: `Unknown command "${invocation.command}" for ${nextExtension.namespace}`,
        });
        return 1;
      }

      return await resolved.command.handler({
        ctx: reloaded.context,
        args: invocation.args,
      });
    }

    return 1;
  }

  if (!invocation.command || invocation.command === "help") {
    await renderExtensionHelp({
      extension,
      commands: loaded.manager.listCommands({ namespace: extension.namespace }),
    });
    return 0;
  }

  const resolved = loaded.manager.resolveCommand({
    namespace: extension.namespace,
    commandName: invocation.command,
  });
  if (!resolved) {
    logger.error({
      message: `Unknown command "${invocation.command}" for ${extension.namespace}`,
    });
    return 1;
  }

  return await resolved.command.handler({
    ctx: loaded.context,
    args: invocation.args,
  });
}

type ExtensionInvocation = {
  readonly namespace?: string;
  readonly command?: string;
  readonly args: readonly string[];
};

function parseExtensionInvocation(opts: {
  readonly argv: readonly string[];
}): ExtensionInvocation | null {
  const index = findDispatchIndex({ argv: opts.argv });
  if (index === -1) {
    return null;
  }
  if (opts.argv[index] !== "x") {
    return null;
  }

  const namespace = opts.argv[index + 1];
  const command = opts.argv[index + 2];
  const rawArgs = opts.argv.slice(index + 3);
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;

  return {
    namespace,
    command,
    args,
  };
}

function findDispatchIndex(opts: { readonly argv: readonly string[] }): number {
  for (let i = 0; i < opts.argv.length; i += 1) {
    const token = opts.argv[i] ?? "";
    if (token === "--") {
      return i + 1 < opts.argv.length ? i + 1 : -1;
    }
    if (!token.startsWith("-")) {
      return i;
    }
  }
  return -1;
}

async function renderDispatcherHelp(opts: {
  readonly extensions: readonly ResolvedExtension[];
}): Promise<void> {
  const lines = [
    "Use `hack x list` to see available extensions.",
    "Use `hack x <namespace> help` to view extension commands.",
  ];
  await display.panel({
    title: "Extensions",
    tone: "info",
    lines,
  });

  if (opts.extensions.length > 0) {
    await renderExtensionList({ extensions: opts.extensions });
  }
}

async function renderExtensionList(opts: {
  readonly extensions: readonly ResolvedExtension[];
}): Promise<void> {
  if (opts.extensions.length === 0) {
    await display.panel({
      title: "Extensions",
      tone: "info",
      lines: ["No extensions registered."],
    });
    return;
  }

  await display.table({
    columns: ["Namespace", "Extension ID", "Scopes", "Enabled"],
    rows: opts.extensions.map((ext) => [
      ext.namespace,
      ext.manifest.id,
      ext.manifest.scopes.join(", "),
      ext.enabled ? "yes" : "no",
    ]),
  });
}

async function renderExtensionHelp(opts: {
  readonly extension: ResolvedExtension;
  readonly commands: readonly ExtensionCommandInfo[];
}): Promise<void> {
  if (opts.commands.length === 0) {
    await display.panel({
      title: `${opts.extension.namespace}`,
      tone: "info",
      lines: ["No commands registered for this extension."],
    });
    return;
  }

  await display.table({
    columns: ["Command", "Summary", "Command ID"],
    rows: opts.commands.map((cmd) => [cmd.name, cmd.summary, cmd.commandId]),
  });
}
