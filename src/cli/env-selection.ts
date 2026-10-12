import { parseEnvConfigSelection } from "../lib/project.ts";
import { CliUsageError } from "./command.ts";

/**
 * Fixed refusal for an unusable `--env` value. It names the accepted grammar
 * and never the argument, which may be a mistyped `KEY=value` or a pasted
 * value.
 */
export const INVALID_ENV_SELECTION_MESSAGE =
  "Invalid --env value. Overlay names must match ^[a-z0-9]+(-[a-z0-9]+)*$; use base, default or none for base layers only.";

/**
 * Resolve a CLI `--env` value through the one shared selection grammar.
 *
 * - `undefined` (option omitted): callers apply the configured default overlay.
 * - `null`: base layers only. `base`, `default` and `none` (any case) and an
 *   empty value bypass the configured default overlay.
 * - `string`: the overlay name, which must already be canonical
 *   (`ENV_CONFIG_NAME_PATTERN`); surrounding whitespace is ignored.
 *
 * Anything else, including any value containing `=`, is refused with a fixed,
 * value-free usage error. A requested name is never slugged: slugging
 * `X=secret` to `xsecret` would print part of the value as the selection and
 * write it into an overlay file name.
 *
 * `runCli` resolves `--env` once before any handler runs, so a refusal
 * precedes project discovery, migration, file access and child processes.
 * Every CLI command that accepts `--env` must also resolve it here so that
 * `default`/`base` mean the same layers everywhere.
 */
export function resolveRequestedEnvName(input: {
  readonly envOption: string | undefined;
}): string | null | undefined {
  if (input.envOption === undefined) {
    return undefined;
  }
  const selection = parseEnvConfigSelection(input.envOption);
  if (selection === undefined) {
    throw new CliUsageError(INVALID_ENV_SELECTION_MESSAGE);
  }
  return selection;
}
