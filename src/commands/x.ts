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

  const loaded = await loadAndLogExtensionManager({ cwd: ctx.cwd });

  const dispatcherResult = await handleDispatcherInvocation({
    loaded,
    invocation,
  });
  if (dispatcherResult !== null) {
    return dispatcherResult;
  }

  const namespace = invocation.namespace ?? "";
  const extension = loaded.manager.getExtensionByNamespace({ namespace });
  if (!extension) {
    logger.error({ message: `Unknown extension namespace: ${namespace}` });
    return 1;
  }

  return await dispatchExtensionCommand({
    ctx,
    loaded,
    extension,
    invocation,
  });
}

async function loadAndLogExtensionManager(opts: {
  readonly cwd: string;
}): Promise<Awaited<ReturnType<typeof loadExtensionManagerForCli>>> {
  const loaded = await loadExtensionManagerForCli({ cwd: opts.cwd });
  if (loaded.configError) {
    logger.warn({
      message: `Control plane config error: ${loaded.configError}`,
    });
  }
  for (const warning of loaded.warnings) {
    logger.warn({ message: warning });
  }
  return loaded;
}

async function handleDispatcherInvocation(opts: {
  readonly loaded: Awaited<ReturnType<typeof loadExtensionManagerForCli>>;
  readonly invocation: ExtensionInvocation;
}): Promise<number | null> {
  if (!opts.invocation.namespace) {
    await renderDispatcherHelp({
      extensions: opts.loaded.manager.listExtensions(),
    });
    return 1;
  }

  if (opts.invocation.namespace === "list") {
    await renderExtensionList({
      extensions: opts.loaded.manager.listExtensions(),
    });
    return 0;
  }

  if (opts.invocation.namespace === "resolve") {
    return handleResolveCommandId({
      loaded: opts.loaded,
      invocation: opts.invocation,
    });
  }

  return null;
}

function handleResolveCommandId(opts: {
  readonly loaded: Awaited<ReturnType<typeof loadExtensionManagerForCli>>;
  readonly invocation: ExtensionInvocation;
}): number {
  const commandId = opts.invocation.command ?? "";
  if (!commandId) {
    throw new CliUsageError(
      "Missing commandId for `hack x resolve <commandId>`"
    );
  }

  const resolved = opts.loaded.manager.resolveCommandId({ commandId });
  if (!resolved) {
    logger.error({ message: `Unknown commandId: ${commandId}` });
    return 1;
  }

  process.stdout.write(
    `hack x ${resolved.namespace} ${resolved.commandName}\n`
  );
  return 0;
}

async function dispatchExtensionCommand(opts: {
  readonly ctx: CliContext;
  readonly loaded: Awaited<ReturnType<typeof loadExtensionManagerForCli>>;
  readonly extension: ResolvedExtension;
  readonly invocation: ExtensionInvocation;
}): Promise<number> {
  if (opts.extension.enabled) {
    return await dispatchEnabledExtensionCommand({
      loaded: opts.loaded,
      extension: opts.extension,
      invocation: opts.invocation,
    });
  }

  const disabledCommandResult = await dispatchDisabledExtensionCommandIfAllowed({
    loaded: opts.loaded,
    extension: opts.extension,
    invocation: opts.invocation,
  });
  if (disabledCommandResult !== null) {
    return disabledCommandResult;
  }

  const didEnable = await promptEnableExtension({
    loaded: opts.loaded,
    extension: opts.extension,
    invocation: opts.invocation,
  });
  if (!didEnable) {
    return 1;
  }

  const reloaded = await loadAndLogExtensionManager({ cwd: opts.ctx.cwd });
  const nextExtension = reloaded.manager.getExtensionByNamespace({
    namespace: opts.extension.namespace,
  });
  if (!nextExtension?.enabled) {
    logger.warn({
      message: "Extension still disabled after enable attempt.",
    });
    return 1;
  }

  return await dispatchEnabledExtensionCommand({
    loaded: reloaded,
    extension: nextExtension,
    invocation: opts.invocation,
  });
}

async function dispatchDisabledExtensionCommandIfAllowed(opts: {
  readonly loaded: Awaited<ReturnType<typeof loadExtensionManagerForCli>>;
  readonly extension: ResolvedExtension;
  readonly invocation: ExtensionInvocation;
}): Promise<number | null> {
  if (!opts.invocation.command || opts.invocation.command === "help") {
    return null;
  }

  const command = opts.extension.commands.find(
    (entry) =>
      entry.name === opts.invocation.command && entry.allowWhenDisabled === true
  );
  if (!command) {
    return null;
  }

  return await command.handler({
    ctx: opts.loaded.context,
    args: opts.invocation.args,
  });
}

async function promptEnableExtension(opts: {
  readonly loaded: Awaited<ReturnType<typeof loadExtensionManagerForCli>>;
  readonly extension: ResolvedExtension;
  readonly invocation: ExtensionInvocation;
}): Promise<boolean> {
  const instructions = buildEnableInstructions({
    extension: opts.extension,
    namespace: opts.invocation.namespace ?? "",
    command: opts.invocation.command,
    args: opts.invocation.args,
  });
  await display.panel({
    title: "Extension disabled",
    tone: "warn",
    lines: instructions.lines,
  });

  return await maybeEnableExtension({
    extension: opts.extension,
    namespace: opts.invocation.namespace ?? "",
    command: opts.invocation.command,
    args: opts.invocation.args,
    projectDir: opts.loaded.context.project?.projectDir,
  });
}

async function dispatchEnabledExtensionCommand(opts: {
  readonly loaded: Awaited<ReturnType<typeof loadExtensionManagerForCli>>;
  readonly extension: ResolvedExtension;
  readonly invocation: ExtensionInvocation;
}): Promise<number> {
  if (!opts.invocation.command || opts.invocation.command === "help") {
    await renderExtensionHelp({
      extension: opts.extension,
      commands: opts.loaded.manager.listCommands({
        namespace: opts.extension.namespace,
      }),
    });
    return 0;
  }

  const resolved = opts.loaded.manager.resolveCommand({
    namespace: opts.extension.namespace,
    commandName: opts.invocation.command,
  });
  if (!resolved) {
    logger.error({
      message: `Unknown command "${opts.invocation.command}" for ${opts.extension.namespace}`,
    });
    await renderExtensionHelp({
      extension: opts.extension,
      commands: opts.loaded.manager.listCommands({
        namespace: opts.extension.namespace,
      }),
    });
    return 1;
  }

  return await resolved.command.handler({
    ctx: opts.loaded.context,
    args: opts.invocation.args,
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
