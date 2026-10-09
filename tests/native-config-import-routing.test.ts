import { expect, test } from "bun:test";
import {
  planLegacyComposeAdoption,
  planLegacyComposeRetainedRoutingAdoption,
} from "../src/lib/native-compose-adoption-plan.ts";
import {
  mapLegacyNativeImport,
  mapLegacyNativeRetainedRouting,
  mapLegacyNativeStorageAdoption,
} from "../src/lib/native-config-import-plan.ts";
import { mapLegacyComposeRouting } from "../src/lib/native-config-import-routing.ts";

const CANARY = "private-route-source-canary";
function fixture() {
  return {
    config: {
      name: "fixture",
      dev_host: "original.hack.local",
      oauth: { enabled: true, tld: "gy" },
      open: { prefer: "alias" },
      worktree: { auto_branch: false },
    },
    compose: {
      name: "fixture",
      networks: { "hack-dev": { external: true } },
      services: {
        web: {
          image: CANARY,
          networks: ["hack-dev", "default"],
          labels: {
            caddy: "original.hack.local,original.hack.gy",
            "caddy.reverse_proxy": "{{upstreams 3000}}",
            "caddy.tls": "internal",
          },
        },
        db: { image: "db:1", volumes: ["data:/data"] },
      },
      volumes: { data: {} },
    },
  };
}
function inputs(config: unknown, compose: unknown) {
  return {
    configText: JSON.stringify(config),
    composeText: JSON.stringify(compose),
  };
}
test("v14 preserves the literal legacy host, existing alias, open preference and named storage without changing old families", () => {
  const { config, compose } = fixture();
  const source = inputs(config, compose);
  const before = JSON.stringify({ config, compose });
  const mapped = mapLegacyNativeRetainedRouting(source);
  const planned = planLegacyComposeRetainedRoutingAdoption(source);
  expect(mapped.report.complete).toBe(true);
  expect(mapped.candidate).toMatchObject({
    routes: {
      origin: "https://original.hack.local",
      aliases: { oauth: { origin: "https://original.hack.gy" } },
      oauth_alias: "oauth",
      http: { web: { service: "web", port: 3000, hostname: "project" } },
    },
    open: { prefer: "alias" },
    storage: { data: { kind: "persistent", scope: "worktree" } },
  });
  expect(planned.report.supported).toBe(true);
  expect(planned.intent?.routing?.openOrigin).toBe("https://original.hack.gy");
  expect(planned.intent?.volumes).toEqual([
    { name: "fixture_data", storage: "data" },
  ]);
  expect(planned.intent?.ownedNetwork).toBeUndefined();
  expect(JSON.stringify({ config, compose })).toBe(before);
  for (const older of [
    mapLegacyNativeImport(source),
    mapLegacyNativeStorageAdoption(source),
  ]) {
    expect(older.report.complete).toBe(false);
  }
  expect(planLegacyComposeAdoption(source).report.supported).toBe(false);
  expect(JSON.stringify(mapped)).not.toContain(CANARY);
  expect(JSON.stringify(planned)).not.toContain("original.hack");
  expect(Object.isFrozen(planned.intent?.routing?.routes[0]?.labels)).toBe(
    true
  );
});
test("custom existing hosts keep their exact primary origin without inventing an OAuth alias", () => {
  const { config, compose } = fixture();
  const selected = {
    ...config,
    dev_host: "app.example.test",
    open: { prefer: "auto" },
  };
  compose.services.web.labels.caddy = "app.example.test";
  const mapped = mapLegacyComposeRouting({ config: selected, compose });
  expect(mapped?.intent.aliasHost).toBeNull();
  expect(mapped?.intent.openOrigin).toBe("https://app.example.test");
  expect(mapped?.candidate.routes).toEqual({
    origin: "https://app.example.test",
    http: { web: { service: "web", port: 3000, hostname: "project" } },
  });
  expect(
    mapLegacyComposeRouting({
      config: { ...selected, open: { prefer: "alias" } },
      compose,
    })
  ).toBeUndefined();
});
test("closed literal label-list syntax and one relative service route preserve paired hosts", () => {
  const { config, compose } = fixture();
  const selected = {
    ...compose,
    services: {
      ...compose.services,
      api: {
        image: "api:1",
        networks: ["default", "hack-dev"],
        labels: [
          "caddy=api.original.hack.local,api.original.hack.gy",
          "caddy.reverse_proxy={{upstreams http 8080}}",
          "caddy.tls=internal",
          "caddy_ingress_network=hack-dev",
        ],
      },
    },
  };
  expect(
    planLegacyComposeRetainedRoutingAdoption(inputs(config, selected)).intent
      ?.routing?.routes[0]
  ).toMatchObject({ service: "api", hostname: "api", port: 8080 });
});
test.each([
  { dev_host: "${PRIVATE}" },
  { dev_host: "UPPER.hack" },
  { dev_host: "https://original.hack.local" },
  { oauth: { enabled: true, tld: "../private" } },
  { oauth: { enabled: true, extra: CANARY } },
  { open: { prefer: "unknown" } },
  { open: { prefer: "dev", service: CANARY } },
  { domain: CANARY },
  { routes: { origin: CANARY } },
  { branch: CANARY },
])("unsupported config cannot mint a routing candidate: %j", (change) => {
  const { config, compose } = fixture();
  const result = mapLegacyNativeRetainedRouting(
    inputs({ ...config, ...change }, compose)
  );
  expect(result.report.complete).toBe(false);
  expect(result.candidate).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain(CANARY);
});
test.each([
  { "caddy.tls": "external" },
  { caddy: "original.hack.local" },
  { caddy: "*.original.hack.local,original.hack.gy" },
  { caddy: "original.hack.local,original.hack.gy,extra.example.test" },
  { "caddy.reverse_proxy": "{{upstreams 0}}" },
  { "caddy.reverse_proxy": "{{upstreams 65536}}" },
  { "caddy.reverse_proxy": "http://foreign:3000" },
  { caddy_ingress_network: "foreign" },
  { caddy_1: CANARY },
  { private: CANARY },
])("unknown label or changed host/upstream refuses the full source: %j", (change) => {
  const { config, compose } = fixture();
  const selected = {
    ...compose,
    services: {
      ...compose.services,
      web: {
        ...compose.services.web,
        labels: { ...compose.services.web.labels, ...change },
      },
    },
  };
  expect(
    planLegacyComposeRetainedRoutingAdoption(inputs(config, selected)).intent
  ).toBeUndefined();
});
test.each([
  { networks: ["hack-dev"] },
  { networks: ["hack-dev", "default", "foreign"] },
  { networks: { "hack-dev": {}, default: {} } },
  { ports: ["3000:3000"] },
  { build: "." },
  { profiles: ["inactive"] },
  { healthcheck: { test: ["true"] } },
  { configs: [] },
  { secrets: [] },
  { volumes: ["./source:/app:ro"] },
])("unqualified capability intersections stay refused: %j", (change) => {
  const { config, compose } = fixture();
  const selected = {
    ...compose,
    services: {
      ...compose.services,
      web: { ...compose.services.web, ...change },
    },
  };
  const result = planLegacyComposeRetainedRoutingAdoption(
    inputs(config, selected)
  );
  expect(result.report.supported).toBe(false);
  expect(result.intent).toBeUndefined();
});
test("extra inactive fields, duplicate host ownership and external network options never disappear from refusal", () => {
  const { config, compose } = fixture();
  for (const selected of [
    {
      ...compose,
      networks: { "hack-dev": { external: true, name: "foreign" } },
    },
    {
      ...compose,
      services: { ...compose.services, other: { ...compose.services.web } },
    },
    { ...compose, "x-private": CANARY },
    {
      ...compose,
      services: {
        ...compose.services,
        db: { ...compose.services.db, network_mode: "host" },
      },
    },
  ]) {
    expect(
      planLegacyComposeRetainedRoutingAdoption(inputs(config, selected)).intent
    ).toBeUndefined();
  }
});
test("the compiler apex sentinel cannot stand in for a literal project prefix", () => {
  const { config, compose } = fixture();
  const prefixed = {
    ...compose.services.web,
    labels: {
      ...compose.services.web.labels,
      caddy: "project.original.hack.local,project.original.hack.gy",
    },
  };
  for (const services of [
    { ...compose.services, web: prefixed },
    { ...compose.services, prefixed },
  ]) {
    const source = inputs(config, { ...compose, services });
    expect(mapLegacyNativeRetainedRouting(source).report.complete).toBe(false);
    expect(
      planLegacyComposeRetainedRoutingAdoption(source).intent
    ).toBeUndefined();
  }
});
test("an explicit routing mapper never upgrades a non-routing source", () => {
  const source = inputs(
    { name: "fixture" },
    {
      name: "fixture",
      services: { db: { image: "db:1", volumes: ["data:/data"] } },
      volumes: { data: {} },
    }
  );
  expect(mapLegacyNativeStorageAdoption(source).report.complete).toBe(true);
  expect(mapLegacyNativeRetainedRouting(source).report.complete).toBe(false);
  expect(
    planLegacyComposeRetainedRoutingAdoption(source).intent
  ).toBeUndefined();
});
test("private non-enumerable preparation bytes reach the exact routing mapper", () => {
  const { config, compose } = fixture();
  const source = inputs(config, compose);
  const privateSource = Object.defineProperties(
    {},
    {
      configText: { value: source.configText },
      composeText: { value: source.composeText },
    }
  ) as typeof source;
  expect(Object.keys(privateSource)).toEqual([]);
  expect(mapLegacyNativeRetainedRouting(privateSource).candidate).toEqual(
    mapLegacyNativeRetainedRouting(source).candidate
  );
  expect(
    planLegacyComposeRetainedRoutingAdoption(privateSource).intent
  ).toEqual(planLegacyComposeRetainedRoutingAdoption(source).intent);
});
