import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a private read is never satisfied from a parent directory swapped in and restored (HACK-2165)", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-private-read-swap-"));
  dirs.push(root);
  const hackDir = join(root, "project", ".hack");
  const outsideDir = join(root, "outside");
  await mkdir(hackDir, { recursive: true });
  await mkdir(outsideDir);
  await writeFile(join(hackDir, ".env"), "INSIDE=1\n", { mode: 0o600 });
  await writeFile(join(outsideDir, ".env"), "OUTSIDE_SENTINEL=1\n", {
    mode: 0o600,
  });
  const proc = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures", "private-read-dir-swap-worker.ts"),
      hackDir,
      outsideDir,
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  // Either the original file (after a retry) or a refusal; never the
  // outside file's contents.
  expect(out).not.toContain("OUTSIDE_SENTINEL");
  expect(["INSIDE=1\n", "refused"]).toContain(out);
});
