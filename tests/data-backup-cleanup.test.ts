import { describe, expect, test } from "bun:test";
import {
  dataCleanupCommand,
  renderDataCleanupText,
} from "../src/commands/data.ts";
import {
  cleanupDataHelpers,
  resolveDataCleanup,
} from "../src/lib/data-backup-cleanup.ts";
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

test("the printed hack data cleanup line carries the run's project and instance, never an env", () => {
  const launcher = dataCleanupCommand({})(NONCE).split(" ")[0] ?? "";
  expect(dataCleanupCommand({})(NONCE)).toBe(
    `${launcher} data cleanup --nonce=${NONCE}`
  );
  // The env selection comes from the run's cleanup record, not the line.
  expect(dataCleanupCommand({ branch: "feature-x" })(NONCE)).toBe(
    `${launcher} data cleanup --branch=feature-x --nonce=${NONCE}`
  );
  // A path that looks like a pasted assignment is never printed.
  expect(dataCleanupCommand({ path: "TOKEN=abc" })(NONCE)).not.toContain(
    "TOKEN"
  );
});

test("a listed container Hack cannot read back (inspect timed out or failed) is unconfirmed", async () => {
  for (const failure of [
    { exitCode: 124, stdout: "", stderr: "" },
    { exitCode: 1, stdout: "", stderr: "error during connect" },
  ]) {
    const fake = new FakeEngine();
    const listed = labeled(fake, "a", NONCE);
    const real = fake.docker();
    const docker = {
      ...real,
      capture: async (
        argv: readonly string[],
        opts?: { readonly timeoutMs?: number }
      ) =>
        argv[2] === "inspect" &&
        argv.some((arg) => arg.includes(".Config.Labels"))
          ? failure
          : await real.capture(argv, opts),
    };
    const result = await cleanupDataHelpers({
      docker,
      nonce: NONCE,
      deadlines: DEADLINES,
    });
    expect({ exit: failure.exitCode, result }).toMatchObject({
      exit: failure.exitCode,
      result: { listed: [listed], removed: [], unconfirmed: [listed] },
    });
    // Never removed blind, and never reported as nothing there.
    expect(fake.leftovers()).toEqual([listed]);
    expect(renderDataCleanupText(result)).not.toContain("No container");
  }
});

describe("cleanup resolves a recorded create only by finding and removing it", () => {
  const resolve = (fake: FakeEngine, unresolvedCreates: readonly string[]) =>
    resolveDataCleanup({
      docker: fake.docker(),
      nonce: NONCE,
      deadlines: DEADLINES,
      unresolvedCreates,
    });

  test("without one, an empty listing settles, with no watch", async () => {
    const fake = new FakeEngine();
    const { result, unresolved, settled } = await resolve(fake, []);
    expect(result.listed).toEqual([]);
    expect({ unresolved, settled }).toEqual({ unresolved: [], settled: true });
    expect(fake.events.watches).toBe(0);
  });

  test("with one and an empty listing, it stays unresolved however long cleanup waits", async () => {
    const fake = new FakeEngine();
    const { unresolved, settled } = await resolve(fake, ["hack-data-export-x"]);
    expect({ unresolved, settled }).toEqual({
      unresolved: ["hack-data-export-x"],
      settled: false,
    });
    // No time-window evidence: cleanup never watches for it.
    expect(fake.events.watches).toBe(0);
  });

  test("a container of that name that appears later is removed, and only then it settles", async () => {
    const fake = new FakeEngine();
    expect((await resolve(fake, ["late"])).settled).toBeFalse();
    labeled(fake, "late", NONCE);
    const { result, unresolved, settled } = await resolve(fake, ["late"]);
    expect(result.removed).toHaveLength(1);
    expect({ unresolved, settled }).toEqual({ unresolved: [], settled: true });
    expect(fake.leftovers()).toEqual([]);
  });

  test("a removed container of another name, or that name under another nonce, does not resolve it", async () => {
    const fake = new FakeEngine();
    labeled(fake, "other", NONCE);
    const foreign = labeled(fake, "late", OTHER);
    const { result, unresolved, settled } = await resolve(fake, ["late"]);
    expect(result.removed).toHaveLength(1);
    expect({ unresolved, settled }).toEqual({
      unresolved: ["late"],
      settled: false,
    });
    expect(fake.leftovers()).toEqual([foreign]);
  });
});
