import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultIngressAddressDeps,
  type IngressAddressDeps,
  type IngressAddressRecord,
  type IngressGeneration,
  parseIngressAddressRecord,
  readIngressGeneration,
  resolveIngressAddresses,
  selectedDockerEngine,
  withIngressChange,
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
  generation: "g1",
  engine: "context:default",
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
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly env?: Record<string, string>;
  readonly installed?: boolean;
  readonly record?: IngressAddressRecord | null;
  readonly generation?: IngressGeneration;
  readonly engine?: string;
}): IngressAddressDeps & {
  readonly calls: (readonly string[])[];
  readonly written: IngressAddressRecord[];
  readonly forgotten: number[];
} {
  const calls: (readonly string[])[] = [];
  const written: IngressAddressRecord[] = [];
  const forgotten: number[] = [];
  return {
    calls,
    written,
    forgotten,
    env: opts.env ?? {},
    stackInstalled: async () => opts.installed ?? true,
    exec: async (argv) => {
      calls.push(argv);
      return {
        exitCode: opts.exitCode ?? 0,
        stdout: opts.stdout ?? "",
        stderr: opts.stderr ?? "",
      };
    },
    readGeneration: async () =>
      opts.generation ?? { token: "g1", settled: true },
    engine: async () => opts.engine ?? "context:default",
    readRecord: async () => opts.record ?? null,
    writeRecord: async (record) => {
      written.push(record);
    },
    forgetRecord: async () => {
      forgotten.push(1);
    },
    now: () => new Date("2026-11-20T00:00:01.000Z"),
  };
}

const BOTH_RUNNING = [
  line({ service: "coredns", ip: "172.30.0.53" }),
  line({ service: "caddy", ip: "172.30.0.2" }),
  "",
].join("\n");

