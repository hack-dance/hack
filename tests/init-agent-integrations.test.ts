import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInitAgentIntegrations } from "../src/agents/init-agent-integrations.ts";

test("interactive init never offers instruction, hook or skill export", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-agent-init-retired-"));
  try {
    const path = join(root, "AGENTS.md");
    await Bun.write(path, "custom instructions\n");
    let guards = 0;
    let notes = 0;
    let exports = 0;
    const prompts = {
      note: () => {
        notes++;
      },
      confirm: () => {
        exports++;
        return Promise.resolve(true);
      },
      multiselect: () => {
        exports++;
        return Promise.resolve(["agents", "claude", "codex", "cursor"]);
      },
    };
    for (const interactive of [true, false]) {
      const result = await runInitAgentIntegrations({
        repoRoot: root,
        interactive,
        prompts,
        guard: () => {
          guards++;
          return Promise.resolve();
        },
      });
      expect(result.kind).toBe(interactive ? "note-only" : "skipped");
    }
    expect(guards).toBe(2);
    expect(notes).toBe(1);
    expect(exports).toBe(0);
    expect(await Bun.file(path).text()).toBe("custom instructions\n");
    for (const path of [
      ".claude/settings.local.json",
      ".codex/skills/hack-cli/SKILL.md",
      ".cursor/rules/hack.mdc",
      "CLAUDE.md",
    ]) {
      expect(await Bun.file(join(root, path)).exists()).toBe(false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("init preserves runtime input guard before optional guidance", async () => {
  let noted = false;
  await expect(
    runInitAgentIntegrations({
      repoRoot: "/unused-fixture",
      interactive: true,
      prompts: {
        note: () => {
          noted = true;
        },
      },
      guard: () => {
        return Promise.reject(new Error("guard refusal"));
      },
    })
  ).rejects.toThrow("guard refusal");
  expect(noted).toBe(false);
});
