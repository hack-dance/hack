import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
    sha256: "6f810416d9e5fc4fd5e18431146f8b3c5a2056ba5a24f76c1e66da86eb3257e2",
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

test.each([
  "downloaded",
  "bundled",
  "override",
  "installed with override",
] as const)("managed Mutagen handles %s without replacing an existing binary", async (source) => {
  const root = await mkdtemp(join(tmpdir(), "mutagen-checksum-"));
  try {
    const artifact = __testOnlyMutagen.resolveMutagenArtifact({
      platform: process.platform,
      arch: process.arch,
      version: "0.18.1",
    });
    expect(artifact).not.toBeNull();
    const bin = join(root, "bin");
    const assets = join(root, "assets");
    await Promise.all([mkdir(bin), mkdir(assets)]);
    await Bun.write(join(bin, "mutagen"), "installed copy");
    if (source === "bundled" && artifact) {
      await Bun.write(join(assets, artifact.filename), "unverified archive");
    }
    const bundle = join(root, "libexec", "mutagen-agents.tar.gz");
    const alreadyInstalled = source === "installed with override";
    if (alreadyInstalled) {
      await mkdir(join(root, "libexec"));
      await Bun.write(bundle, "installed bundle");
    }
    const modulePath = resolve("src/lib/mutagen.ts");
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
          globalThis.fetch = async () => {
            console.error("download requested");
            return new Response("unverified archive");
          };
          const mod = await import(${JSON.stringify(modulePath)});
          console.log(JSON.stringify(await mod.ensureBundledMutagenInstalled()));
        `,
      ],
      {
        cwd: root,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: root,
          HACK_HOME: root,
          HACK_ASSETS_DIR: assets,
          ...(source === "override" || alreadyInstalled
            ? { HACK_MUTAGEN_VERSION: "1.2.3" }
            : {}),
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      }
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe(source === "downloaded" ? "download requested\n" : "");
    expect(JSON.parse(stdout)).toEqual(
      alreadyInstalled
        ? { ok: true, installed: false, mutagenPath: join(bin, "mutagen") }
        : expect.objectContaining({
            ok: false,
            reason:
              source === "override" ? "unpinned-version" : "checksum-mismatch",
          })
    );
    expect(await Bun.file(join(bin, "mutagen")).text()).toBe("installed copy");
    if (alreadyInstalled) {
      expect(await Bun.file(bundle).text()).toBe("installed bundle");
    } else {
      expect(await Bun.file(bundle).exists()).toBe(false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
