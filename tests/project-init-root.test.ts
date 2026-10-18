import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRepoRootForInit } from "../src/lib/project.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

for (const marker of ["directory", "worktree-file"] as const) {
  test(`setup root stops at a ${marker} Git boundary before an ancestor package`, async () => {
    const root = await mkdtemp(join(tmpdir(), "hack-init-root-"));
    roots.push(root);
    const repo = join(root, "repo");
    const child = join(repo, "src");
    await mkdir(child, { recursive: true });
    await writeFile(join(root, "package.json"), "{}");
    if (marker === "directory") {
      await mkdir(join(repo, ".git"));
    } else {
      await writeFile(join(repo, ".git"), "gitdir: /synthetic/worktree");
    }
    expect(await findRepoRootForInit(child)).toBe(repo);
    await writeFile(join(child, "package.json"), "{}");
    expect(await findRepoRootForInit(child)).toBe(child);
  });
}
