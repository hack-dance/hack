import { expect, test } from "bun:test";
import {
  nativeComposeCompletedOneoff,
  nativeComposeRunDependenciesReady,
  nativeComposeWorkloadsReady,
} from "../src/lib/native-compose-completion.ts";
import type {
  NativeComposeContainerObservation,
  NativeComposeOwnershipObservation,
} from "../src/lib/native-compose-ownership.ts";

const generation = {
  generationId: "b".repeat(32),
  identity: { composeProject: "owned-fixture" },
};
const document = {
  services: {
    web: {
      labels: { "io.hack.native-config.workload": "service" },
      healthcheck: {},
    },
    init: { labels: { "io.hack.native-config.workload": "job" } },
  },
};
function observation(
  containers: readonly NativeComposeContainerObservation[]
): NativeComposeOwnershipObservation {
  return { containers, networks: [], volumes: [] };
}
function container(
  service: "web" | "init",
  overrides: Partial<NativeComposeContainerObservation> = {}
): NativeComposeContainerObservation {
  return {
    id: (service === "web" ? "c" : "d").repeat(64),
    name: `owned-fixture-${service}-1`,
    service,
    generationId: generation.generationId,
    state: service === "web" ? "running" : "exited",
    exitCode: 0,
    health: service === "web" ? "healthy" : null,
    oneoff: false,
    ...overrides,
  };
}
test("old healthy service or completed job cannot publish a proposed generation", () => {
  const current = [container("web"), container("init")];
  expect(
    nativeComposeWorkloadsReady(document, observation(current), generation)
  ).toBe(true);
  for (const name of ["web", "init"] as const) {
    const stale = current.map((value) =>
      value.service === name
        ? { ...value, generationId: "a".repeat(32) }
        : value
    );
    expect(
      nativeComposeWorkloadsReady(document, observation(stale), generation)
    ).toBe(false);
  }
});
test("one canonical instance per selected workload is required", () => {
  for (const web of [
    container("web", { name: "alternate" }),
    container("web", { oneoff: true }),
    container("web", { state: "exited" }),
    container("web", { health: "starting" }),
  ]) {
    expect(
      nativeComposeWorkloadsReady(
        document,
        observation([web, container("init")]),
        generation
      )
    ).toBe(false);
  }
  expect(
    nativeComposeWorkloadsReady(
      document,
      observation([
        container("web"),
        container("web", { id: "e".repeat(64) }),
        container("init"),
      ]),
      generation
    )
  ).toBe(false);
  expect(
    nativeComposeWorkloadsReady(
      document,
      observation([container("web")]),
      generation
    )
  ).toBe(false);
  expect(
    nativeComposeWorkloadsReady(
      document,
      observation([container("web"), container("init", { exitCode: 17 })]),
      generation
    )
  ).toBe(false);
});
test("run readiness checks its actual dependencies without requiring a canonical target", () => {
  expect(
    nativeComposeWorkloadsReady(
      document,
      observation([container("init")]),
      generation,
      ["init"]
    )
  ).toBe(true);
  expect(
    nativeComposeWorkloadsReady(
      document,
      observation([container("init", { generationId: "a".repeat(32) })]),
      generation,
      ["init"]
    )
  ).toBe(false);
});

test("run honors started versus healthy dependency conditions", () => {
  const starting = observation([container("web", { health: "starting" })]);
  const doc = (condition: string) => ({
    services: {
      ...document.services,
      run: { depends_on: { web: { condition } } },
    },
  });
  expect(
    nativeComposeRunDependenciesReady(
      doc("service_started"),
      starting,
      generation,
      "run"
    )
  ).toBe(true);
  expect(
    nativeComposeRunDependenciesReady(
      doc("service_healthy"),
      starting,
      generation,
      "run"
    )
  ).toBe(false);
  expect(
    nativeComposeRunDependenciesReady(
      doc("service_healthy"),
      observation([container("web")]),
      generation,
      "run"
    )
  ).toBe(true);
});
test("a completed dependency job does not require its transient dependencies to stay alive", () => {
  const doc = {
    services: {
      web: {
        depends_on: { init: { condition: "service_completed_successfully" } },
      },
      init: { depends_on: { transient: { condition: "service_started" } } },
      transient: {},
    },
  };
  expect(
    nativeComposeRunDependenciesReady(
      doc,
      observation([container("init")]),
      generation,
      "web"
    )
  ).toBe(true);
  expect(
    nativeComposeRunDependenciesReady(
      doc,
      observation([container("init", { exitCode: 17 })]),
      generation,
      "web"
    )
  ).toBe(false);
});
test("named one-off proves the exact nonzero command exit without accepting engine launch failure", () => {
  const done = container("web", {
    name: "owned-oneoff",
    oneoff: true,
    state: "exited",
    exitCode: 17,
  });
  const select = (containers: readonly NativeComposeContainerObservation[]) =>
    nativeComposeCompletedOneoff({
      observed: observation(containers),
      name: "owned-oneoff",
      generationId: generation.generationId,
      service: "web",
      exitCode: 17,
    });
  expect(select([done])).toEqual(done);
  for (const row of [
    { ...done, exitCode: 0 },
    { ...done, state: "created" as const },
    { ...done, generationId: "a".repeat(32) },
    { ...done, name: "foreign" },
    { ...done, service: "init" },
    { ...done, oneoff: false },
  ]) {
    expect(select([row])).toBeNull();
  }
  expect(select([])).toBeNull();
  expect(
    select([done, { ...done, id: "e".repeat(64), name: "second" }])
  ).toBeNull();
});
