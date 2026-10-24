/**
 * Sets one environment variable, or removes it when `value` is undefined. Assigning `undefined`
 * to a `process.env` key stores the string "undefined" in Bun 1.4 (as in Node), which then leaks
 * into later tests in the same process, so a missing value must be deleted instead.
 *
 * Before a delete, the key is set to "". Bun 1.4 copies assignments to the proxy keys
 * (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and their lower-case forms) into the environment that
 * `fetch` and `Bun.spawn` without `env` use, but a delete never reaches it. Without the empty
 * assignment, a proxy a test set and then deleted keeps routing every later `fetch` in the
 * process, including loopback requests, through that proxy (HACK-1327). An empty proxy is no proxy.
 */
export function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    process.env[key] = "";
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}
