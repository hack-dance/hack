import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type ObservedCheck,
  observeMacHostDns,
} from "../src/commands/global-mac-dns.ts";
import {
  type ObserveDeps,
  observeGlobalStatus,
} from "../src/commands/global-status-observe.ts";
import {
  observeComposeStack,
  observeNetworks,
  observeProxyNetwork,
  strictJsonRecords,
} from "../src/commands/global-status-observe-host.ts";
import { observeGlobalCaddyIp } from "../src/lib/caddy-hosts.ts";
import * as dnsQuery from "../src/lib/dns-query.ts";
import { createLinuxDnsHost } from "../src/lib/linux-dns-host.ts";
import type { LinuxDnsInspection } from "../src/lib/linux-dns-setup.ts";
import * as shell from "../src/lib/shell.ts";
import { isolatedDockerClientEnv } from "./helpers/docker-client.ts";

// `hack global status --json --observe` (HACK-2218, R13): never starts
// anything, and never reports what it could not read as absent or failed.
// The decision logic is tested on both platforms' paths; the real adapters
// with injected failures; and the real CLI with every child process
// recorded and only fake, read-only tools on PATH.

const RUNNING = { exitCode: 0, stdout: "29.0.0\n", stderr: "" };
const DOWN = {
  exitCode: 1,
  stdout: "",
  stderr:
    "Cannot connect to the Docker daemon at unix:///var/run/docker.sock\n",
};
const TIMED_OUT = { exitCode: 124, stdout: "", stderr: "" };

const check = (
  name: string,
  outcome: ObservedCheck["outcome"]
): ObservedCheck => ({ name, outcome, message: "" });

function linuxInspection(
  state: LinuxDnsInspection["state"]
): LinuxDnsInspection {
  return {
    resolver: { kind: "systemd-resolved-stub" },
    state,
    code: state === "configured" ? null : "linux_dns_missing",
    link: null,
    message: state,
    fix: [],
  } as unknown as LinuxDnsInspection;
}

function deps(overrides: Partial<ObserveDeps> = {}): {
  readonly deps: ObserveDeps;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const track =
    <T>(name: string, value: T) =>
    async () => {
      calls.push(name);
      return await Promise.resolve(value);
    };
  const base: ObserveDeps = {
    platform: "linux",
    dockerInstalled: () => true,
    probeDocker: track("docker info", RUNNING),
    readCaddy: track("caddy", { ok: true, error: null, services: [] }),
    readLogging: track("logging", { ok: true, error: null, services: [] }),
    readNetworks: track("networks", {
      ok: true,
      error: null,
      missing: [],
      networks: [],
    }),
    readProxyNetwork: track("proxy", { ok: true, readable: true, issues: [] }),
    caddyIp: track("caddy ip", "172.30.0.2"),
    inspectLinuxDns: track("linux dns", {
      inspection: linuxInspection("configured"),
      unreadable: [],
    }),
    observeMacDns: async (opts) => {
      calls.push("mac dns");
      await opts.caddyIp();
      return opts.domains.map((domain) => check(`resolver:${domain}`, "ok"));
    },
    now: () => new Date("2026-11-14T00:00:00.000Z"),
  };
  return { deps: { ...base, ...overrides }, calls };
}

test("Docker that does not answer is never asked again, and its parts are unknown", async () => {
  for (const probe of [
    { result: DOWN, state: "not_running", docker_ok: false },
    { result: TIMED_OUT, state: "unknown", docker_ok: "unknown" },
  ] as const) {
    const { deps: d, calls } = deps({
      probeDocker: async () => await Promise.resolve(probe.result),
    });
    const status = await observeGlobalStatus(d);
    expect(status.docker.state).toBe(probe.state);
    for (const part of [
      "caddy",
      "logging",
      "networks",
      "proxy_network",
    ] as const) {
      expect(status[part].ok).toBe("unknown");
    }
    expect(status.summary).toMatchObject({
      docker_ok: probe.docker_ok,
      caddy_ok: "unknown",
      host_dns_ok: true,
    });
    expect(status.summary.ok).toBe(
      probe.docker_ok === false ? false : "unknown"
    );
    expect(calls).toEqual(["linux dns"]);
  }
});

