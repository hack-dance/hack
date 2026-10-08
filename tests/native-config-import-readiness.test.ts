import { expect, test } from "bun:test";
import { compileNativeConfig } from "../src/lib/native-config-compiler.ts";
import { mapLegacyNativeImport } from "../src/lib/native-config-import-plan.ts";
import {
  mapLegacyComposeDependencies,
  mapLegacyComposeHealthcheck,
} from "../src/lib/native-config-import-readiness.ts";

const CANARY = "synthetic-private-health-value";
const HEALTH = {
  test: ["CMD", "probe", CANARY, "$$HOME", ""],
  interval: "01s",
  timeout: "250ms",
  retries: 2,
};
const BINARY = process.env.HACK_TEST_NATIVE_COMPILER_BINARY;
function map(value: unknown) {
  return mapLegacyNativeImport({
    configText: '{"name":"fixture"}',
    composeText: JSON.stringify(value),
  });
}
test("explicit exec timing and started/healthy edges retain private argv with raw provenance", () => {
  const source = {
    services: {
      db: { image: "fixture:1", healthcheck: HEALTH },
      web: {
        image: "fixture:1",
        depends_on: {
          db: { condition: "service_healthy", required: true, restart: false },
        },
      },
      short: { image: "fixture:1", depends_on: ["web"] },
    },
  };
  const raw = JSON.stringify(source);
  const result = map(source);
  expect(result.report.complete).toBe(true);
  expect(result.candidate).toMatchObject({
    services: {
      db: {
        readiness: {
          kind: "exec",
          command: { exec: ["probe", CANARY, "$HOME", ""] },
          interval: "01s",
          timeout: "250ms",
          retries: 2,
        },
      },
      web: { depends_on: [{ service: "db", condition: "ready" }] },
      short: { depends_on: [{ service: "web", condition: "started" }] },
    },
  });
  expect(JSON.stringify(source)).toBe(raw);
  expect(JSON.stringify(result)).not.toContain(CANARY);
  expect(JSON.stringify({ ...result })).not.toContain(CANARY);
  expect(
    result.report.fields.find(
      (field) => field.pointer === "/services/db/healthcheck/test/2"
    )
  ).toMatchObject({
    status: "normalized",
    code: "compose_readiness_contract",
    line: 1,
  });
});

test.each([
  { test: ["CMD", "probe"] },
  { ...HEALTH, interval: "0s" },
  { ...HEALTH, timeout: "0ms" },
  { ...HEALTH, retries: 0 },
  { ...HEALTH, retries: 4_294_967_296 },
  { ...HEALTH, timeout: "1.5s" },
  { ...HEALTH, timeout: "4294967296ms" },
  { ...HEALTH, start_period: "0s" },
  { ...HEALTH, start_interval: "5s" },
  { ...HEALTH, disable: true },
  { ...HEALTH, test: ["NONE"] },
  { ...HEALTH, test: ["CMD-SHELL", "probe"] },
  { ...HEALTH, test: "probe" },
  { ...HEALTH, test: ["CMD", ""] },
  { ...HEALTH, test: ["CMD", "$HOME"] },
  { ...HEALTH, test: ["CMD", "a\0b"] },
  { ...HEALTH, http: CANARY },
  { ...HEALTH, tcp: CANARY },
])("unsafe/inherited/image-shell health refuses complete conversion, including inactive fields %j", (healthcheck) => {
  expect(mapLegacyComposeHealthcheck(healthcheck)).toBeUndefined();
  const result = map({
    services: {
      web: { image: "fixture:1" },
      inactive: { image: "fixture:1", profiles: ["later"], healthcheck },
    },
  });
  expect(result.report.complete).toBe(false);
  expect(result.candidate).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain(CANARY);
});

test.each([
  { value: ["db", "db"] },
  { value: ["Bad"] },
  { value: { db: { required: false } } },
  { value: { db: { restart: true } } },
  { value: { db: { condition: null } } },
  { value: { db: { unknown: CANARY } } },
  { value: { db: "service_started" } },
])("optional/restart-propagating or malformed dependency refuses %j", ({
  value: depends_on,
}) => {
  expect(mapLegacyComposeDependencies(depends_on)).toBeUndefined();
  const result = map({
    services: {
      db: { image: "fixture" },
      web: { image: "fixture", depends_on },
    },
  });
  expect(result.report.complete).toBe(false);
  expect(result.candidate).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain(CANARY);
});

test("explicit Compose defaults and empty dependencies remain semantically empty", () => {
  expect(mapLegacyComposeDependencies({ db: {} })).toEqual([
    { service: "db", condition: "started" },
  ]);
  expect(mapLegacyComposeDependencies([])).toEqual([]);
  expect(mapLegacyComposeDependencies({})).toEqual([]);
  expect(mapLegacyComposeHealthcheck({ ...HEALTH, disable: false })).toEqual(
    mapLegacyComposeHealthcheck(HEALTH)
  );
});

test.skipIf(!BINARY)(
  "compiled owner normalizes explicit health and preserves dependency conditions",
  async () => {
    const result = map({
      services: {
        db: { image: "fixture", healthcheck: HEALTH },
        web: {
          image: "fixture",
          depends_on: { db: { condition: "service_healthy" } },
        },
        short: { image: "fixture", depends_on: ["web"] },
      },
    });
    expect(result.report.complete).toBe(true);
    const compiled = await compileNativeConfig({
      input: new TextEncoder().encode(JSON.stringify(result.candidate)),
      binary: BINARY,
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) {
      throw new Error("compiled readiness fixture refused");
    }
    expect(compiled.plan).toMatchObject({
      services: {
        db: {
          readiness: {
            kind: "exec",
            command: { exec: ["probe", CANARY, "$HOME", ""] },
            interval: "1000ms",
            timeout: "250ms",
            retries: 2,
          },
        },
        web: { depends_on: [{ service: "db", condition: "ready" }] },
        short: { depends_on: [{ service: "web", condition: "started" }] },
      },
    });
    expect(JSON.stringify(result)).not.toContain(CANARY);
  }
);

test.skipIf(!BINARY).each([
  {
    db: { image: "fixture" },
    web: {
      image: "fixture",
      depends_on: { db: { condition: "service_healthy" } },
    },
  },
  { web: { image: "fixture", depends_on: ["missing"] } },
  {
    db: { image: "fixture", depends_on: ["web"] },
    web: { image: "fixture", depends_on: ["db"] },
  },
  {
    db: { image: "fixture", profiles: ["inactive"] },
    web: { image: "fixture", depends_on: ["db"] },
  },
])(
  "compiled owner refuses missing readiness/targets, cycles and inactive targets %j",
  async (services) => {
    const result = map({ services });
    expect(result.report.complete).toBe(true);
    const compiled = await compileNativeConfig({
      input: new TextEncoder().encode(JSON.stringify(result.candidate)),
      binary: BINARY,
    });
    expect(compiled.ok).toBe(false);
  }
);
