import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNativeComposeBuildExecution,
  buildNativeComposeImages,
  NativeComposeBuildError,
  planNativeComposeBuilds,
  prepareNativeComposeBuildExecution,
} from "../src/lib/native-compose-build.ts";
import { openNativeComposeGenerationStore } from "../src/lib/native-compose-generation.ts";
import { renderNativeCompose } from "../src/lib/native-compose-renderer.ts";
import { composeFixture } from "./helpers/native-compose.ts";

const ID = `sha256:${"d".repeat(64)}`;
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function fixture(rebuild = false) {
  const input = composeFixture({
    services: {
      web: {
        build: {
          context: "build-${AMBIENT}/percent-%{literal}",
          dockerfile: "docker/Dockerfile",
          target: "selected",
        },
        ...(rebuild ? { pull_policy: "build" as const } : {}),
      },
    },
  });
  input.projectRoot = "/verified/${AMBIENT}/checkout";
  const document = renderNativeCompose(input).document;
  const options = {
    document,
    projectRoot: input.projectRoot,
    composeProject: input.runtimeIdentity,
    ownerToken: input.ownerToken,
  };
  return {
    input,
    document,
    options,
    intents: planNativeComposeBuilds(options),
  };
}

function cached(intent: ReturnType<typeof planNativeComposeBuilds>[number]) {
  return {
    id: ID,
    version: "1",
    instance: intent.composeProject,
    owner: intent.ownerToken,
    service: intent.service,
    kind: intent.kind,
  };
}

function harness(rebuild = false, initial = false) {
  const value = fixture(rebuild);
  let present = initial;
  let executed = 0;
  let checks = 0;
  const intent = value.intents[0];
  if (!intent) {
    throw new Error("Intent missing");
  }
  const options = {
    intents: value.intents,
    projectRoot: value.input.projectRoot,
    signal: new AbortController().signal,
    env: undefined,
    json: true,
    assertFresh: async () => {
      checks++;
    },
    assertOwned: async () => {
      checks++;
    },
    io: {
      engine: async (): Promise<unknown> => "fixture-engine:1",
      probe: async (args: readonly string[]) =>
        args[1] === "ls"
          ? present
            ? `${ID}\n`
            : ""
          : JSON.stringify(cached(intent)),
      execute: async (
        _args: readonly string[],
        _timeout: number | undefined
      ) => {
        executed++;
        present = true;
        return 0;
      },
    },
  };
  return { value, options, executed: () => executed, checks: () => checks };
}

