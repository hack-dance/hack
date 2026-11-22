import { expect, test } from "bun:test";
import {
  dockerEngineSupportsStartInterval,
  parseEngineMajor,
} from "../src/lib/docker-engine-features.ts";
import {
  classifyHttps,
  classifyNslookup,
  parseNslookupAnswers,
  ROUTE_PROBE_NAME,
  routeHttpsTargets,
  routeProbeName,
  type StepLook,
  waitForRoutes,
} from "../src/lib/global-route-probe.ts";
import {
  renderGlobalCaddyCompose,
  renderGlobalLoggingCompose,
} from "../src/templates.ts";

test("start_interval is rendered only for Docker Engine 25 and later", async () => {
  const answer =
    (stdout: string, exitCode = 0) =>
    async () => ({
      exitCode,
      stdout,
    });
  expect(await dockerEngineSupportsStartInterval(answer("29.9.2\n"))).toBe(
    true
  );
  expect(await dockerEngineSupportsStartInterval(answer("25.0.0\n"))).toBe(
    true
  );
  // Ubuntu's packaged docker.io, and other older engines: Compose would
  // refuse the key ("feature require Docker Engine v25 or later").
  expect(await dockerEngineSupportsStartInterval(answer("24.0.7\n"))).toBe(
    false
  );
  // No answer, or one this does not understand: the file that works everywhere.
  expect(await dockerEngineSupportsStartInterval(answer("", 1))).toBe(false);
  expect(await dockerEngineSupportsStartInterval(answer("dev\n"))).toBe(false);
  expect(
    await dockerEngineSupportsStartInterval(async () => {
      throw new Error("no docker");
    })
  ).toBe(false);
  expect(parseEngineMajor("v26.1.4")).toBe(26);
});

test("the templates carry start_interval only when asked, and probe every 2 s without it", () => {
  for (const render of [
    (startInterval: boolean) => renderGlobalCaddyCompose({ startInterval }),
    (startInterval: boolean) => renderGlobalLoggingCompose({ startInterval }),
  ]) {
    const without = render(false);
    expect(without).not.toContain("start_interval");
    expect(without).toContain("interval: 2s");
    const withIt = render(true);
    expect(withIt).toContain("start_interval: 500ms");
    expect(withIt).toContain("interval: 10s");
  }
  // The default is the variant every engine accepts.
  expect(renderGlobalCaddyCompose()).not.toContain("start_interval");
});

function clock() {
  let now = 0;
  return {
    now: () => now,
    sleep: (ms: number) => {
      now += ms;
      return Promise.resolve();
    },
  };
}

const answered: StepLook = { kind: "answered" };
const refused = (detail: string): StepLook => ({ kind: "refused", detail });

test("routes are ready once DNS and HTTPS through the proxy both answer", async () => {
  const c = clock();
  let dnsLooks = 0;
  let httpsLooks = 0;
  const progress: string[] = [];
  const result = await waitForRoutes(
    {
      resolveName: (name) => {
        expect(name).toBe(ROUTE_PROBE_NAME);
        dnsLooks++;
        return Promise.resolve(dnsLooks >= 3 ? answered : refused("no name"));
      },
      requestHttps: () => {
        httpsLooks++;
        return Promise.resolve(
          c.now() >= 4000 ? answered : refused("port refused")
        );
      },
      progress: ({ waitingFor }) => progress.push(waitingFor.join(",")),
      ...c,
    },
    { timeoutMs: 15_000, pollMs: 250, progressMs: 3000 }
  );
  expect(result).toEqual({
    dns: { state: "ready" },
    https: { state: "ready" },
  });
  // DNS is not asked again once it answered.
  expect(dnsLooks).toBe(3);
  expect(httpsLooks).toBeGreaterThan(3);
  expect(progress).toEqual(["https"]);
});

test("only a refusal still there at the bound is not-ready", async () => {
  const c = clock();
  expect(
    await waitForRoutes(
      {
        resolveName: () => Promise.resolve(answered),
        requestHttps: () => Promise.resolve(refused("port 443 refused")),
        ...c,
      },
      { timeoutMs: 2000 }
    )
  ).toEqual({
    dns: { state: "ready" },
    https: { state: "not-ready", detail: "port 443 refused" },
  });
  expect(c.now()).toBe(2000);
});

