/**
 * Restore an env var captured before a test.
 *
 * Bun 1.4.4 stores `process.env.X = undefined` as the string "undefined",
 * which leaks into later test files (e.g. HACK_GLOBAL_CONFIG_PATH="undefined"
 * makes the projects registry resolve to the cwd). Delete instead.
 */
export function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}
