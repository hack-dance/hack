import { describe, expect, test } from "bun:test";
import {
  type IngressAddressDeps,
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
    JSON.stringify({ "hack-dev": { IPAddress: opts.ip ?? "" } }),
  ].join("\t");
}

function deps(opts: {
  readonly stdout?: string;
  readonly exitCode?: number;
  readonly env?: Record<string, string>;
  readonly installed?: boolean;
}): IngressAddressDeps & { readonly calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = [];
  return {
    calls,
    env: opts.env ?? {},
    stackInstalled: async () => opts.installed ?? true,
    exec: async (argv) => {
      calls.push(argv);
      return { exitCode: opts.exitCode ?? 0, stdout: opts.stdout ?? "" };
    },
  };
}

describe("resolveIngressAddresses", () => {
  test("reads both addresses with one docker inspect", async () => {
    const d = deps({
      stdout: [
        line({ service: "coredns", ip: "172.30.0.53" }),
        line({ service: "caddy", ip: "172.30.0.2" }),
        "",
      ].join("\n"),
      // The `_` compatibility names are absent: inspect exits 1.
      exitCode: 1,
    });
    expect(await resolveIngressAddresses(d)).toEqual({
      coreDns: "172.30.0.53",
      caddy: "172.30.0.2",
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
  });

  test("a stopped, foreign or off-network container is no address", async () => {
    const d = deps({
      stdout: [
        line({ service: "coredns", running: false, ip: "172.30.0.53" }),
        line({ project: "other", service: "caddy", ip: "10.0.0.2" }),
        line({ service: "caddy" }),
      ].join("\n"),
    });
    expect(await resolveIngressAddresses(d)).toEqual({
      coreDns: null,
      caddy: null,
    });
  });

  test("env overrides skip Docker for the addresses they give", async () => {
    const both = deps({
      env: { HACK_COREDNS_IP: " 10.1.1.53 ", HACK_CADDY_IP: "10.1.1.2" },
    });
    expect(await resolveIngressAddresses(both)).toEqual({
      coreDns: "10.1.1.53",
      caddy: "10.1.1.2",
    });
    expect(both.calls).toHaveLength(0);

    const one = deps({
      env: { HACK_CADDY_IP: "10.1.1.2" },
      stdout: line({ service: "coredns", ip: "172.30.0.53" }),
    });
    expect(await resolveIngressAddresses(one)).toEqual({
      coreDns: "172.30.0.53",
      caddy: "10.1.1.2",
    });
    expect(one.calls[0]?.slice(-2)).toEqual([
      "hack-dev-proxy-coredns-1",
      "hack-dev-proxy_coredns_1",
    ]);
  });

  test("no global stack means no Docker read", async () => {
    const d = deps({ installed: false });
    expect(await resolveIngressAddresses(d)).toEqual({
      coreDns: null,
      caddy: null,
    });
    expect(d.calls).toHaveLength(0);
  });
});
