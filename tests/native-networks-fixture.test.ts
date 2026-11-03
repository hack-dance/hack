import { expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  humanBoundary,
  humanClosedCode,
  NATIVE_NETWORK_FIXTURE_SCENARIO_TIMEOUT,
  NATIVE_NETWORK_PROBE_EXIT,
  nativeNetworkFixtureAttachmentMatches,
  nativeNetworkFixtureCensus,
  nativeNetworkFixtureCommandDiagnostic,
  nativeNetworkFixtureCommandTimeout,
  nativeNetworkFixtureCreateArgs,
  nativeNetworkFixtureFailureLabel,
  nativeNetworkFixtureHasNoPublication,
  nativeNetworkFixtureInventory,
  nativeNetworkFixtureMarkerRead,
  nativeNetworkFixtureMarkerWrite,
  nativeNetworkFixtureNetworkMatches,
  nativeNetworkFixturePeerProbe,
  nativeNetworkFixturePreservedContainerMatches,
  nativeNetworkFixtureProbeDiagnostic,
  nativeNetworkFixtureProbeEvidence,
  nativeNetworkFixtureProbeRoute,
  nativeNetworkFixtureProjectKind,
  nativeNetworkFixtureProtocolMatches,
  nativeNetworkFixtureRefusalDiagnostic,
  nativeNetworkFixtureRunnerDiagnostic,
  nativeNetworkFixtureSavedEvidence,
  nativeNetworkFixtureShim,
  nativeNetworkFixtureStateRefused,
  nativeNetworkFixtureStep,
  nativeNetworkFixtureVolumeMatches,
  nativeNetworkFixtureVolumeSelectionMatches,
  provisionNativeNetworkFixtureComposePlugin,
  runNativeNetworkFixtureCommand,
} from "./e2e/native-config-networks-acceptance.ts";

/**
 * Many tests here start Bun child processes in sequence, and each start can
 * take a second on a loaded host. Bun's 5 s default then fires mid-command:
 * bun test SIGTERMs the child and the test fails on that child's exit (143,
 * or 128 before HACK-1428) instead of on its own assertion. Every fixture
 * command and probe keeps its own, tighter timeout.
 */
const SUBPROCESS_TEST_TIMEOUT_MS = 60_000;
setDefaultTimeout(SUBPROCESS_TEST_TIMEOUT_MS);

test("whole-run and cleanup budgets gate command starts and never clip an in-flight command", () => {
  const started = 1_000_000;
  const budget = NATIVE_NETWORK_FIXTURE_SCENARIO_TIMEOUT;
  // Measured hosted passes reach 3494 s; the named budget keeps margin above it.
  expect(budget).toBe(90 * 60_000);
  expect(budget).toBeGreaterThanOrEqual(1.5 * 3_494_000);
  for (const now of [started, started + 3_494_000, started + budget - 1]) {
    // A command started one millisecond before the budget still gets its full
    // own timeout instead of being killed when the whole-run budget expires.
    expect(
      nativeNetworkFixtureCommandTimeout({ started, cleanupStarted: null, now })
    ).toBe(180_000);
  }
  for (const now of [started + budget, started + budget + 1]) {
    expect(() =>
      nativeNetworkFixtureCommandTimeout({ started, cleanupStarted: null, now })
    ).toThrow("Network scenario exceeded its whole-run budget");
  }
  // Cleanup keeps its own start gate after the whole-run budget is spent.
  const cleanupStarted = started + budget + 60_000;
  expect(
    nativeNetworkFixtureCommandTimeout({
      started,
      cleanupStarted,
      now: cleanupStarted + 3 * 60_000 - 1,
    })
  ).toBe(180_000);
  expect(() =>
    nativeNetworkFixtureCommandTimeout({
      started,
      cleanupStarted,
      now: cleanupStarted + 3 * 60_000,
    })
  ).toThrow("Network scenario exceeded its cleanup budget");
});

test("preserved user container comparison permits only mount ordering", () => {
  const mount = {
    Type: "bind",
    Source: "/fixture/source",
    Destination: "/source",
    RW: false,
  };
  const volume = {
    Type: "volume",
    Name: "fixture-volume",
    Destination: "/data",
    RW: true,
  };
  const value = {
    Id: "a".repeat(64),
    Created: "fixed-birth",
    State: { Status: "exited" },
    Mounts: [mount, volume],
  };
  const before = JSON.stringify([value]);
  expect(
    nativeNetworkFixturePreservedContainerMatches({
      before,
      after: JSON.stringify([{ ...value, Mounts: [volume, mount] }]),
    })
  ).toBe(true);
  for (const after of [
    { ...value, Id: "b".repeat(64) },
    { ...value, Created: "other-birth" },
    { ...value, State: { Status: "running" } },
    { ...value, Mounts: [volume] },
    { ...value, Mounts: [volume, { ...mount, Source: "/other-source" }] },
    { ...value, Mounts: [volume, { ...mount, RW: true }] },
    { ...value, Mounts: [volume, mount, mount] },
    { ...value, Mounts: [volume, { ...mount, Destination: "" }] },
    { ...value, unexpected: true },
  ]) {
    expect(
      nativeNetworkFixturePreservedContainerMatches({
        before,
        after: JSON.stringify([after]),
      })
    ).toBe(false);
  }
  for (const after of [
    "invalid",
    "null",
    "[]",
    JSON.stringify([value, value]),
    JSON.stringify([{ Id: value.Id, Mounts: null }]),
  ]) {
    expect(
      nativeNetworkFixturePreservedContainerMatches({ before, after })
    ).toBe(false);
  }
});

test("foreign endpoint admission requires the structured redacted state error", () => {
  const message =
    "Native Compose state is unsafe or changed; values omitted. Inspect owned state before recovery.";
  expect(
    nativeNetworkFixtureStateRefused({
      ok: false,
      error: { code: "E_CONFIG_INVALID", message },
    })
  ).toBe(true);
  for (const value of [
    null,
    message,
    { ok: true, error: { code: "E_CONFIG_INVALID", message } },
    { ok: false, error: { code: "E_STARTUP_INCOMPLETE", message } },
    { ok: false, error: { code: "E_CONFIG_INVALID", message: "ownership" } },
    {
      ok: false,
      error: { code: "E_CONFIG_INVALID", message: `${message} extra` },
    },
    { ok: false, error: { code: "E_CONFIG_INVALID" } },
    { ok: false, error: null },
  ]) {
    expect(nativeNetworkFixtureStateRefused(value)).toBe(false);
  }
});

test("refusal failure evidence distinguishes its fixed stage and both original checks", () => {
  const result = nativeNetworkFixtureRefusalDiagnostic({
    stage: "disconnected_endpoint",
    fragmentPresent: false,
    dockerInvoked: true,
  });
  expect(result).toContain('"stage":"disconnected_endpoint"');
  expect(result).toContain('"fragmentPresent":false');
  expect(result).toContain('"dockerInvoked":true');
});

test("refusal diagnostics never print untrusted labels or non-boolean values", () => {
  const secret = "external-secret-must-not-appear";
  for (const value of [
    { stage: secret, fragmentPresent: false, dockerInvoked: false },
    { stage: "unrouted_run", fragmentPresent: secret, dockerInvoked: false },
    { stage: "unrouted_run", fragmentPresent: false, dockerInvoked: secret },
  ]) {
    const result = nativeNetworkFixtureRefusalDiagnostic(
      value as Parameters<typeof nativeNetworkFixtureRefusalDiagnostic>[0]
    );
    expect(result).toBe("Network refusal diagnostic unavailable");
    expect(result).not.toContain(secret);
  }
});

