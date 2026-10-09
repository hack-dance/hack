import { expect, test } from "bun:test";
import { legacyComposeRoutingResolutionMatches } from "../src/lib/native-compose-adoption-routing-resolution.ts";
import { resolveNativeComposeOpenOrigin } from "../src/lib/native-compose-open.ts";
import { mapLegacyComposeRouting } from "../src/lib/native-config-import-routing.ts";
import type { NativeRoutingResolution } from "../src/lib/native-routing-plan-protocol.ts";

function fixture(authoredPreference: "auto" | "alias" | "dev" = "alias") {
  const routing = mapLegacyComposeRouting({
    config: {
      name: "fixture",
      dev_host: "original.hack.local",
      oauth: { enabled: true },
      open: { prefer: authoredPreference },
    },
    compose: {
      name: "fixture",
      networks: { "hack-dev": { external: true } },
      services: {
        web: {
          image: "static:1",
          networks: ["hack-dev", "default"],
          labels: {
            caddy: "original.hack.local,original.hack.gy",
            "caddy.reverse_proxy": "{{upstreams 3000}}",
            "caddy.tls": "internal",
          },
        },
      },
    },
  })?.intent;
  if (!routing) {
    throw new Error("Synthetic route missing");
  }
  const resolution: NativeRoutingResolution = {
    domain: "local.test",
    domain_origin: "checkout_local",
    project_origin: "https://original.hack.local",
    aliases: { oauth: "https://original.hack.gy" },
    oauth_alias: "oauth",
    open_preference: "alias",
    open_preference_origin: "primary_local",
    open_origin: "https://original.hack.gy",
    routes: {
      web: {
        service: "web",
        port: 3000,
        protocol: "http",
        origin: "https://original.hack.local",
        aliases: { oauth: "https://original.hack.gy" },
      },
    },
  };
  return { routing, resolution };
}
test("typed-local domain precedence may retain exact served origins and saved open preference", () => {
  const selected = fixture();
  expect(legacyComposeRoutingResolutionMatches(selected)).toBe(true);
  expect(
    resolveNativeComposeOpenOrigin({ resolution: selected.resolution })
  ).toBe("https://original.hack.gy");
  expect(
    resolveNativeComposeOpenOrigin({
      resolution: selected.resolution,
      prefer: "dev",
    })
  ).toBe("https://original.hack.local");
  expect(
    resolveNativeComposeOpenOrigin({
      resolution: selected.resolution,
      target: "web",
    })
  ).toBe("https://original.hack.gy");
});
test("effective checkout preference can differ from raw project preference without changing served origins", () => {
  for (const [authored, effective, expected] of [
    ["dev", "alias", "https://original.hack.gy"],
    ["alias", "dev", "https://original.hack.local"],
    ["dev", "auto", "https://original.hack.gy"],
  ] as const) {
    const { routing, resolution } = fixture(authored);
    const selected: NativeRoutingResolution = {
      ...resolution,
      open_preference: effective,
      open_preference_origin: "checkout_local",
      open_origin: expected,
    };
    expect(routing.openOrigin).not.toBe(expected);
    expect(
      legacyComposeRoutingResolutionMatches({ routing, resolution: selected })
    ).toBe(true);
    expect(resolveNativeComposeOpenOrigin({ resolution: selected })).toBe(
      expected
    );
  }
});
test("effective preference cannot select an inconsistent or unavailable origin", () => {
  const { routing, resolution } = fixture("dev");
  const web = resolution.routes.web;
  if (!web) {
    throw new Error("Synthetic route missing");
  }
  for (const change of [
    { open_preference: "dev", open_origin: "https://original.hack.gy" },
    { open_preference: "alias", open_origin: "https://original.hack.local" },
    { open_preference: "auto", open_origin: "https://original.hack.local" },
  ] as const) {
    expect(
      legacyComposeRoutingResolutionMatches({
        routing,
        resolution: { ...resolution, ...change },
      })
    ).toBe(false);
  }
  expect(
    legacyComposeRoutingResolutionMatches({
      routing: { ...routing, aliasHost: null },
      resolution: {
        ...resolution,
        aliases: {},
        oauth_alias: null,
        open_preference: "alias",
        open_origin: "https://original.hack.local",
        routes: {
          web: { ...web, aliases: {} },
        },
      },
    })
  ).toBe(false);
});
for (const change of [
  { branch: "other" },
  { project_origin: "https://renamed.test" },
  { open_origin: "https://renamed.test" },
  { aliases: {} },
  { oauth_alias: null },
  { routes: {} },
]) {
  test(`effective routing refuses changed served selection ${JSON.stringify(change)}`, () => {
    const { routing, resolution } = fixture();
    expect(
      legacyComposeRoutingResolutionMatches({
        routing,
        resolution: { ...resolution, ...change },
      })
    ).toBe(false);
  });
}
test("route target, port, transport and aliases cannot drift behind matching apex metadata", () => {
  const { routing, resolution } = fixture(),
    web = resolution.routes.web;
  if (!web) {
    throw new Error("Synthetic route missing");
  }
  for (const change of [
    { service: "other" },
    { port: 3001 },
    { protocol: "https" as const },
    { origin: "https://renamed.test" },
    { aliases: {} },
  ]) {
    expect(
      legacyComposeRoutingResolutionMatches({
        routing,
        resolution: { ...resolution, routes: { web: { ...web, ...change } } },
      })
    ).toBe(false);
  }
});
