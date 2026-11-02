import { expect, test } from "bun:test";
import { planLegacyComposeAdoption } from "../src/lib/native-compose-adoption-plan.ts";

const CANARY = "synthetic-private-adoption-canary";
const configText = JSON.stringify({
  name: "fixture",
  worktree: { auto_branch: false },
});
function source(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: "fixture",
    services: {
      db: {
        image: CANARY,
        command: ["serve", ""],
        entrypoint: [],
        environment: { EMPTY: "", PRIVATE: CANARY },
        volumes: ["data:/var/lib/data"],
      },
    },
    volumes: { data: {} },
    ...overrides,
  });
}
function plan(composeText = source(), config = configText) {
  return planLegacyComposeAdoption({ configText: config, composeText });
}
function refused(value: ReturnType<typeof plan>) {
  expect(value.report.supported).toBe(false);
  expect(value.intent).toBeUndefined();
  expect(JSON.stringify(value)).not.toContain(CANARY);
}
test("strict original fields yield only private identity intent and public provenance", () => {
  const result = plan();
  expect(result.report.supported).toBe(true);
  expect(result.report.adoption).toBe("not_performed");
  expect(result.intent).toEqual({
    composeProject: "fixture",
    services: ["db"],
    volumes: [{ storage: "data", name: "fixture_data" }],
    mounts: [
      {
        service: "db",
        storage: "data",
        target: "/var/lib/data",
        readOnly: false,
      },
    ],
  });
  expect(
    result.report.fields.find(
      (field) => field.pointer === "/services/db/volumes/0"
    )
  ).toMatchObject({
    status: "exact",
    code: "existing_storage_binding",
    document: "compose",
  });
  expect(JSON.stringify(result)).not.toContain(CANARY);
  expect(Object.keys(result)).toEqual(["report"]);
  expect(Object.isFrozen(result.intent?.volumes)).toBe(true);
  expect(Object.isFrozen(result.report.fields)).toBe(true);
});
test("adoption maps paired Compose dollars without changing retained resource intent", () => {
  const composeText = source({
    services: {
      db: {
        image: CANARY,
        command: ["serve", "$${LITERAL}", "$$$$"],
        entrypoint: ["db", "$$HOME"],
        volumes: ["data:/var/lib/data"],
      },
    },
  });
  const result = plan(composeText);
  expect(result.report.supported).toBe(true);
  expect(result.intent?.volumes).toEqual([
    { storage: "data", name: "fixture_data" },
  ]);
  expect(result.intent?.mounts).toEqual([
    {
      service: "db",
      storage: "data",
      target: "/var/lib/data",
      readOnly: false,
    },
  ]);
  expect(
    result.report.fields.find(
      (field) => field.pointer === "/services/db/command/1"
    )
  ).toMatchObject({ status: "normalized", code: "escaped_dollar_literal" });
  expect(
    result.report.fields.find(
      (field) => field.pointer === "/services/db/entrypoint/1"
    )
  ).toMatchObject({ status: "normalized", code: "escaped_dollar_literal" });
  expect(JSON.stringify(result)).not.toContain("${LITERAL}");
  expect(JSON.stringify(result)).not.toContain(CANARY);
});
test("authored exact volume names and read-only long mounts retain identity", () => {
  const result = plan(
    source({
      volumes: { data: { name: CANARY } },
      services: {
        db: {
          image: "db:fixture",
          volumes: [
            {
              type: "volume",
              source: "data",
              target: "/var/lib/data",
              read_only: true,
            },
          ],
        },
      },
    })
  );
  expect(result.intent?.volumes).toEqual([{ storage: "data", name: CANARY }]);
  expect(result.intent?.mounts[0]?.readOnly).toBe(true);
  expect(JSON.stringify(result)).not.toContain(CANARY);
});
test.each([
  "data:/var/lib/data:ro",
  "data:/var/lib/data:rw",
])("qualified short mode remains exact: %s", (entry) => {
  const result = plan(
    source({ services: { db: { image: "db:fixture", volumes: [entry] } } })
  );
  expect(result.intent?.mounts[0]?.readOnly).toBe(entry.endsWith(":ro"));
});
test("null empty volume declarations remain default local owned volumes", () => {
  expect(
    plan(source({ volumes: { data: null } })).intent?.volumes[0]?.name
  ).toBe("fixture_data");
});
test.each([
  { name: "other" },
  { name: undefined },
  { volumes: {} },
  { volumes: { data: { external: true } } },
  { volumes: { data: { driver: "local" } } },
  { volumes: { data: { driver_opts: { device: CANARY } } } },
  { volumes: { data: { labels: { private: CANARY } } } },
  { volumes: { data: { name: "${PRIVATE}" } } },
  { volumes: { data: { name: "../unsafe" } } },
  { volumes: { data: { name: null } } },
  { volumes: { data: {}, unused: {} } },
  { volumes: { data: { name: "same" }, other: { name: "same" } } },
  { networks: { default: {} } },
  { "x-private": CANARY },
])("unsupported identity or top-level storage cannot mint intent: %j", (entry) =>
  refused(plan(source(entry))));
test.each([
  "/var/lib/data",
  "./host:/var/lib/data",
  "unknown:/var/lib/data",
  "data:relative",
  "data:/",
  "data:/var/../data",
  "data:/var/lib/data/",
  "data:/var/lib/data:cached",
  "data:${PRIVATE}",
  { type: "bind", source: "data", target: "/data" },
  { type: "volume", source: "data", target: "/data", read_only: null },
  { type: "volume", source: "data", target: "/data", read_only: "true" },
  { type: "volume", source: "data", target: "/data", volume: { nocopy: true } },
])("ambiguous/unsupported mount cannot mint intent: %j", (entry) =>
  refused(
    plan(
      source({ services: { db: { image: "db:fixture", volumes: [entry] } } })
    )
  ));
test("duplicate targets refuse rather than silently overwrite", () =>
  refused(
    plan(
      source({
        services: {
          db: { image: "db:fixture", volumes: ["data:/data", "data:/data:ro"] },
        },
      })
    )
  ));
test("unknown inactive-profile behavior is preserved as refusal", () => {
  const result = plan(
    source({
      services: {
        db: { image: "db:fixture", volumes: ["data:/data"] },
        inactive: { image: CANARY, profiles: ["later"], privileged: true },
      },
    })
  );
  refused(result);
  expect(
    result.report.fields.find(
      (field) => field.pointer === "/services/inactive/privileged"
    )
  ).toMatchObject({ status: "refused", code: "unsupported_field" });
});
test.each([
  "name: fixture\nname: fixture\nservices: {}\nvolumes: {}",
  "%TAG !! tag:yaml.org,2002:\n---\nname: fixture\nservices: {}\nvolumes: {}",
  "name: fixture\nservices: &private {}\nvolumes: {}",
])("strict parser refusal survives storage prerequisite: %s", (text) =>
  refused(plan(text)));
test("decoded equivalent duplicate JSON keys refuse", () =>
  refused(plan(source(), '{"name":"fixture","\\u006eame":"fixture"}')));
