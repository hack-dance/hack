import { describe, expect, test } from "bun:test";

import {
  DEFAULT_CADDY_IP,
  DEFAULT_COREDNS_IP,
  DEFAULT_INGRESS_NETWORK,
} from "../src/constants.ts";
import {
  findProxyNetworkIssues,
  type ProxyContainerState,
  parseProxyContainerInspect,
  reservedProxyIps,
} from "../src/lib/global-proxy-network.ts";
import { renderGlobalCaddyCompose } from "../src/templates.ts";

const RESERVED = reservedProxyIps(
  renderGlobalCaddyCompose({ useStaticCaddyIp: true, useStaticCoreDnsIp: true })
);

function container(
  overrides: Partial<ProxyContainerState> & Pick<ProxyContainerState, "service">
): ProxyContainerState {
  return {
    name: `hack-dev-proxy-${overrides.service}-1`,
    running: true,
    networks: {
      [DEFAULT_INGRESS_NETWORK]:
        overrides.service === "caddy" ? DEFAULT_CADDY_IP : DEFAULT_COREDNS_IP,
    },
    ...overrides,
  };
}

describe("findProxyNetworkIssues", () => {
  test("healthy stack has no issues", () => {
    expect(
      findProxyNetworkIssues({
        containers: [
          container({ service: "caddy" }),
          container({ service: "coredns" }),
        ],
        reservedIps: RESERVED,
      })
    ).toEqual([]);
  });

  test("running caddy with no network (field case) is reported", () => {
    expect(
      findProxyNetworkIssues({
        containers: [
          container({ service: "caddy", networks: {} }),
          container({ service: "coredns" }),
        ],
        reservedIps: RESERVED,
      })
    ).toEqual([
      {
        service: "caddy",
        name: "hack-dev-proxy-caddy-1",
        problem: "no_network",
        expectedIp: DEFAULT_CADDY_IP,
        actualIp: null,
      },
    ]);
  });

  test("wrong network and wrong address are reported; stopped containers are not", () => {
    const issues = findProxyNetworkIssues({
      containers: [
        container({ service: "caddy", networks: { bridge: "172.17.0.5" } }),
        container({
          service: "coredns",
          networks: { [DEFAULT_INGRESS_NETWORK]: "172.30.0.9" },
        }),
        container({
          service: "caddy",
          name: "old",
          running: false,
          networks: {},
        }),
      ],
      reservedIps: RESERVED,
    });
    expect(
      issues.map((issue) => [issue.service, issue.problem, issue.actualIp])
    ).toEqual([
      ["caddy", "not_on_ingress", null],
      ["coredns", "wrong_address", "172.30.0.9"],
    ]);
  });

  test("dynamic-IP mode only requires the ingress attachment", () => {
    const dynamic = reservedProxyIps(renderGlobalCaddyCompose({}));
    expect(dynamic.size).toBe(0);
    expect(
      findProxyNetworkIssues({
        containers: [
          container({
            service: "caddy",
            networks: { [DEFAULT_INGRESS_NETWORK]: "172.30.0.77" },
          }),
        ],
        reservedIps: dynamic,
      })
    ).toEqual([]);
  });
});

describe("parseProxyContainerInspect", () => {
  test("reads compose service, running state and network addresses", () => {
    const raw = JSON.stringify([
      {
        Name: "/hack-dev-proxy-caddy-1",
        Config: { Labels: { "com.docker.compose.service": "caddy" } },
        State: { Running: true, Status: "running" },
        NetworkSettings: { Networks: {} },
      },
      {
        Name: "/hack-dev-proxy-coredns-1",
        Config: { Labels: { "com.docker.compose.service": "coredns" } },
        State: { Running: true },
        NetworkSettings: {
          Networks: {
            [DEFAULT_INGRESS_NETWORK]: { IPAddress: DEFAULT_COREDNS_IP },
          },
        },
      },
      {
        Name: "/unrelated",
        Config: { Labels: { "com.docker.compose.service": "web" } },
        State: { Running: true },
      },
    ]);
    expect(parseProxyContainerInspect(raw)).toEqual([
      {
        service: "caddy",
        name: "hack-dev-proxy-caddy-1",
        running: true,
        networks: {},
      },
      {
        service: "coredns",
        name: "hack-dev-proxy-coredns-1",
        running: true,
        networks: { [DEFAULT_INGRESS_NETWORK]: DEFAULT_COREDNS_IP },
      },
    ]);
  });

  test("a restarting or paused proxy is not reported as a network problem", () => {
    const raw = JSON.stringify([
      {
        Name: "/hack-dev-proxy-caddy-1",
        Config: { Labels: { "com.docker.compose.service": "caddy" } },
        State: { Running: true, Restarting: true },
        NetworkSettings: {
          Networks: { [DEFAULT_INGRESS_NETWORK]: { IPAddress: "" } },
        },
      },
      {
        Name: "/hack-dev-proxy-coredns-1",
        Config: { Labels: { "com.docker.compose.service": "coredns" } },
        State: { Running: true, Paused: true },
        NetworkSettings: { Networks: {} },
      },
    ]);
    const containers = parseProxyContainerInspect(raw);
    expect(containers.map((c) => c.running)).toEqual([false, false]);
    expect(
      findProxyNetworkIssues({ containers, reservedIps: RESERVED })
    ).toEqual([]);
  });

  test("malformed output yields no containers", () => {
    expect(parseProxyContainerInspect("not json")).toEqual([]);
    expect(parseProxyContainerInspect("{}")).toEqual([]);
  });
});
