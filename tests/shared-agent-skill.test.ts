import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkSharedHackSkill,
  installSharedHackSkill,
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
