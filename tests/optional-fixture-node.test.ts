import { expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { optionalFixtureNode } from "./helpers/optional-fixture-node.ts";

test("optional fixture runtime skips a shim that could retain capture pipes", async () => {
  const root = await mkdtemp(join(tmpdir(), "optional-node-shim-"));
  try {
    const marker = join(root, "executed");
    const shim = join(root, "node");
    await writeFile(
      shim,
      `#!/bin/sh\nprintf reached > '${marker}'\n/bin/sleep 30 &\nexit 0\n`
    );
    await chmod(shim, 0o700);
    expect(await optionalFixtureNode(root)).toBeNull();
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("optional fixture runtime does not execute a version-manager target behind node", async () => {
  const root = await mkdtemp(join(tmpdir(), "optional-node-manager-"));
  try {
    const marker = join(root, "executed");
    const manager = join(root, "mise");
    await writeFile(
      manager,
      `#!/bin/sh\nprintf reached > '${marker}'\nexit 0\n`
    );
    await chmod(manager, 0o700);
    await symlink(manager, join(root, "node"));
    expect(await optionalFixtureNode(root)).toBeNull();
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing optional fixture runtime leaves compiled Bun selected", async () => {
  expect(
    await optionalFixtureNode("/nonexistent-hack-fixture-node")
  ).toBeNull();
});

test("optional fixture discovery ignores ambient Node preload configuration", async () => {
  const expected = await optionalFixtureNode();
  const root = await mkdtemp(join(tmpdir(), "optional-node-preload-"));
  try {
    const marker = join(root, "executed");
    const preload = join(root, "preload.cjs");
    await writeFile(
      preload,
      `if (!process.versions.bun) { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'reached'); process.exit(87); }`
    );
    const probe = join(root, "probe.ts");
    await writeFile(
      probe,
      `import {optionalFixtureNode} from ${JSON.stringify(join(import.meta.dir, "helpers/optional-fixture-node.ts"))}; console.log(JSON.stringify(await optionalFixtureNode()));`
    );
    // Bun's implicit child environment is captured at startup. Put the poison
    // in that startup snapshot, rather than only editing this runner's env.
    const child = Bun.spawn([process.execPath, "--no-env-file", probe], {
      env: {
        PATH: process.env.PATH ?? "",
        NODE_OPTIONS: `--require=${preload}`,
        NODE_PATH: root,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    const [output, errors, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(errors).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(output)).toBe(expected);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
