import { afterEach, expect, test } from "bun:test";
import { link, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyConfigCompilerBuildPath } from "../scripts/build-config-compiler.ts";

let directory = "";
afterEach(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true });
  }
});

test("accepts Cargo's linked source without permitting linked output", async () => {
  directory = await mkdtemp(join(tmpdir(), "hack-compiler-build-"));
  const source = join(directory, "cargo-artifact");
  const linked = join(directory, "cargo-target");
  await Bun.write(source, "reviewed fixture bytes");
  await link(source, linked);
  await expect(verifyConfigCompilerBuildPath({ path: linked })).rejects.toThrow(
    "aliased"
  );
  await verifyConfigCompilerBuildPath({
    path: linked,
    allowCargoHardLink: true,
  });
  expect(await Bun.file(source).text()).toBe("reviewed fixture bytes");
  const alias = join(directory, "alias");
  await symlink(source, alias);
  await expect(
    verifyConfigCompilerBuildPath({ path: alias, allowCargoHardLink: true })
  ).rejects.toThrow("aliased");
});
