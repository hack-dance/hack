import { cancel } from "@clack/prompts";
import {
  emitCliResult,
  errorResultFromUnknown,
  HackCliError,
} from "../lib/cli-result.ts";
import { setNoInteractiveFlag } from "../lib/interactivity.ts";
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

function isTruthyEnv(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export async function runCli(argv: readonly string[]): Promise<number> {
  const jsonRequested = argv.includes("--json");
  try {
    const cli = CLI_SPEC;
    const allowUnknownOptions = shouldAllowUnknownOptions({
      cli,
      argv,
    });
    const parsed = parseCliArgv(cli, argv, { allowUnknownOptions });

    setNoInteractiveFlag({
      enabled: parsed.values["no-interactive"] === true,
    });

    const helpFlag = parsed.values.help === true;
    const versionFlag = parsed.values.version === true;

    if (versionFlag) {
      process.stdout.write(`${cli.name} v${cli.version}\n`);
      return 0;
    }

    const resolved = resolveCommand(cli, parsed.positionals);

    if (helpFlag) {
      await printHelpForPath(cli, parsed.positionals, {
        showExperimental: parsed.values.all === true,
      });
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

    maybeWarnExperimentalCommand({
      path: resolved.path,
      jsonRequested: parsed.values.json === true,
    });

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

    if (jsonRequested) {
      emitCliResult({ result: errorResultFromUnknown({ error }) });
      return 1;
    }

    if (error instanceof HackCliError) {
      logger.error({ message: `${error.code}: ${error.message}` });
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

/**
 * One-line stderr warning when an experimental (Beta-group) command is
 * invoked. Suppressed under `--json` output and when the user acknowledged
 * the experimental surface via `HACK_EXPERIMENTAL_ACK=1`.
 */
function maybeWarnExperimentalCommand(opts: {
  readonly path: readonly AnyCommandSpec[];
  readonly jsonRequested: boolean;
}): void {
  const experimental = opts.path.find((command) => command.group === "Beta");
  if (!experimental) {
    return;
  }
  if (opts.jsonRequested) {
    return;
  }
  if (isTruthyEnv(process.env.HACK_EXPERIMENTAL_ACK)) {
    return;
  }

  const invocation = opts.path.map((command) => command.name).join(" ");
  process.stderr.write(
    `Warning: \`hack ${invocation}\` is experimental and unsupported; behavior may change or break. Set HACK_EXPERIMENTAL_ACK=1 to silence this warning.\n`
  );
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
