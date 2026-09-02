import { describe, expect, test } from "bun:test";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const bridgeDir = path.join(repoRoot, "apps/macos/Experiments/GhosttyVTBridge");

describe("Ghostty source pin", () => {
  test("uses one immutable revision in local builds", async () => {
    const revision = (
      await Bun.file(path.join(bridgeDir, "GHOSTTY_REVISION")).text()
    ).trim();
    const setupScript = await Bun.file(
      path.join(repoRoot, "scripts/macos-ghostty-setup.ts")
    ).text();
    const bundleScript = await Bun.file(
      path.join(repoRoot, "scripts/macos-ghostty-bundle.ts")
    ).text();
    expect(revision).toMatch(/^[0-9a-f]{40}$/);
    expect(setupScript).toContain('path.join(bridgeDir, "GHOSTTY_REVISION")');
    expect(bundleScript).toContain('path.join(bridgeDir, "GHOSTTY_REVISION")');
    expect(bundleScript).toContain("git -C ${vendorDir} rev-parse HEAD");
    expect(bundleScript).toContain(
      "git -C ${vendorDir} reset --hard ${ghosttyRevision}"
    );
    expect(setupScript).not.toContain("fetch --depth 1 origin main");
  });
});
