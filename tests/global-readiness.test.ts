import { expect, test } from "bun:test";
import {
  dockerEngineSupportsStartInterval,
  parseEngineMajor,
} from "../src/lib/docker-engine-features.ts";
import {
  probeAddress,
  ROUTE_PROBE_NAME,
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
        return Promise.resolve(dnsLooks >= 3);
      },
      requestHttps: () => {
        httpsLooks++;
        return Promise.resolve(c.now() >= 4000);
      },
      progress: ({ waitingFor }) => progress.push(waitingFor.join(",")),
      ...c,
    },
    { timeoutMs: 15_000, pollMs: 250, progressMs: 3000 }
  );
  expect(result).toEqual({ ready: true, skipped: [] });
  // DNS is not asked again once it answered.
  expect(dnsLooks).toBe(3);
  expect(httpsLooks).toBeGreaterThan(3);
  expect(progress).toEqual(["https"]);
});

test("routes that never answer are reported by step after the bound", async () => {
  const c = clock();
  expect(
    await waitForRoutes(
      {
        resolveName: () => Promise.resolve(true),
        requestHttps: () => Promise.resolve(false),
        ...c,
      },
      { timeoutMs: 2000 }
    )
  ).toEqual({ ready: false, waitingFor: ["https"] });
  expect(c.now()).toBe(2000);
});

test("without curl only DNS is waited for, and the skip is reported", async () => {
  expect(
    await waitForRoutes(
      { resolveName: () => Promise.resolve(true), requestHttps: null },
      { timeoutMs: 1000 }
    )
  ).toEqual({ ready: true, skipped: ["https"] });
});

test("the probe goes to the address the proxy publishes on", () => {
  expect(probeAddress(null)).toBe("127.0.0.1");
  expect(probeAddress("0.0.0.0")).toBe("127.0.0.1");
  expect(probeAddress("::")).toBe("::1");
  expect(probeAddress("10.0.0.5")).toBe("10.0.0.5");
});