test("direct build argv keeps literal path expressions, nested Dockerfile and stage without Bake", async () => {
  const { intents } = fixture();
  const intent = intents[0];
  if (!intent) {
    throw new Error("Intent missing");
  }
  expect(intent.tag).toBe("nc03-fixture-a-web:latest");
  expect(intent.args.slice(0, 9)).toEqual([
    "docker",
    "buildx",
    "build",
    "--load",
    "--tag",
    intent.tag,
    "--file",
    "/verified/${AMBIENT}/checkout/build-${AMBIENT}/percent-%{literal}/docker/Dockerfile",
    "--target",
  ]);
  expect(intent.args[9]).toBe("selected");
  expect(intent.args.at(-1)).toBe(
    "/verified/${AMBIENT}/checkout/build-${AMBIENT}/percent-%{literal}"
  );
  expect(intent.args).not.toContain("bake");
  expect(intent.args).not.toContain("--build-arg");
  expect(intent.args).not.toContain("--pull");
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-build-argv-"))
  );
  roots.push(root);
  const executable = join(root, "argv.ts");
  await Bun.write(
    executable,
    "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n"
  );
  const child = Bun.spawn([process.execPath, executable, ...intent.args], {
    env: { AMBIENT: "must-not-expand" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const observed = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(JSON.parse(observed)).toEqual(intent.args);
  expect(observed).not.toContain("must-not-expand");
});

test("run build scope contains only selected target and transitive dependencies", () => {
  const input = composeFixture({
    services: {
      target: {
        build: { context: ".", dockerfile: "Dockerfile" },
        depends_on: [{ job: "init", condition: "completed" }],
      },
      unrelated: { build: { context: "other", dockerfile: "Dockerfile" } },
      db: { image: "fixture/db:1" },
    },
    jobs: {
      init: {
        build: { context: "deps", dockerfile: "Dockerfile" },
        depends_on: [{ service: "db", condition: "started" }],
      },
    },
  });
  const document = renderNativeCompose(input).document;
  const options = {
    document,
    projectRoot: input.projectRoot,
    composeProject: input.runtimeIdentity,
    ownerToken: input.ownerToken,
  };
  expect(
    planNativeComposeBuilds({ ...options, service: "target" }).map(
      (intent) => intent.service
    )
  ).toEqual(["init", "target"]);
  expect(
    planNativeComposeBuilds(options).map((intent) => intent.service)
  ).toEqual(["init", "target", "unrelated"]);
  expect(
    planNativeComposeBuilds({
      ...options,
      service: "target",
      includeDependencies: false,
    }).map((intent) => intent.service)
  ).toEqual(["target"]);
  expect(() =>
    planNativeComposeBuilds({ ...options, service: "constructor" })
  ).toThrow(NativeComposeBuildError);
  const projected = prepareNativeComposeBuildExecution({
    ...options,
    service: "target",
  });
  expect(projected.intents.map((intent) => intent.service)).toEqual([
    "init",
    "target",
  ]);
  expect(projected.document.services).toMatchObject({
    init: { image: "nc03-fixture-a-init:latest", pull_policy: "never" },
    target: { image: "nc03-fixture-a-target:latest", pull_policy: "never" },
    unrelated: {
      image: "nc03-fixture-a-unrelated:latest",
      pull_policy: "never",
    },
    db: { image: "fixture/db:1" },
  });
  const warm = prepareNativeComposeBuildExecution({
    ...options,
    service: "target",
    includeDependencies: false,
  });
  expect(warm.document).toEqual(projected.document);
  expect(warm.intents.map((intent) => intent.service)).toEqual(["target"]);
});

test("one immutable image-only document preserves exact build source and authored image policies", () => {
  for (const policy of [undefined, "always", "never", "missing"] as const) {
    const input = composeFixture({
      services: {
        web: {
          build: { context: "build-${AMBIENT}", dockerfile: "Dockerfile" },
          pull_policy: "build",
        },
        db: {
          image: "fixture/db:1",
          ...(policy ? { pull_policy: policy } : {}),
        },
      },
    });
    const document = renderNativeCompose(input).document;
    const source = JSON.stringify(document);
    const options = {
      document,
      projectRoot: input.projectRoot,
      composeProject: input.runtimeIdentity,
      ownerToken: input.ownerToken,
    };
    const prepared = prepareNativeComposeBuildExecution(options);
    expect(JSON.stringify(document)).toBe(source);
    expect(prepared.document.services).toMatchObject({
      web: { image: "nc03-fixture-a-web:latest", pull_policy: "never" },
      db: document.services.db,
    });
    const services = prepared.document.services as Record<string, unknown>;
    expect(Object.hasOwn(services.web as object, "build")).toBe(false);
    expect(prepared.document["x-hack-native-build"]).toEqual({
      version: 1,
      workloads: {
        web: {
          build: document.services.web?.build,
          pull_policy: "build",
        },
      },
    });
    expect(() =>
      assertNativeComposeBuildExecution({
        ...options,
        executionDocument: prepared.document,
        intents: prepared.intents,
      })
    ).not.toThrow();
    expect(prepareNativeComposeBuildExecution(options)).toEqual(prepared);
  }
});

test("changed or stripped source, scoped intents and image projections refuse before effects", () => {
  const { options } = fixture();
  const prepared = prepareNativeComposeBuildExecution(options);
  const services = prepared.document.services as Record<string, unknown>;
  const web = services.web as Record<string, unknown>;
  const { "x-hack-native-build": _source, ...stripped } = prepared.document;
  for (const document of [
    stripped,
    {
      ...prepared.document,
      "x-hack-native-build": { version: 1, workloads: {} },
    },
    {
      ...prepared.document,
      services: { web: { ...web, image: "foreign:tag" } },
    },
    {
      ...prepared.document,
      services: { web: { ...web, pull_policy: "build" } },
    },
    { ...prepared.document, services: { web: { ...web, build: {} } } },
  ]) {
    expect(() =>
      assertNativeComposeBuildExecution({
        ...options,
        executionDocument: document,
        intents: prepared.intents,
      })
    ).toThrow(NativeComposeBuildError);
  }
  expect(() =>
    assertNativeComposeBuildExecution({
      ...options,
      executionDocument: prepared.document,
      intents: [],
    })
  ).toThrow(NativeComposeBuildError);
  const changed = {
    ...options.document,
    services: {
      web: {
        ...options.document.services.web,
        build: {
          context: options.projectRoot.replaceAll("$", () => "$$"),
          dockerfile: "other/Dockerfile",
        },
      },
    },
  };
  expect(() =>
    assertNativeComposeBuildExecution({
      ...options,
      document: changed,
      executionDocument: prepared.document,
      intents: prepared.intents,
    })
  ).toThrow(NativeComposeBuildError);
});

test("direct lowerer refuses unknown build keys and malformed paths without invocation", () => {
  const { options, document } = fixture();
  const workload = document.services.web;
  if (!workload) {
    throw new Error("Workload missing");
  }
  const build = workload.build;
  if (!(build && typeof build === "object" && !Array.isArray(build))) {
    throw new Error("Build missing");
  }
  for (const change of [
    { args: { SECRET: "private-canary" } },
    { secrets: [] },
    { ssh: [] },
    { cache_from: [] },
    { context: "/foreign/checkout" },
    { context: "/verified/${AMBIENT}/checkout" },
    { dockerfile: "../Dockerfile" },
    { dockerfile: null },
    { target: "--private-canary" },
  ]) {
    const source = {
      ...document,
      services: {
        web: { ...workload, build: { ...build, ...change } },
      },
    };
    expect(() =>
      planNativeComposeBuilds({ ...options, document: source })
    ).toThrow(NativeComposeBuildError);
    try {
      planNativeComposeBuilds({ ...options, document: source });
    } catch (error) {
      expect(String(error)).not.toContain("private-canary");
    }
  }
  expect(() =>
    planNativeComposeBuilds({
      ...options,
      document: {
        ...document,
        services: { web: { ...workload, image: "foreign:tag" } },
      },
    })
  ).toThrow(NativeComposeBuildError);
});

test.each([
  [false, false, 1],
  [false, true, 0],
  [true, false, 1],
  [true, true, 1],
])("default cache and explicit build policy preserve acquisition decisions %s/%s", async (rebuild, initial, builds) => {
  const state = harness(rebuild, initial);
  expect(await buildNativeComposeImages(state.options)).toBe(0);
  expect(state.executed()).toBe(builds);
  expect(state.checks()).toBeGreaterThan(4);
});

test("foreign cached tags and ambiguous inventory refuse before any build", async () => {
  for (const response of [
    { ...cached(fixture().intents[0]!), owner: "foreign" },
    { ...cached(fixture().intents[0]!), service: "other" },
    { ...cached(fixture().intents[0]!), version: null },
  ]) {
    const state = harness(true, true);
    state.options.io.probe = async (args) =>
      args[1] === "ls" ? ID : JSON.stringify(response);
    await expect(
      buildNativeComposeImages(state.options)
    ).rejects.toBeInstanceOf(NativeComposeBuildError);
    expect(state.executed()).toBe(0);
  }
  const state = harness(true, true);
  state.options.io.probe = async () => `${ID}\n${ID}`;
  await expect(buildNativeComposeImages(state.options)).rejects.toBeInstanceOf(
    NativeComposeBuildError
  );
  expect(state.executed()).toBe(0);
});

test("source changes, cancellation and failed builders prevent subsequent startup", async () => {
  const stale = harness();
  stale.options.assertFresh = async () => {
    throw new Error("source changed");
  };
  await expect(buildNativeComposeImages(stale.options)).rejects.toThrow(
    "source changed"
  );
  expect(stale.executed()).toBe(0);
  const failed = harness();
  failed.options.io.execute = async () => 17;
  expect(await buildNativeComposeImages(failed.options)).toBe(17);
  const cancelled = harness();
  const controller = new AbortController();
  cancelled.options.signal = controller.signal;
  cancelled.options.io.execute = async () => {
    controller.abort();
    return 0;
  };
  expect(await buildNativeComposeImages(cancelled.options)).toBe(1);
});

test.each([
  "abort",
  "deadline",
  "source",
  "owner",
] as const)("last pre-execute image probe invalidating %s prevents any builder spawn", async (change) => {
  const state = harness();
  const controller = new AbortController();
  state.options.signal = controller.signal;
  let valid = true;
  let reads = 0;
  let now = Date.now();
  const deadline = now + 30_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const probe = state.options.io.probe;
  state.options.io.probe = async (args) => {
    const result = await probe(args);
    if (args[1] === "ls" && ++reads === 3) {
      valid = false;
      if (change === "abort") {
        controller.abort();
      } else if (change === "deadline") {
        now = deadline;
      }
    }
    return result;
  };
  if (change === "source") {
    state.options.assertFresh = async () => {
      if (!valid) {
        throw new NativeComposeBuildError();
      }
    };
  }
  if (change === "owner") {
    state.options.assertOwned = async () => {
      if (!valid) {
        throw new NativeComposeBuildError();
      }
    };
  }
  try {
    await expect(
      buildNativeComposeImages({ ...state.options, deadline })
    ).rejects.toBeInstanceOf(NativeComposeBuildError);
    expect(reads).toBe(3);
    expect(state.executed()).toBe(0);
  } finally {
    clock.mockRestore();
  }
});

test("all cached tags admit before builds and changed tag observations refuse", async () => {
  const state = harness(true);
  const first = state.value.intents[0];
  if (!first) {
    throw new Error("Intent missing");
  }
  const other = {
    ...first,
    service: "other",
    tag: "nc03-fixture-a-other:latest",
  };
  const options = { ...state.options, intents: [first, other] };
  options.io.probe = async (args) => {
    const tag = args.find((arg) => arg.includes("other"));
    if (args[1] === "ls") {
      return tag ? ID : "";
    }
    return JSON.stringify({ ...cached(other), owner: "foreign" });
  };
  await expect(buildNativeComposeImages(options)).rejects.toBeInstanceOf(
    NativeComposeBuildError
  );
  expect(state.executed()).toBe(0);

  const changed = harness(true);
  let reads = 0;
  changed.options.io.probe = async (args) => {
    if (args[1] === "ls") {
      reads++;
      return reads === 1 ? "" : ID;
    }
    return JSON.stringify(cached(first));
  };
  await expect(
    buildNativeComposeImages(changed.options)
  ).rejects.toBeInstanceOf(NativeComposeBuildError);
  expect(changed.executed()).toBe(0);
});

test("run builds keep the existing unbounded command budget; startup budgets remain shared", async () => {
  const command = harness();
  let timeout: number | undefined;
  const execute = command.options.io.execute;
  command.options.io.execute = async (args, value) => {
    timeout = value;
    return await execute(args, value);
  };
  expect(await buildNativeComposeImages(command.options)).toBe(0);
  expect(timeout).toBeUndefined();
  const startup = harness();
  const builder = startup.options.io.execute;
  startup.options.io.execute = async (args, value) => {
    timeout = value;
    return await builder(args, value);
  };
  expect(
    await buildNativeComposeImages({
      ...startup.options,
      deadline: Date.now() + 30_000,
    })
  ).toBe(0);
  expect(timeout).toBeGreaterThan(0);
  expect(timeout).toBeLessThanOrEqual(30_000);
  const expired = harness();
  await expect(
    buildNativeComposeImages({ ...expired.options, deadline: Date.now() - 1 })
  ).rejects.toBeInstanceOf(NativeComposeBuildError);
  expect(expired.executed()).toBe(0);
});

test("malformed or replaced daemon identity refuses before builder effects", async () => {
  const malformed = harness();
  malformed.options.io.engine = async () => "private-canary\ninvalid";
  await expect(
    buildNativeComposeImages(malformed.options)
  ).rejects.toBeInstanceOf(NativeComposeBuildError);
  expect(malformed.executed()).toBe(0);
  const changed = harness();
  let reads = 0;
  changed.options.io.engine = async () => {
    reads++;
    return reads === 1 ? "fixture:1" : "fixture:2";
  };
  await expect(
    buildNativeComposeImages(changed.options)
  ).rejects.toBeInstanceOf(NativeComposeBuildError);
  expect(changed.executed()).toBe(0);
});

test("failed direct build remains in the existing generation mutation journal", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-build-pending-"))
  );
  roots.push(root);
  await mkdir(join(root, ".hack"));
  await Bun.write(
    join(root, ".hack/hack.project.json"),
    JSON.stringify({ schema_version: 1, name: "fixture" })
  );
  const store = await openNativeComposeGenerationStore({
    projectRoot: root,
    instance: null,
    mode: "prepare",
  });
  try {
    await store.withMutation(async (mutation) => {
      const reservation = mutation.reserveGeneration();
      const input = composeFixture({
        services: {
          web: { build: { context: ".", dockerfile: "Dockerfile" } },
        },
      });
      input.projectRoot = root;
      input.runtimeIdentity = store.identity.composeProject;
      input.ownerToken = store.identity.ownerToken;
      input.generationIdentity = reservation.generationId;
      const document = renderNativeCompose(input).document;
      const generation = await mutation.publish({
        reservation,
        composeJson: JSON.stringify(document),
        profiles: [],
        inputRevision: "e".repeat(64),
        assertFresh: async () => {},
      });
      const result = await mutation.runEffect({
        generation,
        operation: "up",
        assertFresh: async () => {},
        assertOwned: async () => {},
        effect: async () => {
          expect((await store.loadCurrent()).pending?.generationId).toBe(
            generation.generationId
          );
          const intents = planNativeComposeBuilds({
            document,
            projectRoot: root,
            composeProject: store.identity.composeProject,
            ownerToken: store.identity.ownerToken,
          });
          const value = await buildNativeComposeImages({
            intents,
            projectRoot: root,
            signal: new AbortController().signal,
            env: undefined,
            json: true,
            assertFresh: async () => {
              await store.readGenerationDocument(generation);
            },
            assertOwned: async () => {},
            io: {
              engine: async () => "fixture-engine:1",
              probe: async () => "",
              execute: async () => 17,
            },
          });
          return { value, outcome: "uncertain" };
        },
      });
      expect(result.value).toBe(17);
      expect((await store.loadCurrent()).pending?.generationId).toBe(
        generation.generationId
      );
    });
  } finally {
    await store.close();
  }
});