test("no docker on PATH: nothing is probed, and the Docker parts are unknown", async () => {
  const { deps: d, calls } = deps({ dockerInstalled: () => false });
  const status = await observeGlobalStatus(d);
  expect(status.docker.state).toBe("not_installed");
  expect(status.summary.docker_ok).toBe(false);
  expect(status.caddy.ok).toBe("unknown");
  expect(calls).toEqual(["linux dns"]);
});

test("with Docker running, an adapter's unknown passes through and a thrown read is unknown", async () => {
  const { deps: d } = deps({
    readLogging: async () => {
      throw new Error("synthetic read failure");
    },
    readProxyNetwork: async () =>
      await Promise.resolve({ ok: "unknown", readable: false, issues: [] }),
  });
  const status = await observeGlobalStatus(d);
  expect(status.summary).toEqual({
    docker_ok: true,
    caddy_ok: true,
    logging_ok: "unknown",
    networks_ok: true,
    proxy_network_ok: "unknown",
    host_dns_ok: true,
    ok: "unknown",
  });
});

test("Linux host DNS: configured is yes; manual or a failed read is unknown; a confirmed gap is no", async () => {
  for (const [state, unreadable, expected] of [
    ["configured", [], true],
    ["configured", ["resolvectl -- br0"], true],
    ["manual", [], "unknown"],
    ["not_applied", ["resolvectl -- br0"], "unknown"],
    ["missing", ["read /etc/systemd/system/hack-dns@.service"], "unknown"],
    ["missing", [], false],
    ["bridge_missing", [], false],
    ["not_applied", [], false],
  ] as const) {
    const { deps: d } = deps({
      inspectLinuxDns: async () =>
        await Promise.resolve({
          inspection: linuxInspection(state),
          unreadable,
        }),
    });
    const status = await observeGlobalStatus(d);
    expect({ state, unreadable, ok: status.summary.host_dns_ok }).toEqual({
      state,
      unreadable,
      ok: expected,
    });
  }
  const { deps: failing } = deps({
    inspectLinuxDns: async () => {
      throw new Error("synthetic");
    },
  });
  expect((await observeGlobalStatus(failing)).summary.host_dns_ok).toBe(
    "unknown"
  );
});

test("macOS host DNS: any missing check is no; otherwise any unknown is unknown; Caddy's address is asked of Docker only when it runs", async () => {
  const outcomes = async (list: readonly ObservedCheck["outcome"][]) =>
    (
      await observeGlobalStatus(
        deps({
          platform: "darwin",
          observeMacDns: async () =>
            await Promise.resolve(list.map((o, i) => check(`c${i}`, o))),
        }).deps
      )
    ).host_dns;
  expect(await outcomes(["ok", "ok"])).toMatchObject({
    state: "configured",
    ok: true,
  });
  expect(await outcomes(["ok", "missing", "unknown"])).toMatchObject({
    state: "not_configured",
    ok: false,
  });
  expect(await outcomes(["ok", "unknown"])).toMatchObject({
    state: "unknown",
    ok: "unknown",
  });

  const seen: (string | null | "unknown")[] = [];
  const probe = (result: typeof RUNNING) =>
    deps({
      platform: "darwin",
      probeDocker: async () => await Promise.resolve(result),
      observeMacDns: async (opts) => {
        seen.push(await opts.caddyIp());
        return [];
      },
    });
  const down = probe(DOWN);
  await observeGlobalStatus(down.deps);
  expect(down.calls).not.toContain("caddy ip");
  const up = probe(RUNNING);
  await observeGlobalStatus(up.deps);
  expect(up.calls).toContain("caddy ip");
  expect(seen).toEqual(["unknown", "172.30.0.2"]);
});

test("other platforms report host DNS as unknown", async () => {
  const status = await observeGlobalStatus(deps({ platform: "win32" }).deps);
  expect(status.host_dns).toMatchObject({ state: "unknown", ok: "unknown" });
});

// --- The real adapters, with failures injected at their own boundaries -------