test("failing command evidence names only its closed class, role and product codes", () => {
  const secret = "/private/fixture/secret-path";
  const executables = { cli: "/pinned/hack", engine: "/pinned/docker" };
  expect(
    nativeNetworkFixtureStep(
      ["/pinned/hack", "down", "--recover", "--json"],
      executables
    )
  ).toBe("hack:down+recover");
  expect(
    nativeNetworkFixtureStep(
      ["/pinned/hack", "exec", "web", "--", "bun", "-e", secret],
      executables
    )
  ).toBe("hack:exec");
  expect(
    nativeNetworkFixtureStep(
      ["/pinned/docker", "container", "start", secret],
      executables
    )
  ).toBe("docker:container:start");
  expect(
    nativeNetworkFixtureStep(["/pinned/docker", "exec", secret], executables)
  ).toBe("docker:exec");
  expect(nativeNetworkFixtureStep([secret, "up"], executables)).toBe("other");
  expect(nativeNetworkFixtureStep(["/pinned/hack", secret], executables)).toBe(
    "hack:other"
  );

  const json = nativeNetworkFixtureCommandDiagnostic({
    step: "hack:down+recover",
    role: "primary",
    sequence: 412,
    expected: 0,
    result: {
      exitCode: 1,
      timedOut: false,
      durationMs: 2345,
      stdout: JSON.stringify({
        ok: false,
        error: {
          code: "E_CONFIG_INVALID",
          message: `values ${secret}`,
          detail: {
            native_compose_effect_refusal: {
              stage: "storage-helper-start",
              reason: "probe-timeout",
            },
          },
        },
      }),
      stderr: secret,
    },
  });
  expect(json).toBe(
    'Network command diagnostic {"step":"hack:down+recover","role":"primary","sequence":412,"expected":0,"exit":1,"timedOut":false,"durationMs":2345,"code":"E_CONFIG_INVALID","stage":"storage-helper-start","reason":"probe-timeout","message":null}'
  );
  const human = nativeNetworkFixtureCommandDiagnostic({
    step: "hack:exec",
    role: "sibling-b",
    sequence: 7,
    expected: 0,
    result: {
      exitCode: 1,
      timedOut: false,
      durationMs: 7,
      // The clack backend (no gum on the hosted runner) writes errors to stdout.
      stdout: `\u2502\n\u25a0  E_COMPOSE_FAILED: Native Compose operation failed ${secret}\n\u2502\n\u25a0  Refusal boundary: storage-helper-policy (unclassified); values omitted.\n`,
      stderr: secret,
    },
  });
  expect(human).toContain(
    '"code":"E_COMPOSE_FAILED","stage":"storage-helper-policy","reason":"unclassified"'
  );
  const unbounded = nativeNetworkFixtureCommandDiagnostic({
    step: "hack:exec",
    role: "sibling-b",
    sequence: 8,
    expected: 0,
    result: {
      exitCode: 1,
      timedOut: false,
      durationMs: 7,
      stdout: `\u25a0  E_CONFIG_INVALID: Refused ${secret}\n`,
      stderr: "",
    },
  });
  expect(unbounded).toContain(
    '"code":"E_CONFIG_INVALID","stage":null,"reason":null'
  );
  for (const result of [json, human, unbounded]) {
    expect(result).not.toContain(secret);
    expect(result).not.toContain("values");
  }
});

test("human error output yields only its leading closed code for every logger backend", () => {
  const secret = "/private/fixture/secret-path";
  for (const [text, code] of [
    // clack (hosted runner, NO_COLOR) on stdout
    [`│\n■  E_CONFIG_INVALID: Refused ${secret}\n`, "E_CONFIG_INVALID"],
    // clack with color
    [
      `\u001b[90m│\u001b[39m\n\u001b[31m■\u001b[39m  E_COMPOSE_FAILED: ${secret}\n`,
      "E_COMPOSE_FAILED",
    ],
    // gum and console backends on stderr
    [`ERROR E_NATIVE_COMPOSE_STATE: ${secret}`, "E_NATIVE_COMPOSE_STATE"],
    [`ERROR: E_LIFECYCLE_FAILED: ${secret}\n`, "E_LIFECYCLE_FAILED"],
  ] as const) {
    expect(humanClosedCode(text)).toBe(code);
  }
  for (const text of [
    "",
    secret,
    "ERROR MissingProjectContextError: E_FAKE: nested",
    `value E_INLINE: ${secret}`,
    `■  e_lower: ${secret}`,
    `■  E_${"X".repeat(70)}: ${secret}`,
  ]) {
    expect(humanClosedCode(text)).toBeNull();
  }
  expect(
    humanBoundary(
      "ERROR: Refusal boundary: storage-target (probe-timeout); values omitted.\n"
    )
  ).toEqual({ stage: "storage-target", reason: "probe-timeout" });
  for (const text of [
    `■  Refusal boundary: ${secret} (probe-timeout); values omitted.`,
    "■  Refusal boundary: storage-target (Probe Timeout); values omitted.",
    "■  Refusal boundary: storage-target (probe-timeout)",
    "value Refusal boundary: storage-target (probe-timeout); values omitted.",
  ]) {
    expect(humanBoundary(text)).toBeNull();
  }
});

