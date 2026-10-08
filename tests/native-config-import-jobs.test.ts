import { expect, spyOn, test } from "bun:test";
import { isRecord } from "../src/lib/guards.ts";
import { legacyComposeRetainedPlan } from "../src/lib/native-compose-adoption-readiness.ts";
import { compileNativeConfig } from "../src/lib/native-config-compiler.ts";
import {
  legacyComposeJobNames,
  legacyComposeOneShotMarker,
} from "../src/lib/native-config-import-jobs.ts";
import {
  mapLegacyNativeImport,
  mapLegacyNativeStorageAdoption,
} from "../src/lib/native-config-import-plan.ts";

const CANARY = "synthetic-private-completed-job-value";
const BINARY = process.env.HACK_TEST_NATIVE_COMPILER_BINARY;
const HEALTH = {
  test: ["CMD", "probe"],
  interval: "1s",
  timeout: "250ms",
  retries: 2,
};
function map(services: unknown, storage = false) {
  const source = {
    name: "fixture",
    services,
    ...(storage ? { volumes: { data: {} } } : {}),
  };
  return (storage ? mapLegacyNativeStorageAdoption : mapLegacyNativeImport)({
    configText: '{"name":"fixture"}',
    composeText: JSON.stringify(source),
  });
}
function graph() {
  return {
    db: { image: "fixture:1", healthcheck: HEALTH },
    initialize: {
      image: "fixture:1",
      entrypoint: [],
      command: ["installer", "$$HOME", "", CANARY],
      environment: { PRIVATE: CANARY, EMPTY: "" },
      depends_on: { db: { condition: "service_healthy" } },
    },
    app: {
      image: "fixture:1",
      depends_on: {
        initialize: {
          condition: "service_completed_successfully",
          required: true,
          restart: false,
        },
      },
    },
  };
}
test("two-pass conversion preserves job names and fields when consumers precede targets", () => {
  const source = graph();
  const before = JSON.stringify(source);
  const result = map({
    app: source.app,
    initialize: source.initialize,
    db: source.db,
  });
  expect(result.report.complete).toBe(true);
  expect(result.candidate).toEqual({
    schema_version: 1,
    name: "fixture",
    services: {
      app: {
        image: "fixture:1",
        depends_on: [{ job: "initialize", condition: "completed" }],
      },
      db: {
        image: "fixture:1",
        readiness: {
          kind: "exec",
          command: { exec: ["probe"] },
          interval: "1s",
          timeout: "250ms",
          retries: 2,
        },
      },
    },
    jobs: {
      initialize: {
        image: "fixture:1",
        entrypoint: { exec: [] },
        command: { exec: ["installer", "$HOME", "", CANARY] },
        environment: { PRIVATE: { default: CANARY }, EMPTY: { default: "" } },
        depends_on: [{ service: "db", condition: "ready" }],
      },
    },
  });
  expect(result.candidate).toEqual(map(source).candidate);
  expect(JSON.stringify(source)).toBe(before);
  expect(JSON.stringify(result)).not.toContain(CANARY);
  expect(JSON.stringify({ ...result })).not.toContain(CANARY);
  expect(Object.isFrozen(result.candidate)).toBe(true);
  expect(Object.isFrozen(result.candidate?.jobs)).toBe(true);
  expect(
    result.report.fields.find(
      (field) => field.pointer === "/services/initialize/command/1"
    )
  ).toMatchObject({
    target: "/jobs/initialize/command/exec/1",
    status: "normalized",
    code: "escaped_dollar_literal",
  });
  expect(
    result.report.fields.find(
      (field) => field.pointer === "/services/initialize/environment/PRIVATE"
    )
  ).toMatchObject({
    target: "/jobs/initialize/environment",
    code: "managed_fallback",
  });
});

test.each(
  [{ "hack.service.one-shot": "true" }, ["hack.service.one-shot=true"]].map(
    (labels) => ({ labels })
  )
)("canonical existing one-shot marker maps a standalone job without native labels %j", ({
  labels,
}) => {
  const spawn = spyOn(Bun, "spawn");
  try {
    const result = map({
      one: { image: "fixture:1", labels, restart: "no", init: false },
    });
    expect(result.report.complete).toBe(true);
    expect(result.candidate).toEqual({
      schema_version: 1,
      name: "fixture",
      services: {},
      jobs: {
        one: { image: "fixture:1", restart: { kind: "no" }, init: false },
      },
    });
    expect(
      result.report.fields.find(
        (field) => field.pointer === "/services/one/labels"
      )
    ).toMatchObject({
      target: "/jobs/one",
      status: "normalized",
      code: "compose_one_shot_job",
    });
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    spawn.mockRestore();
  }
});