function fakeExec(
  answer: (cmd: readonly string[]) => { exitCode: number; stdout: string }
) {
  return spyOn(shell, "exec").mockImplementation((async (
    cmd: readonly string[]
  ) => {
    const result = answer(cmd);
    return await Promise.resolve({ ...result, stderr: "" });
  }) as typeof shell.exec);
}

test("compose stack adapter: missing file is no; unreadable file, failed or timed-out read are unknown; a read decides", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hack-observe-compose-"));
  try {
    const file = join(dir, "docker-compose.yml");
    expect((await observeComposeStack({ composeFile: file })).ok).toBe(false);
    // A directory where the file should be: exists, but cannot be read.
    await mkdir(file);
    expect((await observeComposeStack({ composeFile: file })).ok).toBe(
      "unknown"
    );
    await rm(file, { recursive: true });
    await writeFile(file, "services: {}\n");
    for (const [result, expected] of [
      [{ exitCode: 124, stdout: "" }, "unknown"],
      [{ exitCode: 1, stdout: "" }, "unknown"],
      [{ exitCode: 0, stdout: "" }, false],
      [
        {
          exitCode: 0,
          stdout: '{"Service":"caddy","Name":"c","Status":"Up 2 hours"}\n',
        },
        true,
      ],
      [
        {
          exitCode: 0,
          stdout: '{"Service":"caddy","Name":"c","Status":"Exited (1)"}\n',
        },
        false,
      ],
    ] as const) {
      const spy = fakeExec(() => result);
      try {
        expect((await observeComposeStack({ composeFile: file })).ok).toBe(
          expected
        );
        expect(spy.mock.calls[0]?.[1]?.timeoutMs).toBeGreaterThan(0);
      } finally {
        spy.mockRestore();
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("networks and proxy adapters keep a failed read unknown", async () => {
  const names = ["hack-dev", "hack-logging"];
  for (const [result, expected] of [
    [{ exitCode: 124, stdout: "" }, "unknown"],
    [{ exitCode: 1, stdout: "" }, "unknown"],
    [{ exitCode: 0, stdout: '{"Name":"hack-dev"}\n' }, false],
    [
      { exitCode: 0, stdout: '{"Name":"hack-dev"}\n{"Name":"hack-logging"}\n' },
      true,
    ],
  ] as const) {
    const spy = fakeExec(() => result);
    try {
      const observed = await observeNetworks({ names });
      expect(observed.ok).toBe(expected);
      if (expected === "unknown") {
        expect(observed.missing).toEqual([]);
      }
      expect(spy.mock.calls[0]?.[1]?.timeoutMs).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  }
  const dir = await mkdtemp(join(tmpdir(), "hack-observe-proxy-"));
  try {
    const file = join(dir, "docker-compose.yml");
    expect((await observeProxyNetwork({ composeFile: file })).ok).toBe(false);
    await writeFile(file, "services: {}\n");
    const spy = fakeExec(() => ({ exitCode: 124, stdout: "" }));
    try {
      expect((await observeProxyNetwork({ composeFile: file })).ok).toBe(
        "unknown"
      );
    } finally {
      spy.mockRestore();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Caddy address adapter: no container is null; a failed read is unknown; both reads are bounded", async () => {
  for (const [answers, expected] of [
    [[{ exitCode: 124, stdout: "" }], "unknown"],
    [[{ exitCode: 0, stdout: "" }], null],
    [
      [
        { exitCode: 0, stdout: "abc123\n" },
        { exitCode: 1, stdout: "" },
      ],
      "unknown",
    ],
    [
      [
        { exitCode: 0, stdout: "abc123\n" },
        { exitCode: 0, stdout: '{"hack-dev":{"IPAddress":"172.30.0.9"}}' },
      ],
      "172.30.0.9",
    ],
  ] as const) {
    let index = 0;
    const spy = fakeExec(() => answers[index++] ?? { exitCode: 1, stdout: "" });
    try {
      expect(await observeGlobalCaddyIp({ timeoutMs: 1000 })).toBe(expected);
      for (const call of spy.mock.calls) {
        expect(call[1]?.timeoutMs).toBe(1000);
      }
    } finally {
      spy.mockRestore();
    }
  }
});

test("Linux host adapter names every read that failed, and only those", async () => {
  const unreadable: string[] = [];
  const host = createLinuxDnsHost({
    onUnreadable: (what) => unreadable.push(what),
  });
  const spy = fakeExec((cmd) =>
    cmd[0] === "systemctl" && cmd[1] === "--version"
      ? { exitCode: 0, stdout: "systemd 255 (255.4)\n" }
      : { exitCode: 124, stdout: "" }
  );
  try {
    expect(await host.readLinkRoute("br-fixture")).toBeNull();
    expect(
      await host.unitNeedsReload("hack-dns@br-fixture.service")
    ).toBeNull();
    expect(await host.findLinkWithAddress("172.30.0.1")).toBeNull();
    expect(await host.systemdVersion()).toBe(255);
  } finally {
    spy.mockRestore();
  }
  // A file that is missing is absent; one that cannot be read is named.
  const dir = await mkdtemp(join(tmpdir(), "hack-observe-linux-"));
  try {
    expect(await host.readFile(join(dir, "absent"))).toBeNull();
    await mkdir(join(dir, "a-directory"));
    expect(await host.readFile(join(dir, "a-directory"))).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  expect(unreadable).toEqual([
    "resolvectl dns -- br-fixture",
    "resolvectl domain -- br-fixture",
    "resolvectl default-route -- br-fixture",
    "resolvectl dnssec -- br-fixture",
    "resolvectl dnsovertls -- br-fixture",
    "systemctl show -p NeedDaemonReload -- hack-dns@br-fixture.service",
    "ip -j -4 addr show",
    `read ${join(dir, "a-directory")}`,
  ]);
  // Without the hook nothing changes for hack doctor.
  const plain = createLinuxDnsHost();
  expect(await plain.readFile(join(dir, "absent"))).toBeNull();
});

test("Linux host adapter flags each per-link query that fails, alone, and not a confirmed mismatch", async () => {
  const answers: Record<string, string> = {
    dns: "Link 7 (br-fixture): 172.30.0.2\n",
    domain: "Link 7 (br-fixture): ~hack\n",
    "default-route": "Link 7 (br-fixture): no\n",
    dnssec: "Link 7 (br-fixture): no\n",
    dnsovertls: "Link 7 (br-fixture): no\n",
  };
  const read = async (fail: string | null, empty: string | null = null) => {
    const unreadable: string[] = [];
    const host = createLinuxDnsHost({
      onUnreadable: (what) => unreadable.push(what),
    });
    const spy = fakeExec((cmd) => {
      const verb = cmd[1] ?? "";
      if (verb === fail) {
        return { exitCode: 124, stdout: "" };
      }
      if (verb === empty) {
        return { exitCode: 0, stdout: "Link 7 (br-fixture):\n" };
      }
      return { exitCode: 0, stdout: answers[verb] ?? "" };
    });
    try {
      const route = await host.readLinkRoute("br-fixture");
      return { route, unreadable };
    } finally {
      spy.mockRestore();
    }
  };
  const control = await read(null);
  expect(control.unreadable).toEqual([]);
  expect(control.route).toMatchObject({
    dns: ["172.30.0.2"],
    defaultRoute: false,
  });
  for (const verb of [
    "dns",
    "domain",
    "default-route",
    "dnssec",
    "dnsovertls",
  ]) {
    expect((await read(verb)).unreadable).toEqual([
      `resolvectl ${verb} -- br-fixture`,
    ]);
  }
  // A single-value setting that answers nothing could not be read either.
  expect((await read(null, "dnssec")).unreadable).toEqual([
    "resolvectl dnssec -- br-fixture",
  ]);
  // Empty dns or domain lists are answers, not failures.
  expect((await read(null, "domain")).unreadable).toEqual([]);
  // Every query answered, with values that differ from Hack's route: a
  // confirmed mismatch, nothing unreadable.
  answers.dns = "Link 7 (br-fixture): 9.9.9.9\n";
  expect((await read(null)).unreadable).toEqual([]);
});

test("Docker output is read strictly: empty is empty, anything malformed is unreadable", () => {
  expect(strictJsonRecords("")).toEqual([]);
  expect(strictJsonRecords('{"a":1}\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  expect(strictJsonRecords('[{"a":1},{"b":2}]')).toEqual([{ a: 1 }, { b: 2 }]);
  for (const text of [
    "not JSON",
    "null",
    "[1,2]",
    '{"a":1}\nnot JSON',
    '{"a":1}\n[]',
  ]) {
    expect({ text, records: strictJsonRecords(text) }).toEqual({
      text,
      records: null,
    });
  }
});

test("compose, networks and proxy adapters never take malformed or partial output as an answer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hack-observe-malformed-"));
  try {
    const file = join(dir, "docker-compose.yml");
    await writeFile(file, "services: {}\n");
    const running = '{"Service":"caddy","Name":"c","Status":"Up 2 hours"}';
    for (const stdout of [
      "not JSON",
      "null",
      `${running}\nnot JSON`,
      '{"Name":"c","Status":"Up"}',
    ]) {
      const spy = fakeExec(() => ({ exitCode: 0, stdout }));
      try {
        expect({
          stdout,
          ok: (await observeComposeStack({ composeFile: file })).ok,
        }).toEqual({ stdout, ok: "unknown" });
      } finally {
        spy.mockRestore();
      }
    }
    for (const stdout of [
      "not JSON",
      '{"Name":"hack-dev"}\nnot JSON',
      '{"ID":"x"}',
    ]) {
      const spy = fakeExec(() => ({ exitCode: 0, stdout }));
      try {
        const observed = await observeNetworks({ names: ["hack-dev"] });
        expect({ stdout, ok: observed.ok, missing: observed.missing }).toEqual({
          stdout,
          ok: "unknown",
          missing: [],
        });
      } finally {
        spy.mockRestore();
      }
    }
    // Proxy: malformed ps, a row without an id, or an inspect answer that is
    // not one object per id.
    for (const answers of [
      [{ exitCode: 0, stdout: "not JSON" }],
      [{ exitCode: 0, stdout: '{"Service":"caddy"}' }],
      [
        { exitCode: 0, stdout: '{"ID":"abc123"}' },
        { exitCode: 0, stdout: "not JSON" },
      ],
      [
        { exitCode: 0, stdout: '{"ID":"abc123"}\n{"ID":"def456"}' },
        { exitCode: 0, stdout: "[{}]" },
      ],
    ]) {
      let index = 0;
      const spy = fakeExec(
        () => answers[index++] ?? { exitCode: 1, stdout: "" }
      );
      try {
        expect((await observeProxyNetwork({ composeFile: file })).ok).toBe(
          "unknown"
        );
      } finally {
        spy.mockRestore();
      }
    }
    // A stack with no containers is a confirmed, readable answer.
    const empty = fakeExec(() => ({ exitCode: 0, stdout: "" }));
    try {
      expect(await observeProxyNetwork({ composeFile: file })).toMatchObject({
        ok: true,
        readable: true,
      });
    } finally {
      empty.mockRestore();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("macOS DNS adapter: missing files are missing; unreadable files, no Homebrew prefix or no Caddy answer are unknown", async () => {
  const files = new Map<string, string | NodeJS.ErrnoException>();
  const errno = (code: string) => Object.assign(new Error(code), { code });
  const readSpy = spyOn(fsPromises, "readFile").mockImplementation((async (
    path: unknown
  ) => {
    const value = files.get(String(path)) ?? errno("ENOENT");
    if (typeof value === "string") {
      return value;
    }
    throw value;
  }) as typeof fsPromises.readFile);
  const whichSpy = spyOn(shell, "findExecutableInPath").mockImplementation(
    (name: string) => (name === "brew" ? "/fake/brew" : null)
  );
  let brewAnswer = { exitCode: 0, stdout: "/fake-prefix\n" };
  const execSpy = fakeExec(() => brewAnswer);
  const dnsSpy = spyOn(dnsQuery, "queryDnsARecord").mockImplementation(
    async () => await Promise.resolve("127.0.0.1")
  );
  const run = async (caddyIp: string | null | "unknown" = null) =>
    Object.fromEntries(
      (
        await observeMacHostDns({
          domains: ["hack"],
          caddyIp: async () => await Promise.resolve(caddyIp),
        })
      ).map((c) => [c.name, c.outcome])
    );
  try {
    expect(await run()).toEqual({
      "resolver:hack": "missing",
      "dnsmasq.conf:hack": "missing",
      "dnsmasq:53": "ok",
    });
    files.set("/etc/resolver/hack", errno("EACCES"));
    files.set("/fake-prefix/etc/dnsmasq.conf", errno("EIO"));
    expect(await run()).toMatchObject({
      "resolver:hack": "unknown",
      "dnsmasq.conf:hack": "unknown",
    });
    files.set("/etc/resolver/hack", "nameserver 127.0.0.1\n");
    files.set("/fake-prefix/etc/dnsmasq.conf", "address=/.hack/172.30.0.9\n");
    // A line for another address: only Caddy's current address can tell.
    expect((await run("unknown"))["dnsmasq.conf:hack"]).toBe("unknown");
    expect((await run("172.30.0.9"))["dnsmasq.conf:hack"]).toBe("ok");
    expect((await run("172.30.0.5"))["dnsmasq.conf:hack"]).toBe("missing");
    expect((await run())["resolver:hack"]).toBe("ok");
    // brew --prefix fails or times out: dnsmasq.conf cannot be located.
    brewAnswer = { exitCode: 124, stdout: "" };
    expect((await run("172.30.0.9"))["dnsmasq.conf:hack"]).toBe("unknown");
    expect(execSpy.mock.calls.at(-1)?.[1]?.timeoutMs).toBeGreaterThan(0);
  } finally {
    readSpy.mockRestore();
    whichSpy.mockRestore();
    execSpy.mockRestore();
    dnsSpy.mockRestore();
  }
});

// --- The real CLI, with every child process recorded ------------------------

const REPO_ROOT = resolve(import.meta.dir, "..");
const ENTRYPOINT = resolve(REPO_ROOT, "index.ts");
const RECORDER = resolve(import.meta.dir, "fixtures/spawn-argv-recorder.ts");
const RUN_DEADLINE_MS = 10_000;
const CLI_TEST_TIMEOUT_MS = 30_000;

/**
 * Every program the observe mode may run, as complete argv shapes: fixed
 * words exactly, and only the listed variable positions (a file, a link, a
 * unit, container ids). Anything else, a mutating verb or an extra argument
 * included, and above all a starter (`open -a Docker`, `colima start`,
 * `sudo systemctl start docker`), fails the test.
 */
const ID = /^[0-9a-f]{6,64}$/;
const LINK = /^[A-Za-z0-9_.@-]+$/;
const RESOLVECTL_QUERIES = new Set([
  "dns",
  "domain",
  "default-route",
  "dnssec",
  "dnsovertls",
]);

function same(
  words: readonly string[],
  shape: readonly (string | ((word: string) => boolean))[]
): boolean {
  return (
    words.length === shape.length &&
    shape.every((part, index) => {
      const word = words[index] ?? "";
      return typeof part === "string" ? word === part : part(word);
    })
  );
}

function allowed(argv: readonly string[]): boolean {
  const [program, ...rest] = argv;
  const name = (program ?? "").split("/").at(-1) ?? "";
  const words = [name, ...rest];
  const composeFile = (word: string) => word.endsWith("/docker-compose.yml");
  return (
    same(words, ["docker", "info", "--format", "{{.ServerVersion}}"]) ||
    same(words, [
      "docker",
      "compose",
      "-f",
      composeFile,
      "ps",
      "--format",
      "json",
    ]) ||
    same(words, ["docker", "network", "ls", "--format", "json"]) ||
    same(words, [
      "docker",
      "ps",
      "-q",
      "--filter",
      "label=com.docker.compose.project=hack-dev-proxy",
      "--filter",
      "label=com.docker.compose.service=caddy",
    ]) ||
    same(words, [
      "docker",
      "inspect",
      "--format",
      "{{json .NetworkSettings.Networks}}",
      (word) => ID.test(word),
    ]) ||
    (words.length > 2 &&
      words[0] === "docker" &&
      words[1] === "inspect" &&
      words.slice(2).every((word) => ID.test(word))) ||
    same(words, ["systemctl", "is-active", "systemd-resolved"]) ||
    same(words, ["systemctl", "--version"]) ||
    same(words, [
      "systemctl",
      "show",
      "-p",
      "NeedDaemonReload",
      "--",
      (word) => /^hack-dns@[A-Za-z0-9_.-]+\.service$/.test(word),
    ]) ||
    same(words, ["ip", "-j", "-4", "addr", "show"]) ||
    same(words, [
      "resolvectl",
      (word) => RESOLVECTL_QUERIES.has(word),
      "--",
      (word) => LINK.test(word),
    ]) ||
    same(words, ["brew", "--prefix"])
  );
}

test("the allow list takes only the read shapes, never a mutating verb or extra argument", () => {
  for (const argv of [
    ["resolvectl", "dns", "--", "br-fixture", "1.1.1.1"],
    ["resolvectl", "revert", "br-fixture"],
    ["resolvectl", "flush-caches"],
    ["resolvectl", "domain", "--", "br-fixture", "~hack"],
    [
      "docker",
      "compose",
      "-f",
      "/x/docker-compose.yml",
      "ps",
      "--format",
      "xml",
    ],
    ["docker", "compose", "-f", "/x/docker-compose.yml", "up", "-d"],
    [
      "docker",
      "compose",
      "-f",
      "/x/docker-compose.yml",
      "--profile",
      "x",
      "ps",
      "--format",
      "json",
    ],
    ["systemctl", "show", "-p", "NeedDaemonReload", "--", "docker.service"],
    ["systemctl", "start", "docker"],
    ["sudo", "systemctl", "start", "docker"],
    ["open", "-a", "Docker"],
    ["colima", "start"],
    ["docker", "start", "abc123"],
    ["docker", "network", "create", "hack-dev"],
    ["brew", "services", "start", "dnsmasq"],
  ]) {
    expect({ argv, allowed: allowed(argv) }).toEqual({ argv, allowed: false });
  }
  for (const argv of [
    ["/usr/bin/docker", "info", "--format", "{{.ServerVersion}}"],
    [
      "docker",
      "compose",
      "-f",
      "/h/.hack/caddy/docker-compose.yml",
      "ps",
      "--format",
      "json",
    ],
    ["resolvectl", "dnsovertls", "--", "br-0a1b2c"],
    [
      "systemctl",
      "show",
      "-p",
      "NeedDaemonReload",
      "--",
      "hack-dns@br-0a1b2c.service",
    ],
    ["docker", "inspect", "abc123def456"],
  ]) {
    expect({ argv, allowed: allowed(argv) }).toEqual({ argv, allowed: true });
  }
});

let root: string | null = null;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-global-observe-"));
  await mkdir(join(root, "home"), { recursive: true });
  await mkdir(join(root, "bin"), { recursive: true });
});

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = null;
  }
});

/** Fake read-only tools; `docker` answers as a running or stopped engine. */
async function installFakeTools(base: string, docker: "up" | "down") {
  const script = (body: string) => `#!/bin/sh\n${body}\n`;
  const tools: Record<string, string> = {
    docker:
      docker === "down"
        ? script(
            'echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" >&2\nexit 1'
          )
        : script(
            [
              'case "$1" in',
              '  info) echo "29.0.0" ;;',
              '  network) printf \'%s\\n\' \'{"Name":"hack-dev","ID":"a","Driver":"bridge","Scope":"local"}\' \'{"Name":"hack-logging","ID":"b","Driver":"bridge","Scope":"local"}\' ;;',
              "  *) : ;;",
              "esac",
              "exit 0",
            ].join("\n")
          ),
    systemctl: script("exit 1"),
    ip: script("exit 1"),
    resolvectl: script("exit 1"),
    brew: script("exit 1"),
    // What a starter would run; present so a regression is recorded rather
    // than skipped (each fails, so nothing could ever start).
    sudo: script("exit 1"),
    open: script("exit 1"),
    colima: script("exit 1"),
    orb: script("exit 1"),
    orbctl: script("exit 1"),
  };
  for (const [name, body] of Object.entries(tools)) {
    const path = join(base, "bin", name);
    await writeFile(path, body);
    await chmod(path, 0o755);
  }
}

async function runObserve(base: string): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly spawned: readonly (readonly string[])[];
}> {
  const home = join(base, "home");
  const spawnLog = join(base, "spawn.jsonl");
  const proc = Bun.spawn(
    [
      process.execPath,
      "--preload",
      RECORDER,
      ENTRYPOINT,
      "global",
      "status",
      "--json",
      "--observe",
    ],
    {
      cwd: home,
      env: {
        PATH: join(base, "bin"),
        ...isolatedDockerClientEnv(home),
        HOME: home,
        HACK_HOME: join(home, ".hack"),
        TMPDIR: home,
        HACK_GLOBAL_CONFIG_PATH: join(home, ".hack", "hack.config.json"),
        HACK_LOGGER: "console",
        HACK_TEST_SPAWN_ARGV_LOG: spawnLog,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  // An observe read answers quickly; one that waits (for a runtime it
  // started, say) is stopped here so the test reports what it spawned.
  const deadline = setTimeout(() => proc.kill("SIGKILL"), RUN_DEADLINE_MS);
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]).finally(() => clearTimeout(deadline));
  const log = await readFile(spawnLog, "utf8").catch(() => "");
  const spawned = log
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => (JSON.parse(line) as { argv: string[] }).argv);
  return { exitCode, stdout, spawned };
}

function requireRoot(): string {
  if (!root) {
    throw new Error("Missing temp root");
  }
  return root;
}

test(
  "the CLI with Docker stopped runs only the Docker probe and read-only host probes",
  async () => {
    const base = requireRoot();
    await installFakeTools(base, "down");
    const result = await runObserve(base);
    // Nothing outside the listed read-only probes, checked first.
    expect(result.spawned.filter((argv) => !allowed(argv))).toEqual([]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      readonly docker: { readonly state: string };
      readonly summary: Record<string, unknown>;
    };
    expect(payload.docker.state).toBe("not_running");
    expect(payload.summary.caddy_ok).toBe("unknown");
    expect(result.spawned.length).toBeGreaterThan(0);
    expect(result.spawned.filter((argv) => !allowed(argv))).toEqual([]);
    // Docker was asked exactly once, and only `info`.
    const dockerCalls = result.spawned.filter(
      (argv) => (argv[0] ?? "").split("/").at(-1) === "docker"
    );
    expect(dockerCalls).toEqual([
      ["docker", "info", "--format", "{{.ServerVersion}}"],
    ]);
  },
  CLI_TEST_TIMEOUT_MS
);

test(
  "the CLI with Docker running and the stack installed still runs only listed read-only probes",
  async () => {
    const base = requireRoot();
    await installFakeTools(base, "up");
    const hackHome = join(base, "home", ".hack");
    for (const stack of ["caddy", "logging"]) {
      await mkdir(join(hackHome, stack), { recursive: true });
      await writeFile(
        join(hackHome, stack, "docker-compose.yml"),
        "services: {}\n"
      );
    }
    const result = await runObserve(base);
    // Nothing outside the listed read-only probes, checked first.
    expect(result.spawned.filter((argv) => !allowed(argv))).toEqual([]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      readonly docker: { readonly state: string };
      readonly networks: { readonly ok: unknown };
    };
    expect(payload.docker.state).toBe("running");
    expect(payload.networks.ok).toBe(true);
    expect(result.spawned.filter((argv) => !allowed(argv))).toEqual([]);
    expect(
      result.spawned.some(
        (argv) => argv[1] === "compose" && argv.includes("ps")
      )
    ).toBe(true);
  },
  CLI_TEST_TIMEOUT_MS
);

test("without --json, --observe refuses instead of printing a starter-capable view", async () => {
  const base = requireRoot();
  await installFakeTools(base, "down");
  const home = join(base, "home");
  const proc = Bun.spawn(
    [process.execPath, ENTRYPOINT, "global", "status", "--observe"],
    {
      cwd: home,
      env: {
        PATH: join(base, "bin"),
        HOME: home,
        HACK_HOME: join(home, ".hack"),
        TMPDIR: home,
        HACK_LOGGER: "console",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  expect(await proc.exited).toBe(2);
});
