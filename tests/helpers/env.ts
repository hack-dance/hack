/**
 * Sets one environment variable, or removes it when `value` is undefined. Assigning `undefined`
 * to a `process.env` key stores the string "undefined" in Bun 1.4 (as in Node), which then leaks
 * into later tests in the same process, so a missing value must be deleted instead.
 *
 * Before a delete, the key is set to "". Bun copies assignments to the proxy keys (`HTTP_PROXY`,
 * `HTTPS_PROXY`, `NO_PROXY` and their lower-case forms) into the environment that `fetch` and
 * `Bun.spawn` without `env` use. Bun 1.4.2 did not carry a delete there, so a deleted proxy kept
 * routing later `fetch` calls (HACK-1327). Bun 1.4.4 does; tests/global-state-guard.test.ts checks
 * this, and the empty assignment stays as a harmless guard against a regression.
 */
export function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    process.env[key] = "";
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}
