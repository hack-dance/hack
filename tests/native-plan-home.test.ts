import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNativePlanHome } from "../scripts/lib/native-plan-home.ts";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "hack-plan-home-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const failedUp = {
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

async function writeActivity(records: readonly unknown[]): Promise<void> {
  await mkdir(join(home, ".hack"), { recursive: true });
  await Bun.write(
    join(home, ".hack/activity.jsonl"),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
  );
}

test("planning leaves HOME empty, failed ups add only activity", async () => {
  await assertNativePlanHome({ home, failedUps: 0 });
  await writeActivity([failedUp, failedUp]);
  await assertNativePlanHome({ home, failedUps: 2 });
});

test("routing may retain only its prepared global config plus activity", async () => {
  await mkdir(join(home, ".hack"));
  await Bun.write(join(home, ".hack/hack.config.json"), "{}");
  const preparedHackFiles = ["hack.config.json"];
  await assertNativePlanHome({ home, failedUps: 0, preparedHackFiles });
  await writeActivity([failedUp]);
  await assertNativePlanHome({ home, failedUps: 1, preparedHackFiles });
});

for (const extra of [
  ".hack/projects.json",
  ".hack/activity.jsonl.lock",
  ".hack/activity.jsonl.1",
  "native/state",
  "other",
]) {
  test(`rejects extra HOME state: ${extra}`, async () => {
    await writeActivity([failedUp]);
    await Bun.write(join(home, extra), "{}");
    await expect(assertNativePlanHome({ home, failedUps: 1 })).rejects.toThrow(
      "Unexpected registry or runtime HOME state"
    );
  });
}

test("planning rejects an activity write before lifecycle attempts", async () => {
  await writeActivity([failedUp]);
  await expect(assertNativePlanHome({ home, failedUps: 0 })).rejects.toThrow();
});

for (const records of [
  [],
  [failedUp, failedUp],
  [{ ...failedUp, outcome: "ok" }],
  [{ ...failedUp, action: "down" }],
  [{ ...failedUp, project: "registered" }],
  [{ ...failedUp, extra: "unexpected" }],
  [null],
]) {
  test(`rejects missing, duplicate or unrelated activity: ${JSON.stringify(records)}`, async () => {
    await writeActivity(records);
    await expect(
      assertNativePlanHome({ home, failedUps: 1 })
    ).rejects.toThrow();
  });
}

test("rejects a torn activity record", async () => {
  await writeActivity([failedUp]);
  await Bun.write(join(home, ".hack/activity.jsonl"), JSON.stringify(failedUp));
  await expect(assertNativePlanHome({ home, failedUps: 1 })).rejects.toThrow(
    "Expected one complete activity record per failed up"
  );
});

test("rejects private paths in known activity fields", async () => {
  await writeActivity([{ ...failedUp, branch: home }]);
  await expect(assertNativePlanHome({ home, failedUps: 1 })).rejects.toThrow();
});
