import { restoreUpgradeSnapshot } from "../../src/lib/upgrade-snapshot.ts";

// Only the parent fixture supplies the manifest path and boundary number.
// Every target passes two restore boundaries: staged (before displacement)
// and displaced (before publication). The worker stops at the requested one
// so the parent can SIGKILL it there.
const manifestPath = process.argv[2] ?? "";
const boundary = Number(process.argv[3]);
const overwrite = process.argv[4] === "overwrite";
let reached = 0;
const stop = async () => {
  reached += 1;
  if (reached === boundary) {
    process.stdout.write("checkpoint\n");
    await new Promise(() => {});
  }
};
await restoreUpgradeSnapshot({
  manifestPath,
  overwrite,
  beforeReplace: stop,
  afterDisplace: stop,
});
throw new Error("The requested interruption boundary was not reached.");
