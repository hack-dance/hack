import { expect, test } from "bun:test";
import { nativeComposeProxyRoutesMatch } from "../src/lib/native-compose-proxy-routes.ts";
import { NativeComposeRoutingError } from "../src/lib/native-compose-routing.ts";

const HOST = "app.v5.hack.gy";
const ALIAS = "app.hack.gy";
const DIAL = "172.29.0.3:3000";
const expected = [
  {
    hostnames: [HOST, ALIAS],
    service: "web",
    port: 3000,
    protocol: "http" as const,
    dials: [DIAL],
  },
];
function config(dials = [DIAL], protocol: "http" | "https" = "http") {
  return {
    srv0: {
      routes: [
        {
          match: [{ host: [HOST, ALIAS] }],
          handle: [
            {
              handler: "subroute",
              routes: [
                {
                  handle: [
                    {
                      handler: "reverse_proxy",
                      upstreams: dials.map((dial) => ({ dial })),
                      ...(protocol === "https"
                        ? { transport: { protocol: "http", tls: {} } }
                        : {}),
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}
test("active host groups must target exact current container dial pools and protocol", () => {
  expect(
    nativeComposeProxyRoutesMatch({
      servers: config(),
      expected,
      absentHostnames: [],
    })
  ).toBe(true);
  expect(
    nativeComposeProxyRoutesMatch({
      servers: config(["172.29.0.9:3000"]),
      expected,
      absentHostnames: [],
    })
  ).toBe(false);
  expect(
    nativeComposeProxyRoutesMatch({
      servers: config(["172.29.0.3:3001"]),
      expected,
      absentHostnames: [],
    })
  ).toBe(false);
  expect(
    nativeComposeProxyRoutesMatch({
      servers: config([DIAL], "https"),
      expected,
      absentHostnames: [],
    })
  ).toBe(false);
  expect(
    nativeComposeProxyRoutesMatch({
      servers: config([DIAL], "https"),
      expected: [{ ...expected[0]!, protocol: "https" }],
      absentHostnames: [],
    })
  ).toBe(true);
});
test("all replica upstreams must match and duplicated or dynamic dials refuse", () => {
  expect(
    nativeComposeProxyRoutesMatch({
      servers: config([DIAL, "172.29.0.4:3000"]),
      expected,
      absentHostnames: [],
    })
  ).toBe(false);
  expect(
    nativeComposeProxyRoutesMatch({
      servers: config([DIAL, "172.29.0.4:3000"]),
      expected: [{ ...expected[0]!, dials: ["172.29.0.4:3000", DIAL] }],
      absentHostnames: [],
    })
  ).toBe(true);
  expect(() =>
    nativeComposeProxyRoutesMatch({
      servers: config([DIAL, DIAL]),
      expected,
      absentHostnames: [],
    })
  ).toThrow(NativeComposeRoutingError);
  expect(
    nativeComposeProxyRoutesMatch({
      servers: config(["{http.request.host}:3000"]),
      expected,
      absentHostnames: [],
    })
  ).toBe(false);
});
test("retirement requires old hosts absent, including wildcards and nested hosts", () => {
  expect(
    nativeComposeProxyRoutesMatch({
      servers: config(),
      expected: [],
      absentHostnames: [HOST],
    })
  ).toBe(false);
  expect(
    nativeComposeProxyRoutesMatch({
      servers: config(),
      expected,
      absentHostnames: ["old.v5.hack.gy"],
    })
  ).toBe(true);
  expect(
    nativeComposeProxyRoutesMatch({
      servers: {
        srv0: {
          routes: [
            {
              match: [{ host: ["*.v5.hack.gy"] }],
              handle: [{ handler: "static_response", body: "fixture" }],
            },
          ],
        },
      },
      expected: [],
      absentHostnames: [HOST],
    })
  ).toBe(false);
  expect(
    nativeComposeProxyRoutesMatch({
      servers: {},
      expected: [],
      absentHostnames: [HOST],
    })
  ).toBe(true);
  expect(
    nativeComposeProxyRoutesMatch({
      servers: {},
      expected,
      absentHostnames: [],
    })
  ).toBe(false);
});
test("ambiguous duplicate site handlers cannot stand in for a new published generation", () => {
  const servers = config();
  servers.srv0.routes.push(servers.srv0.routes[0]!);
  expect(
    nativeComposeProxyRoutesMatch({ servers, expected, absentHostnames: [] })
  ).toBe(false);
});
test("matcher alternatives and nested conditions cannot narrow a catchall into exact route proof", () => {
  for (const match of [
    [{ host: [HOST, ALIAS] }, { path: ["/private/*"] }],
    [{ host: [HOST, ALIAS], path: ["/private/*"] }],
    [{}],
  ]) {
    const servers = config();
    Object.assign(servers.srv0.routes[0]!, { match });
    expect(
      nativeComposeProxyRoutesMatch({ servers, expected, absentHostnames: [] })
    ).toBe(false);
    expect(
      nativeComposeProxyRoutesMatch({
        servers,
        expected: [],
        absentHostnames: [HOST],
      })
    ).toBe(false);
  }
  const nested = config();
  Object.assign(nested.srv0.routes[0]!.handle[0]!.routes[0]!, {
    match: [{ path: ["/private/*"] }],
  });
  expect(
    nativeComposeProxyRoutesMatch({
      servers: nested,
      expected,
      absentHostnames: [],
    })
  ).toBe(false);
});
test("a hostless reverse proxy prevents retirement while a generic fallback does not claim a hostname", () => {
  const servers = {
    srv0: {
      routes: [
        { handle: [{ handler: "reverse_proxy", upstreams: [{ dial: DIAL }] }] },
      ],
    },
  };
  expect(
    nativeComposeProxyRoutesMatch({ servers, expected, absentHostnames: [] })
  ).toBe(false);
  expect(
    nativeComposeProxyRoutesMatch({
      servers,
      expected: [],
      absentHostnames: [HOST],
    })
  ).toBe(false);
  expect(
    nativeComposeProxyRoutesMatch({
      servers: {
        srv0: {
          routes: [
            { handle: [{ handler: "static_response", status_code: 404 }] },
          ],
        },
      },
      expected: [],
      absentHostnames: [HOST],
    })
  ).toBe(true);
});
test("arbitrary nested objects and private canaries never become public diagnostics", () => {
  const canary = "synthetic-private-proxy-canary";
  for (const servers of [
    null,
    [],
    { srv0: null },
    { srv0: { routes: canary } },
    { srv0: { routes: [{ match: [{ host: [canary, null] }] }] } },
  ]) {
    try {
      nativeComposeProxyRoutesMatch({ servers, expected, absentHostnames: [] });
      throw new Error("unexpected active route success");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(NativeComposeRoutingError);
      expect(String(error)).not.toContain(canary);
      expect(JSON.stringify(error)).not.toContain(canary);
    }
  }
});
