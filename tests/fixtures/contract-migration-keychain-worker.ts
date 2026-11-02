import { spyOn } from "bun:test";
import { secrets } from "bun";

/**
 * Runs one contract migration with `Bun.secrets` stubbed, so no test reaches the
 * OS keychain, and prints `{ message, calls }` as JSON. `HACK_TEST_KEYCHAIN` picks
 * the keychain: `empty`, `key` or `throw`. One process per scenario, because
 * secret-store.ts caches key material and a failure cooldown at module level.
 */
const PREFLIGHT_SERVICE = "contract-migration-keychain-preflight";
const PREFLIGHT_ANSWER = "stub-active";
const keychain = process.env.HACK_TEST_KEYCHAIN;
const projectRoot = process.env.HACK_TEST_PROJECT_ROOT;
if (!(keychain && projectRoot)) {
  throw new Error("Missing HACK_TEST_KEYCHAIN or HACK_TEST_PROJECT_ROOT");
}
const calls = { get: 0, set: 0, delete: 0 };

spyOn(secrets, "get").mockImplementation(async (opts) => {
  if (opts.service === PREFLIGHT_SERVICE) {
    return PREFLIGHT_ANSWER;
  }
  calls.get += 1;
  if (keychain === "throw") {
    throw new Error("stub keychain failure");
  }
  return keychain === "key" ? "stub-keychain-key" : null;
});
spyOn(secrets, "set").mockImplementation(async () => {
  calls.set += 1;
});
spyOn(secrets, "delete").mockImplementation(async () => {
  calls.delete += 1;
  return false;
});

// Fails before any migration runs if this reference to `secrets` isn't stubbed. The
// test's `calls.get` check shows afterwards that secret-store.ts used the stub too.
const preflight = await secrets.get({
  service: PREFLIGHT_SERVICE,
  name: "preflight",
});
if (preflight !== PREFLIGHT_ANSWER) {
  throw new Error("Bun.secrets stub is not active");
}

const { migrateLegacyProjectEnv } = await import(
  "../../src/lib/project-env-config.ts"
);
const message = await migrateLegacyProjectEnv({
  projectRoot,
  projectDir: `${projectRoot}/.hack`,
  projectName: "contract-keychain",
  serviceNames: ["api"],
  materialize: false,
}).then(
  () => null,
  (error: unknown) => (error instanceof Error ? error.message : String(error))
);
console.log(JSON.stringify({ message, calls }));
