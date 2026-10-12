import {
  type AnyCommandSpec,
  builtinOptions,
  type CliSpec,
} from "../../src/cli/command.ts";

/**
 * Strict validator for `hack ...` invocations quoted in generated agent
 * guidance.
 *
 * Every inline backtick segment (and every `hack ...` line inside a fenced
 * block) is resolved against CLI_SPEC: the longest matching subcommand path is
 * selected, an unmatched plain word under a command that only accepts
 * subcommands is reported as an unknown subcommand, and every `--long-flag`
 * before a standalone `--` must belong to the resolved command or to the
 * global/builtin options. Composite shorthands are expanded only through the
 * explicit allowlist below; anything else unrecognized is a failure.
 */

/** Composite command tokens that guidance uses as shorthand for several commands. */
const COMPOSITE_COMMAND_ALLOWLIST: Readonly<Record<string, readonly string[]>> =
  {
    "up/down/restart/doctor": ["up", "down", "restart", "doctor"],
  };

/** Composite argument values that stand for one of several literal values. */
const COMPOSITE_VALUE_ALLOWLIST: ReadonlySet<string> = new Set([
  "claude|codex",
  "cursor|claude|codex",
]);

const INLINE_SEGMENT_PATTERN = /`([^`\n]+)`/g;
const FENCED_BLOCK_PATTERN = /```[^\n]*\n([\s\S]*?)```/g;
const LONG_FLAG_PATTERN = /^--[a-z0-9][a-z0-9-]*/;
const WHITESPACE_PATTERN = /\s/;
const BARE_WORD_PATTERN = /^[a-z][a-z0-9|/-]*$/;

export type GuidanceCommandIssue = {
  readonly segment: string;
  readonly problem: string;
};

/**
 * Extract every `hack ...` invocation from rendered guidance text.
 *
 * Fenced blocks contribute each line that starts with `hack `; inline
 * backtick segments contribute their full text.
 */
export function extractHackInvocations(rendered: string): string[] {
  const invocations: string[] = [];
  const withoutFences = rendered.replace(
    FENCED_BLOCK_PATTERN,
    (_block, body: string) => {
      for (const line of body.split("\n")) {
        const trimmed = line.trim();
        if (isHackInvocation(trimmed)) {
          invocations.push(trimmed);
        }
      }
      return "";
    }
  );
  for (const match of withoutFences.matchAll(INLINE_SEGMENT_PATTERN)) {
    const segment = (match[1] ?? "").trim();
    if (isHackInvocation(segment)) {
      invocations.push(segment);
    }
  }
  return invocations;
}

/**
 * Validate every `hack ...` invocation in rendered guidance against the CLI
 * spec and return one issue per problem (empty when everything resolves).
 */
export function findGuidanceCommandIssues(opts: {
  readonly cli: CliSpec;
  readonly rendered: string;
}): GuidanceCommandIssue[] {
  const issues: GuidanceCommandIssue[] = [];
  for (const segment of extractHackInvocations(opts.rendered)) {
    for (const problem of validateHackInvocation({
      cli: opts.cli,
      segment,
    })) {
      issues.push({ segment, problem });
    }
  }
  return issues;
}

function isHackInvocation(segment: string): boolean {
  return segment === "hack" || segment.startsWith("hack ");
}

function validateHackInvocation(opts: {
  readonly cli: CliSpec;
  readonly segment: string;
}): string[] {
  const tokens = tokenize(opts.segment).slice(1);
  const first = tokens[0];
  if (first === undefined || isPlaceholder(first) || first.startsWith("-")) {
    return validateFlags({
      cli: opts.cli,
      command: null,
      commandPath: "",
      tokens,
    });
  }

  const composite = COMPOSITE_COMMAND_ALLOWLIST[first];
  if (composite) {
    return composite.flatMap((name) =>
      validateResolvedTokens({
        cli: opts.cli,
        tokens: [name, ...tokens.slice(1)],
      })
    );
  }
  return validateResolvedTokens({ cli: opts.cli, tokens });
}

function validateResolvedTokens(opts: {
  readonly cli: CliSpec;
  readonly tokens: readonly string[];
}): string[] {
  const path: AnyCommandSpec[] = [];
  let level: readonly AnyCommandSpec[] = opts.cli.commands;
  let index = 0;
  while (index < opts.tokens.length) {
    const token = opts.tokens[index] ?? "";
    const next = level.find((command) => command.name === token);
    if (!next) {
      break;
    }
    path.push(next);
    level = next.subcommands;
    index += 1;
  }

  const command = path.at(-1) ?? null;
  const commandPath = path.map((entry) => entry.name).join(" ");
  const nextToken = opts.tokens[index];
  if (command === null) {
    return [`unknown command "${nextToken ?? ""}"`];
  }
  if (
    nextToken !== undefined &&
    COMPOSITE_VALUE_ALLOWLIST.has(nextToken) &&
    command.subcommands.length > 0
  ) {
    return nextToken.split("|").flatMap((alternative) =>
      validateResolvedTokens({
        cli: opts.cli,
        tokens: [
          ...path.map((entry) => entry.name),
          alternative,
          ...opts.tokens.slice(index + 1),
        ],
      })
    );
  }
  if (
    nextToken !== undefined &&
    isPlainWord(nextToken) &&
    command.positionals.length === 0
  ) {
    return [
      command.subcommands.length > 0
        ? `unknown subcommand "${nextToken}" for "hack ${commandPath}"`
        : `unexpected argument "${nextToken}" for "hack ${commandPath}"`,
    ];
  }

  return validateFlags({
    cli: opts.cli,
    command,
    commandPath,
    tokens: opts.tokens.slice(index),
  });
}

function validateFlags(opts: {
  readonly cli: CliSpec;
  readonly command: AnyCommandSpec | null;
  readonly commandPath: string;
  readonly tokens: readonly string[];
}): string[] {
  const allowed = new Set<string>([
    ...builtinOptions().map((option) => option.long),
    ...opts.cli.globalOptions.map((option) => option.long),
    ...(opts.command?.options.map((option) => option.long) ?? []),
  ]);
  const problems: string[] = [];
  for (const token of opts.tokens) {
    if (token === "--") {
      break;
    }
    const flag = LONG_FLAG_PATTERN.exec(token)?.[0];
    if (flag !== undefined && !allowed.has(flag)) {
      problems.push(`unknown flag "${flag}" for "hack ${opts.commandPath}"`);
    }
  }
  return problems;
}

/**
 * A bare word in subcommand position (not an option, placeholder, or quoted
 * value). Unlisted composites such as `a|b` or `a/b` count as bare words so
 * they fail instead of silently skipping validation.
 */
function isPlainWord(token: string): boolean {
  if (token.startsWith("-") || isPlaceholder(token)) {
    return false;
  }
  return BARE_WORD_PATTERN.test(token);
}

function isPlaceholder(token: string): boolean {
  return token.startsWith("<") || token.includes("...");
}

/**
 * Split a quoted command line into whitespace-separated tokens, keeping
 * single- and double-quoted spans together.
 */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const char of segment) {
    if (quote !== null) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (WHITESPACE_PATTERN.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}
