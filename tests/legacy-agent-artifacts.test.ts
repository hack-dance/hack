import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  checkLegacyProjectAgentArtifacts,
  checkLegacyUserAgentArtifacts,
  removeLegacyProjectAgentArtifacts,
  removeLegacyUserAgentArtifacts,
} from "../src/agents/legacy-artifacts.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit project sync can audit and remove retired owned artifacts", async () => {
  const projectRoot = await createTempRoot();
  const skillPath = resolve(projectRoot, ".codex/skills/hack-tickets/SKILL.md");
  await mkdir(resolve(skillPath, ".."), { recursive: true });
  await Bun.write(skillPath, "---\nname: hack-tickets\n---\n");
  await Bun.write(
    resolve(projectRoot, "AGENTS.md"),
    [
      "keep before",
      "<!-- hack:tickets:start -->",
      "retired instructions",
      "<!-- hack:tickets:end -->",
      "keep after",
      "",
    ].join("\n")
  );

  const checked = await checkLegacyProjectAgentArtifacts({ projectRoot });
  expect(checked.map((result) => result.status)).toEqual([
    "deprecated",
    "deprecated",
    "absent",
  ]);

  const removed = await removeLegacyProjectAgentArtifacts({ projectRoot });
  expect(removed.map((result) => result.status)).toEqual([
    "removed",
    "removed",
    "absent",
  ]);
  expect(await Bun.file(skillPath).exists()).toBe(false);
  expect(await Bun.file(resolve(projectRoot, "AGENTS.md")).text()).toBe(
    "keep before\n\nkeep after\n"
  );
});

test("legacy cleanup refuses an unrecognized skill directory", async () => {
  const projectRoot = await createTempRoot();
  const skillPath = resolve(projectRoot, ".codex/skills/hack-tickets/SKILL.md");
  await mkdir(resolve(skillPath, ".."), { recursive: true });
  await Bun.write(skillPath, "---\nname: user-owned-skill\n---\n");

  const results = await removeLegacyProjectAgentArtifacts({ projectRoot });
  expect(results[0]?.status).toBe("error");
  expect(results[0]?.message).toContain(
    "Refusing to remove unrecognized skill"
  );
  expect(await Bun.file(skillPath).exists()).toBe(true);
});

test("legacy cleanup preserves malformed instruction markers", async () => {
  const projectRoot = await createTempRoot();
  const agentsPath = resolve(projectRoot, "AGENTS.md");
  const malformed = [
    "<!-- hack:tickets:end -->",
    "user content",
    "<!-- hack:tickets:start -->",
    "",
  ].join("\n");
  await Bun.write(agentsPath, malformed);

  const results = await removeLegacyProjectAgentArtifacts({ projectRoot });
  expect(results[1]?.status).toBe("error");
  expect(results[1]?.message).toContain("malformed retired Hack instruction");
  expect(await Bun.file(agentsPath).text()).toBe(malformed);
});

test("explicit user sync removes all recognized retired skill locations", async () => {
  const home = await createTempRoot();
  const skillFixtures = [
    {
      path: resolve(home, ".codex/skills/hack-tickets/SKILL.md"),
      content: "---\nname: hack-tickets\n---\n",
    },
    {
      path: resolve(home, ".ai/skills/hack/SKILL.md"),
      content:
        "---\nname: hack\nhomepage: https://github.com/hack-dance/hack-cli\n---\n",
    },
    {
      path: resolve(home, ".ai/skills/hack-tickets/SKILL.md"),
      content: "---\nname: hack-tickets\n---\n",
    },
  ];
  for (const fixture of skillFixtures) {
    await mkdir(resolve(fixture.path, ".."), { recursive: true });
    await Bun.write(fixture.path, fixture.content);
  }

  const checked = await checkLegacyUserAgentArtifacts({ home });
  expect(checked.every((result) => result.status === "deprecated")).toBe(true);

  const removed = await removeLegacyUserAgentArtifacts({ home });
  expect(removed.every((result) => result.status === "removed")).toBe(true);
  for (const fixture of skillFixtures) {
    expect(await Bun.file(fixture.path).exists()).toBe(false);
  }
});

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "hack-legacy-agents-"));
  tempRoots.push(root);
  return root;
}