test("one-off delivery tampered during an awaited builder prevents Compose run and preserves pending", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-build-projection-"))
  );
  roots.push(root);
  await mkdir(join(root, ".hack"));
  await Bun.write(
    join(root, ".hack/hack.project.json"),
    JSON.stringify({ schema_version: 1, name: "fixture" })
  );
  const store = await openNativeComposeGenerationStore({
    projectRoot: root,
    instance: null,
    mode: "prepare",
  });
  let builds = 0;
  let composeRuns = 0;
  try {
    await store.withMutation(async (mutation) => {
      const reservation = mutation.reserveGeneration();
      const input = composeFixture({
        services: {
          web: { build: { context: ".", dockerfile: "Dockerfile" } },
        },
      });
      input.projectRoot = root;
      input.runtimeIdentity = store.identity.composeProject;
      input.ownerToken = store.identity.ownerToken;
      input.generationIdentity = reservation.generationId;
      const execution = prepareNativeComposeBuildExecution({
        document: renderNativeCompose(input).document,
        projectRoot: root,
        composeProject: store.identity.composeProject,
        ownerToken: store.identity.ownerToken,
        service: "web",
        includeDependencies: false,
      });
      const generation = await mutation.publish({
        reservation,
        composeJson: JSON.stringify(execution.document),
        profiles: [],
        inputRevision: "e".repeat(64),
        assertFresh: async () => {},
      });
      await mutation.runEffect({
        generation,
        operation: "up",
        assertOwned: async () => {},
        assertFresh: async () => {},
        effect: async () => ({ outcome: "complete", value: 0 }),
      });
      const projection = await mutation.publishRunProjection({
        generation,
        service: "web",
        assertFresh: async () => {},
      });
      const original = await Bun.file(generation.composeFile).text();
      await expect(
        mutation.runEffect({
          generation,
          projection,
          operation: "run",
          assertOwned: async () => {},
          assertFresh: () => mutation.assertRunProjection(projection),
          effect: async () => {
            await buildNativeComposeImages({
              intents: execution.intents,
              projectRoot: root,
              signal: new AbortController().signal,
              env: undefined,
              json: true,
              assertFresh: () => mutation.assertRunProjection(projection),
              assertOwned: async () => {},
              io: {
                engine: async () => "fixture-engine:1",
                probe: async () => "",
                execute: async () => {
                  builds++;
                  await Bun.write(projection.composeFile, "{}");
                  return 0;
                },
              },
            });
            composeRuns++;
            return { outcome: "complete", value: 0 };
          },
        })
      ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
      expect(builds).toBe(1);
      expect(composeRuns).toBe(0);
      expect((await store.loadCurrent()).pending?.generationId).toBe(
        generation.generationId
      );
      expect((await store.loadCurrent()).generation?.generationId).toBe(
        generation.generationId
      );
      expect(await Bun.file(generation.composeFile).text()).toBe(original);
      await mutation.runEffect({
        generation,
        operation: "down",
        recoverPending: true,
        assertOwned: async () => {},
        effect: async () => ({ outcome: "complete", value: 0 }),
      });
      expect((await store.loadCurrent()).pending).toBeNull();
      expect((await store.loadCurrent()).stopped).toBe(true);
    });
  } finally {
    await store.close();
  }
});
