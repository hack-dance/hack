import { expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  runMuxEnvironment,
  stageMuxEnvironment,
} from "../src/mux/private-environment.ts";

test("private mux payload is owner-only, consumed before spawn, and preserves assignments", async () => {
  const root = await mkdtemp(join(tmpdir(), "mux-env-test-"));
  const payload = await stageMuxEnvironment({
    UID: "fake-uid",
    NODE_ENV: "selected",
    FAKE_KEY: "fake-key",
  });
  try {
    expect((await lstat(dirname(payload.path))).mode & 0o777).toBe(0o700);
    expect((await lstat(payload.path)).mode & 0o777).toBe(0o600);
    const output = join(root, "result.json");
    const code = await runMuxEnvironment(payload.path, [
      "NODE_ENV=command-local",
      process.execPath,
      "--eval",
      'const fs = require("node:fs"); fs.writeFileSync(process.argv[1], JSON.stringify({ uid: process.env.UID, node: process.env.NODE_ENV, absent: !fs.existsSync(process.argv[2]), leaked: process.argv.some(arg => arg.includes(process.env.FAKE_KEY)) }));',
      output,
      payload.path,
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
      uid: "fake-uid",
      node: "command-local",
      absent: true,
      leaked: false,
    });
    expect(await Bun.file(payload.path).exists()).toBe(false);
  } finally {
    await payload.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("private mux input refuses public, malformed, oversized, and symlinked payloads", async () => {
  for (const kind of ["public", "malformed", "oversized", "symlink"] as const) {
    const payload = await stageMuxEnvironment({ UID: "fake-uid" });
    const foreign = join(dirname(payload.path), "foreign");
    try {
      if (kind === "public") {
        await chmod(payload.path, 0o644);
      }
      if (kind === "malformed") {
        await writeFile(payload.path, "not json");
      }
      if (kind === "oversized") {
        await writeFile(payload.path, "x".repeat(1024 * 1024 + 1));
      }
      if (kind === "symlink") {
        await writeFile(foreign, "preserve");
        await unlink(payload.path);
        await symlink(foreign, payload.path);
      }
      const result = await runMuxEnvironment(payload.path, [
        "/usr/bin/false",
      ]).catch(() => 1);
      expect(result).toBe(1);
      expect((await lstat(payload.path)).isSymbolicLink()).toBe(
        kind === "symlink"
      );
      if (kind === "symlink") {
        expect(await readFile(foreign, "utf8")).toBe("preserve");
      }
    } finally {
      await rm(foreign, { force: true });
      if (kind === "symlink") {
        await unlink(payload.path);
      }
      await payload.cleanup();
    }
  }
});
