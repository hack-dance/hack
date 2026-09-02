import { describe, expect, test } from "bun:test";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

describe("release product boundary", () => {
  test("does not build or publish the retained macOS app", async () => {
    const releaseWorkflow = await Bun.file(
      path.join(repoRoot, ".github/workflows/release.yml")
    ).text();
    const macosReleaseWorkflow = Bun.file(
      path.join(repoRoot, ".github/workflows/release-macos-app.yml")
    );
    const releaseConfig = await Bun.file(
      path.join(repoRoot, ".releaserc.json")
    ).json();
    const prepareRelease = await Bun.file(
      path.join(repoRoot, "scripts/prepare-release.ts")
    ).text();

    expect(releaseWorkflow).not.toContain("release-macos-app");
    expect(releaseWorkflow).not.toContain("macos-app:");
    expect(await macosReleaseWorkflow.exists()).toBe(false);
    expect(JSON.stringify(releaseConfig)).not.toContain("apps/macos");
    expect(prepareRelease).not.toContain("Base.xcconfig");
  });
});
