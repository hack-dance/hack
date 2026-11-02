import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runSetupSyncScope,
  setupSyncExitCode,
} from "../src/agents/setup-sync.ts";

test("retired sync refuses every action and scope without changing legacy or customized files", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-sync-retired-"));
  const paths = [
    "AGENTS.md",
    "CLAUDE.md",
    ".claude/settings.json",
    ".codex/skills/hack-cli/SKILL.md",
    ".ai/skills/hack-cli/SKILL.md",
    ".cursor/rules/hack.mdc",
  ];
  try {
    for (const path of paths) {
      await Bun.write(
        join(root, path),
        `custom or stale legacy content: ${path}\n`
      );
    }
    for (const scope of ["project", "global"] as const) {
      for (const action of ["sync", "check", "remove"] as const) {
        const results = await runSetupSyncScope({
          scope,
          action,
          root,
          installMissing: true,
        });
        expect(setupSyncExitCode({ action, results })).toBe(1);
        expect(results).toHaveLength(1);
        expect(results[0]?.message).toContain("retired in v5");
        for (const path of paths) {
          expect(await Bun.file(join(root, path)).text()).toBe(
            `custom or stale legacy content: ${path}\n`
          );
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
