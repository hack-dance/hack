import { expect, test } from "bun:test";
import { __testOnlyNodeRailway } from "../src/commands/node.ts";

test("deriveRailwayServiceName normalizes user-facing names", () => {
  const value = __testOnlyNodeRailway.deriveRailwayServiceName({
    value: "Old MacBook Node (Primary)!",
  });
  expect(value).toBe("old-macbook-node-primary");
});

test("parseRailwayJsonOutput extracts payload from noisy CLI output", () => {
  const output = [
    "> Select a workspace Hack Dance",
    "> Select a project Omega",
    '{ "projectId": "proj-1", "serviceName": "hack-node" }',
  ].join("\n");
  const parsed = __testOnlyNodeRailway.parseRailwayJsonOutput({ output });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }
  expect(parsed.value).toMatchObject({
    projectId: "proj-1",
    serviceName: "hack-node",
  });
});

test("parseRailwayDomainEndpoint supports nested service domain payloads", () => {
  const output = JSON.stringify({
    domains: {
      serviceDomains: [{ domain: "hack-node.up.railway.app" }],
    },
  });
  const parsed = __testOnlyNodeRailway.parseRailwayDomainEndpoint({ output });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }
  expect(parsed.endpoint).toBe("https://hack-node.up.railway.app");
});

test("buildRailwaySshNodeInitArgs includes project/service/env and init flags", () => {
  const args = __testOnlyNodeRailway.buildRailwaySshNodeInitArgs({
    project: "proj-123",
    service: "node-svc",
    environment: "production",
    name: "railway-node-1",
    endpoint: "https://hack-node.up.railway.app",
    labels: ["railway", "linux"],
  });

  expect(args).toContain("ssh");
  expect(args).toContain("--project");
  expect(args).toContain("proj-123");
  expect(args).toContain("--service");
  expect(args).toContain("node-svc");
  expect(args).toContain("--environment");
  expect(args).toContain("production");
  expect(args).toContain("--json");
  expect(args).toContain("--labels");
  expect(args).toContain("railway,linux");
});

test("buildRailwaySshTailscaleStatusArgs uses userspace tailscaled socket", () => {
  const args = __testOnlyNodeRailway.buildRailwaySshTailscaleStatusArgs({
    project: "proj-123",
    service: "node-svc",
    environment: "production",
  });
  expect(args).toEqual([
    "ssh",
    "--project",
    "proj-123",
    "--service",
    "node-svc",
    "--environment",
    "production",
    "--",
    "tailscale",
    "--socket",
    "/tmp/tailscaled.sock",
    "status",
    "--json",
  ]);
});

test("buildRailwayVariablePairs provisions stable gateway auth vars", () => {
  const pairs = __testOnlyNodeRailway.buildRailwayVariablePairs({
    name: "railway-node-1",
    endpoint: "https://hack-node.up.railway.app",
    labels: ["railway", "linux"],
    gatewayPort: 7788,
    staticGatewayToken: "test-static-token",
    privateNetworking: true,
    tailscaleAuthKey: "tskey-auth-test",
    tailscaleHostname: "hack-node-1",
    tailscaleTags: ["tag:hack-node"],
  });

  expect(pairs).toContain("HACK_DAEMON_DISABLE_DOCKER_EVENTS=1");
  expect(pairs).toContain("HACK_GATEWAY_STATIC_TOKEN=test-static-token");
  expect(pairs).toContain("HACK_GATEWAY_STATIC_TOKEN_SCOPE=write");
  expect(pairs).toContain("HACK_TAILSCALE_ENABLE=1");
  expect(pairs).toContain("TS_AUTHKEY=tskey-auth-test");
  expect(pairs).toContain("HACK_TAILSCALE_HOSTNAME=hack-node-1");
  expect(pairs).toContain("HACK_TAILSCALE_ADVERTISE_TAGS=tag:hack-node");
});

