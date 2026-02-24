import { expect, test } from "bun:test";

import { selectCliTarballAsset } from "../src/lib/self-update.ts";
import { compareSemver, parseSemver } from "../src/lib/semver.ts";

test("parseSemver accepts v-prefix and ignores prerelease/build metadata", () => {
  expect(parseSemver("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
  expect(parseSemver("1.2.3-beta.1")).toEqual({ major: 1, minor: 2, patch: 3 });
  expect(parseSemver("1.2.3+sha.abc")).toEqual({
    major: 1,
    minor: 2,
    patch: 3,
  });
});

test("compareSemver orders versions correctly", () => {
  expect(compareSemver("1.4.0", "1.10.0")).toBe(-1);
  expect(compareSemver("2.0.0", "1.99.99")).toBe(1);
  expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
});

test("selectCliTarballAsset chooses matching darwin/arm64 tarball", () => {
  const release = {
    tag: "v1.5.0",
    assets: [
      {
        name: "hack-1.5.0-linux-x86_64.tar.gz",
        url: "https://example.com/linux-x86_64",
      },
      {
        name: "hack-1.5.0-darwin-arm64.tar.gz",
        url: "https://example.com/darwin-arm64",
      },
    ],
  } as const;

  const asset = selectCliTarballAsset({
    release,
    version: "1.5.0",
    target: { platform: "darwin", arch: "arm64" },
  });

  expect(asset?.url).toBe("https://example.com/darwin-arm64");
});
