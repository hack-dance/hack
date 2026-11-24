import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordNativeResourceOwner } from "../src/backends/native-resource-runs.ts";
import { nativeInventory } from "../src/lib/resources-inventory.ts";

const COMPOSE = "a".repeat(32);
const AUTHORED = "b".repeat(32);
const UNKNOWN = "c".repeat(32);

test("native inventory attributes unregistered Compose branches and authored projects", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-resource-inventory-"))
  );
  const home = join(root, "candidate");
  const runtime = { home, binary: "/fixture/native" };
  try {
    for (const [store, run, branch] of [
      ["runtime", COMPOSE, "feature"],
      ["authored", AUTHORED, null],
    ] as const) {
      const projectRoot = join(root, store);
      const projectDir = join(projectRoot, ".hack");
      await mkdir(projectDir, { recursive: true });
      await Bun.write(
        join(
          projectDir,
          store === "runtime" ? "docker-compose.yml" : "hack.project.json"
        ),
        store === "runtime"
          ? "name: compose-fixture\nservices: {}\n"
          : '{"name":"authored-fixture"}'
      );
      const runDir = join(
        home,
        ".hack-local",
        "run",
        store === "runtime" ? "graphs" : "native-graphs",
        run
      );
      await mkdir(runDir, { recursive: true, mode: 0o700 });
      const namespace = new Bun.CryptoHasher("sha256")
        .update(
          branch === null
            ? projectRoot
            : `hack-native-branch-namespace-v1\0${projectRoot}\0${branch}`
        )
        .digest("hex");
      await Bun.write(
        join(runDir, "state.json"),
        JSON.stringify(
          store === "runtime"
            ? { run, namespace }
            : { review: { provenance: { run, namespace } } }
        )
      );
      await recordNativeResourceOwner(
        { nativeHome: home, projectRoot, projectDir, branch },
        store,
        run
      );
    }
    let volumeRun = COMPOSE;
    const readers = {
      select: () => runtime,
      disk: async () => ({
        scope: "native-home-host-files",
        complete: true,
        allocatedBytes: 1,
        logicalBytes: 1,
        reclaimableBytes: null,
        categories: [],
      }),
      invoke: async ({ args }: { args: readonly string[] }) =>
        args[1] === "status"
          ? { receipt: { run: COMPOSE, resources: {} } }
          : {
              volumes: [
                {
                  name: "volume-fixture",
                  bytes: 20,
                  graph_reference: { run: volumeRun },
                },
              ],
            },
      compose: async () => ({
        backend: "native" as const,
        status: "observed" as const,
        run: COMPOSE,
        phase: "ready-observed",
        items: [
          {
            service: "db",
            container: "d".repeat(64),
            phase: "started",
            state: "running",
            health: null,
            exitCode: null,
          },
        ],
      }),
      authored: async () => ({
        backend: "native" as const,
        status: "observed" as const,
        run: AUTHORED,
        phase: "ready",
        items: [
          {
            service: "worker",
            container: "e".repeat(64),
            state: "running",
            health: null,
            exitCode: null,
          },
        ],
      }),
    };
    const result = await nativeInventory(root, readers);
    expect(result.issues).toEqual([]);
    expect(result.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "db",
          owners: [
            expect.objectContaining({
              project: "compose-fixture",
              branch: "feature",
            }),
          ],
        }),
        expect.objectContaining({
          name: "worker",
          owners: [
            expect.objectContaining({
              project: "authored-fixture",
              branch: null,
            }),
          ],
        }),
        expect.objectContaining({
          name: "volume-fixture",
          owners: [
            expect.objectContaining({
              project: "compose-fixture",
              branch: "feature",
            }),
          ],
        }),
      ])
    );
    volumeRun = UNKNOWN;
    await mkdir(join(home, ".hack-local", "run", "graphs", UNKNOWN), {
      mode: 0o700,
    });
    const partial = await nativeInventory(root, readers);
    expect(partial.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("unverifiable checkout receipt"),
        expect.stringContaining("volumes could not be attributed"),
      ])
    );
    expect(
      partial.rows.find((row) => row.name === "volume-fixture")?.owners
    ).toEqual([]);
    await rm(join(root, "authored"), { recursive: true });
    const missing = await nativeInventory(root, readers);
    expect(missing.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("checkout or project name"),
      ])
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