test("buildRailwayVariableDeletes clears stale tailscale vars when not needed", () => {
  const privateNoTags = __testOnlyNodeRailway.buildRailwayVariableDeletes({
    gatewayPort: 8080,
    privateNetworking: true,
    tailscaleTags: [],
  });
  expect(privateNoTags).toContain("HACK_TAILSCALE_ADVERTISE_TAGS");
  expect(privateNoTags).not.toContain("HACK_TAILSCALE_ENABLE");

  const publicNode = __testOnlyNodeRailway.buildRailwayVariableDeletes({
    gatewayPort: null,
    privateNetworking: false,
    tailscaleTags: [],
  });
  expect(publicNode).toContain("HACK_NODE_GATEWAY_PORT");
  expect(publicNode).toContain("HACK_TAILSCALE_ADVERTISE_TAGS");
  expect(publicNode).toContain("HACK_TAILSCALE_ENABLE");
  expect(publicNode).toContain("HACK_TAILSCALE_SERVE");
  expect(publicNode).toContain("TS_AUTHKEY");
  expect(publicNode).toContain("HACK_TAILSCALE_HOSTNAME");
});

test("parseRailwayTailscaleEndpoint resolves Self.DNSName into https endpoint", () => {
  const output = JSON.stringify({
    BackendState: "Running",
    Self: {
      DNSName: "hack-node-1.tailnet.ts.net.",
    },
  });
  const parsed = __testOnlyNodeRailway.parseRailwayTailscaleEndpoint({
    output,
  });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }
  expect(parsed.endpoint).toBe("https://hack-node-1.tailnet.ts.net");
});

test("ensurePrivateTailscaleTags only applies explicit tags and normalizes", () => {
  const defaults = __testOnlyNodeRailway.ensurePrivateTailscaleTags({
    tags: [],
  });
  expect(defaults).toEqual([]);

  const normalized = __testOnlyNodeRailway.ensurePrivateTailscaleTags({
    tags: ["Prod", "tag:prod", "Tag:Ops"],
  });
  expect(normalized).toEqual(["tag:prod", "tag:ops"]);
});

test("redaction helpers cover sensitive values", () => {
  expect(
    __testOnlyNodeRailway.redactRailwaySecretToken({
      token: "TS_AUTHKEY=super-secret",
    })
  ).toBe("TS_AUTHKEY=***");
});

test("config helpers prefer provider-route values over extension defaults", () => {
  const routeConfig: Record<string, unknown> = {
    project: "route-project",
    createService: "true",
    domainPort: "9000",
  };
  const extensionConfig: Record<string, unknown> = {
    project: "extension-project",
    createService: false,
    domainPort: 7788,
  };

  expect(
    __testOnlyNodeRailway.resolveRailwayConfigString({
      routeConfig,
      extensionConfig,
      key: "project",
    })
  ).toBe("route-project");
  expect(
    __testOnlyNodeRailway.resolveRailwayConfigBoolean({
      routeConfig,
      extensionConfig,
      key: "createService",
    })
  ).toBe(true);
  expect(
    __testOnlyNodeRailway.resolveRailwayConfigInteger({
      routeConfig,
      extensionConfig,
      key: "domainPort",
    })
  ).toBe(9000);
});

test("config helpers fallback to extension defaults when route value is absent", () => {
  const routeConfig: Record<string, unknown> = {};
  const extensionConfig: Record<string, unknown> = {
    service: "railway-svc",
    private: "false",
    initRetries: "8",
  };

  expect(
    __testOnlyNodeRailway.resolveRailwayConfigString({
      routeConfig,
      extensionConfig,
      key: "service",
    })
  ).toBe("railway-svc");
  expect(
    __testOnlyNodeRailway.resolveRailwayConfigBoolean({
      routeConfig,
      extensionConfig,
      key: "private",
    })
  ).toBe(false);
  expect(
    __testOnlyNodeRailway.resolveRailwayConfigInteger({
      routeConfig,
      extensionConfig,
      key: "initRetries",
    })
  ).toBe(8);
});
