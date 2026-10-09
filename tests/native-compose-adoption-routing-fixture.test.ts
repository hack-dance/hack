import { expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPrivate } from "../src/lib/native-compose-private-state.ts";
import { mapLegacyNativeRetainedRouting } from "../src/lib/native-config-import-plan.ts";
import {
  prepareRetainedRoutingFixtureLocals,
  retainedRoutingFixtureConfig,
  retainedRoutingFixtureOrigins,
  retainedRoutingFixtureSelection,
  retainedRoutingFixtureService,
} from "./e2e/scenarios/native-compose-adoption-routing-inputs.ts";
import {
  nativeComposeAdoptionRoutingWorktreesScenario,
  retainedRoutingPartialStopScript,
} from "./e2e/scenarios/native-compose-adoption-routing-worktrees.ts";
import { ownedAdoptionFixtureObservation } from "./e2e/scenarios/native-compose-adoption-worktrees.ts";

const IMAGE = `sha256:${"a".repeat(64)}`;
const IDS = ["b".repeat(64), "c".repeat(64), "d".repeat(64)] as const;
function selection(prefer: "alias" | "dev" = "alias") {
  return retainedRoutingFixtureSelection({
    image: IMAGE,
    name: "retained-origin",
    marker: "synthetic-http-marker",
    prefer,
  });
}
test("routing acceptance is explicitly selected and retains uncertain source/resource evidence", () => {
  expect(
    nativeComposeAdoptionRoutingWorktreesScenario.requiresExplicitSelection
  ).toBe(true);
  expect(
    nativeComposeAdoptionRoutingWorktreesScenario.preserveFixtureOnFailure
  ).toBe(true);
});
test("maintained legacy HTTP fixture has a real apex, existing alias and lossless defined candidate", () => {
  const route = selection();
  const result = mapLegacyNativeRetainedRouting({
    configText: JSON.stringify({
      name: "retained-origin",
      ...retainedRoutingFixtureConfig(route),
      worktree: { auto_branch: false, inherit_local: true },
    }),
    composeText: JSON.stringify({
      name: "retained-origin",
      services: {
        web: retainedRoutingFixtureService(route),
        db: { image: IMAGE, volumes: ["data:/data"] },
      },
      volumes: { data: {} },
      networks: { "hack-dev": { external: true } },
    }),
  });
  expect(result.report.complete).toBe(true);
  expect(result.candidate).toBeDefined();
  expect(retainedRoutingFixtureOrigins(route)).toEqual([
    "https://retained-origin.hack.local",
    "https://retained-origin.hack.gy",
  ]);
  expect(retainedRoutingFixtureConfig(selection("dev")).open.prefer).toBe(
    "dev"
  );
  expect(retainedRoutingFixtureConfig(route).open.prefer).toBe("dev");
  expect(retainedRoutingFixtureService(route).image).toBe(IMAGE);
});
test("alpha checkout alias differs from authored and primary-local dev selections", async () => {
  const root = await mkdtemp(join(tmpdir(), "retained-routing-locals-"));
  try {
    const primary = { root: join(root, "primary") };
    const instance = { root: join(root, "checkout"), routing: selection() };
    await mkdir(join(primary.root, ".hack"), { recursive: true, mode: 0o700 });
    await mkdir(join(instance.root, ".hack"), { recursive: true, mode: 0o700 });
    await prepareRetainedRoutingFixtureLocals({
      primary,
      instances: [instance],
    });
    expect(retainedRoutingFixtureConfig(instance.routing).open.prefer).toBe(
      "dev"
    );
    expect(
      JSON.parse(
        await readFile(join(primary.root, ".hack/hack.local.json"), "utf8")
      )
    ).toEqual({
      schema_version: 1,
      routes: { domain: "primary-shadowed.test" },
      open: { prefer: "dev" },
    });
    expect(
      JSON.parse(
        await readFile(join(instance.root, ".hack/hack.local.json"), "utf8")
      )
    ).toEqual({
      schema_version: 1,
      routes: { domain: "checkout-selected.test" },
      open: { prefer: "alias" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("new routed web observation requires exact birth, zero mounts and original service/name scope", () => {
  const instance = {
    root: "/synthetic/retained",
    name: "retained-origin",
    marker: "synthetic-sql",
    routing: selection(),
  };
  const row = {
    id: IDS[1],
    createdAt: "2026-10-09T01:02:03Z",
    project: instance.name,
    nativeNames: [],
    name: `/${instance.name}-web-1`,
    service: "web",
    workingDir: `${instance.root}/.hack`,
    configFiles: `${instance.root}/.hack/docker-compose.yml`,
    mounts: [],
  };
  expect(
    ownedAdoptionFixtureObservation({ instance, kind: "container", row })
  ).toEqual({ id: IDS[1], service: "web", createdAt: row.createdAt });
  for (const change of [
    { createdAt: null },
    { mounts: [{ type: "volume" }] },
    { nativeNames: ["io.hack.native-config.owner"] },
    { service: "other" },
  ]) {
    expect(() =>
      ownedAdoptionFixtureObservation({
        instance,
        kind: "container",
        row: { ...row, ...change },
      })
    ).toThrow();
  }
});

/** Closed child ports, but the emitted marker uses the actual exclusive writer. */
async function replay(
  state: unknown,
  args: readonly string[],
  existingMarker = false
) {
  const root = await mkdtemp(join(tmpdir(), "retained-routing-marker-"));
  await chmod(root, 0o700);
  const markerPath = join(root, "marker");
  try {
    if (existingMarker) {
      await writeFile(markerPath, "existing-private-marker", {
        flag: "wx",
        mode: 0o600,
      });
    }
    const requests: string[][] = [];
    let writeError: string | null = null;
    const source = retainedRoutingPartialStopScript({
      engine: "/synthetic/docker",
      engineId: '"synthetic-daemon"',
      receipt: "/synthetic/receipt",
      ids: IDS,
      stopId: IDS[0],
      marker: markerPath,
    });
    const exit = { code: -1 };
    const readReceipt = async (path: string, limit: number) => {
      if (path !== "/synthetic/receipt" || limit !== 131_072) {
        throw new Error("unexpected read");
      }
      return { text: JSON.stringify(state) };
    };
    const fixtureProcess = {
      argv: ["bun", "shim", ...args],
      exit: (code: number): never => {
        exit.code = code;
        throw exit;
      },
    };
    const fixtureBun = {
      spawn: (argv: string[], _options: unknown) => {
        requests.push(argv);
        if (
          JSON.stringify(argv) ===
          JSON.stringify([
            "/synthetic/docker",
            "info",
            "--format",
            "{{json .ID}}",
          ])
        ) {
          return {
            exited: Promise.resolve(0),
            stdout: new Response('"synthetic-daemon"\n').body,
          };
        }
        if (
          JSON.stringify(argv) ===
          JSON.stringify(["/synthetic/docker", "container", "stop", IDS[0]])
        ) {
          return { exited: Promise.resolve(0) };
        }
        throw new Error("unexpected effect");
      },
    };
    const AsyncFunction: new (
      ...args: string[]
    ) => (...ports: unknown[]) => Promise<unknown> = Object.getPrototypeOf(
      async () => undefined
    ).constructor;
    try {
      const lines = source.split("\n");
      if (
        !(
          lines[1]?.startsWith("import { readPrivate } from ") &&
          lines[1].endsWith(";")
        ) ||
        lines[2] !== "import { writeFile } from 'node:fs/promises';"
      ) {
        throw new Error("emitted bounded reader import missing");
      }
      await new AsyncFunction(
        "Bun",
        "process",
        "readPrivate",
        "writeFile",
        lines.slice(3).join("\n")
      )(fixtureBun, fixtureProcess, readReceipt, writeFile);
      throw new Error("emitted forwarder did not exit");
    } catch (error: unknown) {
      if (
        existingMarker &&
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        writeError = "EEXIST";
      } else if (error !== exit) {
        throw error;
      }
    }
    let marker: string | null = null;
    let markerMode: number | null = null;
    try {
      const info = await lstat(markerPath);
      markerMode = info.mode & 0o777;
      marker = (await readPrivate(markerPath, 128)).text;
    } catch (error: unknown) {
      if (
        !(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        )
      ) {
        throw error;
      }
    }
    return { code: exit.code, requests, marker, markerMode, writeError };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const PENDING = {
  adoption_receipt_version: 14,
  pendingOperation: { operation: "stop", services: ["db", "web", "worker"] },
  routingOperation: { disposition: "prospective", code: null },
  routingHandoff: "held",
};
test("emitted partial-stop control requires prospective authority before one original-ID stop and exact marker", async () => {
  const result = await replay(PENDING, ["container", "stop", ...IDS]);
  expect(result).toEqual({
    code: 71,
    requests: [
      ["/synthetic/docker", "info", "--format", "{{json .ID}}"],
      ["/synthetic/docker", "container", "stop", IDS[0]],
    ],
    marker: "known-routing-partial-stop",
    markerMode: 0o600,
    writeError: null,
  });
});
test("emitted partial-stop marker refuses an existing private leaf without overwriting it", async () => {
  expect(await replay(PENDING, ["container", "stop", ...IDS], true)).toEqual({
    code: -1,
    requests: [
      ["/synthetic/docker", "info", "--format", "{{json .ID}}"],
      ["/synthetic/docker", "container", "stop", IDS[0]],
    ],
    marker: "existing-private-marker",
    markerMode: 0o600,
    writeError: "EEXIST",
  });
});
test("emitted partial-stop control refuses stale journals, incomplete selection and foreign argv without effects", async () => {
  for (const state of [
    { ...PENDING, adoption_receipt_version: 11 },
    { ...PENDING, routingOperation: { disposition: "settled", code: 0 } },
    {
      ...PENDING,
      pendingOperation: {
        operation: "start",
        services: ["db", "web", "worker"],
      },
    },
    { ...PENDING, routingHandoff: "releasing" },
  ]) {
    expect(await replay(state, ["container", "stop", ...IDS])).toEqual({
      code: 98,
      requests: [],
      marker: null,
      markerMode: null,
      writeError: null,
    });
  }
  expect(await replay(PENDING, ["container", "stop", IDS[0]])).toEqual({
    code: 99,
    requests: [],
    marker: null,
    markerMode: null,
    writeError: null,
  });
});