test("probe scripts exit with a closed code for every in-container failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-network-probe-"));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/hang") {
        return new Promise<Response>(() => undefined);
      }
      return new Response(path === "/wrong" ? "other" : "primary:peer");
    },
  });
  const closed = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });
  const refused = `http://127.0.0.1:${closed.port}/`;
  closed.stop(true);
  const origin = `http://127.0.0.1:${server.port}`;
  const run = async (script: string, peer = origin): Promise<number> => {
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PEER_ORIGIN: peer },
      stdout: "ignore",
      stderr: "ignore",
    });
    return await child.exited;
  };
  try {
    const probe = (alias: string, timeoutMs = 4000) =>
      nativeNetworkFixturePeerProbe({
        origin,
        alias,
        expected: "primary:peer",
        timeoutMs,
      });
    expect(await run(probe(`${origin}/alias`))).toBe(0);
    expect(await run(probe(`${origin}/alias`), `${origin}/x`)).toBe(
      NATIVE_NETWORK_PROBE_EXIT.environment
    );
    expect(await run(probe(`${origin}/wrong`))).toBe(
      NATIVE_NETWORK_PROBE_EXIT.response
    );
    expect(await run(probe(refused))).toBe(NATIVE_NETWORK_PROBE_EXIT.rejected);
    expect(await run(probe(`${origin}/hang`, 200))).toBe(
      NATIVE_NETWORK_PROBE_EXIT.timeout
    );

    const marker = join(root, "marker");
    const read = nativeNetworkFixtureMarkerRead({ path: marker, marker: "m" });
    expect(await run(read)).toBe(NATIVE_NETWORK_PROBE_EXIT.unreadable);
    expect(
      await run(nativeNetworkFixtureMarkerWrite({ path: marker, marker: "m" }))
    ).toBe(0);
    expect(await run(read)).toBe(0);
    expect(
      await run(nativeNetworkFixtureMarkerRead({ path: marker, marker: "n" }))
    ).toBe(NATIVE_NETWORK_PROBE_EXIT.marker);
    expect(
      await run(
        nativeNetworkFixtureMarkerWrite({
          // Bun.write creates directories; a regular-file parent cannot be one.
          path: join(marker, "child"),
          marker: "m",
        })
      )
    ).toBe(NATIVE_NETWORK_PROBE_EXIT.unwritable);
    // No probe code collides with an ordinary product failure exit.
    expect(Object.values(NATIVE_NETWORK_PROBE_EXIT)).not.toContain(1);
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

// HACK-1419: a hosted probe exited 27 with no way to tell which URL or phase stalled.
test("peer probe attributes a failure to one URL and phase in closed stderr evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-network-probe-"));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      return new URL(request.url).pathname === "/hang"
        ? new Promise<Response>(() => undefined)
        : new Response("primary:peer");
    },
  });
  const closed = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });
  const refused = `http://127.0.0.1:${closed.port}`;
  closed.stop(true);
  const origin = `http://127.0.0.1:${server.port}`;
  const run = async (opts: {
    readonly origin: string;
    readonly alias: string;
    readonly timeoutMs: number;
  }): Promise<{ readonly code: number; readonly stderr: string }> => {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        nativeNetworkFixturePeerProbe({ ...opts, expected: "primary:peer" }),
      ],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          PEER_ORIGIN: opts.origin,
        },
        stdout: "ignore",
        stderr: "pipe",
      }
    );
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    return { code, stderr };
  };
  try {
    // A name resolving to several families still reaches the IPv4 listener.
    const named = `http://localhost:${server.port}`;
    expect(
      await run({ origin: named, alias: `${named}/a`, timeoutMs: 4000 })
    ).toEqual({ code: 0, stderr: "" });

    const hung = await run({ origin, alias: `${origin}/hang`, timeoutMs: 300 });
    expect(hung.code).toBe(NATIVE_NETWORK_PROBE_EXIT.timeout);
    const hungEvidence = nativeNetworkFixtureProbeEvidence(hung.stderr);
    expect(hungEvidence).toMatchObject({
      url: "alias",
      phase: "http",
      addresses: 1,
    });
    // Resolution and the HTTP exchange share one budget per URL.
    expect(hungEvidence?.elapsedMs).toBeGreaterThanOrEqual(250);
    expect(hungEvidence?.elapsedMs).toBeLessThan(2000);

    const rejected = await run({
      origin: refused,
      alias: `${origin}/a`,
      timeoutMs: 4000,
    });
    expect(rejected.code).toBe(NATIVE_NETWORK_PROBE_EXIT.rejected);
    expect(nativeNetworkFixtureProbeEvidence(rejected.stderr)).toMatchObject({
      url: "origin",
      phase: "http",
    });

    // RFC 6761 `.invalid` never resolves; an unreachable resolver times out instead.
    const unresolved = await run({
      origin,
      alias: "http://probe-1419.invalid:3000/",
      timeoutMs: 2000,
    });
    expect<number[]>([
      NATIVE_NETWORK_PROBE_EXIT.dnsRejected,
      NATIVE_NETWORK_PROBE_EXIT.dnsTimeout,
    ]).toContain(unresolved.code);
    expect(nativeNetworkFixtureProbeEvidence(unresolved.stderr)).toMatchObject({
      url: "alias",
      phase: "dns",
      addresses: 0,
    });
    expect(unresolved.stderr).not.toContain("probe-1419");

    expect(new Set(Object.values(NATIVE_NETWORK_PROBE_EXIT)).size).toBe(
      Object.values(NATIVE_NETWORK_PROBE_EXIT).length
    );
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Runs the peer probe with `Bun.dns.lookup` replaced by a stub that answers
 * every name with `answer` (default 127.0.0.1, family 4), after `delayMs` for
 * names starting with `slow`. The probe names use RFC 6761 `.invalid`, so only
 * the stubbed answer can reach the local listener: a second, real resolution
 * fails (HACK-1428).
 */
async function runStubbedPeerProbe(opts: {
  readonly root: string;
  readonly origin: string;
  readonly alias: string;
  readonly timeoutMs: number;
  readonly delayMs: number;
  readonly answer?: { readonly address: string; readonly family: 4 | 6 };
}): Promise<{ readonly code: number; readonly stderr: string }> {
  const answer = JSON.stringify([
    opts.answer ?? { address: "127.0.0.1", family: 4 },
  ]);
  const stub = `Bun.dns.lookup=async(h)=>{if(h.startsWith("slow"))await Bun.sleep(${opts.delayMs});return ${answer}};`;
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      stub +
        nativeNetworkFixturePeerProbe({
          origin: opts.origin,
          alias: opts.alias,
          expected: "primary:peer",
          timeoutMs: opts.timeoutMs,
        }),
    ],
    {
      cwd: opts.root,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        PEER_ORIGIN: opts.origin,
      },
      stdout: "ignore",
      stderr: "pipe",
    }
  );
  const [code, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  return { code, stderr };
}