test("a look that cannot be checked stops that step at once as unknown, not a failure", async () => {
  const c = clock();
  let dnsLooks = 0;
  const result = await waitForRoutes(
    {
      resolveName: () => {
        dnsLooks++;
        return Promise.resolve(
          classifyNslookup({
            exitCode: 127,
            output: "",
            expected: ["10.0.0.2"],
          })
        );
      },
      requestHttps: () => Promise.resolve(answered),
      ...c,
    },
    { timeoutMs: 15_000 }
  );
  expect(dnsLooks).toBe(1);
  expect(result.dns.state).toBe("unknown");
  expect(result.https).toEqual({ state: "ready" });
  // No wait for the bound.
  expect(c.now()).toBe(0);
});

test("an unknown that may clear is retried, and is unknown (not not-ready) at the bound", async () => {
  const c = clock();
  const result = await waitForRoutes(
    {
      resolveName: () =>
        Promise.resolve(
          classifyNslookup({
            exitCode: 1,
            output: "timed out",
            expected: ["10.0.0.2"],
          })
        ),
      requestHttps: () => Promise.reject(new Error("spawn failed")),
      ...c,
    },
    { timeoutMs: 1000 }
  );
  expect(result.dns.state).toBe("unknown");
  expect(result.https).toEqual({ state: "unknown", detail: "spawn failed" });
});

test("without an HTTPS look only DNS is waited for, and the skip is reported", async () => {
  expect(
    await waitForRoutes(
      {
        resolveName: () => Promise.resolve(answered),
        requestHttps: null,
        httpsSkipped: "curl is not on PATH",
      },
      { timeoutMs: 1000 }
    )
  ).toEqual({
    dns: { state: "ready" },
    https: { state: "unknown", detail: "curl is not on PATH" },
  });
});

const NSLOOKUP = (address: string) =>
  `Server:\t\tcoredns\nAddress:\t127.0.0.11:53\n\nNon-authoritative answer:\nName:\tschemas.hack\nAddress: ${address}\n`;

test("nslookup's answer is read after the server lines", () => {
  expect(parseNslookupAnswers(NSLOOKUP("10.0.0.2"))).toEqual(["10.0.0.2"]);
  expect(
    parseNslookupAnswers("Server:\t\tcoredns\nAddress:\t127.0.0.11:53\n")
  ).toEqual([]);
});

test("nslookup: only the proxy's own address answers; a wrong address is a refusal; a v4 image without the tool is not checked", () => {
  const expected = ["10.0.0.2"];
  expect(
    classifyNslookup({ exitCode: 0, output: NSLOOKUP("10.0.0.2"), expected })
  ).toEqual(answered);
  // An answer that is not Caddy's: CoreDNS (or something in its place) is
  // sending the name elsewhere.
  expect(
    classifyNslookup({ exitCode: 0, output: NSLOOKUP("192.0.2.99"), expected })
  ).toEqual({
    kind: "refused",
    detail:
      "CoreDNS answered 192.0.2.99, not only the proxy's address (10.0.0.2)",
  });
  // A client may pick any address in the answer: one that is not Caddy's
  // fails even next to Caddy's.
  expect(
    classifyNslookup({
      exitCode: 0,
      output: `${NSLOOKUP("10.0.0.2")}Address: 192.0.2.99\n`,
      expected,
    })
  ).toEqual({
    kind: "refused",
    detail:
      "CoreDNS answered 10.0.0.2, 192.0.2.99, not only the proxy's address (10.0.0.2)",
  });
  // The proxy's address cannot be read: the answer cannot be compared.
  expect(
    classifyNslookup({
      exitCode: 0,
      output: NSLOOKUP("10.0.0.2"),
      expected: null,
    })
  ).toMatchObject({ kind: "unknown", retry: false });
  // A v4 proxy file's image: `exec: "nslookup": executable file not found`.
  for (const exitCode of [126, 127]) {
    expect(classifyNslookup({ exitCode, output: "", expected })).toMatchObject({
      kind: "unknown",
      retry: false,
    });
  }
  expect(
    classifyNslookup({
      exitCode: 1,
      output: "** server can't find schemas.hack.local: NXDOMAIN",
      expected,
    }).kind
  ).toBe("refused");
  expect(
    classifyNslookup({
      exitCode: 1,
      output: ";; connection timed out",
      expected,
    })
  ).toMatchObject({ kind: "unknown", retry: true });
});

