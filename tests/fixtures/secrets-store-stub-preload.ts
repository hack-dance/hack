import { spyOn } from "bun:test";
import { appendFileSync } from "node:fs";
import { secrets } from "bun";

/**
 * Preload for a source CLI child (`bun --preload <this> index.ts secrets ...`)
 * that replaces `Bun.secrets` with a stub, so no test reaches the OS keychain.
 *
 * Each call appends one line `<method> <service> <name>` to the file named by
 * `HACK_TEST_SECRETS_LOG` (values are never written). `get` answers null,
 * `set` stores nothing, and `delete` answers true, as if the secret existed.
 */
const log = process.env.HACK_TEST_SECRETS_LOG;
if (!log) {
  throw new Error("Missing HACK_TEST_SECRETS_LOG");
}
const logPath: string = log;

function record(method: string, opts: unknown): void {
  const { service, name } = (opts ?? {}) as {
    readonly service?: unknown;
    readonly name?: unknown;
  };
  appendFileSync(logPath, `${method} ${String(service)} ${String(name)}\n`);
}

spyOn(secrets, "get").mockImplementation(async (opts) => {
  record("get", opts);
  return null;
});
spyOn(secrets, "set").mockImplementation(async (opts) => {
  record("set", opts);
});
spyOn(secrets, "delete").mockImplementation(async (opts) => {
  record("delete", opts);
  return true;
});
