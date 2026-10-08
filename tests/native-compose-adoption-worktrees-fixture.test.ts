import { expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeComposeProbe } from "../src/lib/native-compose-ownership.ts";
import {
  assertAdoptionBridgeObservation,
  assertAdoptionEndpointObservation,
  assertAdoptionWorkerArgv,
  cleanupOwnedAdoptionFixture,
  createAdoptionFixtureProbe,
  nativeComposeAdoptionWorktreesScenario,
  ownedAdoptionFixtureObservation,
  waitForAdoptionFixtureSql,
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

const literalArgv = {
  id,
  command: ["command-$NC04_LITERAL", "$$", ""],
  entrypoint: [
    "/bin/sh",
    "-c",
    "trap 'sleep 10; exit 0' TERM; while true; do sleep 1; done",
    "entrypoint-${NC04_LITERAL}",
  ],
};
const clearedArgv = {
  id,
  command: [
    "/bin/sh",
    "-c",
    "trap 'sleep 10; exit 0' TERM; while true; do sleep 1; done",
    "command-$NC04_LITERAL",
    "$$",
    "",
  ],
  entrypoint: [],
};

test("owned fixture actual argv keeps both dollar forms and an empty argument", () => {
  expect(() =>
    assertAdoptionWorkerArgv({ id, row: literalArgv })
  ).not.toThrow();
  expect(() =>
    assertAdoptionWorkerArgv({
      id,
      row: literalArgv,
      mode: "string-entrypoint",
    })
  ).not.toThrow();
});

test("string-form fixture requires an explicitly cleared image entrypoint and exact command words", () => {
  expect(() =>
    assertAdoptionWorkerArgv({ id, row: clearedArgv, mode: "string-cleared" })
  ).not.toThrow();
  for (const row of [
    { ...clearedArgv, entrypoint: null },
    { ...clearedArgv, entrypoint: ["/bin/sh"] },
    { ...clearedArgv, command: clearedArgv.command.slice(0, -1) },
    { ...clearedArgv, command: [CANARY] },
  ]) {
    expect(() =>
      assertAdoptionWorkerArgv({ id, row, mode: "string-cleared" })
    ).toThrow(REFUSAL);
  }
});

test.each([
  ["changed container ID", { ...literalArgv, id: "b".repeat(64) }],
  ["interpolated command", { ...literalArgv, command: [CANARY, "$$", ""] }],
  [
    "missing empty argument",
    { ...literalArgv, command: ["command-$NC04_LITERAL", "$$"] },
  ],
  ["changed entrypoint", { ...literalArgv, entrypoint: ["/bin/sh", "-c"] }],
  [
    "interpolated entrypoint",
    { ...literalArgv, entrypoint: ["/bin/sh", "-c", CANARY, "literal"] },
  ],
  ["malformed command", { ...literalArgv, command: null }],
])("actual argv oracle refuses %s with a fixed diagnostic", (_label, row) => {
  expect(() => assertAdoptionWorkerArgv({ id, row })).toThrow(REFUSAL);
  expect(() => assertAdoptionWorkerArgv({ id, row })).not.toThrow(CANARY);
});

test("later fixture lifecycle reads create independent bounded acquisitions after the original expires", async () => {
  const root = await mkdtemp(join(tmpdir(), "adoption-probe-lifetime-"));
  const previous = process.env.PATH;
  const commands = join(root, "queries");
  const script = join(root, "docker");
  await Bun.write(
    script,
    `#!${process.execPath}
import {appendFileSync,writeFileSync} from "node:fs";
const args=process.argv.slice(2);
if(args.join(" ")!=="info --format {{.OSType}}") {writeFileSync(${JSON.stringify(join(root, "unexpected"))},"refused");process.exit(99);}
appendFileSync(${JSON.stringify(commands)},JSON.stringify(args)+"\\n");
console.log("linux");
`
  );
  await chmod(script, 0o700);
  process.env.PATH = root;
  const wallClock = spyOn(Date, "now").mockReturnValue(0);
  try {
    const args = ["info", "--format", "{{.OSType}}"];
    const original = createNativeComposeProbe({ timeoutMs: 30_000 });
    const later = createAdoptionFixtureProbe();
    expect((await original(args)).trim()).toBe("linux");
    expect(await later(args)).toBe("linux");
    wallClock.mockReturnValue(30_001);
    await expect(original(args)).rejects.toMatchObject({
      code: "E_NATIVE_COMPOSE_PROBE_TIMEOUT",
    });
    expect(await later(args)).toBe("linux");
    wallClock.mockReturnValue(60_002);
    expect(await later(args)).toBe("linux");
    expect((await readFile(commands, "utf8")).trim().split("\n")).toHaveLength(
      4
    );
    expect(await Bun.file(join(root, "unexpected")).exists()).toBe(false);
  } finally {
    wallClock.mockRestore();
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, "PATH");
    } else {
      process.env.PATH = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("SQL usability retries a transient initialization refusal before accepting the expected row", async () => {
  let attempts = 0;
  let now = 0;
  await waitForAdoptionFixtureSql({
    read: () => {
      attempts++;
      return attempts === 1
        ? Promise.reject(new Error(CANARY))
        : Promise.resolve("1");
    },
    expected: "1",
    timeoutMs: 1000,
    now: () => now,
    pause: async () => {
      now += 500;
    },
  });
  expect(attempts).toBe(2);
});

test("connection acceptance alone does not establish the expected SQL marker", async () => {
  let attempts = 0;
  let now = 0;
  await waitForAdoptionFixtureSql({
    read: () =>
      Promise.resolve(++attempts === 1 ? "accepting connections" : "marker"),
    expected: "marker",
    timeoutMs: 1000,
    now: () => now,
    pause: async () => {
      now += 500;
    },
  });
  expect(attempts).toBe(2);
});

test("a row returned after the SQL deadline refuses", async () => {
  let now = 0;
  await expect(
    waitForAdoptionFixtureSql({
      read: () => {
        now = 1000;
        return Promise.resolve("1");
      },
      expected: "1",
      timeoutMs: 1000,
      now: () => now,
    })
  ).rejects.toThrow(REFUSAL);
});

test("persistent SQL initialization errors stop at the deadline with fixed diagnostics", async () => {
  let attempts = 0;
  let now = 0;
  await expect(
    waitForAdoptionFixtureSql({
      read: () => {
        attempts++;
        return Promise.reject(new Error(CANARY));
      },
      expected: "1",
      timeoutMs: 1000,
      now: () => now,
      pause: async () => {
        now += 500;
      },
    })
  ).rejects.toThrow(REFUSAL);
  expect(attempts).toBe(2);
});

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
        mounts: [{ ...rows.container.mounts[0], rw: false }],
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

test.each([
  ["writable storage", [{ ...rows.container.mounts[0], rw: true }]],
  ["missing explicit storage", []],
  [
    "image-created anonymous storage",
    [{ ...rows.container.mounts[0], name: "b".repeat(64), rw: false }],
  ],
])("worker cleanup refuses %s", (_name, mounts) => {
  expect(() =>
    ownedAdoptionFixtureObservation({
      instance,
      kind: "container",
      row: {
        ...rows.container,
        name: `/${instance.name}-worker-1`,
        service: "worker",
        mounts,
      },
    })
  ).toThrow(REFUSAL);
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

test("owned bridge fixture cleanup binds exact logical name and internal bridge policy", () => {
  const custom = { ...instance, ownedNetwork: true as const };
  const selected = {
    ...rows.network,
    name: `${instance.name}_private`,
    logical: "private",
    driver: "bridge",
    scope: "local",
    internal: true,
  };
  expect(
    ownedAdoptionFixtureObservation({
      instance: custom,
      kind: "network",
      row: selected,
    })
  ).toEqual({ id, createdAt });
  for (const changed of [
    { name: `${instance.name}_default` },
    { logical: "default" },
    { driver: "overlay" },
    { scope: "swarm" },
    { internal: false },
  ]) {
    expect(() =>
      ownedAdoptionFixtureObservation({
        instance: custom,
        kind: "network",
        row: { ...selected, ...changed },
      })
    ).toThrow(REFUSAL);
  }
});

test("owned bridge observation refuses foreign membership and policy", () => {
  const custom = { ...instance, ownedNetwork: true as const };
  const selected = {
    id,
    name: `${instance.name}_private`,
    logical: "private",
    driver: "bridge",
    scope: "local",
    internal: true,
    members: [id],
  };
  expect(() =>
    assertAdoptionBridgeObservation({
      instance: custom,
      id,
      members: [id],
      row: selected,
    })
  ).not.toThrow();
  for (const changed of [
    { members: [] },
    { members: [id, "b".repeat(64)] },
    { internal: false },
    { name: `${instance.name}_default` },
    { id: "c".repeat(64) },
  ]) {
    expect(() =>
      assertAdoptionBridgeObservation({
        instance: custom,
        id,
        members: [id],
        row: { ...selected, ...changed },
      })
    ).toThrow(REFUSAL);
  }
});

test("running original requires exact bridge ID and static aliases; stopped alias loss stays bounded", () => {
  const custom = { ...instance, ownedNetwork: true as const };
  const selected = {
    id,
    running: true,
    networks: [
      {
        name: `${instance.name}_private`,
        id,
        aliases: [`${instance.name}-db-1`, "db", "db-reader"],
      },
    ],
  };
  const verify = (row: unknown, running = true) =>
    assertAdoptionEndpointObservation({
      instance: custom,
      networkId: id,
      container: { id, service: "db" },
      running,
      row,
    });
  expect(() => verify(selected)).not.toThrow();
  const originalEndpoint = selected.networks[0];
  if (!originalEndpoint) {
    throw new Error("Fixture endpoint missing");
  }
  for (const endpoint of [
    { ...originalEndpoint, id: "c".repeat(64) },
    { ...originalEndpoint, aliases: ["db", "db-reader"] },
    {
      ...originalEndpoint,
      aliases: [...originalEndpoint.aliases, "foreign"],
    },
    { ...originalEndpoint, name: `${instance.name}_default` },
  ]) {
    expect(() => verify({ ...selected, networks: [endpoint] })).toThrow(
      REFUSAL
    );
  }
  expect(() =>
    verify({
      ...selected,
      networks: [{ ...selected.networks[0], aliases: null }],
    })
  ).toThrow(REFUSAL);
  expect(() =>
    verify(
      {
        ...selected,
        running: false,
        networks: [{ ...selected.networks[0], aliases: null }],
      },
      false
    )
  ).not.toThrow();
  expect(() =>
    verify(
      {
        ...selected,
        running: false,
        networks: [{ ...selected.networks[0], aliases: ["foreign"] }],
      },
      false
    )
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
        retainFixtures: () => {
          throw new Error("Unexpected fixture retention");
        },
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

test.each([
  "entry",
  "container",
  "network",
  "volume",
] as const)("changed daemon at cleanup %s sends no removal command", async (phase) => {
  const resourceKind = phase === "entry" ? "container" : phase;
  const observation = ownedAdoptionFixtureObservation({
    instance,
    kind: resourceKind,
    row: rows[resourceKind],
  });
  const resources = {
    container: resourceKind === "container" ? [observation] : [],
    network: resourceKind === "network" ? [observation] : [],
    volume: resourceKind === "volume" ? [observation] : [],
  };
  let daemonReads = 0;
  let removals = 0;
  await expect(
    cleanupOwnedAdoptionFixture({
      engineId: "prepared-daemon",
      instances: [instance],
      anchors: new Map([[instance, { resources, source: "synthetic-source" }]]),
      resources: async () => resources,
      owned: async (_instance, kind) =>
        ownedAdoptionFixtureObservation({ instance, kind, row: rows[kind] }),
      list: async () => [],
      probe: async (args) => {
        if (args[0] === "info") {
          daemonReads++;
          return phase === "entry" || daemonReads > 1
            ? "changed-daemon"
            : "prepared-daemon";
        }
        return args[0] === "network" ? "0" : "";
      },
      effect: async () => {
        removals++;
        return {
          command: "synthetic-removal",
          exitCode: 0,
          stdout: "",
          stderr: "",
          combined: "",
          timedOut: false,
          durationMs: 0,
        };
      },
    })
  ).rejects.toThrow(REFUSAL);
  expect(removals).toBe(0);
  expect(daemonReads).toBe(phase === "entry" ? 1 : 2);
});

test("unchanged prepared daemon allows only the captured cleanup identities", async () => {
  const resources = {
    container: [
      ownedAdoptionFixtureObservation({
        instance,
        kind: "container",
        row: rows.container,
      }),
    ],
    network: [
      ownedAdoptionFixtureObservation({
        instance,
        kind: "network",
        row: rows.network,
      }),
    ],
    volume: [
      ownedAdoptionFixtureObservation({
        instance,
        kind: "volume",
        row: rows.volume,
      }),
    ],
  };
  let daemonReads = 0;
  const removals: string[][] = [];
  await cleanupOwnedAdoptionFixture({
    engineId: "prepared-daemon",
    instances: [instance],
    anchors: new Map([[instance, { resources, source: "synthetic-source" }]]),
    resources: async () => resources,
    owned: async (_instance, kind) =>
      ownedAdoptionFixtureObservation({ instance, kind, row: rows[kind] }),
    list: async () => [],
    probe: async (args) => {
      if (args[0] === "info") {
        daemonReads++;
        return "prepared-daemon";
      }
      return args[0] === "network" ? "0" : "";
    },
    effect: async (args) => {
      removals.push([...args]);
      return {
        command: "synthetic-removal",
        exitCode: 0,
        stdout: "",
        stderr: "",
        combined: "",
        timedOut: false,
        durationMs: 0,
      };
    },
  });
  expect(removals).toEqual([
    ["container", "rm", "--force", id],
    ["network", "rm", id],
    ["volume", "rm", `${instance.name}_data`],
  ]);
  expect(daemonReads).toBe(4);
});
