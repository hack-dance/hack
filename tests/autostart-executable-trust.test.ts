import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertAutostartExecutablePathTrusted } from "../src/lib/autostart-executable-trust.ts";

let root = "";
let bin = "";
let program = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-executable-trust-"));
  bin = join(root, "bin");
  program = join(bin, "docker");
  await mkdir(bin, { mode: 0o700 });
  await writeFile(program, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("safe owned lookup directories and programs are accepted without execution", async () => {
  await expect(
    assertAutostartExecutablePathTrusted({ path: bin })
  ).resolves.toBeUndefined();
  expect(await readFile(program, "utf8")).toBe("#!/bin/sh\nexit 0\n");
});

test("a group-writable optional tool directory refuses only automatic execution", async () => {
  const homebrew = join(root, "homebrew");
  await mkdir(homebrew, { mode: 0o775 });
  await chmod(homebrew, 0o775);
  await writeFile(join(homebrew, "docker"), "#!/bin/sh\nexit 99\n", {
    mode: 0o755,
  });
  await expect(
    assertAutostartExecutablePathTrusted({ path: `${homebrew}:${bin}` })
  ).rejects.toMatchObject({ code: "E_PERMISSION" });
  expect((await Bun.file(homebrew).stat()).mode & 0o777).toBe(0o775);
});

test("writable lookup directories and ancestor paths refuse without permission repair", async () => {
  await chmod(bin, 0o777);
  await expect(
    assertAutostartExecutablePathTrusted({ path: bin })
  ).rejects.toMatchObject({
    code: "E_PERMISSION",
    detail: { reason: "executable_path_untrusted" },
  });
  expect((await Bun.file(program).stat()).mode & 0o777).toBe(0o700);
  await chmod(bin, 0o700);
  await chmod(root, 0o777);
  await expect(
    assertAutostartExecutablePathTrusted({ path: bin })
  ).rejects.toMatchObject({ code: "E_PERMISSION" });
  await chmod(root, 0o700);
});

test("writable helper entries and symlink targets refuse even with private lookup directories", async () => {
  await chmod(program, 0o777);
  await expect(
    assertAutostartExecutablePathTrusted({ path: bin })
  ).rejects.toMatchObject({ code: "E_PERMISSION" });
  await rm(program);
  const target = join(root, "target");
  await writeFile(target, "#!/bin/sh\nexit 0\n", { mode: 0o777 });
  await chmod(target, 0o777);
  await symlink(target, program);
  await expect(
    assertAutostartExecutablePathTrusted({ path: bin })
  ).rejects.toMatchObject({ code: "E_PERMISSION" });
  await chmod(target, 0o700);
  await expect(
    assertAutostartExecutablePathTrusted({ path: bin })
  ).resolves.toBeUndefined();
});

test("empty or relative lookup entries refuse with fixed value-free errors", async () => {
  for (const path of ["", `${bin}:`, "private-sentinel/relative"]) {
    let error: unknown;
    try {
      await assertAutostartExecutablePathTrusted({ path });
    } catch (failure) {
      error = failure;
    }
    expect(error).toMatchObject({
      code: "E_PERMISSION",
      detail: { reason: "executable_path_untrusted" },
    });
    expect(String(error)).not.toContain(root);
    expect(String(error)).not.toContain("private-sentinel");
  }
});

test("Darwin ACL inspection includes lookup ancestors, programs and symlink target chains", async () => {
  const targetDir = join(root, "targets");
  await mkdir(targetDir, { mode: 0o700 });
  const target = join(targetDir, "helper");
  await writeFile(target, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await symlink(target, join(bin, "helper"));
  const inspected = new Set<string>();
  await assertAutostartExecutablePathTrusted(
    { path: `${bin}:${join(root, "missing", "bin")}` },
    {
      platform: "darwin",
      inspect: async (paths, timeoutMs) => {
        expect(timeoutMs).toBeGreaterThan(0);
        expect(timeoutMs).toBeLessThanOrEqual(3000);
        for (const path of paths) {
          inspected.add(path);
        }
        return {
          exitCode: 0,
          stdout:
            " 0: group:everyone deny delete\n 1: user:reader allow read,execute\n",
        };
      },
    }
  );
  for (const path of [
    "/",
    root,
    bin,
    program,
    join(bin, "helper"),
    targetDir,
    target,
  ]) {
    expect(inspected.has(path)).toBe(true);
  }
  expect(inspected.has(join(root, "missing"))).toBe(false);
});

for (const stdout of [
  " 0: user:other allow write\n",
  " 0: group:other allow add_file,add_subdirectory\n",
  " 0: user:other allow unknown_right\n",
  " 0: malformed ACL\n",
]) {
  test(`Darwin mutation or unknown ACL refuses without exposing output: ${stdout.trim()}`, async () => {
    await expect(
      assertAutostartExecutablePathTrusted(
        { path: bin },
        { platform: "darwin", inspect: async () => ({ exitCode: 0, stdout }) }
      )
    ).rejects.toMatchObject({
      code: "E_PERMISSION",
      detail: { reason: "executable_path_untrusted" },
    });
    expect((await Bun.file(program).stat()).mode & 0o777).toBe(0o700);
  });
}

test("Darwin ACL probe failures refuse with closed diagnostics", async () => {
  for (const exitCode of [1, 124, 125]) {
    await expect(
      assertAutostartExecutablePathTrusted(
        { path: bin },
        {
          platform: "darwin",
          inspect: async () => ({ exitCode, stdout: "private-sentinel" }),
        }
      )
    ).rejects.toThrow(
      "Automatic startup refused an unsafe executable search path."
    );
  }
});