test("HTTPS: only the proxy's own certificate answers; a refused port or another server's certificate is a refusal; an incomplete handshake is not checked", () => {
  expect(classifyHttps([{ address: "127.0.0.1", state: "ok" }])).toEqual(
    answered
  );
  // One family answering is enough, as in doctor's reachable.
  expect(
    classifyHttps([
      { address: "127.0.0.1", state: "ok" },
      { address: "::1", state: "tls-error" },
    ])
  ).toEqual(answered);
  expect(
    classifyHttps([{ address: "127.0.0.1", state: "untrusted" }])
  ).toMatchObject({ kind: "refused" });
  // Another server on one family is a refusal even when the proxy answers on
  // the other: names resolving to 127.0.0.1 would reach it.
  expect(
    classifyHttps([
      { address: "127.0.0.1", state: "untrusted" },
      { address: "::1", state: "ok" },
    ])
  ).toEqual({
    kind: "refused",
    detail:
      "port 443 on 127.0.0.1 answered with a certificate this home's proxy did not issue for schemas.hack.local (another server is answering there, or the proxy does not serve that name)",
  });
  // A TLS alert: a server there refused the selected name.
  expect(
    classifyHttps([{ address: "127.0.0.1", state: "rejected" }], "schemas.hack")
  ).toEqual({
    kind: "refused",
    detail:
      "port 443 on 127.0.0.1 refused TLS for schemas.hack: the server there does not serve that name",
  });
  expect(
    classifyHttps([{ address: "127.0.0.1", state: "unreachable" }])
  ).toEqual({
    kind: "refused",
    detail: "port 443 on 127.0.0.1 refused the connection",
  });
  // A timeout or a handshake that did not complete (a container runtime
  // that does not forward loopback cleanly): what doctor tolerates.
  for (const state of ["timeout", "tls-error"] as const) {
    expect(classifyHttps([{ address: "::1", state }])).toMatchObject({
      kind: "unknown",
      retry: false,
    });
  }
});

test("HTTPS endpoints come from the proxy's live bindings: doctor's loopback choice locally, the engine's address over TCP, none otherwise", () => {
  const ports = (b443: readonly string[]) => ({ 80: [], 443: b443 });
  const local = "host:unix:///var/run/docker.sock";
  expect(
    routeHttpsTargets({ engine: local, loopbackPorts: ports(["0.0.0.0"]) })
  ).toEqual({ addresses: ["127.0.0.1"] });
  expect(
    routeHttpsTargets({
      engine: local,
      loopbackPorts: ports(["0.0.0.0", "::"]),
    })
  ).toEqual({ addresses: ["127.0.0.1", "::1"] });
  expect(
    routeHttpsTargets({ engine: local, loopbackPorts: ports(["127.81.0.5"]) })
  ).toEqual({ addresses: ["127.81.0.5"] });
  // 443 not published (or only on a non-loopback address): nothing to probe.
  expect(
    "skipped" in routeHttpsTargets({ engine: local, loopbackPorts: ports([]) })
  ).toBe(true);
  expect(
    "skipped" in routeHttpsTargets({ engine: local, loopbackPorts: null })
  ).toBe(true);
  expect(
    routeHttpsTargets({
      engine: "host:tcp://10.1.2.3:2376",
      loopbackPorts: ports(["0.0.0.0"]),
    })
  ).toEqual({ addresses: ["10.1.2.3"] });
  for (const [engine, b443] of [
    ["host:tcp://10.1.2.3:2376", ["127.0.0.1"]],
    ["host:tcp://builder.example:2376", ["0.0.0.0"]],
    ["host:ssh://builder@remote", ["0.0.0.0"]],
    ["host:unknown://", ["0.0.0.0"]],
  ] as const) {
    expect(
      "skipped" in routeHttpsTargets({ engine, loopbackPorts: ports(b443) })
    ).toBe(true);
  }
});

test("the probe asks for the schemas name the proxy file routes, so an older file is probed by its own name", () => {
  // v4 proxy files route only schemas.hack.
  expect(routeProbeName("    labels:\n      caddy: schemas.hack\n")).toBe(
    "schemas.hack"
  );
  expect(
    routeProbeName(
      "    labels:\n      caddy: schemas.hack.local, schemas.hack\n"
    )
  ).toBe("schemas.hack.local");
  expect(routeProbeName(renderGlobalCaddyCompose())).toBe(ROUTE_PROBE_NAME);
  expect(routeProbeName("")).toBe(ROUTE_PROBE_NAME);
});
