import { readFile } from "node:fs/promises";
import { runUpgradeApply } from "../../src/lib/upgrade-apply.ts";
import type { UpgradeCheckReport } from "../../src/lib/upgrade-check.ts";
import { collectUpgradeSnapshotTargets } from "../../src/lib/upgrade-snapshot-targets.ts";

// Only the parent fixture supplies these paths and a metadata-only report.
const report = JSON.parse(
  await readFile(process.argv[2] ?? "", "utf8")
) as UpgradeCheckReport;
const boundary = Number(process.argv[3]);
let checkpoint = 0;
await runUpgradeApply({
  report,
  home: process.env.HOME ?? "",
  only: [process.argv[4] ?? "ignore-rules"],
  dryRun: false,
  collect: collectUpgradeSnapshotTargets,
  checkpoint: async () => {
    checkpoint += 1;
    if (checkpoint === boundary) {
      process.stdout.write("checkpoint\n");
      await new Promise(() => {});
    }
  },
});
throw new Error("The requested interruption boundary was not reached.");
