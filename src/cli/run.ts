import { cancel } from "@clack/prompts";
import { logger } from "../ui/logger.ts";
import {
  type AnyCommandSpec,
  CliUsageError,
  collectAllowedOptionNames,
  collectUnionOptionNames,
  hasHandler,
  parseCliArgv,
  parseOptionsForCommand,
  parsePositionalsForCommand,
  resolveCommand,
} from "./command.ts";
import { printHelpForPath } from "./help.ts";
import { maybeEnsureAgentIntegrations } from "./integration-sync.ts";
import { CLI_SPEC } from "./spec.ts";

export async function runCli(argv: readonly string[]): Promise<number> {
  try {
    const cli = CLI_SPEC;
    const allowUnknownOptions = shouldAllowUnknownOptions({
      cli,
      argv,
    });
    const parsed = parseCliArgv(cli, argv, { allowUnknownOptions });

    const helpFlag = parsed.values.help === true;
    const versionFlag = parsed.values.version === true;

    if (versionFlag) {
      process.stdout.write(`${cli.name} v${cli.version}\n`);
      return 0;
    }

    const resolved = resolveCommand(cli, parsed.positionals);

    if (helpFlag) {
      await printHelpForPath(cli, parsed.positionals);
      return 0;
    }

    if (!resolved.command) {
      // No command matched; show root help.
      await printHelpForPath(cli, []);
      return parsed.positionals.length === 0 ? 1 : 1;
    }

    validateResolvedCommandOptions({
      cli,
      command: resolved.command,
      parsedValues: parsed.values,
    });

    // If the resolved command has no handler, it acts as a namespace.
    if (!hasHandler(resolved.command)) {
      const pathTokens = resolved.path.map((c) => c.name);
      await printHelpForPath(cli, pathTokens);
      return 1;
    }

    const opts = parseOptionsForCommand(
      resolved.command.options,
      parsed.values
    );
    const pos = parsePositionalsForCommand(
      resolved.command.positionals,
      resolved.remainingPositionals
    );

    await maybeEnsureAgentIntegrations({
      cwd: process.cwd(),
      commandPath: resolved.path.map((command) => command.name),
    });

    return await resolved.command.handler({
      ctx: { cwd: process.cwd(), cli },
      args: {
        options: opts,
        positionals: pos,
        raw: { argv, positionals: resolved.remainingPositionals },
      },
    });
  } catch (error: unknown) {
    if (error instanceof CliUsageError) {
      logger.error({ message: error.message });
      await printHelpForPath(CLI_SPEC, []);
      return 1;
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    cancel(message);
    if (error instanceof Error && error.stack) {
      logger.error({ message: error.stack });
    }
    return 1;
  }
}

function isExtensionDispatch(opts: {
  readonly argv: readonly string[];
}): boolean {
  for (const token of opts.argv) {
    if (token === "--") {
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    return token === "x" || token === "tickets";
  }
  return false;
}

function shouldAllowUnknownOptions(opts: {
  readonly cli: typeof CLI_SPEC;
  readonly argv: readonly string[];
}): boolean {
  if (isExtensionDispatch({ argv: opts.argv })) {
    return true;
  }

  const firstCommandToken = opts.argv.find(
    (token) => token !== "--" && !token.startsWith("-")
  );
  if (!firstCommandToken) {
    return false;
  }

  const command = opts.cli.commands.find(
    (entry) => entry.name === firstCommandToken
  );
  return allowsUnknownOptions({ command: command ?? null });
}

function validateResolvedCommandOptions(opts: {
  readonly cli: typeof CLI_SPEC;
  readonly command: AnyCommandSpec;
  readonly parsedValues: Record<string, unknown>;
}): void {
  if (
    opts.command.name === "x" ||
    opts.command.name === "tickets" ||
    allowsUnknownOptions({ command: opts.command })
  ) {
    return;
  }

  const unionOptNames = collectUnionOptionNames(opts.cli);
  const unknownOptions = Object.keys(opts.parsedValues).filter(
    (key) => !unionOptNames.has(key)
  );
  if (unknownOptions.length > 0) {
    throw new CliUsageError(
      `Unknown option(s): ${unknownOptions.map((option) => `--${option}`).join(", ")}`
    );
  }

  const allowedForCommand = collectAllowedOptionNames(opts.cli, opts.command);
  const disallowed = Object.keys(opts.parsedValues).filter(
    (key) => !allowedForCommand.has(key)
  );
  if (disallowed.length > 0) {
    throw new CliUsageError(
      `Option(s) not valid for "${opts.command.name}": ${disallowed.map((option) => `--${option}`).join(", ")}`
    );
  }
}

function allowsUnknownOptions(opts: {
  readonly command: AnyCommandSpec | null;
}): boolean {
  return (
    opts.command !== null &&
    "allowUnknownOptions" in opts.command &&
    opts.command.allowUnknownOptions === true
  );
}
