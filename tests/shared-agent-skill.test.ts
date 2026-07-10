import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkDeprecatedSharedHackSkills,
  checkSharedHackSkill,
  installSharedHackSkill,
  removeDeprecatedSharedHackSkills,
} from "../src/agents/shared-skill.ts";

let tempHome: string | null = null;
let originalHome: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  tempHome = await mkdtemp(join(tmpdir(), "hack-shared-skill-"));
  process.env.HOME = tempHome;
});

afterEach(async () => {
  if (originalHome === undefined) {
    Reflect.deleteProperty(process.env, "HOME");
  } else {
    process.env.HOME = originalHome;
  }
  if (tempHome) {
    await rm(tempHome, { recursive: true, force: true });
    tempHome = null;
  }
});

test("shared Hack skill installs current ticket-free guidance and detects drift", async () => {
  expect((await checkSharedHackSkill()).status).toBe("missing");

  const installed = await installSharedHackSkill();
  expect(installed.status).toBe("created");
  expect(installed.path).toBe(
    join(tempHome ?? "", ".ai", "skills", "hack-cli", "SKILL.md")
  );

  const content = await Bun.file(installed.path).text();
  expect(content).toContain("Integration freshness");
  expect(content).not.toMatch(/hack[ -]?tickets/i);
  expect((await checkSharedHackSkill()).status).toBe("noop");

  await Bun.write(
    installed.path,
    content.replace("Integration freshness", "Old rules")
  );
  const stale = await checkSharedHackSkill();
  expect(stale.status).toBe("stale");
  expect(stale.message).toContain("hack setup sync --all-scopes");
});

test("known legacy shared Hack skills are reported and removed", async () => {
  const hackPath = join(tempHome ?? "", ".ai", "skills", "hack", "SKILL.md");
  const ticketsPath = join(
    tempHome ?? "",
    ".ai",
    "skills",
    "hack-tickets",
    "SKILL.md"
  );
  await mkdir(join(hackPath, ".."), { recursive: true });
  await mkdir(join(ticketsPath, ".."), { recursive: true });
  await Bun.write(
    hackPath,
    "---\nname: hack\nhomepage: https://github.com/hack-dance/hack-cli\n---\n"
  );
  await Bun.write(ticketsPath, "---\nname: hack-tickets\n---\n");

  const checked = await checkDeprecatedSharedHackSkills();
  expect(checked.map((result) => result.status)).toEqual([
    "deprecated",
    "deprecated",
  ]);

  const removed = await removeDeprecatedSharedHackSkills();
  expect(removed.map((result) => result.status)).toEqual([
    "removed",
    "removed",
  ]);
  expect(await Bun.file(hackPath).exists()).toBe(false);
  expect(await Bun.file(ticketsPath).exists()).toBe(false);
});

test("unrecognized shared hack alias is protected from cleanup", async () => {
  const hackPath = join(tempHome ?? "", ".ai", "skills", "hack", "SKILL.md");
  await mkdir(join(hackPath, ".."), { recursive: true });
  await Bun.write(hackPath, "---\nname: hack\n---\nuser-owned\n");

  const removed = await removeDeprecatedSharedHackSkills();
  expect(removed[0]?.status).toBe("error");
  expect(await Bun.file(hackPath).exists()).toBe(true);
});
