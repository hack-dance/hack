import { expect, test } from "bun:test";
import { nativeComposeProxyRoutesMatch } from "../src/lib/native-compose-proxy-routes.ts";
import { NativeComposeRoutingError } from "../src/lib/native-compose-routing.ts";

const HOST = "app.v5.hack.gy";
const ALIAS = "app.hack.gy";
const DIAL = "172.29.0.3:3000";
const expected = [
  {
    hostnames: [HOST, ALIAS],
    origins: [`https://${HOST}`, `https://${ALIAS}`],
    service: "web",
    port: 3000,
    protocol: "http" as const,
    dials: [DIAL],
  },
];
function config(dials = [DIAL], protocol: "http" | "https" = "http") {
  return {
    srv0: {
      listen: [":443"],
      tls_connection_policies: [{}],
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
  expect(
    nativeComposeProxyRoutesMatch({
      servers: config([DIAL, DIAL]),
      expected,
      absentHostnames: [],
    })
  ).toBe(false);
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

test("frontend listener and TLS must serve the selected origin, independently of upstream HTTP", () => {
  for (const change of [
    { listen: [":8443"] },
    { listen: ["127.0.0.1:443"] },
    { listen: [":80"] },
    { tls_connection_policies: [] },
    { tls_connection_policies: [{ match: { sni: ["foreign.test"] } }] },
    { tls_connection_policies: [{ drop: true }, {}] },
  ]) {
    const servers = config();
    Object.assign(servers.srv0, change);
    expect(
      nativeComposeProxyRoutesMatch({ servers, expected, absentHostnames: [] })
    ).toBe(false);
  }
  const http = config();
  Object.assign(http.srv0, { listen: [":80"], tls_connection_policies: [] });
  expect(
    nativeComposeProxyRoutesMatch({
      servers: http,
      expected: [
        { ...expected[0]!, origins: [`http://${HOST}`, `http://${ALIAS}`] },
      ],
      absentHostnames: [],
    })
  ).toBe(true);
});

test("an earlier responder, middleware, conditional or terminal route cannot shadow the expected proxy", () => {
  for (const earlier of [
    {
      match: [{ host: [HOST] }],
      handle: [{ handler: "static_response", status_code: 200 }],
      terminal: true,
    },
    { handle: [{ handler: "static_response", status_code: 404 }] },
    {
      match: [{ host: [HOST], path: ["/private/*"] }],
      handle: [{ handler: "file_server" }],
    },
    { match: [{ host: [HOST] }], handle: [], terminal: true },
  ]) {
    const servers = config();
    (servers.srv0.routes as unknown[]).unshift(earlier);
    expect(
      nativeComposeProxyRoutesMatch({ servers, expected, absentHostnames: [] })
    ).toBe(false);
  }
  for (const handler of ["static_response", "rewrite", "headers"]) {
    const servers = config();
    (servers.srv0.routes[0]!.handle[0]!.routes[0]!.handle as unknown[]).unshift(
      { handler }
    );
    expect(
      nativeComposeProxyRoutesMatch({ servers, expected, absentHostnames: [] })
    ).toBe(false);
  }
});

test("ordinary HTTP redirect and later fallback do not mask an exact HTTPS proxy path", () => {
  const servers = config();
  (servers.srv0.routes as unknown[]).push({
    handle: [{ handler: "static_response", status_code: 404 }],
  });
  Object.assign(servers, {
    redirect: {
      listen: [":80"],
      routes: [
        {
          match: [{ host: [HOST, ALIAS] }],
          handle: [{ handler: "static_response", status_code: 308 }],
        },
      ],
    },
  });
  expect(
    nativeComposeProxyRoutesMatch({ servers, expected, absentHostnames: [] })
  ).toBe(true);
  const changed = config();
  Object.assign(changed.srv0.routes[0]!.handle[0]!.routes[0]!.handle[0]!, {
    handle_response: [
      { routes: [{ handle: [{ handler: "static_response" }] }] },
    ],
  });
  expect(
    nativeComposeProxyRoutesMatch({
      servers: changed,
      expected,
      absentHostnames: [],
    })
  ).toBe(false);
});

test("group dispatch and subroute overrides cannot masquerade as an unconditional generated route", () => {
  const grouped = config();
  Object.assign(grouped.srv0.routes[0]!, { group: "foreign-choice" });
  expect(
    nativeComposeProxyRoutesMatch({
      servers: grouped,
      expected,
      absentHostnames: [],
    })
  ).toBe(false);
  const overrides = config();
  Object.assign(overrides.srv0.routes[0]!.handle[0]!, {
    errors: { routes: [{ handle: [{ handler: "static_response" }] }] },
  });
  expect(
    nativeComposeProxyRoutesMatch({
      servers: overrides,
      expected,
      absentHostnames: [],
    })
  ).toBe(false);
});

test("unsupported TLS policies cannot stand in for a clear HTTP listener", () => {
  const servers = config();
  Object.assign(servers.srv0, {
    listen: [":80"],
    tls_connection_policies: [{ match: { sni: ["foreign.test"] } }],
  });
  expect(
    nativeComposeProxyRoutesMatch({
      servers,
      expected: [
        { ...expected[0]!, origins: [`http://${HOST}`, `http://${ALIAS}`] },
      ],
      absentHostnames: [],
    })
  ).toBe(false);
});

test("unrelated custom proxies stay opaque without blocking another project's proof or API preflight", () => {
  const servers = config();
  const foreign = {
    match: [{ host: ["foreign.test"] }],
    handle: [
      {
        handler: "reverse_proxy",
        upstreams: [{ dial: "foreign:3000" }],
        headers: { request: { set: { "X-Fixture": ["private-canary"] } } },
        health_checks: { active: { uri: "/health" } },
      },
    ],
  };
  (servers.srv0.routes as unknown[]).unshift(foreign);
  expect(
    nativeComposeProxyRoutesMatch({
      servers,
      expected: [],
      absentHostnames: [],
    })
  ).toBe(true);
  expect(
    nativeComposeProxyRoutesMatch({ servers, expected, absentHostnames: [] })
  ).toBe(true);
  foreign.match[0]!.host = [HOST];
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
});
