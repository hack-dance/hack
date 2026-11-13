import { expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";

import { inspectCaddyCaIdentity } from "../src/lib/caddy-ca-identity.ts";
import { inspectProxyLoopback } from "../src/lib/proxy-loopback.ts";
import {
  EXEC_STDOUT_OVERFLOW_EXIT,
  type ExecOptions,
  type ExecResult,
} from "../src/lib/shell.ts";
import { CURRENT_CA_PEM, OLD_CA_PEM } from "./helpers/ca-certificates.ts";
import { asExecStdout, paxRecords, tarArchive } from "./helpers/tar.ts";

const ID = "a".repeat(64);
const certificate = new X509Certificate(CURRENT_CA_PEM);
const now = Date.parse(certificate.validFrom) + 1000;
const secretError = "untrusted raw stderr must never appear";

type CopyKind =
  | "symlink"
  | "directory"
  | "missing"
  | "two-files"
  | "wrong-name"
  | "bad-checksum"
  | "trailing-data"
  | "truncated"
  | "pax-path";

function copiedArchive(opts: {
  readonly runtime: string;
  readonly copyKind?: CopyKind;
}): Uint8Array | null {
  const file = { name: "root.crt", content: opts.runtime };
  switch (opts.copyKind) {
    case "missing":
      return null;
    case "symlink":
      return tarArchive([
        { name: "root.crt", type: "2", linkName: "/unowned/root.crt" },
      ]);
    case "directory":
      return tarArchive([{ name: "root.crt", type: "5" }]);
    case "two-files":
      return tarArchive([file, { name: "root.crt", content: OLD_CA_PEM }]);
    case "wrong-name":
      return tarArchive([{ name: "intermediate.crt", content: opts.runtime }]);
    case "bad-checksum":
      return tarArchive([{ ...file, badChecksum: true }]);
    case "trailing-data":
      return tarArchive([file], {
        trailer: Buffer.concat([new Uint8Array(1024), Buffer.from("x")]),
      });
    case "truncated":
      return tarArchive([file]).subarray(0, 700);
    case "pax-path":
      return tarArchive([
        {
          name: "PaxHeaders/root.crt",
          type: "x",
          content: paxRecords({ path: "root.crt", mtime: "1.5" }),
        },
        { name: "ignored-short-name", content: opts.runtime },
      ]);
    default:
      return tarArchive([file]);
  }
}

function fixture(
  opts: {
    readonly exported?: string | null;
    readonly runtime?: string;
    readonly copyKind?: CopyKind;
    readonly selected?: string;
    readonly metadata?: unknown;
    readonly inspectOutput?: string;
    readonly readFails?: boolean;
    readonly failureAt?: number;
    readonly throwAt?: number;
    readonly now?: number;
    readonly timeoutMs?: number;
    readonly ports?: unknown;
    readonly requestedPorts?: unknown;
  } = {}
) {
  const calls: {
    readonly cmd: readonly string[];
    readonly options?: ExecOptions;
  }[] = [];
  let reads = 0;
  const run = () =>
    inspectCaddyCaIdentity({
      certPath: "/owned/export/root.crt",
      now: opts.now ?? now,
      timeoutMs: opts.timeoutMs,
      readTextFile: async (path) => {
        // The runtime root is never read back from a path.
        expect(path).toBe("/owned/export/root.crt");
        reads += 1;
        if (opts.readFails) {
          throw new Error(secretError);
        }
        return opts.exported === undefined ? CURRENT_CA_PEM : opts.exported;
      },
      exec: async (cmd, options): Promise<ExecResult> => {
        calls.push({ cmd, options });
        if (calls.length === opts.throwAt) {
          throw new Error(secretError);
        }
        if (calls.length === opts.failureAt) {
          return { exitCode: 124, stdout: "", stderr: secretError };
        }
        if (cmd[1] === "cp") {
          // Mirror `exec`: archives stream to stdout ("-") under the budget.
          expect(cmd[3]).toBe("-");
          const archive = copiedArchive({
            runtime: opts.runtime ?? CURRENT_CA_PEM,
            copyKind: opts.copyKind,
          });
          if (archive === null) {
            return { exitCode: 1, stdout: "", stderr: secretError };
          }
          const limit = options?.maxStdoutBytes;
          if (limit === undefined) {
            throw new Error("docker cp must be bounded");
          }
          return archive.length > limit
            ? { exitCode: EXEC_STDOUT_OVERFLOW_EXIT, stdout: "", stderr: "" }
            : { exitCode: 0, stdout: asExecStdout(archive), stderr: "" };
        }
        // Docker projects the selected field, rather than returning both
        // runtime and requested bindings regardless of the inspect template.
        const format = cmd[cmd.indexOf("--format") + 1] ?? "";
        const portFields: Record<string, unknown> = {};
        for (const [, field, source] of format.matchAll(
          /"(\w+)":\{\{json \.(NetworkSettings\.Ports|HostConfig\.PortBindings)\}\}/g
        )) {
          const value =
            source === "NetworkSettings.Ports"
              ? opts.ports
              : opts.requestedPorts;
          if (field && value !== undefined) {
            portFields[field] = value;
          }
        }
        const outputs = [
          opts.selected ?? ID,
          opts.inspectOutput ??
            JSON.stringify(
              opts.metadata === undefined
                ? {
                    id: ID,
                    running: true,
                    project: "hack-dev-proxy",
                    service: "caddy",
                    ...portFields,
                  }
                : opts.metadata
            ),
        ];
        return {
          exitCode: 0,
          stdout: outputs[calls.length - 1] ?? "",
          stderr: "",
        };
      },
    });
  return {
    run,
    calls,
    reads: () => reads,
  };
}

test("unchanged CA uses exact owned running container and bounded public-certificate read", async () => {
  const f = fixture();
  const result = await f.run();
  expect(result.state).toBe("current");
  expect(new X509Certificate(result.currentPem ?? "").raw).toEqual(
    certificate.raw
  );
  // Selected by fixed project and service labels, never via the Compose file.
  expect(f.calls[0]?.cmd).toEqual([
    "docker",
    "ps",
    "--quiet",
    "--no-trunc",
    "--filter",
    "label=com.docker.compose.project=hack-dev-proxy",
    "--filter",
    "label=com.docker.compose.service=caddy",
  ]);
  expect(f.calls.some((call) => call.cmd.includes("compose"))).toBe(false);
  expect(f.calls[1]?.cmd.slice(0, 5)).toEqual([
    "docker",
    "inspect",
    "--type",
    "container",
    "--format",
  ]);
  expect(f.calls[1]?.cmd[5]).toContain(".HostConfig.PortBindings");
  expect(f.calls[1]?.cmd[5]).toContain(".NetworkSettings.Ports");
  expect(f.calls[2]?.cmd).toEqual([
    "docker",
    "cp",
    `${ID}:/data/caddy/pki/authorities/local/root.crt`,
    "-",
  ]);
  expect(
    f.calls.some(
      (call) => call.cmd.includes("exec") || call.cmd.includes("head")
    )
  ).toBe(false);
  expect(f.calls.map((call) => call.options)).toEqual([
    { timeoutMs: 5000, stdin: "ignore" },
    { timeoutMs: 5000, stdin: "ignore" },
    { timeoutMs: 5000, stdin: "ignore", maxStdoutBytes: 98_304 },
  ]);
});

test("interactive diagnostics can shorten each runtime CA read without changing the default", async () => {
  const f = fixture({ timeoutMs: 1000 });
  expect((await f.run()).state).toBe("current");
  expect(f.calls).toHaveLength(3);
  expect(f.calls.every((call) => call.options?.timeoutMs === 1000)).toBe(true);
});

test("runtime port metadata distinguishes wildcard, single-family, LAN and remapped publications", async () => {
  for (const [hosts, port, expected] of [
    [[""], "443", ["0.0.0.0", "::"]],
    [["0.0.0.0", "::"], "443", ["0.0.0.0", "::"]],
    [["0.0.0.0"], "443", ["0.0.0.0"]],
    [["127.0.0.1"], "443", ["127.0.0.1"]],
    [["::1"], "443", ["::1"]],
    [["192.0.2.10"], "443", []],
    [["0.0.0.0"], "8443", []],
  ] as const) {
    const f = fixture({
      ports: {
        "80/tcp": null,
        "443/tcp": hosts.map((HostIp) => ({ HostIp, HostPort: port })),
      },
    });
    expect((await f.run()).loopbackPorts).toEqual({ 80: [], 443: expected });
  }
  expect(
    (
      await fixture({
        ports: { "443/tcp": [{ HostIp: 123, HostPort: "443" }] },
      }).run()
    ).loopbackPorts
  ).toBeUndefined();
  expect(
    (await fixture({ ports: "invalid" }).run()).loopbackPorts
  ).toBeUndefined();
});

test("an IPv6-disabled host uses its actual IPv4 binding instead of default dual-family intent", async () => {
  await expectActualIpv4Only("0.0.0.0");
});

test("an IPv4-only runtime forwarder does not acquire an implied IPv6 listener", async () => {
  await expectActualIpv4Only("127.0.0.1");
});

async function expectActualIpv4Only(HostIp: string): Promise<void> {
  const ports = {
    "80/tcp": [{ HostIp, HostPort: "80" }],
    "443/tcp": [{ HostIp, HostPort: "443" }],
  };
  const requestedPorts = {
    "80/tcp": [{ HostIp: "", HostPort: "80" }],
    "443/tcp": [{ HostIp: "", HostPort: "443" }],
  };
  const identity = await fixture({ ports, requestedPorts }).run();
  expect(identity.loopbackPorts).toEqual({ 80: [HostIp], 443: [HostIp] });
  const called: string[] = [];
  const report = await inspectProxyLoopback({
    loadCa: async () => identity,
    probe: async ({ address, port }) => {
      called.push(`${address}/${port}`);
      expect(address).toBe("127.0.0.1");
      return "ok";
    },
    listListeners: async () => {
      throw new Error("healthy IPv4 publication must not warn");
    },
  });
  expect(report.status).toBe("ok");
  expect(called).toEqual(["127.0.0.1/80", "127.0.0.1/443"]);
}

test("publication intent is a fallback only when the runtime port projection is absent", async () => {
  const requestedPorts = { "443/tcp": [{ HostIp: "", HostPort: "443" }] };
  expect((await fixture({ requestedPorts }).run()).loopbackPorts).toEqual({
    80: [],
    443: ["0.0.0.0", "::"],
  });
  expect(
    (await fixture({ ports: null, requestedPorts }).run()).loopbackPorts
  ).toEqual({ 80: [], 443: ["0.0.0.0", "::"] });
  expect(
    (await fixture({ ports: {}, requestedPorts }).run()).loopbackPorts
  ).toEqual({ 80: [], 443: [] });
  expect(
    (await fixture({ ports: "malformed", requestedPorts }).run()).loopbackPorts
  ).toBeUndefined();
});

test("rotation is stale even when both CA subjects are identical", async () => {
  expect(new X509Certificate(OLD_CA_PEM).subject).toBe(certificate.subject);
  const result = await fixture({ exported: OLD_CA_PEM }).run();
  expect(result.state).toBe("stale");
  expect(new X509Certificate(result.currentPem ?? "").raw).toEqual(
    certificate.raw
  );
});

test("PEM line ending differences do not change DER identity", async () => {
  expect(
    (await fixture({ exported: CURRENT_CA_PEM.replaceAll("\n", "\r\n") }).run())
      .state
  ).toBe("current");
});

test("missing export still inspects and validates the runtime CA", async () => {
  const f = fixture({ exported: null });
  const result = await f.run();
  expect(result.state).toBe("missing");
  expect(result.currentPem).toBeDefined();
  expect(f.calls).toHaveLength(3);
});

for (const exported of ["", "malformed", CURRENT_CA_PEM + OLD_CA_PEM]) {
  test(`malformed export is stale and eligible for explicit verified refresh (${exported.length})`, async () => {
    const result = await fixture({ exported }).run();
    expect(result.state).toBe("stale");
    expect(new X509Certificate(result.currentPem ?? "").raw).toEqual(
      certificate.raw
    );
  });
}

for (const runtime of [
  "",
  "malformed",
  CURRENT_CA_PEM + OLD_CA_PEM,
  CURRENT_CA_PEM.padEnd(65_537, " "),
]) {
  test(`invalid or oversized runtime cannot authorize an export (${runtime.length})`, async () => {
    const f = fixture({ runtime, exported: null });
    const result = await f.run();
    expect(result.state).toBe("invalid");
    expect(result.currentPem).toBeUndefined();
    expect(f.reads()).toBe(0);
  });
}

for (const time of [
  Date.parse(certificate.validFrom) - 1,
  Date.parse(certificate.validTo) + 1,
  Number.NaN,
  Number.POSITIVE_INFINITY,
]) {
  test(`runtime validity must hold at the requested clock (${time})`, async () => {
    const result = await fixture({ now: time }).run();
    expect(result.state).toBe("invalid");
    expect(result.currentPem).toBeUndefined();
  });
}

for (const selected of [
  "",
  "a".repeat(11),
  "a".repeat(65),
  `${ID}\n${"b".repeat(64)}`,
  "--privileged",
  "foreign-name",
]) {
  test(`reject ambiguous or non-ID selection (${selected.length}) before inspection`, async () => {
    const f = fixture({ selected });
    expect((await f.run()).state).toBe("unavailable");
    expect(f.calls).toHaveLength(1);
  });
}

for (const metadata of [
  { id: ID, running: true, project: "hack-dev-proxy", service: "foreign" },
  { id: ID, running: false, project: "hack-dev-proxy", service: "caddy" },
  {
    id: "b".repeat(64),
    running: true,
    project: "hack-dev-proxy",
    service: "caddy",
  },
  // A `caddy` service of another Compose project (a renamed project).
  { id: ID, running: true, project: "attacker", service: "caddy" },
  { id: ID, running: true, service: "caddy" },
  {},
  null,
  [],
]) {
  test(`reject unverified Caddy ownership or running state (${JSON.stringify(metadata)})`, async () => {
    const f = fixture({ metadata });
    const result = await f.run();
    expect(result.state).toBe("unavailable");
    expect(f.calls).toHaveLength(2);
    expect(result.currentPem).toBeUndefined();
  });
}

test("a single abbreviated ID must match the inspected full ID", async () => {
  expect((await fixture({ selected: ID.slice(0, 12) }).run()).state).toBe(
    "current"
  );
});

for (const step of [1, 2, 3]) {
  for (const kind of ["failureAt", "throwAt"] as const) {
    test(`${kind} at runtime step ${step} is sanitized unavailable`, async () => {
      const result = await fixture({ [kind]: step, exported: null }).run();
      expect(result.state).toBe("unavailable");
      expect(result.currentPem).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(secretError);
    });
  }
}

test("malformed inspect output never reaches docker cp", async () => {
  const f = fixture({ inspectOutput: "not JSON" });
  expect((await f.run()).state).toBe("unavailable");
  expect(f.calls).toHaveLength(2);
});

test("export read exceptions are sanitized and never publish a root", async () => {
  const result = await fixture({ readFails: true }).run();
  expect(result.state).toBe("unavailable");
  expect(result.currentPem).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain(secretError);
});

test("a parseable non-CA runtime certificate cannot authorize export", async () => {
  // Public fixture-only DER mutation changes basicConstraints CA=true to false.
  const leaf = Buffer.from(certificate.raw);
  const offset = leaf.indexOf(Buffer.from([0x30, 0x03, 0x01, 0x01, 0xff]));
  expect(offset).toBeGreaterThan(-1);
  leaf[offset + 4] = 0;
  const nonCa = new X509Certificate(leaf);
  expect(nonCa.ca).toBe(false);
  const result = await fixture({ runtime: nonCa.toString() }).run();
  expect(result.state).toBe("invalid");
  expect(result.currentPem).toBeUndefined();
});

for (const copyKind of [
  "symlink",
  "directory",
  "missing",
  "two-files",
  "wrong-name",
  "bad-checksum",
  "trailing-data",
  "truncated",
] as const) {
  test(`streamed copy that is not exactly one root.crt file is refused (${copyKind})`, async () => {
    const f = fixture({ copyKind, exported: null });
    const result = await f.run();
    expect(result.state).toBe(
      copyKind === "missing" ? "unavailable" : "invalid"
    );
    expect(result.currentPem).toBeUndefined();
    expect(f.reads()).toBe(0);
  });
}

test("a PAX path record names the streamed entry", async () => {
  const f = fixture({ copyKind: "pax-path" });
  expect((await f.run()).state).toBe("current");
});

test("an oversized streamed root is refused without parsing certificate bytes", async () => {
  const f = fixture({ runtime: CURRENT_CA_PEM.padEnd(65_537, " ") });
  expect((await f.run()).state).toBe("invalid");
  expect(f.reads()).toBe(0);
});

test("a copy past the stdout budget is refused", async () => {
  const f = fixture({ runtime: CURRENT_CA_PEM.padEnd(120_000, " ") });
  expect((await f.run()).state).toBe("invalid");
  expect(f.reads()).toBe(0);
});

for (const kind of ["failureAt", "throwAt"] as const) {
  test(`copy ${kind} reports the runtime as unavailable`, async () => {
    const f = fixture({ [kind]: 3 });
    expect((await f.run()).state).toBe("unavailable");
    expect(f.reads()).toBe(0);
  });
}
