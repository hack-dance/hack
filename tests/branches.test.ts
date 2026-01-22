import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_BRANCHES_FILENAME } from "../src/constants.ts";
import {
  readBranchesFile,
  touchBranchUsage,
  writeBranchesFile,
} from "../src/lib/branches.ts";
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

test("touchBranchUsage updates last_used_at when branch entry exists", async () => {
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
        },
      ],
    },
  });

  const res = await touchBranchUsage({
    projectDir,
    branch: "feature-x",
    nowIso: "2025-01-02T03:04:05Z",
  });
  expect(res.updated).toBe(true);

  const read = await readBranchesFile({ projectDir });
  expect(read.file.branches[0]?.last_used_at).toBe("2025-01-02T03:04:05Z");
});

test("touchBranchUsage does not create file when missing", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-branches-"));
  const projectDir = join(tempDir, ".hack");
  await ensureDir(projectDir);

  const res = await touchBranchUsage({
    projectDir,
    branch: "feature-x",
  });
  expect(res.updated).toBe(false);
  expect(await pathExists(join(projectDir, PROJECT_BRANCHES_FILENAME))).toBe(
    false
  );
});
