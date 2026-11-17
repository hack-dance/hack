import { publishRelease } from "../../src/lib/release-install.ts";

const [release, binary, assets, phase, version] = Bun.argv.slice(2);
if (
  !(
    release &&
    binary &&
    assets &&
    version &&
    ["assets-published", "compiler-published"].includes(phase ?? "")
  )
) {
  throw new Error("Missing publication fixture arguments.");
}
await publishRelease({
  version,
  extractedReleaseDir: release,
  binaryPath: binary,
  assetsDir: assets,
  checkpoint: (point) => {
    if (point === phase) {
      process.kill(process.pid, "SIGKILL");
    }
  },
});
throw new Error(
  "Publication fixture failed to reach its hard-kill checkpoint."
);
