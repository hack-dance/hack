import { expect, test } from "bun:test";
import {
  planLegacyComposeAdoption,
  planLegacyComposeRetainedBasicBuildAdoption,
  planLegacyComposeRetainedFileAdoption,
} from "../src/lib/native-compose-adoption-plan.ts";
import {
  mapLegacyNativeImport,
  mapLegacyNativeRetainedBasicBuild,
  mapLegacyNativeRetainedFileStorage,
} from "../src/lib/native-config-import-plan.ts";

function source(
  service: Record<string, unknown>,
  declarations = {},
  storage = true
) {
  return {
    configText: '{"name":"fixture"}',
    composeText: JSON.stringify({
      name: "fixture",
      services: {
        app: { ...service, ...(storage ? { volumes: ["data:/data"] } : {}) },
      },
      ...(storage ? { volumes: { data: {} } } : {}),
      ...declarations,
    }),
  };
}

const file = {
  image: "synthetic/app:1",
  configs: ["settings"],
};
const declarations = { configs: { settings: { file: "../settings" } } };

test("retained file intent remains distinct from the basic-build owner", () => {
  const input = source(file, declarations);
  const mapped = mapLegacyNativeRetainedFileStorage(input);
  expect(mapped.candidate).toMatchObject({
    services: {
      app: {
        image: "synthetic/app:1",
        mounts: [{ volume: "data" }, { config: "settings" }],
      },
    },
  });
  expect(planLegacyComposeRetainedFileAdoption(input).intent).toBeDefined();
  expect(planLegacyComposeAdoption(input).intent).toBeUndefined();
  expect(
    planLegacyComposeRetainedBasicBuildAdoption(input).intent
  ).toBeUndefined();
  expect(mapLegacyNativeRetainedBasicBuild(input).candidate).toBeUndefined();
});

test("retained build intent remains distinct from the file owner", () => {
  const input = source({ build: ".." });
  expect(mapLegacyNativeRetainedBasicBuild(input).candidate).toMatchObject({
    services: {
      app: { build: { context: "." }, mounts: [{ volume: "data" }] },
    },
  });
  expect(
    planLegacyComposeRetainedBasicBuildAdoption(input).intent
  ).toBeDefined();
  expect(planLegacyComposeAdoption(input).intent).toBeUndefined();
  expect(planLegacyComposeRetainedFileAdoption(input).intent).toBeUndefined();
  expect(mapLegacyNativeRetainedFileStorage(input).candidate).toBeUndefined();
});

test("a symbolic build plus file preview cannot mint either retained proof family", () => {
  const input = source({ build: "..", configs: ["settings"] }, declarations);
  const preview = mapLegacyNativeImport(
    source({ build: "..", configs: ["settings"] }, declarations, false)
  );
  expect(preview.candidate).toMatchObject({
    services: {
      app: { build: { context: "." }, mounts: [{ config: "settings" }] },
    },
  });
  expect(planLegacyComposeAdoption(input).intent).toBeUndefined();
  expect(
    planLegacyComposeRetainedBasicBuildAdoption(input).intent
  ).toBeUndefined();
  expect(planLegacyComposeRetainedFileAdoption(input).intent).toBeUndefined();
  expect(mapLegacyNativeRetainedBasicBuild(input).candidate).toBeUndefined();
  expect(mapLegacyNativeRetainedFileStorage(input).candidate).toBeUndefined();
});
