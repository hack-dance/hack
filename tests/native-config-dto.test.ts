import { expect, test } from "bun:test";
import type {
  LocalConfig,
  Project,
} from "../packages/config-compiler/generated/native-config.ts";

// Generated DTOs are projections; only Rust owns semantic validation.
const minimal: Project = { schema_version: 1, name: "example" };
// @ts-expect-error schema versions are independently fenced
const future: Project = { schema_version: 2, name: "example" };
const nullOverlay: Project = {
  schema_version: 1,
  name: "example",
  // @ts-expect-error project overlay null is not the local-file base override
  environment: { default_overlay: null },
};
const unknown: Project = {
  schema_version: 1,
  name: "example",
  // @ts-expect-error arbitrary backend fields must not become pass-through DTOs
  backend_options: {},
};
const falseTombstone: Project = {
  schema_version: 1,
  name: "example",
  // @ts-expect-error tagged environment tombstone accepts true only
  services: { web: { image: "x:1", environment: { KEY: { unset: false } } } },
};
void [future, nullOverlay, unknown, falseTombstone];

const localMissing: LocalConfig = { schema_version: 1 };
const localNull: LocalConfig = {
  schema_version: 1,
  environment: { default_overlay: null },
};
const localNamed: LocalConfig = {
  schema_version: 1,
  environment: { default_overlay: "qa" },
};
const localInvalid: LocalConfig = {
  schema_version: 1,
  // @ts-expect-error local configuration cannot declare workloads
  services: {},
};
const localFuture: LocalConfig = {
  // @ts-expect-error local version is independently fenced
  schema_version: 2,
};
const localNullEnvironment: LocalConfig = {
  schema_version: 1,
  // @ts-expect-error only overlay selection permits null
  environment: null,
};
void [localInvalid, localFuture, localNullEnvironment];

test("authored DTO permits omitted default fields", () => {
  expect(minimal).toEqual({ schema_version: 1, name: "example" });
});

test("local DTO preserves omitted, base and named overlay choices", () => {
  expect(localMissing).toEqual({ schema_version: 1 });
  expect(localNull.environment?.default_overlay).toBeNull();
  expect(localNamed.environment?.default_overlay).toBe("qa");
});
