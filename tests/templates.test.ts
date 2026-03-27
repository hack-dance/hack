import { expect, test } from "bun:test";

import { renderProjectEnvConfigYaml } from "../src/templates.ts";

test("renderProjectEnvConfigYaml emits an object-valued global scope", () => {
  expect(renderProjectEnvConfigYaml()).toContain("  global: {}");
});
