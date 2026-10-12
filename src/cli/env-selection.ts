import {
  ENV_BASE_SELECTION_ALIASES,
  parseEnvConfigSelection,
} from "../lib/project.ts";
import { CliUsageError } from "./command.ts";

const INVALID_ENV_SELECTION_MESSAGE = "Invalid --env value.";

/**
 * Resolve a CLI `--env` value through the one shared selection grammar.
 *
 * - `undefined` (option omitted): callers apply the configured default overlay.
 * - `null`: base layers only. `base`, `default` and `none` (any case) and an
 *   empty value bypass the configured default overlay.
 * - `string`: the canonical overlay name (`normalizeEnvConfigName`).
 *
 * A non-empty value with no usable overlay characters is refused with a fixed,
 * value-free usage error instead of silently selecting the base layers.
 * Every CLI command that accepts `--env` must resolve it here so that
 * `default`/`base` mean the same layers everywhere.
 */
export function resolveRequestedEnvName(input: {
  readonly envOption: string | undefined;
}): string | null | undefined {
  const selection = parseEnvConfigSelection(input.envOption);
  if (input.envOption === undefined) {
    return selection;
  }
  if (selection === undefined) {
    throw new CliUsageError(INVALID_ENV_SELECTION_MESSAGE);
  }
  const trimmed = input.envOption.trim();
  if (
    selection === null &&
    trimmed.length > 0 &&
    !ENV_BASE_SELECTION_ALIASES.has(trimmed.toLowerCase())
  ) {
    throw new CliUsageError(INVALID_ENV_SELECTION_MESSAGE);
  }
  return selection;
}
