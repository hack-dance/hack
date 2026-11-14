import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNativePlanRefusalActivity,
  snapshotNativePlanHome,
} from "../scripts/lib/native-plan-home-state.ts";

const roots: string[] = [];
const sentinel = "synthetic-native-plan-private-value";
const record = { v: 1, action: "up", outcome: "failed", project: null };

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(authoredConfig = true, directoryMode = 0o700) {
  const root = await mkdtemp(join(tmpdir(), "plan-home-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  const hack = join(home, ".hack");
  const config = join(hack, "hack.config.json");
  if (authoredConfig) {
    await mkdir(hack, { mode: directoryMode });
    await writeFile(config, '{"fixture":true}\n', { mode: 0o600 });
  }
  const before = await snapshotNativePlanHome(home);
  await mkdir(hack, { mode: 0o700, recursive: true });
  const activity = join(hack, "activity.jsonl");
  await writeFile(activity, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return {
    root,
    home,
    hack,
    config,
    activity,
    options: { home, before, attempts: 1, sentinel, fixtureRoot: root },
  };
}

for (const authoredConfig of [true, false]) {
  test(`native plan HOME admits exactly failure activity (authored config ${authoredConfig})`, async () => {
    const { options } = await fixture(authoredConfig);
    await assertNativePlanRefusalActivity(options);
    expect(options.before.has(".hack/activity.jsonl")).toBe(false);
  });
}

test("native plan HOME preserves an existing metadata directory mode inside its private HOME", async () => {
  const { options } = await fixture(true, 0o755);
  await assertNativePlanRefusalActivity(options);
  expect(options.before.has(".hack/hack.config.json")).toBe(true);
});

test("native plan HOME refuses a newly created activity directory with wider permissions", async () => {
  const { options, hack } = await fixture(false);
  await chmod(hack, 0o755);
  await expect(assertNativePlanRefusalActivity(options)).rejects.toThrow(
    "Native plan"
  );
});

for (const change of [
  "registry",
  "config",
  "mode",
  "extra-record",
  "outcome",
  "registered-project",
  "torn-record",
  "value",
  "path",
  "malformed",
] as const) {
  test(`native plan HOME refuses ${change} instead of widening its activity exception`, async () => {
    const state = await fixture();
    switch (change) {
      case "registry":
        await writeFile(join(state.hack, "projects.json"), "{}\n");
        break;
      case "config":
        await writeFile(state.config, '{"fixture":false}\n');
        break;
      case "mode":
        await chmod(state.activity, 0o644);
        break;
      case "extra-record":
        await writeFile(
          state.activity,
          `${JSON.stringify(record)}\n`.repeat(2)
        );
        break;
      case "outcome":
        await writeFile(
          state.activity,
          JSON.stringify({ ...record, outcome: "ok" })
        );
        break;
      case "registered-project":
        await writeFile(
          state.activity,
          `${JSON.stringify({ ...record, project: "registered" })}\n`
        );
        break;
      case "torn-record":
        await writeFile(state.activity, JSON.stringify(record));
        break;
      case "value":
      case "path":
        await writeFile(
          state.activity,
          JSON.stringify({
            ...record,
            project: change === "value" ? sentinel : state.root,
          })
        );
        break;
      case "malformed":
        await writeFile(state.activity, `{${sentinel}`);
        break;
      default:
        throw new Error("Unknown native plan HOME negative control");
    }
    const error = await assertNativePlanRefusalActivity(state.options).then(
      () => null,
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) {
      expect(error.message).not.toContain(sentinel);
      expect(error.message).not.toContain(state.root);
    }
  });
}
