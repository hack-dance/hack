import { resolve } from "node:path";
import type { CliContext, CommandArgs } from "../cli/command.ts";
import { CliUsageError, defineCommand, withHandler } from "../cli/command.ts";
import { PROJECT_CONFIG_FILENAME } from "../constants.ts";
import { loadExtensionManagerForCli } from "../control-plane/extensions/cli.ts";
import type {
  ExtensionCommandInfo,
  ResolvedExtension,
} from "../control-plane/extensions/types.ts";
import { resolveGlobalConfigPath } from "../lib/config-paths.ts";
import { resolveHackInvocation } from "../lib/hack-cli.ts";
import { display } from "../ui/display.ts";
import { gumConfirm, isGumAvailable } from "../ui/gum.ts";
import { logger } from "../ui/logger.ts";
import { isTty } from "../ui/terminal.ts";

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
    const instructions = buildEnableInstructions({ extension, invocation });
    await display.panel({
      title: "Extension disabled",
      tone: "warn",
      lines: instructions.lines,
    });

    const didEnable = await maybeEnableExtension({
      extension,
      invocation,
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

type EnableInstruction = {
  readonly lines: readonly string[];
  readonly enableCommand?: {
    readonly argv: readonly string[];
    readonly printable: string;
    readonly prompt?: string;
  };
};

function buildEnableInstructions(opts: {
  readonly extension: ResolvedExtension;
  readonly invocation: ExtensionInvocation;
}): EnableInstruction {
  const rerun = buildRerunCommand({ invocation: opts.invocation });
  if (opts.extension.manifest.id === "dance.hack.gateway") {
    return {
      lines: [
        `Extension: ${opts.extension.manifest.id}`,
        "Enable with:",
        "  hack gateway enable",
        ...(rerun ? ["Re-run:", `  ${rerun}`] : []),
      ],
      enableCommand: {
        argv: ["gateway", "enable"],
        printable: "hack gateway enable",
        prompt: "Enable gateway for this project? (runs hack gateway enable)",
      },
    };
  }

  const key = `controlPlane.extensions["${opts.extension.manifest.id}"].enabled`;
  const enableScope = resolveExtensionEnableScope({
    extension: opts.extension,
  });
  const printable = enableScope.isGlobal
    ? `hack config set --global '${key}' true`
    : `hack config set '${key}' true`;
  return {
    lines: [
      `Extension: ${opts.extension.manifest.id}`,
      "Enable with:",
      `  ${printable}`,
      ...(rerun ? ["Re-run:", `  ${rerun}`] : []),
    ],
    enableCommand: {
      argv: enableScope.isGlobal
        ? ["config", "set", "--global", key, "true"]
        : ["config", "set", key, "true"],
      printable,
      prompt: enableScope.prompt,
    },
  };
}

function buildRerunCommand(opts: {
  readonly invocation: ExtensionInvocation;
}): string | null {
  const namespace = opts.invocation.namespace;
  if (!namespace) {
    return null;
  }
  const command = opts.invocation.command ? ` ${opts.invocation.command}` : "";
  const args =
    opts.invocation.args.length > 0 ? ` ${opts.invocation.args.join(" ")}` : "";
  return `hack x ${namespace}${command}${args}`;
}

async function maybeEnableExtension(opts: {
  readonly extension: ResolvedExtension;
  readonly invocation: ExtensionInvocation;
  readonly projectDir?: string;
}): Promise<boolean> {
  if (!(opts.projectDir || opts.extension.manifest.scopes.includes("global"))) {
    return false;
  }
  if (!(isTty() && isGumAvailable())) {
    return false;
  }

  const instructions = buildEnableInstructions({
    extension: opts.extension,
    invocation: opts.invocation,
  });
  if (!instructions.enableCommand) {
    return false;
  }

  const configPath = instructions.enableCommand.prompt
    ? undefined
    : resolveConfigPathForEnable({
        extension: opts.extension,
        projectDir: opts.projectDir,
      });
  const prompt =
    instructions.enableCommand.prompt ??
    (configPath
      ? `Enable ${opts.extension.manifest.id}? (updates ${configPath})`
      : `Enable ${opts.extension.manifest.id}?`);
  const confirmed = await gumConfirm({ prompt, default: true });
  if (!(confirmed.ok && confirmed.value)) {
    return false;
  }

  const invocation = await resolveHackInvocation();
  const proc = Bun.spawn(
    [invocation.bin, ...invocation.args, ...instructions.enableCommand.argv],
    {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }
  );
  const exitCode = await proc.exited;
  return exitCode === 0;
}

function resolveExtensionEnableScope(opts: {
  readonly extension: ResolvedExtension;
}): { readonly isGlobal: boolean; readonly prompt?: string } {
  const isGlobal =
    opts.extension.manifest.scopes.includes("global") &&
    !opts.extension.manifest.scopes.includes("project");
  const prompt = isGlobal
    ? `Enable ${opts.extension.manifest.id}? (updates ${resolveGlobalConfigPath()})`
    : undefined;
  return { isGlobal, ...(prompt ? { prompt } : {}) };
}

function resolveConfigPathForEnable(opts: {
  readonly extension: ResolvedExtension;
  readonly projectDir?: string;
}): string | null {
  if (opts.extension.manifest.scopes.includes("global")) {
    return resolveGlobalConfigPath();
  }
  if (!opts.projectDir) {
    return null;
  }
  return resolve(opts.projectDir, PROJECT_CONFIG_FILENAME);
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
