import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_BRANCHES_FILENAME } from "../src/constants.ts";
import {
  forgetBranchUsage,
  mergeBranchUsage,
  readBranchUsage,
  recordBranchUsage,
  resolveBranchUsagePath,
} from "../src/lib/branch-usage.ts";
import { readBranchesFile, writeBranchesFile } from "../src/lib/branches.ts";
import { ensureDir, pathExists } from "../src/lib/fs.ts";
import { sanitizeBranchSlug } from "../src/lib/project.ts";

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

test("sanitizeBranchSlug normalizes separators and strips invalid chars", () => {
  expect(sanitizeBranchSlug("feature/foo_bar ")).toBe("feature-foo-bar");
  expect(sanitizeBranchSlug("  ")).toBe("");
});

test("recordBranchUsage writes machine-local state, never hack.branches.json", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-branches-"));
  const projectDir = join(tempDir, ".hack");
  await ensureDir(projectDir);

  const res = await recordBranchUsage({
    projectDir,
    branch: "feature-x",
    nowIso: "2025-01-02T03:04:05Z",
  });
  expect(res.error).toBeUndefined();
  expect(res.path).toBe(join(projectDir, ".internal", "branch-usage.json"));
  expect(await pathExists(join(projectDir, PROJECT_BRANCHES_FILENAME))).toBe(
    false
  );

  const usage = await readBranchUsage({ projectDir });
  expect(usage.get("feature-x")?.last_used_at).toBe("2025-01-02T03:04:05Z");
});

test("recordBranchUsage leaves an existing tracked registry byte-identical", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-branches-"));
  const projectDir = join(tempDir, ".hack");
  await ensureDir(projectDir);

  const path = join(projectDir, PROJECT_BRANCHES_FILENAME);
  await writeBranchesFile({
    path,
    file: {
      version: 1,
      branches: [
        {
          name: "feature-x",
          slug: "feature-x",
          created_at: "2025-01-01T00:00:00Z",
          last_used_at: "2025-01-01T00:00:00Z",
        },
      ],
    },
  });
  const before = await Bun.file(path).text();

  await recordBranchUsage({
    projectDir,
    branch: "feature-x",
    nowIso: "2025-01-02T03:04:05Z",
  });

  expect(await Bun.file(path).text()).toBe(before);
  const read = await readBranchesFile({ projectDir });
  const merged = mergeBranchUsage({
    branches: read.file.branches,
    usage: await readBranchUsage({ projectDir }),
  });
  expect(merged[0]?.last_used_at).toBe("2025-01-02T03:04:05Z");
});

test("mergeBranchUsage falls back to the legacy tracked value", () => {
  const merged = mergeBranchUsage({
    branches: [
      { name: "a", slug: "a", last_used_at: "2025-01-01T00:00:00Z" },
      { name: "b", slug: "b" },
    ],
    usage: new Map([["b", { last_used_at: "2025-02-02T00:00:00Z" }]]),
  });
  expect(merged.map((entry) => entry.last_used_at)).toEqual([
    "2025-01-01T00:00:00Z",
    "2025-02-02T00:00:00Z",
  ]);
});

test("forgetBranchUsage drops one entry and keeps the rest", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-branches-"));
  const projectDir = join(tempDir, ".hack");
  await recordBranchUsage({
    projectDir,
    branch: "a",
    nowIso: "2025-01-01T00:00:00Z",
  });
  await recordBranchUsage({
    projectDir,
    branch: "b",
    nowIso: "2025-01-01T00:00:00Z",
  });

  await forgetBranchUsage({ projectDir, branch: "a" });

  const usage = await readBranchUsage({ projectDir });
  expect([...usage.keys()]).toEqual(["b"]);
});

test("readBranchUsage tolerates a corrupt machine-local file", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-branches-"));
  const projectDir = join(tempDir, ".hack");
  await ensureDir(join(projectDir, ".internal"));
  await Bun.write(resolveBranchUsagePath({ projectDir }), "{not json");

  expect((await readBranchUsage({ projectDir })).size).toBe(0);
  const res = await recordBranchUsage({ projectDir, branch: "a" });
  expect(res.error).toBeUndefined();
  expect((await readBranchUsage({ projectDir })).has("a")).toBe(true);
});
