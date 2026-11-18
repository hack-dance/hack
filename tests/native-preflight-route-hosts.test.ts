import { expect, test } from "bun:test";
import { hostResolutionFindings } from "../src/backends/native-preflight.ts";

const plan = {
  services: {
    web: { active: true, routing: { hostnames: ["web.example.hack"] } },
    api: { active: true, routing: { hostnames: ["api.example.hack"] } },
    jobs: { active: false, routing: { hostnames: ["jobs.example.hack"] } },
    db: { active: true },
  },
};

function resolver(answers: Record<string, readonly string[]>) {
  const asked: string[] = [];
  return {
    asked,
    resolveHost: (hostname: string) => {
      asked.push(hostname);
      return Promise.resolve(answers[hostname] ?? []);
    },
  };
}

test("a hostname that resolves to the Compose proxy is named by service and address, never by hostname (HACK-2338 item 6)", async () => {
  const dns = resolver({
    "web.example.hack": ["172.30.0.2"],
    "api.example.hack": ["127.0.0.1"],
  });
  const findings = await hostResolutionFindings({
    plan,
    httpsPort: 18_443,
    resolveHost: dns.resolveHost,
    defaultHttpsTaken: () => Promise.resolve(false),
  });
  expect(dns.asked.sort()).toEqual(["api.example.hack", "web.example.hack"]);
  expect(findings).toEqual([
    {
      severity: "warning",
      gate: "cli",
      code: "route_host_resolves_elsewhere",
      service: "web",
      message:
        "A hostname this service routes resolves on this machine to 172.30.0.2, the address of Hack's Compose proxy, not to native's HTTPS listener on 127.0.0.1:18443. Clients on this machine reach that address instead of native.",
      fix: "Make the hostname resolve to 127.0.0.1 here (for the Compose proxy, stop it with hack global down; otherwise remove the hosts file or local DNS entry) and open it with port 18443; or reach native directly with curl --resolve HOST:18443:127.0.0.1 https://HOST:18443/.",
    },
  ]);
  expect(JSON.stringify(findings)).not.toContain("example.hack");
});

test("loopback names on another port warn only when something else answers on 443", async () => {
  const dns = resolver({
    "web.example.hack": ["127.0.0.1", "::1"],
    "api.example.hack": ["127.0.0.1"],
  });
  const taken = await hostResolutionFindings({
    plan,
    httpsPort: 18_443,
    resolveHost: dns.resolveHost,
    defaultHttpsTaken: () => Promise.resolve(true),
  });
  expect(taken.map((found) => [found.code, found.service])).toEqual([
    ["route_default_port_elsewhere", "api"],
    ["route_default_port_elsewhere", "web"],
  ]);
  expect(taken[0]?.message).toContain("127.0.0.1:18443");
  for (const opts of [
    { httpsPort: 18_443, taken: false },
    { httpsPort: 443, taken: true },
  ]) {
    expect(
      await hostResolutionFindings({
        plan,
        httpsPort: opts.httpsPort,
        resolveHost: dns.resolveHost,
        defaultHttpsTaken: () => Promise.resolve(opts.taken),
      })
    ).toEqual([]);
  }
});

test("unknown lookups and a failing resolver report nothing", async () => {
  expect(
    await hostResolutionFindings({
      plan,
      httpsPort: 18_443,
      resolveHost: () => Promise.resolve([]),
      defaultHttpsTaken: () => Promise.resolve(true),
    })
  ).toEqual([]);
  expect(
    await hostResolutionFindings({
      plan,
      httpsPort: 18_443,
      resolveHost: () => Promise.reject(new Error("resolver unavailable")),
      defaultHttpsTaken: () => Promise.resolve(true),
    })
  ).toEqual([]);
});
