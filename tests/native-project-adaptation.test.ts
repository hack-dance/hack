import { expect, test } from "bun:test";
import {
  adaptNativeProject,
  prepareNativeProjectAdaptation,
} from "../src/backends/native-project-adaptation.ts";
import type { NativeProjectInput } from "../src/backends/native-project-input.ts";

function input(): NativeProjectInput {
  return {
    originalSha256: "a".repeat(64),
    normalizedComposeJson: JSON.stringify({
      services: {
        web: {
          image: "example/app",
          environment: { TOKEN: null },
          networks: ["default", "hack-dev"],
          labels: {
            caddy: "web.hack.gy",
            "caddy.reverse_proxy": "{{upstreams 3000}}",
            "caddy.tls": "internal",
          },
        },
        deps: { image: "example/deps" },
      },
      networks: {
        "hack-dev": { external: true },
        default: { internal: false },
      },
    }),
    managedEnvironment: { web: { TOKEN: "synthetic-private" } },
    lifecycleHostEnvironment: {},
    effectiveEnvName: null,
    environmentFiles: [],
    serviceNames: ["web", "deps"],
  };
}
test("explicit native adaptation preserves original identity, private env and existing aliases", async () => {
  const original = input();
  const bytes = original.normalizedComposeJson;
  const adapted = adaptNativeProject({
    input: original,
    selection: {
      version: 1,
      isolatedNetworks: ["hack-dev"],
      httpProbes: { web: { port: 3000, path: "/health" } },
      additionalHostnames: { web: ["web.hack.local"] },
    },
  });
  const compose = JSON.parse(adapted.normalizedComposeJson);
  expect(compose.networks["hack-dev"]).toEqual({
    external: true,
    "x-hack-isolated": true,
  });
  expect(compose.networks.default).toEqual({ internal: false });
  expect(compose.services.web.healthcheck).toEqual({
    "x-hack-http": {
      port: 3000,
      path: "/health",
      interval_ms: 1000,
      timeout_ms: 2000,
      retries: 60,
      start_period_ms: 120_000,
    },
  });
  expect(compose.services.web.labels.caddy).toBe("web.hack.gy, web.hack.local");
  expect(compose.services.deps).toEqual({ image: "example/deps" });
  expect(adapted.originalSha256).toBe(original.originalSha256);
  expect(adapted.managedEnvironment).toBe(original.managedEnvironment);
  expect(adapted.normalizedComposeJson).not.toContain("synthetic-private");
  expect(original.normalizedComposeJson).toBe(bytes);
  expect(await prepareNativeProjectAdaptation({ input: original })).toBe(
    original
  );
});
test("unsupported changes and conflicts refuse without mutating input", () => {
  const original = input();
  const bytes = original.normalizedComposeJson;
  for (const selection of [
    null,
    { version: 2 },
    { version: 1, environment: { TOKEN: "private" } },
    { version: 1, isolatedNetworks: ["missing"] },
    { version: 1, isolatedNetworks: ["default"] },
    { version: 1, isolatedNetworks: ["hack-dev", "hack-dev"] },
    { version: 1, httpProbes: { missing: { port: 3000, path: "/health" } } },
    { version: 1, httpProbes: { web: { port: 0, path: "/health" } } },
    {
      version: 1,
      httpProbes: { web: { port: 3000, path: "https://host/health" } },
    },
    {
      version: 1,
      httpProbes: { web: { port: 3000, path: "/health?secret=value" } },
    },
    {
      version: 1,
      httpProbes: { web: { port: 3000, path: "/health", retries: 101 } },
    },
    {
      version: 1,
      httpProbes: { web: { port: 3000, path: "/health", command: "echo yes" } },
    },
    { version: 1, additionalHostnames: { deps: ["deps.hack.local"] } },
    { version: 1, additionalHostnames: { web: ["web.hack.gy"] } },
    { version: 1, additionalHostnames: { web: ["*.hack.local"] } },
  ]) {
    expect(() => adaptNativeProject({ input: original, selection })).toThrow(
      "values omitted"
    );
    expect(original.normalizedComposeJson).toBe(bytes);
  }
  const compose = JSON.parse(bytes);
  compose.services.web.healthcheck = { test: ["CMD", "true"] };
  expect(() =>
    adaptNativeProject({
      input: { ...original, normalizedComposeJson: JSON.stringify(compose) },
      selection: {
        version: 1,
        httpProbes: { web: { port: 3000, path: "/health" } },
      },
    })
  ).toThrow("conflicts");
});
