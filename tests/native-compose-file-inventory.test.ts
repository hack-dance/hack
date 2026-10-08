import { expect, test } from "bun:test";
import {
  assertNativeComposeFileMounts,
  assertNativeComposeFileMountsAbsent,
  observeNativeComposeFileEngine,
} from "../src/lib/native-compose-file-inventory.ts";
import type { NativeComposeOwnershipObservation } from "../src/lib/native-compose-ownership.ts";

// This tests the read-only engine codec. Actual material authority and publication
// are exercised separately with the compiler, generation and filesystem owners.
const GENERATION = "a".repeat(32);
const ID = "b".repeat(64);
const OTHER = "c".repeat(64);
const ROOT = "/private/synthetic/${literal}$";
const PREFIX = `${ROOT}/${GENERATION}-${"d".repeat(32)}`;
const SOURCE = `${PREFIX}/member`;
const TARGET = "/run/${literal}$";
const INFO = ["info", "--format", "{{json .ID}}"];
const LIST = [
  "container",
  "ls",
  "-a",
  "--no-trunc",
  "--format",
  "{{json .ID}}",
];
const INSPECT = [
  "container",
  "inspect",
  "--format",
  '{"id":{{json .Id}},"mounts":{{json .Mounts}}}',
];
function document() {
  return {
    "x-hack-native-file-engine": { version: 1, engineId: "synthetic-engine:1" },
    "x-hack-native-files": {
      version: 1,
      root: ROOT,
      rootToken: "e".repeat(32),
      rootDirectory: { dev: 1, ino: 2 },
      rootReceipt: { dev: 1, ino: 3, digest: "f".repeat(64) },
      snapshotToken: "d".repeat(32),
      snapshotDirectory: { dev: 1, ino: 4 },
      generationId: GENERATION,
      manifest: { dev: 1, ino: 5, digest: "f".repeat(64) },
    },
    services: {
      reader: {
        volumes: [
          {
            type: "bind",
            source: SOURCE.replaceAll("$", () => "$$"),
            target: TARGET.replaceAll("$", () => "$$"),
            read_only: true,
            bind: { create_host_path: false },
          },
        ],
      },
    },
  };
}
function observation(): NativeComposeOwnershipObservation {
  return {
    containers: [
      {
        id: ID,
        name: "reader",
        generationId: GENERATION,
        service: "reader",
        state: "exited",
        exitCode: 0,
        health: null,
        oneoff: false,
      },
    ],
    networks: [],
    volumes: [],
  };
}
type Mount = { Type: string; Source: string; Destination: string; RW: boolean };
function mount(): Mount {
  return { Type: "bind", Source: SOURCE, Destination: TARGET, RW: false };
}
function transport(
  opts: {
    readonly rows?: readonly { id: string; mounts: readonly Mount[] }[];
    readonly drift?: boolean;
    readonly malformed?: boolean;
    readonly first?: () => void;
  } = {}
) {
  const calls: string[][] = [];
  let info = 0;
  const rows = opts.rows ?? [{ id: ID, mounts: [mount()] }];
  const probe = async (args: readonly string[]) => {
    calls.push([...args]);
    if (JSON.stringify(args) === JSON.stringify(INFO)) {
      opts.first?.();
      info++;
      return JSON.stringify(
        opts.drift && info > 1 ? "different-engine:1" : "synthetic-engine:1"
      );
    }
    if (JSON.stringify(args) === JSON.stringify(LIST)) {
      return rows.map((row) => JSON.stringify(row.id)).join("\n");
    }
    if (
      JSON.stringify(args) ===
      JSON.stringify([...INSPECT, ...rows.map((row) => row.id)])
    ) {
      return opts.malformed
        ? "{}"
        : rows.map((row) => JSON.stringify(row)).join("\n");
    }
    throw new Error("Unexpected engine query or mutation");
  };
  return { probe, calls };
}
test("exact literal read-only binds qualify an exited owned job through fixed read-only queries", async () => {
  const io = transport();
  await assertNativeComposeFileMounts({
    document: document(),
    generationId: GENERATION,
    observed: observation(),
    probe: io.probe,
  });
  expect(io.calls).toEqual([INFO, LIST, [...INSPECT, ID], INFO]);
});
for (const [name, changed] of [
  ["writable", { ...mount(), RW: true }],
  ["different source", { ...mount(), Source: `${SOURCE}-other` }],
  ["different target", { ...mount(), Destination: "/run/other" }],
  ["volume masquerading as bind", { ...mount(), Type: "volume" }],
] as const) {
  test(`${name} refuses exact file delivery`, async () => {
    const io = transport({ rows: [{ id: ID, mounts: [changed] }] });
    await expect(
      assertNativeComposeFileMounts({
        document: document(),
        generationId: GENERATION,
        observed: observation(),
        probe: io.probe,
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
  });
}
test("duplicate targets and an extra private snapshot bind on a foreign container refuse", async () => {
  for (const rows of [
    [{ id: ID, mounts: [mount(), mount()] }],
    [
      { id: ID, mounts: [mount()] },
      { id: OTHER, mounts: [{ ...mount(), Destination: "/extra" }] },
    ],
    [
      {
        id: ID,
        mounts: [
          mount(),
          { ...mount(), Source: PREFIX, Destination: "/extra" },
        ],
      },
    ],
  ]) {
    await expect(
      assertNativeComposeFileMounts({
        document: document(),
        generationId: GENERATION,
        observed: observation(),
        probe: transport({ rows }).probe,
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
  }
});
test("engine drift, malformed inspect, missing container and mismatched generation refuse", async () => {
  for (const opts of [{ drift: true }, { malformed: true }, { rows: [] }]) {
    await expect(
      assertNativeComposeFileMounts({
        document: document(),
        generationId: GENERATION,
        observed: observation(),
        probe: transport(opts).probe,
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
  }
  const io = transport();
  await expect(
    assertNativeComposeFileMounts({
      document: document(),
      generationId: "f".repeat(32),
      observed: observation(),
      probe: io.probe,
    })
  ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
  expect(io.calls).toEqual([]);
});
test("ownership observation is captured before admission awaits", async () => {
  const observed = observation();
  const io = transport({
    first: () => {
      Object.assign(observed.containers[0] ?? {}, { id: OTHER });
    },
  });
  await assertNativeComposeFileMounts({
    document: document(),
    generationId: GENERATION,
    observed,
    probe: io.probe,
  });
});
test("retirement requires global absence on the saved engine even for unowned stopped containers", async () => {
  await assertNativeComposeFileMountsAbsent({
    document: document(),
    probe: transport({ rows: [] }).probe,
  });
  for (const source of [SOURCE, PREFIX]) {
    await expect(
      assertNativeComposeFileMountsAbsent({
        document: document(),
        probe: transport({
          rows: [{ id: OTHER, mounts: [{ ...mount(), Source: source }] }],
        }).probe,
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
  }
  await expect(
    assertNativeComposeFileMountsAbsent({
      document: document(),
      probe: transport({ rows: [], drift: true }).probe,
    })
  ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
});
test("saved engine observation is checked twice and errors omit daemon output", async () => {
  await expect(
    observeNativeComposeFileEngine({ probe: transport({ drift: true }).probe })
  ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
  await expect(
    observeNativeComposeFileEngine({
      probe: async () => {
        throw new Error("synthetic-sensitive-daemon-diagnostic");
      },
    })
  ).rejects.toThrow("values omitted");
});
test("whole-observation output charging and cancellation cannot become successful engine binding", async () => {
  const padded = `${JSON.stringify("synthetic-engine:1")}${" ".repeat(4 * 1024 * 1024)}`;
  let count = 0;
  await expect(
    observeNativeComposeFileEngine({
      probe: () => {
        count++;
        return Promise.resolve(padded);
      },
    })
  ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
  expect(count).toBe(2);
  const controller = new AbortController();
  await expect(
    observeNativeComposeFileEngine({
      signal: controller.signal,
      probe: () => {
        controller.abort();
        return Promise.resolve(JSON.stringify("synthetic-engine:1"));
      },
    })
  ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
});
