/**
 * Sets one environment variable, or removes it when `value` is undefined. Assigning `undefined`
 * to a `process.env` key stores the string "undefined" in Bun 1.4 (as in Node), which then leaks
 * into later tests in the same process, so a missing value must be deleted instead.
 */
export function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}
