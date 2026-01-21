import { expect, test } from "bun:test";
import { YAML } from "bun";
import { DEFAULT_INGRESS_NETWORK } from "../src/constants.ts";
import type { ComposePlan } from "../src/init/compose.ts";
import { renderCompose } from "../src/init/compose.ts";

test("renderCompose emits ingress network and service fields", () => {
  const plan: ComposePlan = {
    name: "my-project",
    services: [
      {
        name: "api",
        role: "http",
        image: "node:20",
        workingDir: "/app",
        command: "bun dev",
        env: new Map([["FOO", "bar"]]),
        labels: new Map([["caddy", "api.myapp.hack"]]),
        networks: [DEFAULT_INGRESS_NETWORK, "default"],
      },
    ],
  };

  const yaml = renderCompose(plan);
  expect(yaml.endsWith("\n")).toBe(true);

  const parsed = YAML.parse(yaml) as Record<string, unknown>;
  const services = parsed.services as Record<string, unknown>;
  const api = services.api as Record<string, unknown>;
  const networks = parsed.networks as Record<string, { external?: boolean }>;

  expect(networks[DEFAULT_INGRESS_NETWORK]?.external).toBe(true);
  expect(api.image).toBe("node:20");
  expect(api.working_dir).toBe("/app");
  expect(api.environment).toEqual({ FOO: "bar" });
  expect(api.labels).toEqual({ caddy: "api.myapp.hack" });
  expect(api.networks).toEqual([DEFAULT_INGRESS_NETWORK, "default"]);
});
