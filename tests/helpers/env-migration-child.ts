import { join } from "node:path";
import { applyEnvMigration } from "../../src/lib/env-migration.ts";
import { fixtureEnvSnapshots } from "./env-migration-fixture.ts";

const root = process.argv[2];
const stop = process.argv[3];
if (!(root && stop)) {
  throw new Error("Fixture arguments required");
}
const projectRoot = join(root, "project");
const result = await applyEnvMigration({
  project: {
    projectRoot,
    projectDir: join(projectRoot, ".hack"),
    projectName: "journal",
    serviceNames: ["api"],
  },
  snapshots: fixtureEnvSnapshots(root),
  acceptTrackedChanges: true,
  hooks: {
    boundary: async (event) => {
      if (`${event.phase}:${event.index}` === stop) {
        process.stdout.write(`${JSON.stringify(event)}\n`);
        // Owned test child: the parent kills and awaits it at this exact durable boundary.
        await Bun.sleep(60_000);
        throw new Error("Fixture parent did not kill the child");
      }
    },
  },
});
process.stdout.write(`${JSON.stringify(result)}\n`);
