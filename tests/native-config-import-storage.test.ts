import { expect, test } from "bun:test";
import {
  mapLegacyNativeImport,
  mapLegacyNativeStorageAdoption,
} from "../src/lib/native-config-import-plan.ts";
import { mapLegacyComposeStorage } from "../src/lib/native-config-import-storage.ts";

const CANARY = "synthetic-private-original-storage";
const configText = '{"name":"fixture"}';
const compose = {
  name: "fixture",
  services: {
    db: {
      image: "synthetic:image",
      entrypoint: [],
      command: ["sleep", "30"],
      environment: { EMPTY: "", STATIC: CANARY },
      volumes: ["data:/z-data:rw", "logs:/a-logs:ro"],
    },
  },
  volumes: { data: { name: CANARY }, logs: null },
};

test("private storage adoption preserves command, empty environment and authored mount order", () => {
  const composeText = JSON.stringify(compose);
  const mapped = mapLegacyNativeStorageAdoption({ configText, composeText });
  expect(mapped.report.complete).toBe(true);
  expect(mapped.candidate).toEqual({
    schema_version: 1,
    name: "fixture",
    services: {
      db: {
        image: "synthetic:image",
        entrypoint: { exec: [] },
        command: { exec: ["sleep", "30"] },
        environment: { EMPTY: { default: "" }, STATIC: { default: CANARY } },
        mounts: [
          { storage: "data", target: "/z-data", access: "read-write" },
          { storage: "logs", target: "/a-logs", access: "read-only" },
        ],
      },
    },
    storage: {
      data: { kind: "persistent", scope: "worktree" },
      logs: { kind: "persistent", scope: "worktree" },
    },
  });
  expect(JSON.stringify(mapped)).not.toContain(CANARY);
  expect(Object.isFrozen(mapped.candidate)).toBe(true);
  expect(JSON.stringify(compose)).toBe(composeText);
  const preview = mapLegacyNativeImport({ configText, composeText });
  expect(preview.report.complete).toBe(false);
  expect(preview.candidate).toBeUndefined();
});

test("owned bridge extends private intent while omitted topology keeps old intent bytes", () => {
  const config = { name: "fixture" };
  const legacy = mapLegacyComposeStorage({ config, compose });
  expect(legacy?.intent).not.toHaveProperty("ownedNetwork");
  const selected = {
    ...compose,
    networks: { private: { driver: "bridge", internal: true } },
    services: {
      db: {
        ...compose.services.db,
        networks: { private: { aliases: ["db-reader"] } },
      },
    },
  };
  const mapping = mapLegacyComposeStorage({ config, compose: selected });
  expect(mapping?.intent.ownedNetwork).toEqual({
    logical: "private",
    name: "fixture_private",
    internal: true,
    attachments: [{ service: "db", aliases: ["db-reader"] }],
  });
  expect(
    mapLegacyNativeStorageAdoption({
      configText,
      composeText: JSON.stringify(selected),
    }).report.complete
  ).toBe(true);
  expect(
    mapLegacyComposeStorage({
      config,
      compose: { ...selected, networks: { private: { external: true } } },
    })
  ).toBeUndefined();
});

for (const [name, change] of [
  [
    "foreign volume options",
    { volumes: { data: { external: true }, logs: null } },
  ],
  ["unmounted data", { volumes: { ...compose.volumes, unused: null } }],
  [
    "unknown inactive workload",
    {
      services: {
        ...compose.services,
        dormant: {
          image: "synthetic:image",
          profiles: ["inactive"],
          privileged: true,
        },
      },
    },
  ],
  [
    "interpolation source",
    {
      services: {
        db: { ...compose.services.db, environment: { PRIVATE: "${PRIVATE}" } },
      },
    },
  ],
  [
    "shell string",
    {
      services: { db: { ...compose.services.db, command: "echo ${PRIVATE}" } },
    },
  ],
  [
    "empty command",
    { services: { db: { ...compose.services.db, command: [] } } },
  ],
  [
    "unset environment",
    {
      services: {
        db: { ...compose.services.db, environment: { PRIVATE: null } },
      },
    },
  ],
  [
    "shadowed logical mount",
    {
      services: {
        db: { ...compose.services.db, volumes: ["data:/data", "logs:/data"] },
      },
    },
  ],
  ["missing explicit project", { name: undefined }],
] as const) {
  test(`storage conversion retains complete refusal for ${name}`, () => {
    const result = mapLegacyNativeStorageAdoption({
      configText,
      composeText: JSON.stringify({ ...compose, ...change }),
    });
    expect(result.report.complete).toBe(false);
    expect(result.candidate).toBeUndefined();
    expect(
      result.report.fields.some((field) => field.status === "refused")
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });
}

test("storage conversion keeps duplicate source position before map construction", () => {
  const result = mapLegacyNativeStorageAdoption({
    configText,
    composeText:
      "name: fixture\nservices:\n  db:\n    image: synthetic:image\n    volumes:\n      - data:/data\nvolumes:\n  data: null\n  data: null\n",
  });
  expect(result.report.complete).toBe(false);
  expect(result.candidate).toBeUndefined();
  expect(result.report.fields).toContainEqual(
    expect.objectContaining({
      document: "compose",
      pointer: "",
      status: "refused",
      code: "duplicate_key",
      line: 9,
      column: 3,
    })
  );
});
