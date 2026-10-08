import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  nativeComposeAdoptionWorktreesScenario,
  ownedAdoptionFixtureObservation,
} from "./e2e/scenarios/native-compose-adoption-worktrees.ts";

const instance = {
  root: "/synthetic/linked-checkout",
  name: "owned-linked-fixture",
  marker: "synthetic-existing-sql-row",
};
const id = "a".repeat(64);
const createdAt = "2026-10-07T21:00:00.123456789Z";
const REFUSAL =
  "Adoption worktree fixture ownership or data check failed; values omitted.";
const CANARY = "synthetic-private-fixture-canary";
const rows = {
  container: {
    id,
    name: `/${instance.name}-db-1`,
    project: instance.name,
    nativeNames: ["com.docker.compose.project"],
    service: "db",
    workingDir: join(instance.root, ".hack"),
    configFiles: join(instance.root, ".hack/docker-compose.yml"),
    mounts: [
      {
        type: "volume",
        name: `${instance.name}_data`,
        target: "/var/lib/postgresql/data",
        rw: true,
      },
    ],
  },
  network: {
    id,
    name: `${instance.name}_default`,
    project: instance.name,
    nativeNames: [],
    logical: "default",
    createdAt,
  },
  volume: {
    name: `${instance.name}_data`,
    project: instance.name,
    nativeNames: [],
    storage: "data",
    createdAt,
  },
};

test("cleanup oracle accepts only the original fixture IDs, canonical mounts and creation facts", () => {
  expect(
    ownedAdoptionFixtureObservation({
      instance,
      kind: "container",
      row: rows.container,
    })
  ).toEqual({ id, service: "db" });
  expect(
    ownedAdoptionFixtureObservation({
      instance,
      kind: "container",
      row: {
        ...rows.container,
        name: `/${instance.name}-worker-1`,
        service: "worker",
        mounts: [],
      },
    })
  ).toEqual({ id, service: "worker" });
  expect(
    ownedAdoptionFixtureObservation({
      instance,
      kind: "network",
      row: rows.network,
    })
  ).toEqual({ id, createdAt });
  expect(
    ownedAdoptionFixtureObservation({
      instance,
      kind: "volume",
      row: rows.volume,
    })
  ).toEqual({ id: `${instance.name}_data`, createdAt });
});

for (const kind of ["container", "network", "volume"] as const) {
  test.each([
    ["foreign project", { project: "foreign-fixture" }],
    ["missing project", { project: null }],
    ["native version", { nativeNames: ["io.hack.native-config.version"] }],
    [
      "native owner without a version",
      { nativeNames: ["io.hack.native-config.owner"] },
    ],
    ["invalid label names", { nativeNames: [42] }],
    ["missing label inventory", { nativeNames: null }],
  ])(`${kind} cleanup refuses %s`, (_name, changed) => {
    expect(() =>
      ownedAdoptionFixtureObservation({
        instance,
        kind,
        row: { ...rows[kind], ...changed },
      })
    ).toThrow(REFUSAL);
  });
}

test.each([
  ["abbreviated ID", { id: id.slice(0, 12) }],
  ["other ordinal", { name: `/${instance.name}-db-2` }],
  ["other service", { service: "other" }],
  ["other checkout", { workingDir: "/synthetic/foreign/.hack" }],
  [
    "extra Compose override",
    { configFiles: `${rows.container.configFiles},/override.yml` },
  ],
  ["missing mounts", { mounts: [] }],
  [
    "replacement volume",
    { mounts: [{ ...rows.container.mounts[0], name: "empty-replacement" }] },
  ],
  [
    "changed mount target",
    { mounts: [{ ...rows.container.mounts[0], target: "/different" }] },
  ],
  ["read-only mount", { mounts: [{ ...rows.container.mounts[0], rw: false }] }],
  [
    "extra mounted resource",
    {
      mounts: [
        ...rows.container.mounts,
        { type: "bind", name: "", target: "/extra", rw: true },
      ],
    },
  ],
])("container cleanup refuses %s", (_name, changed) => {
  expect(() =>
    ownedAdoptionFixtureObservation({
      instance,
      kind: "container",
      row: { ...rows.container, ...changed },
    })
  ).toThrow(REFUSAL);
});

for (const kind of ["network", "volume"] as const) {
  test.each([
    ["other name", { name: "foreign-resource" }],
    ["missing creation fact", { createdAt: null }],
    ["malformed creation fact", { createdAt: "invalid-time" }],
    ["ambiguous date", { createdAt: "0" }],
  ])(`${kind} cleanup refuses %s`, (_name, changed) => {
    expect(() =>
      ownedAdoptionFixtureObservation({
        instance,
        kind,
        row: { ...rows[kind], ...changed },
      })
    ).toThrow(REFUSAL);
  });
}

test("logical resource mismatches and shortened network IDs never authorize cleanup", () => {
  for (const row of [
    { ...rows.network, logical: "foreign" },
    { ...rows.network, id: id.slice(0, 12) },
  ]) {
    expect(() =>
      ownedAdoptionFixtureObservation({ instance, kind: "network", row })
    ).toThrow(REFUSAL);
  }
  expect(() =>
    ownedAdoptionFixtureObservation({
      instance,
      kind: "volume",
      row: { ...rows.volume, storage: "foreign" },
    })
  ).toThrow(REFUSAL);
});

test("malformed observations and throwing getters have fixed diagnostics", () => {
  for (const row of [
    null,
    [],
    CANARY,
    {
      get project() {
        throw new Error(CANARY);
      },
    },
  ]) {
    expect(() =>
      ownedAdoptionFixtureObservation({ instance, kind: "volume", row })
    ).toThrow(REFUSAL);
  }
  expect(() =>
    ownedAdoptionFixtureObservation({
      instance,
      kind: "container",
      row: {
        ...rows.container,
        service: { toString: () => "db" },
        mounts: [],
      },
    })
  ).toThrow(REFUSAL);
  expect(() =>
    ownedAdoptionFixtureObservation({
      instance,
      get kind(): never {
        throw new Error(CANARY);
      },
      row: rows.volume,
    })
  ).toThrow(REFUSAL);
});

test("maintained adoption acceptance refuses source invocation before probes or effects", async () => {
  const previous = process.env.HACK_E2E_CLI_BIN;
  Reflect.deleteProperty(process.env, "HACK_E2E_CLI_BIN");
  let invocations = 0;
  try {
    await expect(
      nativeComposeAdoptionWorktreesScenario.run({
        repoRoot: instance.root,
        hackHome: "/synthetic/unused-home",
        tempRoot: "/synthetic/unused-temp",
        cli: async () => {
          invocations++;
          throw new Error("Unexpected fixture command");
        },
        log: () => {},
        skip: () => {
          throw new Error("Unexpected fixture skip");
        },
      })
    ).rejects.toThrow(
      "requires the current compiled CLI and companion compiler"
    );
    expect(invocations).toBe(0);
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, "HACK_E2E_CLI_BIN");
    } else {
      process.env.HACK_E2E_CLI_BIN = previous;
    }
  }
});
