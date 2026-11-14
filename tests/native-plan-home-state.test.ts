import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativePlanHomeMatches } from "../scripts/lib/native-plan-home-state.ts";

let home = "";
let hackHome = "";
let activity = "";
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "hack-plan-home-"));
  hackHome = join(home, ".hack");
  activity = join(hackHome, "activity.jsonl");
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
function matches(activityCount: number, existingConfig = false) {
  return nativePlanHomeMatches({
    home,
    activityCount,
    existingConfig,
    privateValues: ["synthetic-private-value", home],
  });
}
async function install() {
  await mkdir(hackHome, { mode: 0o700 });
  await writeFile(
    activity,
    '{"action":"up","outcome":"failed","project":null}\n',
    {
      mode: 0o600,
    }
  );
}

test("offline planning is empty and lifecycle activity requires the exact count and outcome", async () => {
  expect(await matches(0)).toBe(true);
  await install();
  expect(await matches(0)).toBe(false);
  expect(await matches(1)).toBe(true);
  expect(await matches(2)).toBe(false);
  for (const text of [
    '{"action":"up","outcome":"ok"}',
    '{"action":"down","outcome":"failed"}',
    "invalid",
    '{"action":"up","outcome":"failed","project":null,"detail":"synthetic-private-value"}',
    JSON.stringify({
      action: "up",
      outcome: "failed",
      project: null,
      detail: home,
    }),
  ]) {
    await writeFile(activity, text);
    expect(await matches(1)).toBe(false);
  }
});

test("extra registry, native, or lock state never hides behind activity", async () => {
  await install();
  for (const name of ["projects.json", "native", "activity.jsonl.lock"]) {
    const path = join(hackHome, name);
    await writeFile(path, "{}");
    expect(await matches(1)).toBe(false);
    await rm(path);
  }
  await writeFile(join(home, "native"), "{}");
  expect(await matches(1)).toBe(false);
});

test("activity must be a private regular file under a protected directory", async () => {
  await install();
  await chmod(activity, 0o644);
  expect(await matches(1)).toBe(false);
  await chmod(activity, 0o600);
  await chmod(hackHome, 0o777);
  expect(await matches(1)).toBe(false);
  await chmod(hackHome, 0o700);
  await rm(activity);
  const target = join(hackHome, "hack.config.json");
  await writeFile(
    target,
    '{"action":"up","outcome":"failed","project":null}\n',
    {
      mode: 0o600,
    }
  );
  await symlink(target, activity);
  expect(await matches(1, true)).toBe(false);
});

test("routing fixtures may retain only their explicitly supplied config", async () => {
  await mkdir(hackHome, { mode: 0o700 });
  await writeFile(join(hackHome, "hack.config.json"), "{}");
  expect(await matches(0)).toBe(false);
  expect(await matches(0, true)).toBe(true);
  await writeFile(
    activity,
    '{"action":"up","outcome":"failed","project":null}\n',
    {
      mode: 0o600,
    }
  );
  expect(await matches(1, true)).toBe(true);
  await writeFile(join(hackHome, "projects.json"), "{}");
  expect(await matches(1, true)).toBe(false);
});
