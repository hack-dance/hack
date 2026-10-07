import { expect, test } from "bun:test";
import type { Project } from "../packages/config-compiler/generated/native-config.ts";

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

test("authored DTO permits omitted default fields", () => {
  expect(minimal).toEqual({ schema_version: 1, name: "example" });
});
