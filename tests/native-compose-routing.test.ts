import { expect, test } from "bun:test";
import { renderNativeCompose } from "../src/lib/native-compose-renderer.ts";
import {
  NativeComposeRoutingError,
  planNativeComposeRouting,
} from "../src/lib/native-compose-routing.ts";
import type { NativeRoutingResolution } from "../src/lib/native-routing-plan-protocol.ts";
import { composeFixture } from "./helpers/native-compose.ts";

function fixture() {
  const input = composeFixture({
    services: {
      web: { image: "fixture/web:1" },
    },
  });
  input.plan.routes = {
    domain: "dev.test",
    aliases: { oauth: { domain: "hack.gy" } },
    oauth_alias: "oauth",
    http: {
      app: {
        service: "web",
        port: 3000,
        protocol: "http",
        hostname: "project",
      },
      inactive: {
        service: "inactive",
        port: 3001,
        protocol: "http",
        hostname: "inactive",
      },
    },
  };
  input.plan.open = { prefer: "alias" };
  const resolution: NativeRoutingResolution = {
    domain: "dev.test",
    domain_origin: "project",
    project_origin: "https://fixture.dev.test",
    aliases: { oauth: "https://fixture.hack.gy" },
    oauth_alias: "oauth",
    open_preference: "alias",
    open_preference_origin: "project",
    open_origin: "https://fixture.hack.gy",
    routes: {
      app: {
        service: "web",
        port: 3000,
        protocol: "http",
        origin: "https://fixture.dev.test",
        aliases: { oauth: "https://fixture.hack.gy" },
      },
    },
  };
  return {
    plan: input.plan,
    resolution,
    declared: { web: "service", inactive: "service" } as const,
  };
}

test("ordinary workloads acquire no routing intent or effects", () => {
  expect(
    planNativeComposeRouting({
      plan: composeFixture().plan,
      resolution: undefined,
    })
  ).toBeNull();
});

test("compiler-selected active origins and OAuth aliases form one Caddy group", () => {
  const input = fixture();
  const result = planNativeComposeRouting(input);
  expect(result).toEqual({
    labels: {
      web: {
        caddy_0: "https://fixture.dev.test, https://fixture.hack.gy",
        "caddy_0.reverse_proxy": "{{upstreams http 3000}}",
        "caddy_0.tls": "internal",
        caddy_ingress_network: "hack-dev",
      },
    },
    hostnames: ["fixture.dev.test", "fixture.hack.gy"],
    origins: ["https://fixture.dev.test", "https://fixture.hack.gy"],
    network: "hack-dev",
  });
  expect(JSON.stringify(result)).not.toContain("inactive");
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result?.labels.web)).toBe(true);
});

test("private Compose document joins only routed services to the external ingress", () => {
  const input = fixture();
  const base = composeFixture({
    services: { web: { image: "fixture/web:1" } },
  });
  const rendered = renderNativeCompose({
    ...base,
    plan: input.plan,
    routingResolution: input.resolution,
    declaredWorkloads: input.declared,
  });
  expect(rendered.document.networks.ingress).toEqual({
    name: "hack-dev",
    external: true,
  });
  expect(rendered.document.services.web?.networks).toEqual([
    "default",
    "ingress",
  ]);
  expect(rendered.document.services.web?.labels).toMatchObject({
    caddy_0: "https://fixture.dev.test, https://fixture.hack.gy",
    "caddy_0.reverse_proxy": "{{upstreams http 3000}}",
    "io.hack.native-config.owner": base.ownerToken,
    "io.hack.native-config.generation": base.generationIdentity,
  });
});

test("distinct upstream protocols and ports remain separate site groups", () => {
  const input = fixture();
  if (!input.plan.routes?.http) {
    throw new Error("Expected route declarations");
  }
  input.plan.routes.http.api = {
    service: "web",
    port: 3443,
    protocol: "https",
    hostname: "api",
  };
  const result = planNativeComposeRouting({
    ...input,
    resolution: {
      ...input.resolution,
      routes: {
        ...input.resolution.routes,
        api: {
          service: "web",
          port: 3443,
          protocol: "https",
          origin: "https://api.fixture.dev.test",
          aliases: { oauth: "https://api.fixture.hack.gy" },
        },
      },
    },
  });
  expect(result?.labels.web?.["caddy_0.reverse_proxy"]).toBe(
    "{{upstreams https 3443}}"
  );
  expect(result?.labels.web?.["caddy_1.reverse_proxy"]).toBe(
    "{{upstreams http 3000}}"
  );
  expect(result?.hostnames).toHaveLength(4);
});

test("stale, foreign or unselected route reports refuse without partial output", () => {
  const input = fixture();
  const app = input.resolution.routes.app;
  if (!app) {
    throw new Error("Expected selected app route");
  }
  const cases = [
    { ...app, service: "inactive" },
    { ...app, port: 9999 },
    { ...app, origin: "https://private-sentinel.test" },
    { ...app, aliases: {} },
  ];
  for (const changed of cases) {
    expect(() =>
      planNativeComposeRouting({
        ...input,
        resolution: { ...input.resolution, routes: { app: changed } },
      })
    ).toThrow(NativeComposeRoutingError);
  }
  expect(() =>
    planNativeComposeRouting({
      plan: fixture().plan,
      resolution: undefined,
    })
  ).toThrow(NativeComposeRoutingError);
});

test("nonstandard browser ports require an explicit ingress binding", () => {
  const input = fixture();
  if (!input.plan.routes) {
    throw new Error("Expected route declarations");
  }
  input.plan.routes.origin = "https://fixture.dev.test:8443";
  const app = input.resolution.routes.app;
  if (!app) {
    throw new Error("Expected selected app route");
  }
  expect(() =>
    planNativeComposeRouting({
      ...input,
      resolution: {
        ...input.resolution,
        project_origin: "https://fixture.dev.test:8443",
        routes: { app: { ...app, origin: "https://fixture.dev.test:8443" } },
      },
    })
  ).toThrow(NativeComposeRoutingError);
});
