import { expect, test } from "bun:test";
import {
  dockerEngineSupportsStartInterval,
  parseEngineMajor,
} from "../src/lib/docker-engine-features.ts";
import {
  classifyCurl,
  classifyNslookup,
  ROUTE_PROBE_NAME,
  routeProbeAddress,
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
        return Promise.resolve(classifyNslookup({ exitCode: 127, output: "" }));
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
        Promise.resolve(classifyNslookup({ exitCode: 1, output: "timed out" })),
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

test("nslookup: an answer, a v4 image without the tool, a refusal, anything else", () => {
  expect(
    classifyNslookup({ exitCode: 0, output: "Address: 10.0.0.2" })
  ).toEqual(answered);
  // A v4 proxy file's image: `exec: "nslookup": executable file not found`.
  for (const exitCode of [126, 127]) {
    expect(classifyNslookup({ exitCode, output: "" })).toMatchObject({
      kind: "unknown",
      retry: false,
    });
  }
  expect(
    classifyNslookup({
      exitCode: 1,
      output: "** server can't find schemas.hack.local: NXDOMAIN",
    }).kind
  ).toBe("refused");
  expect(
    classifyNslookup({ exitCode: 1, output: ";; connection timed out" })
  ).toMatchObject({ kind: "unknown", retry: true });
});

test("curl: any HTTP status answers; a refused port is a refusal; a timeout or TLS failure is not checked", () => {
  const look = (exitCode: number, status: string) =>
    classifyCurl({ exitCode, status, address: "127.0.0.1" });
  expect(look(0, "404")).toEqual(answered);
  expect(look(0, "000").kind).not.toBe("answered");
  expect(look(7, "000").kind).toBe("refused");
  // 28: timeout (loopback a container runtime does not forward to Caddy);
  // 35: TLS handshake failed. Doctor tolerates both; up does not fail on them.
  for (const exitCode of [28, 35, 52, 56]) {
    expect(look(exitCode, "000")).toMatchObject({
      kind: "unknown",
      retry: false,
    });
  }
});

test("the HTTPS address follows the engine: local uses doctor's choice, TCP its host, others none", () => {
  const address = (engine: string, publishesAllInterfaces = true) =>
    routeProbeAddress({
      engine,
      localAddress: "127.0.0.1",
      publishesAllInterfaces,
    });
  expect(address("host:unix:///var/run/docker.sock")).toBe("127.0.0.1");
  expect(address("host:npipe:////./pipe/docker_engine")).toBe("127.0.0.1");
  expect(address("host:tcp://10.1.2.3:2376")).toBe("10.1.2.3");
  // A TCP engine whose proxy publishes on one address only: not reachable here.
  expect(address("host:tcp://10.1.2.3:2376", false)).toBeNull();
  expect(address("host:ssh://builder@remote")).toBeNull();
  expect(address("host:unknown://")).toBeNull();
  // Doctor found no address in the Compose file: none invented.
  expect(
    routeProbeAddress({
      engine: "host:unix:///var/run/docker.sock",
      localAddress: null,
      publishesAllInterfaces: true,
    })
  ).toBeNull();
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
