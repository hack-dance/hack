import { describe, expect, test } from "bun:test";
import {
  dataCleanupCommand,
  renderDataCleanupText,
} from "../src/commands/data.ts";
import {
  cleanupDataHelpers,
  cleanupWithSettle,
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

describe("cleanup applies the settle rule to a record with an unresolved create", () => {
  const settle = (
    fake: FakeEngine,
    unresolvedCreates: readonly string[],
    docker = fake.docker()
  ) =>
    cleanupWithSettle({
      docker,
      nonce: NONCE,
      deadlines: DEADLINES,
      unresolvedCreates,
      settleMs: 60,
    });

  test("without one, an empty listing settles at once, with no watch", async () => {
    const fake = new FakeEngine();
    const { result, settled } = await settle(fake, []);
    expect(result.listed).toEqual([]);
    expect(settled).toBeTrue();
    expect(fake.events.watches).toBe(0);
  });

  test("with one, a quiet watch and an empty final listing settle; the listing ran twice", async () => {
    const fake = new FakeEngine();
    const { settled } = await settle(fake, ["hack-data-export-x"]);
    expect(settled).toBeTrue();
    expect(fake.events.watches).toBe(1);
    expect(
      fake.calls.filter((argv) => argv[1] === "ps" && argv.includes("--all"))
    ).toHaveLength(2);
  });

  test("a container that lands during the watch is removed", async () => {
    const fake = new FakeEngine();
    const real = fake.docker();
    const docker = {
      ...real,
      watch: (argv: readonly string[], onLine: (line: string) => void) => {
        const watch = real.watch(argv, onLine);
        // It lands while the window is open.
        setTimeout(() => {
          labeled(fake, "late", NONCE);
        }, 10);
        return watch;
      },
    };
    const { result, settled } = await settle(fake, ["late"], docker);
    expect(result.removed).toHaveLength(1);
    expect(settled).toBeTrue();
    expect(fake.leftovers()).toEqual([]);
  });

  test("a watch that ends early proves nothing: unknown, the record stays", async () => {
    const fake = new FakeEngine();
    const real = fake.docker();
    const docker = {
      ...real,
      watch: (argv: readonly string[], onLine: (line: string) => void) => {
        const watch = real.watch(argv, onLine);
        setTimeout(() => fake.events.end(), 5);
        return watch;
      },
    };
    const { result, settled } = await settle(fake, ["gone"], docker);
    expect(result.listed).toEqual([]);
    expect(settled).toBeFalse();
  });
});