test("YAML source positions remain original while job targets use native pointers", () => {
  const result = mapLegacyNativeImport({
    configText: '{"name":"fixture"}',
    composeText:
      'services:\n  done:\n    image: fixture:1\n    labels:\n      hack.service.one-shot: "true"\n    command: [installer, "$$HOME"]\n',
  });
  expect(result.report.complete).toBe(true);
  expect(
    result.report.fields.find(
      (field) => field.pointer === "/services/done/command/1"
    )
  ).toMatchObject({
    line: 6,
    target: "/jobs/done/command/exec/1",
    code: "escaped_dollar_literal",
  });
  expect(
    result.report.fields.find(
      (field) => field.pointer === "/services/done/labels/hack.service.one-shot"
    )
  ).toMatchObject({
    line: 5,
    target: "/jobs/done",
    code: "compose_one_shot_job",
  });
});

test("omitted job restart remains absent; empty image-default entrypoint/command semantics survive", () => {
  const result = map({
    done: {
      image: "fixture:1",
      labels: ["hack.service.one-shot=true"],
      entrypoint: null,
      command: null,
    },
  });
  expect(result.candidate).toEqual({
    schema_version: 1,
    name: "fixture",
    services: {},
    jobs: { done: { image: "fixture:1" } },
  });
});

test("pure named mount mapping includes jobs and keeps original logical storage identity", () => {
  const source = graph();
  const result = map(
    {
      ...source,
      initialize: { ...source.initialize, volumes: ["data:/cache:ro"] },
    },
    true
  );
  expect(result.report.complete).toBe(true);
  expect(result.candidate).toMatchObject({
    storage: { data: { kind: "persistent", scope: "worktree" } },
    jobs: {
      initialize: {
        mounts: [{ storage: "data", target: "/cache", access: "read-only" }],
      },
    },
  });
  expect(
    result.report.fields.find(
      (field) => field.pointer === "/services/initialize/volumes/0"
    )
  ).toMatchObject({ target: "/jobs/initialize/mounts" });
});

test("pure bridge mapping includes job attachments without changing original Compose identity", () => {
  const source = graph();
  const services = Object.fromEntries(
    Object.entries(source).map(([name, workload]) => [
      name,
      {
        ...workload,
        networks: {
          private: { aliases: name === "initialize" ? ["seed"] : [] },
        },
      },
    ])
  );
  const result = mapLegacyNativeImport({
    configText: '{"name":"fixture"}',
    composeText: JSON.stringify({
      name: "fixture",
      services,
      networks: { private: { driver: "bridge", internal: true } },
    }),
  });
  expect(result.report.complete).toBe(true);
  expect(result.candidate).toMatchObject({
    networks: { private: { internal: true } },
    jobs: { initialize: { networks: { private: { aliases: ["seed"] } } } },
  });
  expect(
    result.report.fields.find(
      (field) =>
        field.pointer === "/services/initialize/networks/private/aliases/0"
    )?.target
  ).toBe("/jobs/initialize/networks");
});

test.each([
  "service_started",
  "service_healthy",
  "short",
])("a job cannot also satisfy a service edge %s", (condition) => {
  const source = graph();
  const result = map({
    ...source,
    other: {
      image: "fixture:1",
      depends_on:
        condition === "short" ? ["initialize"] : { initialize: { condition } },
    },
  });
  expect(result.report.complete).toBe(false);
  expect(result.candidate).toBeUndefined();
  expect(
    result.report.fields.find(
      (field) => field.pointer === "/services/other/depends_on"
    )
  ).toMatchObject({ code: "mixed_job_service_dependency", status: "refused" });
});

test("undeclared completed target refuses at its original dependency pointer", () => {
  const result = map({
    app: {
      image: "fixture:1",
      depends_on: { missing: { condition: "service_completed_successfully" } },
    },
  });
  expect(result.candidate).toBeUndefined();
  expect(
    result.report.fields.find(
      (field) => field.pointer === "/services/app/depends_on/missing"
    )
  ).toMatchObject({ code: "undeclared_job_target", status: "refused" });
});

test.each([
  "always",
  "unless-stopped",
  "on-failure",
  "on-failure:2",
  null,
  0,
])("unsupported job restart intent refuses across inactive declarations %j", (restart) => {
  const result = map({
    done: {
      image: "fixture:1",
      labels: ["hack.service.one-shot=true"],
      profiles: ["later"],
      restart,
    },
  });
  expect(result.candidate).toBeUndefined();
  expect(
    result.report.fields.find(
      (field) => field.pointer === "/services/done/restart"
    )
  ).toMatchObject({
    code: "job_restart_policy_unsupported",
    status: "refused",
  });
});

test.each(
  [
    {},
    [],
    { "hack.service.one-shot": true },
    { "hack.service.one-shot": "false" },
    ["HACK.SERVICE.ONE-SHOT=true"],
    ["hack.service.one-shot=true "],
    ["hack.service.one-shot=true", "hack.service.one-shot=true"],
    { "hack.service.one-shot": "true", private: CANARY },
  ].map((labels) => ({ labels }))
)("unsupported or mixed labels refuse without a guessed role %j", ({
  labels,
}) => {
  expect(legacyComposeOneShotMarker(labels)).toBe(false);
  const result = map({
    done: { image: "fixture:1", labels, profiles: ["later"] },
  });
  expect(result.candidate).toBeUndefined();
  expect(
    result.report.fields.find(
      (field) => field.pointer === "/services/done/labels"
    )
  ).toMatchObject({
    code: "one_shot_label_contract_unsupported",
    status: "refused",
  });
  expect(JSON.stringify(result)).not.toContain(CANARY);
});

