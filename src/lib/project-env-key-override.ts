import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute, resolve } from "node:path";
import { CliUsageError } from "../cli/command.ts";

/**
 * A one-run choice of where the project env key comes from (HACK-2287, R26).
 *
 * The CLI carries only a location: a key file path or the NAME of an
 * environment variable. The key itself never appears on argv, in this value,
 * or in any message built from it. `project-env-config.ts` reads the key from
 * the location when a key is needed.
 *
 * Invariant: while an override is active, key discovery uses only the
 * override. It never falls back to the checkout, shared or primary key files
 * or to `HACK_ENV_SECRET_KEY`, and no key file is created.
 */
export type ProjectEnvKeyOverride =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "env"; readonly name: string };

const KEY_ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/** Value-free: the argument may be a key pasted into the wrong place. */
export const KEY_ENV_NAME_INVALID_MESSAGE =
  "Invalid --key-env value: pass the NAME of an environment variable that holds the key (matching ^[A-Z_][A-Z0-9_]*$), never the key itself. The argument is not shown because it may contain a key.";
export const KEY_OVERRIDE_CONFLICT_MESSAGE =
  "Use either --key-file or --key-env, not both.";
export const KEY_FILE_EMPTY_MESSAGE =
  "Invalid --key-file value: pass a path to a key file.";

const overrideStorage = new AsyncLocalStorage<ProjectEnvKeyOverride>();

/**
 * Parse `--key-file` / `--key-env` into an override, or null when neither is
 * given. A relative key file path resolves against `cwd`. Refusals never echo
 * the argument.
 */
export function parseProjectEnvKeyOverride(input: {
  readonly keyFile: string | undefined;
  readonly keyEnv: string | undefined;
  readonly cwd: string;
}): ProjectEnvKeyOverride | null {
  if (input.keyFile !== undefined && input.keyEnv !== undefined) {
    throw new CliUsageError(KEY_OVERRIDE_CONFLICT_MESSAGE);
  }
  if (input.keyEnv !== undefined) {
    const name = input.keyEnv.trim();
    if (!KEY_ENV_NAME_PATTERN.test(name)) {
      throw new CliUsageError(KEY_ENV_NAME_INVALID_MESSAGE);
    }
    return { kind: "env", name };
  }
  if (input.keyFile !== undefined) {
    const path = input.keyFile.trim();
    if (path.length === 0) {
      throw new CliUsageError(KEY_FILE_EMPTY_MESSAGE);
    }
    return {
      kind: "file",
      path: isAbsolute(path) ? path : resolve(input.cwd, path),
    };
  }
  return null;
}

/** Run `fn` with `override` as the key source for every key read inside it. */
export async function runWithProjectEnvKeyOverride<T>(input: {
  readonly override: ProjectEnvKeyOverride | null;
  readonly run: () => Promise<T>;
}): Promise<T> {
  if (input.override === null) {
    return await input.run();
  }
  return await overrideStorage.run(input.override, input.run);
}

/** The override active for the current async context, if any. */
export function currentProjectEnvKeyOverride(): ProjectEnvKeyOverride | null {
  return overrideStorage.getStore() ?? null;
}
