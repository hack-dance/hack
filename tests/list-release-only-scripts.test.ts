import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { listReleaseOnlyScripts } from "../scripts/list-release-only-scripts.ts";

test("release inventory follows reusable workflows, local actions and Bun aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "release-only-scripts-"));
  const files = {
    ".github/workflows/release.yml": `
jobs:
  prerequisite:
    uses: ./.github/workflows/prerelease.yml
  release:
    steps:
      - run: bun run --cwd packages/cli stage
      - uses: ./.github/actions/package
      - run: bun scripts/shared.ts
`,
    ".github/workflows/prerelease.yml": `
jobs:
  qualification:
    steps:
      - run: |
          # bun scripts/disabled.ts
          mise exec zig -- scripts/check.sh
`,
    ".github/workflows/ci.yml": `
jobs:
  test:
    steps:
      - run: bun scripts/shared.ts
      - run: bunx ultracite check scripts/check.sh
`,
    ".github/actions/package/action.yml": `
runs:
  using: composite
  steps:
    - run: bash scripts/package.sh
`,
    "packages/cli/package.json": JSON.stringify({
      scripts: { stage: "cd ../.. && bun scripts/stage.ts" },
    }),
  };
  try {
    for (const [path, contents] of Object.entries(files)) {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await Bun.write(target, contents);
    }
    expect(await listReleaseOnlyScripts(root)).toEqual([
      "scripts/check.sh",
      "scripts/package.sh",
      "scripts/stage.ts",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
