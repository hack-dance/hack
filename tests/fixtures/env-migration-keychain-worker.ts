import { spyOn } from "bun:test";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { secrets } from "bun";

// One process owns the stubs and secret-store cache; no real keychain is reached.
const root = process.env.HACK_TEST_PROJECT_ROOT;
if (!root) {
  throw new Error("Missing private fixture root");
}
const key = "synthetic-deferred-repair-keychain-key";
const value = "synthetic-deferred-repair-keychain-value";
const calls = { get: 0, set: 0, delete: 0 };
spyOn(secrets, "get").mockImplementation(async () => {
  calls.get += 1;
  return key;
});
spyOn(secrets, "set").mockImplementation(async () => {
  calls.set += 1;
});
spyOn(secrets, "delete").mockImplementation(async () => {
  calls.delete += 1;
  return false;
});
if ((await secrets.get({ service: "fixture", name: "preflight" })) !== key) {
  throw new Error("Keychain stub is not active");
}
calls.get = 0;

const { resolveSecretStore } = await import("../../src/lib/secret-store.ts");
const { resolveProjectEnvConfig } = await import(
  "../../src/lib/project-env-config.ts"
);
const { envMigrationSnapshots } = await import(
  "../../src/lib/env-migration-snapshot.ts"
);
const { applyEnvMigration, migrateLegacyEnvForCommand, previewEnvMigration } =
  await import("../../src/lib/env-migration.ts");
const project = {
  projectRoot: root,
  projectDir: join(root, ".hack"),
  projectName: "journal",
  serviceNames: ["api"],
};
// Seed the synthetic store without provisioning its configured key file. Later
// reads can obtain the same key only from the stubbed native-keychain fallback.
process.env.HACK_SECRETS_FILE_KEY = key;
await (await resolveSecretStore(project)).set({ key: "SEC", value });
Reflect.deleteProperty(process.env, "HACK_SECRETS_FILE_KEY");
await migrateLegacyEnvForCommand({ ...project, materialize: false });

async function snapshot(fixtureRoot: string): Promise<string> {
  const paths = await readdir(fixtureRoot, {
    recursive: true,
    withFileTypes: true,
  });
  const entries = await Promise.all(
    paths.map(async (entry) => {
      const path = join(entry.parentPath, entry.name);
      const state = await lstat(path);
      return {
        path: relative(fixtureRoot, path),
        mode: state.mode,
        digest: entry.isFile()
          ? new Bun.CryptoHasher("sha256")
              .update(await readFile(path))
              .digest("hex")
          : null,
      };
    })
  );
  return JSON.stringify(entries.sort((a, b) => a.path.localeCompare(b.path)));
}
const before = await snapshot(root);
const preview = await previewEnvMigration(project);
const unchangedAfterPreview = before === (await snapshot(root));
const absentAfterPreview = !(await Bun.file(
  join(root, "legacy-backend.key")
).exists());
let applied = false;
try {
  applied =
    (
      await applyEnvMigration({
        project,
        snapshots: envMigrationSnapshots(),
        acceptTrackedChanges: true,
      })
    ).status === "applied";
} catch {
  // Report only the outcome, never backend diagnostics or key material.
}
const resolved = await resolveProjectEnvConfig({ ...project, envName: null });
console.log(
  JSON.stringify({
    previewStatus: preview.status,
    unchangedAfterPreview,
    absentAfterPreview,
    absentAfterApply: !(await Bun.file(
      join(root, "legacy-backend.key")
    ).exists()),
    applied,
    preserved: resolved?.serviceEnv.api?.SEC === value,
    calls,
  })
);
