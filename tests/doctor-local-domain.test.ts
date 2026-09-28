import { expect, test } from "bun:test";
import {
  buildDoctorJsonData,
  checkHackLocalDns,
  checkNativeHostDns,
} from "../src/commands/doctor.ts";
import { DEFAULT_CADDY_IP, DEFAULT_HOST_DNS_IP } from "../src/constants.ts";

test("new local suffix accepts static and loopback ingress without changing global service names", async () => {
  for (const address of [DEFAULT_CADDY_IP, DEFAULT_HOST_DNS_IP, "::1"]) {
    const result = await checkHackLocalDns({
      lookup: async (host) => {
        expect(host).toBe("doctor.hack.local");
        return { address };
      },
      caddyIp: async () => {
        throw new Error("static target needs no Docker query");
      },
    });
    expect(result.status).toBe("ok");
    expect(result.name).toBe("dns:hack.local");
  }
});

test("new local suffix verifies the current dynamic ingress and warns for foreign addresses", async () => {
  for (const address of ["172.30.1.4", "192.0.2.10"]) {
    const result = await checkHackLocalDns({
      lookup: async () => ({ address }),
      caddyIp: async () => "172.30.1.4",
    });
    expect(result.status).toBe(address === "172.30.1.4" ? "ok" : "warn");
  }
});

test("missing local suffix has explicit global setup guidance and separate summary identity", async () => {
  const result = await checkHackLocalDns({
    lookup: async () => {
      throw new Error("not found");
    },
  });
  expect(result.status).toBe("warn");
  expect(result.message).toContain("hack global install");
  const report = buildDoctorJsonData({
    results: [{ ...result, durationMs: 0 }],
  });
  expect(report.checks[0]?.id).toBe("dns:hack.local");
  expect(report.summary.join(" ")).toContain("Resolver & DNS");
});

test("configured custom domain checks the exact DNS suffix", async () => {
  const result = await checkHackLocalDns({
    domain: "dev.example.test",
    lookup: async (host) => {
      expect(host).toBe("doctor.dev.example.test");
      return { address: DEFAULT_HOST_DNS_IP };
    },
  });
  expect(result).toEqual({
    name: "dns:dev.example.test",
    status: "ok",
    message: `doctor.dev.example.test → ${DEFAULT_HOST_DNS_IP}`,
  });
});

test("native host DNS refuses foreign and IPv6 answers even with a loopback answer", async () => {
  const hostname = "app.dev.example.test";
  const ready = await checkNativeHostDns({
    hostname,
    lookupAll: async (observed) => {
      expect(observed).toBe(hostname);
      return [{ address: DEFAULT_HOST_DNS_IP }];
    },
  });
  expect(ready.status).toBe("ok");
  for (const addresses of [
    [{ address: "192.0.2.42" }],
    [{ address: DEFAULT_HOST_DNS_IP }, { address: "::1" }],
    [],
  ]) {
    const result = await checkNativeHostDns({
      hostname,
      lookupAll: async () => addresses,
    });
    expect(result.status).toBe("warn");
  }
  const missing = await checkNativeHostDns({
    hostname,
    lookupAll: async () => {
      throw new Error("DNS lookup failed");
    },
  });
  expect(missing.status).toBe("warn");
  const summary = buildDoctorJsonData({
    results: [{ ...missing, durationMs: 0 }],
  }).summary.join(" ");
  expect(summary).toContain("Resolver & DNS");
});
