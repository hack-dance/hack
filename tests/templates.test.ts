import { expect, test } from "bun:test";

import {
  renderProjectConfigJson,
  renderProjectConfigSchemaJson,
  renderProjectEnvConfigYaml,
} from "../src/templates.ts";

test("renderProjectEnvConfigYaml emits an object-valued global scope", () => {
  expect(renderProjectEnvConfigYaml()).toContain("  global: {}");
});

test("renderProjectConfigJson makes automatic browser host preference explicit", () => {
  const config = JSON.parse(
    renderProjectConfigJson({
      name: "demo",
      devHost: "demo.hack",
      oauth: { enabled: true, tld: "gy" },
    })
  ) as { readonly open?: { readonly prefer?: string } };

  expect(config.open?.prefer).toBe("auto");
});

test("project config schema exposes browser host preference values", () => {
  const schema = JSON.parse(renderProjectConfigSchemaJson()) as {
    readonly properties?: {
      readonly open?: {
        readonly properties?: {
          readonly prefer?: { readonly enum?: readonly string[] };
        };
      };
    };
  };

  expect(schema.properties?.open?.properties?.prefer?.enum).toEqual([
    "auto",
    "alias",
    "dev",
  ]);
});
