import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativePlanHomeMatches } from "../scripts/lib/native-plan-home.ts";

let root: string;
let home: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-plan-audit-"));
  home = join(root, "home");
  await mkdir(home);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const entry = {
  v: 1,
  ts: "2026-01-01T00:00:00Z",
  project: null,
  branch: null,
  action: "up",
  origin: "cli",
  outcome: "failed",
  failed_services: [],
  duration_ms: 1,
};
async function write(records: readonly object[]) {
  await mkdir(join(home, ".hack"), { recursive: true });
  await Bun.write(
    join(home, ".hack/activity.jsonl"),
    `${records.map((value) => JSON.stringify(value)).join("\n")}\n`
  );
}
function matches(failedActions: number) {
  return nativePlanHomeMatches({ home, privateRoot: root, failedActions });
}
test("planning must leave home empty; lifecycle probes have an exact audit count", async () => {
  expect(await matches(0)).toBe(true);
  expect(await matches(1)).toBe(false);
  await write([entry]);
  expect(await matches(0)).toBe(false);
  expect(await matches(1)).toBe(true);
  expect(await matches(2)).toBe(false);
  await write([entry, entry]);
  expect(await matches(2)).toBe(true);
});
test("audit allowance refuses registry files, unexpected fields, paths and successful actions", async () => {
  for (const record of [
    { ...entry, outcome: "ok" },
    { ...entry, path: "extra" },
    { ...entry, project: root },
  ]) {
    await write([record]);
    expect(await matches(1)).toBe(false);
  }
  await write([entry]);
  await Bun.write(join(home, ".hack/projects.json"), "{}");
  expect(await matches(1)).toBe(false);
});
