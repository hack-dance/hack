import { expect, test } from "bun:test";

import { __testOnlyMutagen } from "../src/lib/mutagen.ts";

test("resolveMutagenArtifact maps darwin arm64 correctly", () => {
  const artifact = __testOnlyMutagen.resolveMutagenArtifact({
    platform: "darwin",
    arch: "arm64",
    version: "0.18.1",
  });

  expect(artifact).toEqual({
    version: "0.18.1",
    platform: "darwin",
    arch: "arm64",
    filename: "mutagen_darwin_arm64_v0.18.1.tar.gz",
    downloadUrl:
      "https://github.com/mutagen-io/mutagen/releases/download/v0.18.1/mutagen_darwin_arm64_v0.18.1.tar.gz",
  });
});

test("resolveMutagenArtifact maps linux x64 to amd64 naming", () => {
  const artifact = __testOnlyMutagen.resolveMutagenArtifact({
    platform: "linux",
    arch: "x64",
    version: "0.18.1",
  });

  expect(artifact?.filename).toBe("mutagen_linux_amd64_v0.18.1.tar.gz");
});

test("resolveMutagenArtifact returns null for unsupported platform", () => {
  const artifact = __testOnlyMutagen.resolveMutagenArtifact({
    platform: "win32",
    arch: "x64",
    version: "0.18.1",
  });

  expect(artifact).toBeNull();
});