test("inactive job health and unknown fields remain refused rather than removed", () => {
  const result = map({
    done: {
      image: "fixture:1",
      labels: ["hack.service.one-shot=true"],
      profiles: ["later"],
      healthcheck: HEALTH,
      custom: CANARY,
    },
  });
  expect(result.candidate).toBeUndefined();
  expect(
    result.report.fields.find(
      (field) => field.pointer === "/services/done/healthcheck"
    )
  ).toMatchObject({ code: "job_healthcheck_unsupported", status: "refused" });
  expect(
    result.report.fields.find(
      (field) => field.pointer === "/services/done/custom"
    )?.status
  ).toBe("refused");
  expect(JSON.stringify(result)).not.toContain(CANARY);
});

test("inactive supported jobs keep profiles; malformed optional edges cannot infer a role", () => {
  const result = map({
    done: {
      image: "fixture:1",
      labels: ["hack.service.one-shot=true"],
      profiles: ["later"],
    },
  });
  expect(result.candidate).toMatchObject({
    jobs: { done: { profiles: ["later"] } },
    profiles: ["later"],
  });
  expect(
    legacyComposeJobNames({
      done: { image: "fixture:1" },
      web: {
        depends_on: {
          done: {
            condition: "service_completed_successfully",
            required: false,
          },
        },
      },
    }).size
  ).toBe(0);
  expect(
    map({
      done: { image: "fixture:1" },
      web: {
        image: "fixture:1",
        depends_on: {
          done: {
            condition: "service_completed_successfully",
            required: false,
          },
        },
      },
    }).candidate
  ).toBeUndefined();
});

test("command/name/restart heuristics never infer a one-shot job", () => {
  const result = map({
    deps: { image: "fixture:1", command: ["bun", "install"], restart: "no" },
  });
  expect(result.report.complete).toBe(true);
  expect(result.candidate?.jobs).toBeUndefined();
  expect(result.candidate).toMatchObject({
    services: {
      deps: { command: { exec: ["bun", "install"] }, restart: { kind: "no" } },
    },
  });
});

test("explicit completed chains classify each target independently of declaration order", () => {
  const result = map({
    app: {
      image: "fixture:1",
      depends_on: { second: { condition: "service_completed_successfully" } },
    },
    second: {
      image: "fixture:1",
      depends_on: { first: { condition: "service_completed_successfully" } },
    },
    first: { image: "fixture:1" },
  });
  expect(result.report.complete).toBe(true);
  expect(result.candidate).toMatchObject({
    services: {
      app: { depends_on: [{ job: "second", condition: "completed" }] },
    },
    jobs: {
      second: { depends_on: [{ job: "first", condition: "completed" }] },
      first: { image: "fixture:1" },
    },
  });
  expect(Object.keys(result.candidate?.services ?? {})).toEqual(["app"]);
  expect(Object.keys(result.candidate?.jobs ?? {})).toEqual([
    "second",
    "first",
  ]);
});

test("canonical standalone jobs still refuse an inactive started consumer", () => {
  const result = map({
    one: { image: "fixture:1", labels: ["hack.service.one-shot=true"] },
    inactive: { image: "fixture:1", profiles: ["later"], depends_on: ["one"] },
  });
  expect(result.candidate).toBeUndefined();
  expect(
    result.report.fields.find(
      (field) => field.pointer === "/services/inactive/depends_on"
    )
  ).toMatchObject({ code: "mixed_job_service_dependency", status: "refused" });
});

test("positive mapping does not activate retained-job adoption or change v5/v6 meaning", () => {
  const result = map(graph());
  expect(result.report.complete).toBe(true);
  expect(() => legacyComposeRetainedPlan(result.candidate)).toThrow(
    "retained dependency plan refused"
  );
});

test.skipIf(!BINARY)(
  "matching compiler admits the positive job candidate with exact workload kinds",
  async () => {
    const result = map(graph());
    const compiled = await compileNativeConfig({
      input: new TextEncoder().encode(JSON.stringify(result.candidate)),
      binary: BINARY,
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) {
      throw new Error("completed-job compiler fixture refused");
    }
    expect(compiled.declared_workloads).toEqual({
      app: "service",
      db: "service",
      initialize: "job",
    });
    expect(compiled.plan).toMatchObject({
      jobs: {
        initialize: { command: { exec: ["installer", "$HOME", "", CANARY] } },
      },
      services: {
        app: { depends_on: [{ job: "initialize", condition: "completed" }] },
      },
    });
    expect(
      isRecord(compiled.plan.services) &&
        Object.hasOwn(compiled.plan.services, "initialize")
    ).toBe(false);
  }
);