// HACK-1428: an HTTP-phase failure must not hide a second, uncounted resolution.
test("peer probe fetches the address it just resolved", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-network-probe-"));
  const hosts: (string | null)[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      hosts.push(request.headers.get("host"));
      return new Response("primary:peer");
    },
  });
  try {
    const origin = `http://probe-1428.invalid:${server.port}`;
    expect(
      await runStubbedPeerProbe({
        root,
        origin,
        alias: `http://probe-1428-alias.invalid:${server.port}/a`,
        timeoutMs: 4000,
        delayMs: 0,
      })
    ).toEqual({ code: 0, stderr: "" });
    // Both requests went to the stub's address, not to the unresolvable names.
    expect(hosts).toEqual([
      `127.0.0.1:${server.port}`,
      `127.0.0.1:${server.port}`,
    ]);
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

// HACK-1457: an IPv6-only answer is bracketed into the URL host. Without the
// brackets the URL rejects the bare address, keeps the unresolvable name, and the
// fetch fails.
test("peer probe fetches an IPv6-only answer through a bracketed host", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-network-probe-"));
  const hosts: (string | null)[] = [];
  const server = Bun.serve({
    hostname: "::1",
    port: 0,
    fetch(request) {
      hosts.push(request.headers.get("host"));
      return new Response("primary:peer");
    },
  });
  try {
    const result = await runStubbedPeerProbe({
      root,
      origin: `http://probe-1457.invalid:${server.port}`,
      alias: `http://probe-1457-alias.invalid:${server.port}/a`,
      timeoutMs: 4000,
      delayMs: 0,
      answer: { address: "::1", family: 6 },
    });
    expect(result).toEqual({ code: 0, stderr: "" });
    expect(hosts).toEqual([`[::1]:${server.port}`, `[::1]:${server.port}`]);
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

// HACK-1428: resolution time is charged against the URL's one shared budget.
test("peer probe charges resolution time against the shared per-URL budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-network-probe-"));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      return new URL(request.url).pathname === "/hang"
        ? new Promise<Response>(() => undefined)
        : new Response("primary:peer");
    },
  });
  try {
    const origin = `http://probe-1428.invalid:${server.port}`;
    const alias = `http://slow-1428.invalid:${server.port}/hang`;
    const budget = 2000;
    const delay = 1200;
    const hung = await runStubbedPeerProbe({
      root,
      origin,
      alias,
      timeoutMs: budget,
      delayMs: delay,
    });
    expect(hung.code).toBe(NATIVE_NETWORK_PROBE_EXIT.timeout);
    const evidence = nativeNetworkFixtureProbeEvidence(hung.stderr);
    expect(evidence).toMatchObject({ url: "alias", phase: "http" });
    expect(evidence?.dnsMs).toBeGreaterThanOrEqual(delay - 50);
    expect(evidence?.elapsedMs).toBeGreaterThanOrEqual(budget - 50);
    // The HTTP phase gets only what resolution left: a fresh full budget
    // would end near budget + delay (3200 ms).
    expect(evidence?.elapsedMs).toBeLessThan(budget + delay / 2);

    // Resolution alone exceeding the budget is a resolution timeout.
    const stalled = await runStubbedPeerProbe({
      root,
      origin,
      alias,
      timeoutMs: 500,
      delayMs: delay,
    });
    expect(stalled.code).toBe(NATIVE_NETWORK_PROBE_EXIT.dnsTimeout);
    const stalledEvidence = nativeNetworkFixtureProbeEvidence(stalled.stderr);
    expect(stalledEvidence).toMatchObject({
      url: "alias",
      phase: "dns",
      addresses: 0,
    });
    expect(stalledEvidence?.elapsedMs).toBeGreaterThanOrEqual(450);
    expect(stalledEvidence?.elapsedMs).toBeLessThan(delay);
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("probe evidence admits only the closed stderr line", () => {
  const secret = "/private/fixture/secret-path";
  expect(
    nativeNetworkFixtureProbeEvidence(
      `warning ${secret}\nprobe-evidence origin dns 4001 4003 0\n`
    )
  ).toEqual({
    url: "origin",
    phase: "dns",
    dnsMs: 4001,
    elapsedMs: 4003,
    addresses: 0,
  });
  for (const text of [
    "",
    secret,
    "probe-evidence other http 1 2 1",
    "probe-evidence alias connect 1 2 1",
    `probe-evidence alias http 1 2 1 ${secret}`,
    "probe-evidence alias http -1 2 1",
    "probe-evidence alias http 1 2 1000",
  ]) {
    expect(nativeNetworkFixtureProbeEvidence(text)).toBeNull();
  }
});

test("probe route state reduces inspections to closed counts and booleans", () => {
  const outbound = "a".repeat(64);
  const ingress = "b".repeat(64);
  const foreign = "c".repeat(64);
  const source = {
    State: { Status: "running", Health: { Status: "healthy" } },
    NetworkSettings: {
      Networks: {
        project_outbound: { NetworkID: outbound, IPAddress: "10.9.0.2" },
        "hack-dev": { NetworkID: ingress, IPAddress: "10.8.0.5" },
      },
    },
  };
  const target = {
    State: { Status: "running", Health: { Status: "starting" } },
    NetworkSettings: {
      Networks: {
        project_outbound: { NetworkID: outbound, IPAddress: "10.9.0.3" },
        other: { NetworkID: foreign, IPAddress: "10.7.0.3" },
      },
    },
  };
  const shared = nativeNetworkFixtureProbeRoute({
    source,
    target,
    resolved:
      "10.9.0.3        STREAM peer\n10.9.0.3        DGRAM\n10.9.0.3        RAW\n",
    ingressId: ingress,
  });
  expect(shared).toEqual({
    source: { state: "running", health: "healthy" },
    target: { state: "running", health: "starting" },
    sourceAttachments: 2,
    targetAttachments: 2,
    sharedBridges: 1,
    sourceIngress: true,
    addresses: 1,
    resolvesToSharedTarget: true,
  });
  for (const value of [outbound, ingress, foreign, "10.9.0", "hack-dev"]) {
    expect(JSON.stringify(shared)).not.toContain(value);
  }
  // A name answering an address off the shared bridge (another network, a
  // stale container) is the misroute a timeout would hide.
  expect(
    nativeNetworkFixtureProbeRoute({
      source,
      target,
      resolved: "10.9.0.3 STREAM peer\n10.7.0.3 STREAM peer\n",
      ingressId: null,
    })
  ).toMatchObject({
    addresses: 2,
    resolvesToSharedTarget: false,
    sourceIngress: false,
  });
  expect(
    nativeNetworkFixtureProbeRoute({
      source,
      target,
      resolved: "",
      ingressId: ingress,
    })
  ).toMatchObject({ addresses: 0, resolvesToSharedTarget: false });
  expect(
    nativeNetworkFixtureProbeRoute({
      source: null,
      target: { State: { Status: "secret" } },
      resolved: null,
      ingressId: ingress,
    })
  ).toEqual({
    source: { state: "unknown", health: "unknown" },
    target: { state: "unknown", health: "none" },
    sourceAttachments: 0,
    targetAttachments: 0,
    sharedBridges: 0,
    sourceIngress: false,
    addresses: null,
    resolvesToSharedTarget: null,
  });
});

test("probe diagnostic names role, pair, outcomes and route state only", () => {
  const secret = "/private/fixture/secret-path";
  const route = nativeNetworkFixtureProbeRoute({
    source: null,
    target: null,
    resolved: null,
    ingressId: null,
  });
  const text = nativeNetworkFixtureProbeDiagnostic({
    role: "primary",
    service: "web",
    target: "peer",
    first: {
      exitCode: NATIVE_NETWORK_PROBE_EXIT.timeout,
      timedOut: false,
      stderr: `${secret}\nprobe-evidence alias http 2 4001 1\n`,
    },
    rerun: { exitCode: 0, timedOut: false, stderr: "" },
    route,
  });
  expect(text).toBe(
    `Network probe diagnostic ${JSON.stringify({
      role: "primary",
      service: "web",
      target: "peer",
      exit: 27,
      timedOut: false,
      outcome: "timeout",
      evidence: {
        url: "alias",
        phase: "http",
        dnsMs: 2,
        elapsedMs: 4001,
        addresses: 1,
      },
      rerun: {
        exit: 0,
        timedOut: false,
        outcome: "pass",
        evidence: null,
      },
      route,
    })}`
  );
  expect(text).not.toContain(secret);
  expect(
    nativeNetworkFixtureProbeDiagnostic({
      role: "sibling-a",
      service: "reader",
      target: "vault",
      first: { exitCode: 1, timedOut: false, stderr: secret },
      rerun: null,
      route: null,
    })
  ).toContain('"exit":1,"timedOut":false,"outcome":"other","evidence":null');
  expect(
    nativeNetworkFixtureProbeDiagnostic({
      role: "primary",
      service: secret,
      target: "peer",
      first: { exitCode: 27, timedOut: false, stderr: "" },
      rerun: null,
      route: null,
    })
  ).toBe("Network probe diagnostic unavailable");
});

test("saved-state evidence reports closed flags and pending operation only", () => {
  const secret = "secret-generation-token";
  expect(
    nativeNetworkFixtureSavedEvidence([
      {
        role: "primary",
        stopped: false,
        pending: null,
        storageWitnessesPending: false,
        beforeHooksPending: false,
      },
      {
        role: "sibling-b",
        stopped: false,
        pending: { operation: "up", token: secret, generationId: secret },
        storageWitnessesPending: true,
        beforeHooksPending: false,
      },
      {
        role: "sibling-a",
        stopped: secret,
        pending: { operation: secret },
        storageWitnessesPending: undefined,
        beforeHooksPending: null,
      },
    ])
  ).toBe(
    'Network failure saved state {"primary":{"stopped":false,"pending":"none","storageWitnessesPending":false,"beforeHooksPending":false},"sibling-b":{"stopped":false,"pending":"up","storageWitnessesPending":true,"beforeHooksPending":false},"sibling-a":{"stopped":"unknown","pending":"unknown","storageWitnessesPending":"unknown","beforeHooksPending":"unknown"}}'
  );
});

test("an incomplete saved stop without an issued boundary is still named by its fixed sentence", () => {
  const secret = "/private/fixture/secret-path";
  const stop =
    "Native Compose stop is incomplete; saved ownership and persistent data are retained.";
  const diagnostic = (stdout: string, stderr = "") =>
    nativeNetworkFixtureCommandDiagnostic({
      step: "hack:down+recover",
      role: "sibling-a",
      sequence: 942,
      expected: 0,
      result: {
        exitCode: 1,
        timedOut: false,
        durationMs: 2750,
        stdout,
        stderr,
      },
    });
  // The sampled HACK-1281 cleanup failure: E_COMPOSE_FAILED with no stage or reason.
  const json = diagnostic(
    JSON.stringify({
      ok: false,
      error: { code: "E_COMPOSE_FAILED", message: stop },
    })
  );
  expect(json).toContain(
    '"code":"E_COMPOSE_FAILED","stage":null,"reason":null,"message":"stop-incomplete"'
  );
  expect(diagnostic(`│\n■  E_COMPOSE_FAILED: ${stop}\n`, secret)).toContain(
    '"message":"stop-incomplete"'
  );
  expect(
    diagnostic(
      JSON.stringify({
        ok: false,
        error: {
          code: "E_CONFIG_INVALID",
          message:
            "Native Compose operation has an uncertain outcome; inspect the saved generation or explicitly stop its owned resources before retrying.",
        },
      })
    )
  ).toContain('"message":"native-uncertain"');
  // Only the exact sentence is classified; appended values are withheld.
  for (const changed of [`${stop} ${secret}`, stop.toUpperCase(), ""]) {
    const result = diagnostic(
      JSON.stringify({
        ok: false,
        error: { code: "E_COMPOSE_FAILED", message: changed },
      })
    );
    expect(result).toContain('"message":null');
    expect(result).not.toContain(secret);
  }
  expect(diagnostic(`■  E_COMPOSE_FAILED: ${stop} ${secret}\n`)).toContain(
    '"message":null'
  );
});

test("a command the runner killed or could not return still names its class and runner outcome", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-network-runner-"));
  try {
    const caught = await runNativeNetworkFixtureCommand({
      argv: ["/bin/sh", "-c", "sleep 5"],
      cwd: root,
      env: {},
      captures: join(root, "captures"),
      timeoutMs: 150,
    }).catch((error: unknown) => error);
    const timeout = nativeNetworkFixtureRunnerDiagnostic({
      step: "hack:exec",
      role: "sibling-a",
      sequence: 941,
      durationMs: 180_000,
      error: caught,
    });
    expect(timeout).toBe(
      'Network command diagnostic {"step":"hack:exec","role":"sibling-a","sequence":941,"durationMs":180000,"runner":"timeout"}'
    );
    const secret = "/private/fixture/secret-path";
    expect(
      nativeNetworkFixtureRunnerDiagnostic({
        step: "hack:exec",
        role: "primary",
        sequence: 1,
        durationMs: 1,
        error: new Error(secret),
      })
    ).toBe(
      'Network command diagnostic {"step":"hack:exec","role":"primary","sequence":1,"durationMs":1,"runner":"other"}'
    );
    for (const value of [
      { step: secret, role: "primary" },
      { step: "hack:exec", role: secret },
    ]) {
      expect(
        nativeNetworkFixtureRunnerDiagnostic({
          ...(value as { step: string; role: "primary" }),
          sequence: 1,
          durationMs: 1,
          error: caught,
        })
      ).toBe("Network command diagnostic unavailable");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failing command evidence drops non-closed codes and malformed fields", () => {
  const secret = "secret-value-must-not-appear";
  const forged = nativeNetworkFixtureCommandDiagnostic({
    step: "hack:up",
    role: "primary",
    sequence: 1,
    expected: 0,
    result: {
      exitCode: 1,
      timedOut: false,
      durationMs: 1,
      stdout: JSON.stringify({
        ok: false,
        error: {
          code: `E_${secret}`,
          detail: {
            native_compose_effect_refusal: {
              stage: `/${secret}`,
              reason: { value: secret },
            },
          },
        },
      }),
      stderr: "",
    },
  });
  expect(forged).toContain('"code":null,"stage":null,"reason":null');
  expect(forged).not.toContain(secret);
  for (const value of [
    { step: secret, role: "primary" },
    { step: "hack:up", role: secret },
    { step: "hack:up --json", role: "primary" },
  ]) {
    const result = nativeNetworkFixtureCommandDiagnostic({
      ...(value as { step: string; role: "primary" }),
      sequence: 1,
      expected: 0,
      result: {
        exitCode: 1,
        timedOut: false,
        durationMs: 1,
        stdout: "",
        stderr: "",
      },
    });
    expect(result).toBe("Network command diagnostic unavailable");
  }
});

test("fixture failure label prints only fixed assertion sentences", () => {
  expect(
    nativeNetworkFixtureFailureLabel(
      new Error(
        "Product saved down must retire all exact fixture containers/bridges and clear intent"
      )
    )
  ).toBe(
    'Network failure "Product saved down must retire all exact fixture containers/bridges and clear intent"'
  );
  for (const error of [
    new Error("Refused /private/fixture/root"),
    new Error("Value 42 omitted"),
    new Error("lowercase start"),
    new Error(`Long ${"x".repeat(200)}`),
    "Fixture string throw",
    { message: "Fixture object" },
  ]) {
    expect(nativeNetworkFixtureFailureLabel(error)).toBe(
      "Network failure withheld"
    );
  }
});

test("failure census separates canonical services from one-offs and strays", () => {
  const project = "hack-nc-0123456789abcdef0123456789abcdef";
  expect(
    nativeNetworkFixtureProjectKind({
      project,
      name: `${project}-web-1`,
      service: "web",
      oneoff: "False",
    })
  ).toBe("service");
  expect(
    nativeNetworkFixtureProjectKind({
      project,
      name: `0123456789ab_${project}-web-1`,
      service: "web",
      oneoff: "False",
    })
  ).toBe("stray");
  expect(
    nativeNetworkFixtureProjectKind({
      project,
      name: `${project}-run-0123`,
      service: "web",
      oneoff: "True",
    })
  ).toBe("oneoff");
  for (const value of [
    { name: `${project}-other-1`, service: "other", oneoff: "False" },
    { name: `${project}-web-2`, service: "web", oneoff: "False" },
    { name: `${project}-web-1`, service: "web", oneoff: "" },
  ]) {
    expect(nativeNetworkFixtureProjectKind({ project, ...value })).toBe(
      "stray"
    );
  }
});

test("failure census counts owned roles and kinds by closed engine state only", () => {
  expect(
    nativeNetworkFixtureCensus([
      { role: "primary", kind: "service", state: "running" },
      { role: "primary", kind: "service", state: "running" },
      { role: "primary", kind: "carrier", state: "exited" },
      { role: "fixture", kind: "fixture", state: "created" },
      { role: "sibling-a", kind: "service", state: "secret-state" },
    ])
  ).toBe(
    'Network failure census {"fixture:fixture:created":1,"primary:carrier:exited":1,"primary:service:running":2,"sibling-a:service:unknown":1}'
  );
  expect(nativeNetworkFixtureCensus([])).toBe("Network failure census {}");
});

async function withPluginFixture(
  run: (opts: {
    path: string;
    expectedHash: string;
    dockerConfig: string;
  }) => Promise<void>
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fixture-plugin-")));
  try {
    const path = join(root, "installed-compose");
    const dockerConfig = join(root, "docker-config");
    const source = "#!/bin/sh\nprintf '%s\\n' '2.40.3'\n";
    await writeFile(path, source, { mode: 0o700 });
    await mkdir(dockerConfig, { mode: 0o700 });
    await writeFile(join(dockerConfig, "config.json"), "{}\n", { mode: 0o600 });
    await run({
      path,
      expectedHash: createHash("sha256").update(source).digest("hex"),
      dockerConfig,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("private Compose registration uses only the pinned canonical binary and preserves empty auth config", async () => {
  await withPluginFixture(async (opts) => {
    const pin = await provisionNativeNetworkFixtureComposePlugin(opts);
    const installed = join(opts.dockerConfig, "cli-plugins", "docker-compose");
    expect(pin.path).toBe(opts.path);
    expect(pin.sha256).toBe(opts.expectedHash);
    expect(pin.registeredPath).toBe(installed);
    expect((await lstat(installed)).isSymbolicLink()).toBe(true);
    expect(await readlink(installed)).toBe(opts.path);
    expect(await readFile(join(opts.dockerConfig, "config.json"), "utf8")).toBe(
      "{}\n"
    );
  });
});

test("private Compose plugin registration preserves multicall basename dispatch", async () => {
  await withPluginFixture(async (opts) => {
    const source =
      '#!/bin/sh\ncase "$0" in */docker-compose) printf "%s\\n" "5.1.2" ;; *) exit 23 ;; esac\n';
    await writeFile(opts.path, source);
    const plugin = await provisionNativeNetworkFixtureComposePlugin({
      ...opts,
      expectedHash: createHash("sha256").update(source).digest("hex"),
    });
    const execute = (path: string) =>
      runNativeNetworkFixtureCommand({
        argv: [path, "version", "--short"],
        cwd: dirname(opts.path),
        env: { PATH: "/usr/bin:/bin" },
        captures: join(dirname(opts.path), "captures"),
      });
    expect((await execute(plugin.path)).exitCode).toBe(23);
    const observed = await execute(plugin.registeredPath);
    expect(observed.exitCode).toBe(0);
    expect(observed.stdout).toBe("5.1.2\n");
  });
});

test("Compose registration refuses a wrong binary hash before creating a plugin directory", async () => {
  await withPluginFixture(async (opts) => {
    await expect(
      provisionNativeNetworkFixtureComposePlugin({
        ...opts,
        expectedHash: "f".repeat(64),
      })
    ).rejects.toThrow("identity/hash qualification failed");
    expect(
      await Bun.file(join(opts.dockerConfig, "cli-plugins")).exists()
    ).toBe(false);
  });
});

test.each([
  "symlink",
  "hardlink",
])("Compose registration refuses an unqualified %s executable", async (kind) => {
  await withPluginFixture(async (opts) => {
    const path = `${opts.path}-alias`;
    if (kind === "symlink") {
      await symlink(opts.path, path);
    } else {
      await link(opts.path, path);
    }
    await expect(
      provisionNativeNetworkFixtureComposePlugin({ ...opts, path })
    ).rejects.toThrow("Fixture artifact");
    expect(
      await Bun.file(join(opts.dockerConfig, "cli-plugins")).exists()
    ).toBe(false);
  });
});

test.each([
  "symlink",
  "permissions",
])("Compose registration refuses unsafe private-config %s", async (kind) => {
  await withPluginFixture(async (opts) => {
    let dockerConfig = opts.dockerConfig;
    if (kind === "symlink") {
      dockerConfig = `${dockerConfig}-alias`;
      await symlink(opts.dockerConfig, dockerConfig);
    } else {
      await chmod(dockerConfig, 0o755);
    }
    await expect(
      provisionNativeNetworkFixtureComposePlugin({ ...opts, dockerConfig })
    ).rejects.toThrow("canonical private fixture config");
    expect(
      await Bun.file(join(opts.dockerConfig, "cli-plugins")).exists()
    ).toBe(false);
  });
});

test("Compose registration refuses an existing plugin path and preserves its bytes", async () => {
  await withPluginFixture(async (opts) => {
    const path = join(opts.dockerConfig, "cli-plugins");
    await writeFile(path, "unowned-plugin-path");
    await expect(
      provisionNativeNetworkFixtureComposePlugin(opts)
    ).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("unowned-plugin-path");
  });
});

const PROJECT = "com.docker.compose.project";
const INSTANCE = "io.hack.native-config.instance";
const OWNER = "io.hack.native-config.owner";
const VERSION = "io.hack.native-config.version";
const STORAGE = "io.hack.native-config.storage";
const project = "hack-native-fixture";
const owner = "b".repeat(32);
const labels = {
  [PROJECT]: project,
  [INSTANCE]: project,
  [OWNER]: owner,
  [VERSION]: "1",
};
const volumePin = {
  name: "hack-native-fixture_state",
  createdAt: "2026-10-08T00:00:00Z",
  storage: "state",
  project,
  owner,
};
const networkPin = {
  name: "hack-net-fixture-outbound",
  id: "a".repeat(64),
  createdAt: "2026-10-08T00:00:00Z",
  internal: false,
  project,
  owner,
};

function volume() {
  return {
    Name: volumePin.name,
    CreatedAt: volumePin.createdAt,
    Driver: "local",
    Labels: { ...labels, [STORAGE]: "state" },
  };
}
function network() {
  return {
    Id: networkPin.id,
    Name: networkPin.name,
    Created: networkPin.createdAt,
    Driver: "bridge",
    Internal: false,
    Labels: { ...labels },
    Containers: {},
  };
}

test("network fixture admits all required own version-one protocol capabilities", () => {
  const value = {
    transport_version: 1,
    authored_version: 1,
    plan_version: 1,
    resolve_version: 1,
    local_version: 1,
    env_plan_version: 1,
    endpoint_plan_version: 1,
    process_plan_version: 1,
    acquisition_plan_version: 1,
    network_plan_version: 1,
  };
  expect(nativeNetworkFixtureProtocolMatches(value)).toBe(true);
  for (const key of Object.keys(value)) {
    const dropped: Record<string, unknown> = { ...value };
    delete dropped[key];
    expect(nativeNetworkFixtureProtocolMatches(dropped)).toBe(false);
    expect(nativeNetworkFixtureProtocolMatches({ ...value, [key]: 2 })).toBe(
      false
    );
  }
  expect(nativeNetworkFixtureProtocolMatches(Object.create(value))).toBe(false);
  expect(nativeNetworkFixtureProtocolMatches(null)).toBe(false);
});

test("retained volume requires exact singleton selection even after saved stop", () => {
  expect(
    nativeNetworkFixtureVolumeSelectionMatches([volumePin.name], volumePin)
  ).toBe(true);
  expect(nativeNetworkFixtureVolumeSelectionMatches([], volumePin)).toBe(false);
  expect(
    nativeNetworkFixtureVolumeSelectionMatches(
      [volumePin.name, "extra"],
      volumePin
    )
  ).toBe(false);
  expect(
    nativeNetworkFixtureVolumeSelectionMatches(["replacement"], volumePin)
  ).toBe(false);
  expect(nativeNetworkFixtureVolumeSelectionMatches([], null)).toBe(true);
  expect(
    nativeNetworkFixtureVolumeSelectionMatches([volumePin.name], null)
  ).toBe(false);
});

test.each([
  { Name: "replacement" },
  { CreatedAt: "2026-10-09T00:00:00Z" },
  { Driver: "remote" },
  { Labels: { ...labels, [STORAGE]: "wrong" } },
  { Labels: { ...labels, [OWNER]: "c".repeat(32), [STORAGE]: "state" } },
  { Labels: Object.create({ ...labels, [STORAGE]: "state" }) },
])("volume effect fence refuses creation/name/storage/owner drift (%#)", (change) => {
  expect(nativeNetworkFixtureVolumeMatches(volume(), volumePin)).toBe(true);
  expect(
    nativeNetworkFixtureVolumeMatches({ ...volume(), ...change }, volumePin)
  ).toBe(false);
});

test.each([
  { Id: "c".repeat(64) },
  { Name: "replacement" },
  { Created: "2026-10-09T00:00:00Z" },
  { Driver: "host" },
  { Internal: true },
  { Labels: { ...labels, [OWNER]: "d".repeat(32) } },
  { Labels: Object.create(labels) },
  { Containers: { constructor: {} } },
  { Containers: null },
])("network deletion fence refuses nonempty, replaced or wrong-policy bridge (%#)", (change) => {
  expect(nativeNetworkFixtureNetworkMatches(network(), networkPin, true)).toBe(
    true
  );
  expect(
    nativeNetworkFixtureNetworkMatches(
      { ...network(), ...change },
      networkPin,
      true
    )
  ).toBe(false);
});

test("actual aliases bind the exact reciprocal network ID with no extra alias", () => {
  const aliases = ["fixture-web-1", "web", "web-alias"];
  const check = (value: unknown, created = false) =>
    nativeNetworkFixtureAttachmentMatches({
      value,
      networkId: networkPin.id,
      aliases,
      created,
    });
  expect(
    check({ NetworkID: networkPin.id, Aliases: [...aliases].reverse() })
  ).toBe(true);
  expect(check({ NetworkID: "c".repeat(64), Aliases: aliases })).toBe(false);
  expect(
    check({ NetworkID: networkPin.id, Aliases: [...aliases, "extra"] })
  ).toBe(false);
  expect(
    check({ NetworkID: networkPin.id, Aliases: ["web", "web-alias"] })
  ).toBe(false);
  expect(
    check(Object.create({ NetworkID: networkPin.id, Aliases: aliases }))
  ).toBe(false);
  expect(
    check({ NetworkID: networkPin.id, Aliases: [...aliases, "web"] })
  ).toBe(false);
});

test("created recovery admits empty NetworkID with null, empty or configured aliases without admitting ready emptiness", () => {
  const aliases = ["fixture-web-1", "web", "web-alias"];
  for (const wireAliases of [null, [], aliases]) {
    const value = { NetworkID: "", Aliases: wireAliases };
    expect(
      nativeNetworkFixtureAttachmentMatches({
        value,
        networkId: networkPin.id,
        aliases,
        created: true,
      })
    ).toBe(true);
    expect(
      nativeNetworkFixtureAttachmentMatches({
        value,
        networkId: networkPin.id,
        aliases,
        created: false,
      })
    ).toBe(false);
  }
  expect(
    nativeNetworkFixtureAttachmentMatches({
      value: { NetworkID: "", Aliases: ["foreign"] },
      networkId: networkPin.id,
      aliases,
      created: true,
    })
  ).toBe(false);
  expect(
    nativeNetworkFixtureAttachmentMatches({
      value: { NetworkID: "c".repeat(64), Aliases: aliases },
      networkId: networkPin.id,
      aliases,
      created: true,
    })
  ).toBe(false);
});

test("network inventory requests complete physical IDs from the engine", async () => {
  const id = "a".repeat(64);
  const calls: string[][] = [];
  const values = await nativeNetworkFixtureInventory(
    (args) => {
      calls.push([...args]);
      return Promise.resolve(
        args.includes("--no-trunc") ? id : id.slice(0, 12)
      );
    },
    "network",
    project
  );
  expect(values).toEqual([id]);
  expect(calls).toEqual([
    [
      "network",
      "ls",
      "-q",
      "--no-trunc",
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ],
  ]);
});

test.each([
  "a".repeat(12),
  "A".repeat(64),
  `sha256:${"a".repeat(64)}`,
  `${"a".repeat(64)}\n${"a".repeat(64)}`,
  `${"a".repeat(64)}\nnot-an-id`,
])("network inventory refuses malformed or truncated response %s", async (reply) => {
  await expect(
    nativeNetworkFixtureInventory(
      (args) => {
        expect(args).toContain("--no-trunc");
        return Promise.resolve(reply);
      },
      "network",
      project
    )
  ).rejects.toThrow("unique physical identities");
});

test("container inventory retains its full-ID command and validation", async () => {
  const id = "a".repeat(64);
  const calls: string[][] = [];
  expect(
    await nativeNetworkFixtureInventory(
      (args) => {
        calls.push([...args]);
        return Promise.resolve(id);
      },
      "container",
      project
    )
  ).toEqual([id]);
  expect(calls).toEqual([
    [
      "container",
      "ls",
      "-aq",
      "--no-trunc",
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ],
  ]);
  await expect(
    nativeNetworkFixtureInventory(
      () => Promise.resolve(id.slice(0, 12)),
      "container",
      project
    )
  ).rejects.toThrow("unique physical identities");
});

test("volume inventory preserves legitimate names and its original invocation", async () => {
  const names = ["shared-deps", "a".repeat(12)];
  const calls: string[][] = [];
  expect(
    await nativeNetworkFixtureInventory(
      (args) => {
        calls.push([...args]);
        return Promise.resolve(names.join("\n"));
      },
      "volume",
      project
    )
  ).toEqual([...names].sort());
  expect(calls).toEqual([
    [
      "volume",
      "ls",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ],
  ]);
  await expect(
    nativeNetworkFixtureInventory(
      () => Promise.resolve(`${names[0]}\n${names[0]}`),
      "volume",
      project
    )
  ).rejects.toThrow("unique physical identities");
});

test("empty inventories remain valid for exact absence checks", async () => {
  for (const kind of ["container", "network", "volume"] as const) {
    expect(
      await nativeNetworkFixtureInventory(
        () => Promise.resolve(""),
        kind,
        project
      )
    ).toEqual([]);
  }
});

test("controlled created interruption rewrites only the exact admitted product up argv", () => {
  const args = [
    "compose",
    "-p",
    project,
    "-f",
    "/owned/generation/compose.json",
    "up",
    "-d",
    "--remove-orphans",
  ];
  expect(nativeNetworkFixtureCreateArgs(args, project)).toEqual([
    ...args.slice(0, 5),
    "create",
    "--no-build",
    "--pull",
    "never",
  ]);
  for (const changed of [
    args.slice(0, 7),
    [...args.slice(0, 6), "--remove-orphans", "-d"],
    [...args, "web"],
    [...args.slice(0, -1), "--force-recreate"],
    ["compose", "-p", "foreign", ...args.slice(3)],
    [...args.slice(0, 4), "relative/compose.json", ...args.slice(5)],
    [...args.slice(0, 4), "/owned/override.yaml", ...args.slice(5)],
    [...args.slice(0, 5), "run", "-d"],
    ["container", "rm", "-f", networkPin.id],
  ]) {
    expect(nativeNetworkFixtureCreateArgs(changed, project)).toBeNull();
  }
});

test("generated create shim matches the strict argv oracle without calling Docker", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-network-create-shim-"))
  );
  const receipt = join(root, "receipt");
  const calls = join(root, "engine-call.json");
  try {
    const engine = join(root, "synthetic-engine");
    await writeFile(
      engine,
      `#!${process.execPath}\nawait Bun.write(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2)));\n`,
      { mode: 0o700 }
    );
    const document = join(root, "compose.json");
    await writeFile(
      document,
      JSON.stringify({
        services: Object.fromEntries(
          ["web", "peer", "vault", "reader"].map((name) => [
            name,
            {
              labels: {
                "io.hack.native-config.owner": owner,
                "io.hack.native-config.instance": project,
              },
            },
          ])
        ),
      }),
      { mode: 0o600 }
    );
    const shim = await nativeNetworkFixtureShim({
      root: join(root, "shim"),
      engine,
      bun: process.execPath,
      identity: {
        checkoutRoot: root,
        repositoryRoot: root,
        instance: null,
        instanceId: "a".repeat(64),
        composeProject: project,
        ownerToken: owner,
      },
      create: true,
      receipt,
    });
    const args = [
      "compose",
      "-p",
      project,
      "-f",
      document,
      "up",
      "-d",
      "--remove-orphans",
    ];
    const invoke = (argv: readonly string[]) =>
      runNativeNetworkFixtureCommand({
        argv: [join(shim, "docker"), ...argv],
        cwd: root,
        env: {},
        captures: join(root, "captures"),
        timeoutMs: 30_000,
      });
    for (const changed of [
      args.slice(0, 7),
      [...args.slice(0, 6), "--remove-orphans", "-d"],
      [...args, "web"],
      [...args.slice(0, 7), "--force-recreate"],
      ["compose", "-p", "foreign", ...args.slice(3)],
      [...args.slice(0, 4), "relative/compose.json", ...args.slice(5)],
      [...args.slice(0, 4), "/owned/override.yaml", ...args.slice(5)],
    ]) {
      expect(nativeNetworkFixtureCreateArgs(changed, project)).toBeNull();
      expect((await invoke(changed)).exitCode).toBe(98);
      expect(await Bun.file(receipt).exists()).toBe(false);
      expect(await Bun.file(calls).exists()).toBe(false);
    }
    expect((await invoke(args)).exitCode).toBe(71);
    expect(await Bun.file(receipt).text()).toBe("create-admitted");
    const actualCall = await Bun.file(calls).text();
    expect(JSON.parse(actualCall)).toEqual(
      nativeNetworkFixtureCreateArgs(args, project)
    );
    expect((await invoke(args)).exitCode).toBe(98);
    expect(await Bun.file(calls).text()).toBe(actualCall);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publication verifier permits exposed-unpublished ports and refuses host bindings or unexpected keys", () => {
  for (const value of [
    null,
    {},
    { "3000/tcp": null },
    { "80/tcp": null, "443/tcp": null },
  ]) {
    expect(nativeNetworkFixtureHasNoPublication(value)).toBe(true);
  }
  for (const value of [
    undefined,
    [],
    { "3000/tcp": [] },
    { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "3000" }] },
    { constructor: null },
  ]) {
    expect(nativeNetworkFixtureHasNoPublication(value)).toBe(false);
  }
});

test("bounded private capture preserves literal argv, rejects inherited caller credentials and returns exit17", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-network-capture-"));
  const previous = process.env.CALLER_PRIVATE;
  process.env.CALLER_PRIVATE = "synthetic-private-caller-control";
  try {
    const result = await runNativeNetworkFixtureCommand({
      argv: [
        process.execPath,
        "-e",
        "if(process.env.CALLER_PRIVATE)process.exit(23);console.log(JSON.stringify(process.argv.slice(-2)));process.exit(17)",
        "--",
        "space arg",
        "$HOME",
      ],
      cwd: root,
      env: { PATH: "/usr/bin:/bin" },
      captures: join(root, "captures"),
    });
    expect(result.exitCode).toBe(17);
    expect(result.stdout.trim()).toBe('["space arg","$HOME"]');
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, "CALLER_PRIVATE");
    } else {
      process.env.CALLER_PRIVATE = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
});

// HACK-1428: a bare 128 hid which signal ended a fixture command.
test("capture reports a signaled command as 128 plus its signal number", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-network-signal-"));
  try {
    for (const [signal, expected] of [
      ["TERM", 143],
      ["KILL", 137],
    ] as const) {
      const result = await runNativeNetworkFixtureCommand({
        argv: ["/bin/sh", "-c", `kill -${signal} $$`],
        cwd: root,
        env: { PATH: "/usr/bin:/bin" },
        captures: join(root, "captures"),
      });
      expect(result.exitCode).toBe(expected);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture output overflow fails rather than returning a truncated green command", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-network-output-"));
  try {
    await expect(
      runNativeNetworkFixtureCommand({
        argv: [
          process.execPath,
          "-e",
          'process.stdout.write("x".repeat(20000))',
        ],
        cwd: root,
        env: {},
        captures: join(root, "captures"),
        outputLimit: 1024,
      })
    ).rejects.toThrow("output bound");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture timeout reaps the owned descendant group and retains failure evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-network-timeout-"));
  const marker = join(root, "escaped");
  try {
    await expect(
      runNativeNetworkFixtureCommand({
        argv: [
          "/bin/sh",
          "-c",
          '(sleep 1; printf escaped > "$1") & wait',
          "fixture",
          marker,
        ],
        cwd: root,
        env: {},
        captures: join(root, "captures"),
        timeoutMs: 150,
      })
    ).rejects.toThrow("timed out");
    await Bun.sleep(1100);
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owned parent completion cannot leave a delayed background child writing a marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-network-orphan-"));
  const marker = join(root, "escaped");
  try {
    const result = await runNativeNetworkFixtureCommand({
      argv: [
        "/bin/sh",
        "-c",
        '(sleep 1; printf escaped > "$1") & exit 0',
        "fixture",
        marker,
      ],
      cwd: root,
      env: {},
      captures: join(root, "captures"),
      timeoutMs: 2000,
    });
    expect(result.exitCode).toBe(0);
    await Bun.sleep(1100);
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture failure kills and reaps the owned command before allowing fixture cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-network-capture-failure-"));
  const marker = join(root, "escaped");
  try {
    await expect(
      runNativeNetworkFixtureCommand({
        argv: [
          "/bin/sh",
          "-c",
          '(sleep 1; printf escaped > "$1") & printf capture; wait',
          "fixture",
          marker,
        ],
        cwd: root,
        env: {},
        captures: join(root, "captures"),
        timeoutMs: 2000,
        afterCaptureWrite: () => {
          throw new Error("synthetic capture failure");
        },
      })
    ).rejects.toThrow("capture failed after owned command reap");
    await Bun.sleep(1100);
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
