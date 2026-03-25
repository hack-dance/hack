import { expect, test } from "bun:test";

import {
  appMetadata,
  scaffoldMilestones,
  scaffoldSummary,
} from "../src/lib/workspace-scaffold";

test("workspace scaffold metadata describes the placeholder shell", () => {
  expect(appMetadata.title).toBe("Hack control plane");
  expect(appMetadata.description).toContain("workspace scaffold");
  expect(scaffoldSummary).toContain("CLI-first workflows stay available");
  expect(scaffoldMilestones.map(({ title }) => title)).toEqual([
    "Workspace package",
    "Local runtime wiring",
    "Browser auth handoff",
  ]);
});

test("workspace scaffold page keeps the root route wired to the shared placeholder page", async () => {
  const pageSource = await Bun.file(
    new URL("../app/page.tsx", import.meta.url)
  ).text();

  expect(pageSource).toContain("WorkspaceScaffoldPage");
});
