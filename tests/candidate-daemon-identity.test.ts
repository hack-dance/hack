import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  copyFile,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fixtureChildren } from "./helpers/fixture-children.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/*
 * HACK-2263: the release gate on a compiled candidate bundle. The bundle
 * here is this checkout's CLI compiled with a prerelease version, the real
 * `hack-v5` launcher and a stub executor; the gate puts a fake stable
 * `hack` first on PATH in a temp HOME and starts hackd from the launcher.
 */

const REPO = resolve(import.meta.dir, "..");
const VERSION = "5.0.0-next.97";
const children = fixtureChildren("candidate-daemon-identity");
let root: string | null = null;

afterEach(async () => {
  await children.stopAll();
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = null;
  }
});

test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
  "a compiled candidate starts its own hackd, which reports the release version",
  async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "hack-cdi-test-")));
    const bundle = join(root, "bundle");
    const build = await children.run({
      cmd: [
        process.execPath,
        "build",
        join(REPO, "index.ts"),
        "--compile",
        "--define",
        `__HACK_BUILD_VERSION__="${VERSION}"`,
        "--outfile",
        join(bundle, "hack-cli"),
      ],
      cwd: root,
      env: privateCliEnv({ root }),
    });
    expect(build.exitCode).toBe(0);
    await copyFile(
      join(REPO, "scripts", "hack-v5.sh"),
      join(bundle, "hack-v5")
    );
    await chmod(join(bundle, "hack-v5"), 0o755);
    await writeFile(join(bundle, "hack-native"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });

    const gate = await children.run({
      cmd: [
        process.execPath,
        join(REPO, "scripts", "check-candidate-daemon-identity.ts"),
        bundle,
        VERSION,
      ],
      cwd: root,
      env: privateCliEnv({ root }),
    });
    expect(gate.stderr).toBe("");
    expect(gate.exitCode).toBe(0);
    expect(gate.stdout).toContain("hack-next: hackd pid");
    expect(gate.stdout).toContain("hack-v5: hackd pid");
    expect(gate.stdout).toContain(`CLI and hackd report ${VERSION}`);
  },
  120_000
);
