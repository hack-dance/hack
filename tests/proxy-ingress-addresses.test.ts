import { describe, expect, test } from "bun:test";
import {
  type IngressAddressDeps,
  type IngressAddressRecord,
  parseIngressAddressRecord,
  resolveIngressAddresses,
} from "../src/lib/proxy-ingress-addresses.ts";

function line(opts: {
  readonly project?: string;
  readonly service: string;
  readonly running?: boolean;
  readonly ip?: string;
}): string {
  return [
    opts.project ?? "hack-dev-proxy",
    opts.service,
    String(opts.running ?? true),
    `id-${opts.service}`,
    "2026-11-20T00:00:00Z",
    JSON.stringify({ "hack-dev": { IPAddress: opts.ip ?? "" } }),
  ].join("\t");
}

const RECORD: IngressAddressRecord = {
  schema: 1,
  coreDns: "172.30.0.53",
  caddy: "172.30.0.2",
  containers: {
    coredns: { id: "id-coredns", startedAt: "2026-11-20T00:00:00Z" },
    caddy: { id: "id-caddy", startedAt: "2026-11-20T00:00:00Z" },
  },
  recordedAt: "2026-11-20T00:00:01.000Z",
};

function deps(opts: {
  readonly stdout?: string;
  readonly exitCode?: number;
  readonly env?: Record<string, string>;
  readonly installed?: boolean;
  readonly record?: IngressAddressRecord | null;
}): IngressAddressDeps & {
  readonly calls: (readonly string[])[];
  readonly written: IngressAddressRecord[];
} {
  const calls: (readonly string[])[] = [];
  const written: IngressAddressRecord[] = [];
  return {
    calls,
    written,
    env: opts.env ?? {},
    stackInstalled: async () => opts.installed ?? true,
    exec: async (argv) => {
      calls.push(argv);
      return { exitCode: opts.exitCode ?? 0, stdout: opts.stdout ?? "" };
    },
    readRecord: async () => opts.record ?? null,
    writeRecord: async (record) => {
      written.push(record);
    },
    now: () => new Date("2026-11-20T00:00:01.000Z"),
  };
}

const BOTH_RUNNING = [
  line({ service: "coredns", ip: "172.30.0.53" }),
  line({ service: "caddy", ip: "172.30.0.2" }),
  "",
].join("\n");

describe("resolveIngressAddresses", () => {
  test("fresh: one docker inspect of both containers, recorded", async () => {
    // The `_` compatibility names are absent: inspect exits 1.
    const d = deps({ stdout: BOTH_RUNNING, exitCode: 1, record: RECORD });
    expect(await resolveIngressAddresses(d, "fresh")).toEqual({
      coreDns: "172.30.0.53",
      caddy: "172.30.0.2",
      fromRecord: false,
    });
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0]?.slice(0, 4)).toEqual([
      "docker",
      "inspect",
      "--type",
      "container",
    ]);
    expect(d.calls[0]?.slice(-4)).toEqual([
      "hack-dev-proxy-coredns-1",
      "hack-dev-proxy_coredns_1",
      "hack-dev-proxy-caddy-1",
      "hack-dev-proxy_caddy_1",
    ]);
    expect(d.written).toEqual([RECORD]);
  });

  test("recorded: the record answers with no Docker call", async () => {
    const d = deps({ record: RECORD });
    expect(await resolveIngressAddresses(d, "recorded")).toEqual({
      coreDns: "172.30.0.53",
      caddy: "172.30.0.2",
      fromRecord: true,
    });
    expect(d.calls).toHaveLength(0);
  });

  test("recorded with no record reads Docker once and records", async () => {
    const d = deps({ stdout: BOTH_RUNNING });
    const result = await resolveIngressAddresses(d, "recorded");
    expect(result.fromRecord).toBe(false);
    expect(d.calls).toHaveLength(1);
    expect(d.written).toHaveLength(1);
  });

  test("a stopped, foreign or off-network container is no address and is not recorded", async () => {
    const d = deps({
      stdout: [
        line({ service: "coredns", running: false, ip: "172.30.0.53" }),
        line({ project: "other", service: "caddy", ip: "10.0.0.2" }),
        line({ service: "caddy" }),
      ].join("\n"),
    });
    expect(await resolveIngressAddresses(d, "fresh")).toEqual({
      coreDns: null,
      caddy: null,
      fromRecord: false,
    });
    expect(d.written).toHaveLength(0);
  });

  test("env overrides win over the record and Docker", async () => {
    const both = deps({
      env: { HACK_COREDNS_IP: " 10.1.1.53 ", HACK_CADDY_IP: "10.1.1.2" },
      record: RECORD,
    });
    expect(await resolveIngressAddresses(both, "fresh")).toEqual({
      coreDns: "10.1.1.53",
      caddy: "10.1.1.2",
      fromRecord: false,
    });
    expect(both.calls).toHaveLength(0);

    const one = deps({ env: { HACK_CADDY_IP: "10.1.1.2" }, record: RECORD });
    expect(await resolveIngressAddresses(one, "recorded")).toEqual({
      coreDns: "172.30.0.53",
      caddy: "10.1.1.2",
      fromRecord: true,
    });
  });

  test("no global stack means no Docker read", async () => {
    const d = deps({ installed: false, record: RECORD });
    expect(await resolveIngressAddresses(d, "recorded")).toEqual({
      coreDns: null,
      caddy: null,
      fromRecord: false,
    });
    expect(d.calls).toHaveLength(0);
  });
});

describe("parseIngressAddressRecord", () => {
  test("round-trips a record and refuses anything partial", () => {
    expect(
      parseIngressAddressRecord(JSON.parse(JSON.stringify(RECORD)))
    ).toEqual(RECORD);
    expect(parseIngressAddressRecord({ ...RECORD, schema: 2 })).toBeNull();
    expect(parseIngressAddressRecord({ ...RECORD, caddy: "" })).toBeNull();
    expect(
      parseIngressAddressRecord({ ...RECORD, containers: { caddy: {} } })
    ).toBeNull();
  });
});
