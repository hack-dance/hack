import { expect, test } from "bun:test";
import {
  dataCleanupCommand,
  renderDataCleanupText,
} from "../src/commands/data.ts";
import { cleanupDataHelpers } from "../src/lib/data-backup-cleanup.ts";
import { FakeEngine } from "./helpers/data-backup-fake-engine.ts";

const NONCE = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const DEADLINES = { commandMs: 1000, stepMs: 60_000 };

/** Create a container through the fake engine, labeled with `nonce`. */
function labeled(fake: FakeEngine, name: string, nonce: string): string {
  const created = fake.capture([
    "docker",
    "create",
    "--name",
    name,
    "--label",
    `io.hack.data-backup.nonce=${nonce}`,
    "--entrypoint",
    "true",
    "image",
  ]);
  return created.stdout.trim();
}

test("hack data cleanup removes only the nonce's containers, by ID, and never a volume", async () => {
  const fake = new FakeEngine();
  fake.volume("shop_db", { labels: {}, content: "rows" });
  const ours = [labeled(fake, "a", NONCE), labeled(fake, "b", NONCE)];
  const theirs = labeled(fake, "c", OTHER);
  fake.calls = [];

  const result = await cleanupDataHelpers({
    docker: fake.docker(),
    nonce: NONCE,
    deadlines: DEADLINES,
  });

  expect([...result.removed].sort()).toEqual([...ours].sort());
  expect(result.unconfirmed).toEqual([]);
  expect(fake.leftovers()).toEqual([theirs]);
  // Removed by full ID, without --volumes; no volume command at all.
  for (const argv of fake.calls.filter((call) => call[1] === "rm")) {
    expect(argv.slice(3).every((ref) => /^[a-f0-9]{64}$/.test(ref))).toBe(true);
    expect(argv).not.toContain("--volumes");
    expect(argv).not.toContain("-v");
  }
  expect(fake.calls.some((argv) => argv[1] === "volume")).toBeFalse();
  expect(fake.volumes.get("shop_db")?.content).toBe("rows");
  expect(renderDataCleanupText(result)).toBe(
    `Removed 2 containers labeled io.hack.data-backup.nonce=${NONCE}: ${result.removed.map((id) => id.slice(0, 12)).join(", ")}.\n`
  );
});

test("a removal Docker cannot confirm is reported, and nothing matching is a clean no-op", async () => {
  const fake = new FakeEngine();
  const stuck = labeled(fake, "a", NONCE);
  fake.rmFails.add(stuck);
  const result = await cleanupDataHelpers({
    docker: fake.docker(),
    nonce: NONCE,
    deadlines: DEADLINES,
  });
  expect(result.removed).toEqual([]);
  expect(result.unconfirmed).toEqual([stuck]);

  const empty = await cleanupDataHelpers({
    docker: new FakeEngine().docker(),
    nonce: NONCE,
    deadlines: DEADLINES,
  });
  expect(empty).toMatchObject({ removed: [], unconfirmed: [] });
  expect(renderDataCleanupText(empty)).toBe(
    `No container is labeled io.hack.data-backup.nonce=${NONCE}; nothing to remove.\n`
  );
});

test("the printed hack data cleanup line carries export's selection, --env only when given", () => {
  const launcher = dataCleanupCommand({})(NONCE).split(" ")[0] ?? "";
  expect(dataCleanupCommand({})(NONCE)).toBe(
    `${launcher} data cleanup --nonce=${NONCE}`
  );
  expect(
    dataCleanupCommand({ branch: "feature-x", env: "staging" })(NONCE)
  ).toBe(
    `${launcher} data cleanup --branch=feature-x --env=staging --nonce=${NONCE}`
  );
  // A path that looks like a pasted assignment is never printed.
  expect(dataCleanupCommand({ path: "TOKEN=abc" })(NONCE)).not.toContain(
    "TOKEN"
  );
});
