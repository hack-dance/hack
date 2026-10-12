import {
  assertValidProjectEnvScopeName,
  ENV_KEY_ASSIGNMENT_MESSAGE,
  ENV_KEY_INVALID_MESSAGE,
  ENV_SCOPE_INVALID_MESSAGE,
} from "../lib/project-env-config.ts";
import { CliUsageError } from "./command.ts";

const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const SCOPE_CONFLICT_MESSAGE = "Use either --scope or --service, not both.";
const APPLY_SERVICE_REQUIRED_MESSAGE =
  "--service <compose-service> is required.";

/**
 * Parsers for the env-scope and env-key arguments of `hack env` and
 * `hack host` commands.
 *
 * Invariant: every refusal is fixed text. A scope or key argument is often a
 * mistyped `KEY=value` or a value pasted into the wrong position, so no error
 * raised here may contain any part of the argument. Callers must parse
 * user-supplied scopes here before resolving env files, reading stdin, or
 * spawning a child process, so a refused argument never reaches another
 * component that might echo it.
 */

/** Normalize a `--service`/`--scope` value; empty means `global`. */
export function parseEnvScopeOption(input: {
  readonly scopeName: string | undefined;
}): string {
  try {
    return assertValidProjectEnvScopeName({ scopeName: input.scopeName });
  } catch {
    throw new CliUsageError(ENV_SCOPE_INVALID_MESSAGE);
  }
}

/**
 * Resolve the `--scope`/`--service` pair of host execution commands.
 * Returns `null` when neither names a scope (the global scope).
 */
export function parseExecutionScopeOptions(input: {
  readonly scopeName: string | undefined;
  readonly serviceName: string | undefined;
}): string | null {
  const scopeName = input.scopeName?.trim() ?? "";
  const serviceName = input.serviceName?.trim() ?? "";
  if (scopeName.length > 0 && serviceName.length > 0) {
    throw new CliUsageError(SCOPE_CONFLICT_MESSAGE);
  }
  const requested = scopeName || serviceName;
  if (requested.length === 0) {
    return null;
  }
  return parseEnvScopeOption({ scopeName: requested });
}

/** `hack env materialize --service`: omitted or empty is `null` (global). */
export function parseMaterializeScopeOption(input: {
  readonly serviceName: string | undefined;
}): string | null {
  if ((input.serviceName?.trim() ?? "").length === 0) {
    return null;
  }
  return parseEnvScopeOption({ scopeName: input.serviceName });
}

/** `hack env apply --service`: a single non-global service scope. */
export function parseApplyServiceOption(input: {
  readonly serviceName: string | undefined;
}): string {
  if ((input.serviceName?.trim() ?? "").length === 0) {
    throw new CliUsageError(APPLY_SERVICE_REQUIRED_MESSAGE);
  }
  const scope = parseEnvScopeOption({ scopeName: input.serviceName });
  if (scope === "global") {
    throw new CliUsageError(APPLY_SERVICE_REQUIRED_MESSAGE);
  }
  return scope;
}

/**
 * `hack env get <KEY> [--service <scope>]`. Validated here, before any project
 * or backend access. The command also replaces every failure with one generic
 * message, but these refusals stay value-free on their own so that removing
 * that wrapper cannot reintroduce an echo.
 */
export function parseEnvGetArguments(input: {
  readonly key: string;
  readonly serviceName: string | undefined;
}): { readonly key: string; readonly scope: string } {
  if (input.key.includes("=")) {
    throw new CliUsageError(ENV_KEY_ASSIGNMENT_MESSAGE);
  }
  if (!ENV_KEY_PATTERN.test(input.key)) {
    throw new CliUsageError(ENV_KEY_INVALID_MESSAGE);
  }
  return {
    key: input.key,
    scope: parseEnvScopeOption({ scopeName: input.serviceName }),
  };
}