describe("the record is bound to the selected Docker engine", () => {
  test("a record read from another engine is not trusted: that engine is read and recorded", async () => {
    const d = deps({
      record: RECORD,
      engine: "host:tcp://other:2375",
      stdout: [
        line({ service: "coredns", ip: "10.9.0.53" }),
        line({ service: "caddy", ip: "10.9.0.2" }),
        "",
      ].join("\n"),
    });
    const result = await resolveIngressAddresses(d, "recorded");
    expect(result).toEqual({
      coreDns: "10.9.0.53",
      caddy: "10.9.0.2",
      fromRecord: false,
    });
    expect(d.calls).toHaveLength(1);
    expect(d.written.map((r) => r.engine)).toEqual(["host:tcp://other:2375"]);
  });

  test("the same engine trusts it with no Docker call", async () => {
    const d = deps({ record: RECORD });
    expect((await resolveIngressAddresses(d, "recorded")).fromRecord).toBe(
      true
    );
    expect(d.calls).toEqual([]);
  });

  test("a record written before engines were recorded is no record", () => {
    const { engine: _engine, ...withoutEngine } = RECORD;
    expect(parseIngressAddressRecord(withoutEngine)).toBeNull();
    expect(parseIngressAddressRecord(RECORD)).toEqual(RECORD);
  });

  test("the engine is chosen as docker chooses it, without a Docker call", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hack-docker-config-"));
    try {
      await writeFile(
        join(dir, "config.json"),
        `${JSON.stringify({ currentContext: "colima" })}\n`
      );
      expect(
        await selectedDockerEngine({
          DOCKER_HOST: "unix:///a.sock",
          DOCKER_CONTEXT: "x",
        })
      ).toBe("host:unix:///a.sock");
      expect(
        await selectedDockerEngine({ DOCKER_CONTEXT: "x", DOCKER_CONFIG: dir })
      ).toBe("context:x");
      expect(await selectedDockerEngine({ DOCKER_CONFIG: dir })).toBe(
        "context:colima"
      );
      expect(
        await selectedDockerEngine({ DOCKER_CONFIG: join(dir, "missing") })
      ).toBe("context:default");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

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

  test("a record under another or an unsettled token is not trusted", async () => {
    for (const generation of [
      { token: "g2", settled: true },
      { token: "g1", settled: false },
    ]) {
      const d = deps({ record: RECORD, generation, stdout: BOTH_RUNNING });
      const result = await resolveIngressAddresses(d, "recorded");
      expect(result.fromRecord).toBe(false);
      expect(d.calls).toHaveLength(1);
      expect(d.written[0]?.generation).toBe(generation.token);
    }
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

  test("a read that finds the containers gone forgets the record", async () => {
    const d = deps({
      exitCode: 1,
      stderr: [
        "Error response from daemon: No such container: hack-dev-proxy-coredns-1",
        "Error response from daemon: No such container: hack-dev-proxy-caddy-1",
        "",
      ].join("\n"),
      record: RECORD,
    });
    expect(await resolveIngressAddresses(d, "fresh")).toEqual({
      coreDns: null,
      caddy: null,
      fromRecord: false,
    });
    expect(d.forgotten).toHaveLength(1);
  });

  test("an engine failure keeps the record", async () => {
    const d = deps({
      exitCode: 1,
      stderr:
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\n",
      record: RECORD,
    });
    await resolveIngressAddresses(d, "fresh");
    expect(d.forgotten).toHaveLength(0);
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

describe("generation token (model: tests/models/tla/ingress-address-record)", () => {
  let home = "";
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "hack-ingress-generation-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  /** Real record and token files; Docker answers with `current()`. */
  function realDeps(current: () => string): IngressAddressDeps {
    return {
      ...defaultIngressAddressDeps(home),
      env: {},
      stackInstalled: async () => true,
      exec: async () => ({
        exitCode: 0,
        stdout: [
          line({ service: "coredns", ip: current() }),
          line({ service: "caddy", ip: current() }),
        ].join("\n"),
        stderr: "",
      }),
    };
  }

  test("a change replaces the token, unsettled during it and settled after, even on failure", async () => {
    const before = await readIngressGeneration(home);
    expect(before).toEqual({ token: "", settled: true });
    let during: IngressGeneration | null = null;
    await expect(
      withIngressChange(home, async () => {
        during = await readIngressGeneration(home);
        throw new Error("compose up failed");
      })
    ).rejects.toThrow("compose up failed");
    const after = await readIngressGeneration(home);
    expect(during).toMatchObject({ settled: false });
    expect(after.settled).toBe(true);
    expect(after.token).not.toBe(before.token);
    expect(after.token).not.toBe((during as IngressGeneration | null)?.token);
  });

  test("model witness: a read that overlaps a Hack change is not trusted after it", async () => {
    let address = "172.30.0.2";
    const d = realDeps(() => address);
    // HackBegin, ReadToken, Inspect (old address), HackApply, Write, HackEnd.
    await withIngressChange(home, async () => {
      await resolveIngressAddresses(d, "fresh");
      address = "172.30.0.9";
    });
    const trusted = await resolveIngressAddresses(d, "recorded");
    expect(trusted.fromRecord).toBe(false);
    expect(trusted.caddy).toBe("172.30.0.9");
  });

  test("model witness: a token read before a change cannot be trusted after it", async () => {
    let address = "172.30.0.2";
    const base = realDeps(() => address);
    // ReadToken, then the change runs while this read inspects, then Write.
    const d: IngressAddressDeps = {
      ...base,
      exec: async (argv) => {
        const observed = await base.exec(argv);
        await withIngressChange(home, async () => {
          address = "172.30.0.9";
        });
        return observed;
      },
    };
    await resolveIngressAddresses(d, "fresh");
    const trusted = await resolveIngressAddresses(base, "recorded");
    expect(trusted.fromRecord).toBe(false);
    expect(trusted.caddy).toBe("172.30.0.9");
  });

  test("model control unlocked: overlapping changes run one after another", async () => {
    let address = "172.30.0.2";
    const d = realDeps(() => address);
    const order: string[] = [];
    let releaseA: () => void = () => undefined;
    const aRunning = new Promise<void>((resolve) => {
      const a = withIngressChange(home, async () => {
        order.push("A begin");
        resolve();
        await new Promise<void>((done) => {
          releaseA = done;
        });
        order.push("A end");
      });
      void a;
    });
    await aRunning;
    // B starts while A holds the lock: its effect must wait for A to settle.
    const b = withIngressChange(home, async () => {
      order.push("B begin");
      address = "172.30.0.9";
    });
    await Bun.sleep(100);
    expect(order).toEqual(["A begin"]);
    releaseA();
    await b;
    expect(order).toEqual(["A begin", "A end", "B begin"]);
    // A read now sees B's settled change, never a state between A and B.
    await resolveIngressAddresses(d, "fresh");
    const trusted = await resolveIngressAddresses(d, "recorded");
    expect(trusted.fromRecord).toBe(true);
    expect(trusted.caddy).toBe("172.30.0.9");
  });

  test("a settled read is trusted with no Docker call; an unreadable token trusts nothing", async () => {
    const d = realDeps(() => "172.30.0.2");
    await resolveIngressAddresses(d, "fresh");
    let calls = 0;
    const counting: IngressAddressDeps = {
      ...d,
      exec: async (argv) => {
        calls += 1;
        return await d.exec(argv);
      },
    };
    expect(
      (await resolveIngressAddresses(counting, "recorded")).fromRecord
    ).toBe(true);
    expect(calls).toBe(0);
    await writeFile(join(home, "caddy", "ingress-generation.json"), "{");
    expect(
      (await resolveIngressAddresses(counting, "recorded")).fromRecord
    ).toBe(false);
    expect(calls).toBe(1);
  });
});
