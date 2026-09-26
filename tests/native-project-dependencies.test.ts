import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverNativeHostDependency,
  parseNativeHostDependencies,
  prepareNativeDependencyServices,
  readNativeHostDependencies,
} from "../src/backends/native-project-dependencies.ts";
import { NativeRuntimeRequestError } from "../src/backends/native-runtime-client.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
function binding(service = "web", name = "search") {
  return {
    service,
    binding: name,
    guest_port: 443,
    host_port: 8443,
    host_pid: 123,
    aliases: [`${name}.example.com`],
  };
}
function parse(dependencies: unknown[]) {
  return parseNativeHostDependencies({
    value: { version: 1, dependencies },
    services: ["web", "worker"],
  });
}

const discovery = {
  runtime: { binary: "/synthetic/native", home: "/synthetic/home" },
  projectRoot: "/synthetic/project",
  executable: "/synthetic/tunnel",
  hostPort: 8443,
};
function unavailableListener() {
  return new NativeRuntimeRequestError({
    message: "Native runtime request failed (host_endpoint_identity)",
    nativeCode: "host_endpoint_identity",
  });
}

test("startup discovery waits for a delayed listener and keeps immediate preflight unchanged", async () => {
  let calls = 0;
  const invoke = async () => {
    if (++calls === 1) {
      throw unavailableListener();
    }
    return { host_pid: 456, endpoint_fingerprint: "e".repeat(64) };
  };
  await expect(
    discoverNativeHostDependency({ ...discovery, invoke })
  ).rejects.toThrow("host_endpoint_identity");
  expect(calls).toBe(1);
  calls = 0;
  expect(
    await discoverNativeHostDependency({
      ...discovery,
      invoke,
      wait: {
        deadlineMs: performance.now() + 2000,
        signal: new AbortController().signal,
      },
    })
  ).toEqual({ host_pid: 456, endpoint_fingerprint: "e".repeat(64) });
  expect(calls).toBe(2);
});

test("startup discovery stops on cancellation and never accepts a late query result", async () => {
  const controller = new AbortController();
  let calls = 0;
  const waiting = discoverNativeHostDependency({
    ...discovery,
    wait: { deadlineMs: performance.now() + 2000, signal: controller.signal },
    invoke: async () => {
      calls++;
      queueMicrotask(() => controller.abort());
      throw unavailableListener();
    },
  });
  await expect(waiting).rejects.toThrow();
  expect(calls).toBe(1);
  const late = new AbortController();
  await expect(
    discoverNativeHostDependency({
      ...discovery,
      wait: { deadlineMs: performance.now() + 2000, signal: late.signal },
      invoke: async () => {
        late.abort();
        return { host_pid: 456, endpoint_fingerprint: "e".repeat(64) };
      },
    })
  ).rejects.toThrow("values omitted");
});

test("startup discovery deadline bounds missing listeners and subsequent bindings", async () => {
  const wait = {
    deadlineMs: performance.now() + 30,
    signal: new AbortController().signal,
  };
  let calls = 0;
  const invoke = async () => {
    calls++;
    throw unavailableListener();
  };
  await expect(
    discoverNativeHostDependency({ ...discovery, wait, invoke })
  ).rejects.toThrow("values omitted");
  const exhaustedCalls = calls;
  await expect(
    discoverNativeHostDependency({
      ...discovery,
      hostPort: 8444,
      wait,
      invoke,
    })
  ).rejects.toThrow("values omitted");
  expect(calls).toBe(exhaustedCalls);
});

test("startup discovery does not retry unrelated failures or malformed results", async () => {
  for (const error of [
    new Error("synthetic failure"),
    new NativeRuntimeRequestError({
      message: "native refusal",
      nativeCode: "candidate_ownership",
    }),
  ]) {
    let calls = 0;
    await expect(
      discoverNativeHostDependency({
        ...discovery,
        wait: {
          deadlineMs: performance.now() + 2000,
          signal: new AbortController().signal,
        },
        invoke: async () => {
          calls++;
          throw error;
        },
      })
    ).rejects.toThrow();
    expect(calls).toBe(1);
  }
  let malformedCalls = 0;
  await expect(
    discoverNativeHostDependency({
      ...discovery,
      wait: {
        deadlineMs: performance.now() + 2000,
        signal: new AbortController().signal,
      },
      invoke: async () => {
        malformedCalls++;
        return { password: "synthetic-do-not-print" };
      },
    })
  ).rejects.toThrow("values omitted");
  expect(malformedCalls).toBe(1);
});

test("discovery bounds each request by remaining time and never retries a timed-out query", async () => {
  const now = spyOn(performance, "now").mockReturnValue(100);
  try {
    for (const [deadlineMs, timeoutMs] of [
      [5000, 2000],
      [100.5, 1],
    ] as const) {
      await discoverNativeHostDependency({
        ...discovery,
        wait: { deadlineMs, signal: new AbortController().signal },
        invoke: async (request) => {
          expect(request.timeoutMs).toBe(timeoutMs);
          return { host_pid: 456, endpoint_fingerprint: "e".repeat(64) };
        },
      });
    }
    let calls = 0;
    await expect(
      discoverNativeHostDependency({
        ...discovery,
        wait: { deadlineMs: 5000, signal: new AbortController().signal },
        invoke: async () => {
          calls++;
          throw new NativeRuntimeRequestError({ message: "request timed out" });
        },
      })
    ).rejects.toThrow("request timed out");
    expect(calls).toBe(1);
  } finally {
    now.mockRestore();
  }
});
test("dependency launchers add reaping init only when omitted and preserve explicit refusal", () => {
  const dependencies = parse([binding()]);
  const services: Record<string, Record<string, unknown>> = {
    web: {},
    worker: { init: false },
  };
  prepareNativeDependencyServices({ dependencies, services });
  expect(services.web?.init).toBe(true);
  expect(services.worker?.init).toBe(false);
  const refused = { web: { init: false } };
  expect(() =>
    prepareNativeDependencyServices({ dependencies, services: refused })
  ).toThrow("init: true");
  expect(refused.web.init).toBe(false);
});
test("equal endpoints share transport across services while same-service bindings remain distinct", () => {
  const selected = parse([
    binding(),
    binding("web", "other"),
    binding("worker"),
  ]);
  expect(selected.map((entry) => entry.slot)).toEqual([0, 1, 0]);
  expect(selected[0]?.aliases).toEqual(["search.example.com"]);
  expect(selected[2]?.service).toBe("worker");
});
test("ambiguous, undeclared, wildcard or credential-bearing dependencies refuse without values", () => {
  const bad = [
    [],
    [binding(), binding()],
    [binding("missing")],
    [{ ...binding(), slot: 1 }],
    [{ ...binding(), host_pid: 1 }],
    [{ ...binding(), host_pid: 2 ** 32 }],
    [{ ...binding(), guest_port: 65_536 }],
    [{ ...binding(), host_port: 0 }],
    [{ ...binding(), aliases: [] }],
    [{ ...binding(), aliases: ["*.example.com"] }],
    [{ ...binding(), aliases: ["127.0.0.1"] }],
    [{ ...binding(), aliases: ["localhost"] }],
    [{ ...binding(), aliases: ["X.example.com"] }],
    [{ ...binding(), aliases: ["search.example.com", "search.example.com"] }],
    [{ ...binding(), token: "synthetic-do-not-print" }],
    Array.from({ length: 33 }, (_, i) => binding("web", `h${i}`)),
  ];
  for (const entries of bad) {
    expect(() => parse(entries)).toThrow("values omitted");
  }
  for (const value of [
    null,
    { version: 2, dependencies: [binding()] },
    {
      version: 1,
      dependencies: [binding()],
      password: "synthetic-do-not-print",
    },
  ]) {
    expect(() =>
      parseNativeHostDependencies({ value, services: ["web"] })
    ).toThrow("values omitted");
  }
});
test("selection files are bounded regular files; symlinks and malformed private contents refuse", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-dependencies-"));
  roots.push(root);
  const path = join(root, "selection.json");
  await writeFile(
    path,
    JSON.stringify({ version: 1, dependencies: [binding()] })
  );
  expect(
    (await readNativeHostDependencies({ path, services: ["web"] }))[0]?.host_pid
  ).toBe(123);
  const link = join(root, "link.json");
  await symlink(path, link);
  for (const candidate of [link, root, "relative.json"]) {
    await expect(
      readNativeHostDependencies({ path: candidate, services: ["web"] })
    ).rejects.toThrow("values omitted");
  }
  for (const body of ["synthetic-do-not-print", " ".repeat(65_537)]) {
    await writeFile(path, body);
    await expect(
      readNativeHostDependencies({ path, services: ["web"] })
    ).rejects.toThrow("values omitted");
  }
  expect(await readNativeHostDependencies({ services: ["web"] })).toEqual([]);
});

test("executable-pinned selection refreshes one current PID per shared listener after hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-dependencies-refresh-"));
  roots.push(root);
  const path = join(root, "selection.json");
  const executable = "/usr/local/bin/synthetic-tunnel";
  const selected = [binding(), binding("worker")].map((entry) => {
    const { host_pid: _stale, ...intent } = entry;
    return { ...intent, host_executable: executable };
  });
  await writeFile(path, JSON.stringify({ version: 1, dependencies: selected }));
  const calls: unknown[] = [];
  const discover = async (request: {
    readonly hostPort: number;
    readonly executable: string;
  }) => {
    calls.push(request);
    return { host_pid: 456, endpoint_fingerprint: "a".repeat(64) };
  };
  const result = await readNativeHostDependencies({
    path,
    services: ["web", "worker"],
    discover,
  });
  expect(calls).toEqual([{ hostPort: 8443, executable }]);
  expect(result.map((entry) => [entry.host_pid, entry.slot])).toEqual([
    [456, 0],
    [456, 0],
  ]);
  expect(result[0]?.host_executable).toBe(executable);
  await expect(
    readNativeHostDependencies({ path, services: ["web", "worker"] })
  ).rejects.toThrow("values omitted");
  await expect(
    readNativeHostDependencies({
      path,
      services: ["web", "worker"],
      discover: async () => ({
        host_pid: 456,
        endpoint_fingerprint: "invalid",
      }),
    })
  ).rejects.toThrow("values omitted");
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      dependencies: [{ ...selected[0], host_executable: "relative/tunnel" }],
    })
  );
  calls.length = 0;
  await expect(
    readNativeHostDependencies({ path, services: ["web"], discover })
  ).rejects.toThrow("values omitted");
  expect(calls).toEqual([]);
});

test("72 service-specific grants use six shared host transports", () => {
  const services = Array.from({ length: 12 }, (_, i) => `service-${i}`);
  const entries = services.flatMap((service) =>
    Array.from({ length: 6 }, (_, endpoint) => ({
      ...binding(service, `endpoint-${endpoint}`),
      host_port: 8000 + endpoint,
    }))
  );
  const selected = parseNativeHostDependencies({
    value: { version: 1, dependencies: entries },
    services,
  });
  expect(selected).toHaveLength(72);
  expect(new Set(selected.map((entry) => entry.slot)).size).toBe(6);
  for (const service of services) {
    expect(
      selected
        .filter((entry) => entry.service === service)
        .map((entry) => entry.slot)
    ).toEqual([0, 1, 2, 3, 4, 5]);
  }
  expect(
    new Set(selected.map((entry) => `${entry.service}:${entry.binding}`)).size
  ).toBe(72);
});

test("logical grant bounds and endpoint identity remain independent of transport sharing", () => {
  const services = Array.from({ length: 129 }, (_, i) => `service-${i}`);
  const entries = services.map((service) => binding(service));
  const select = (dependencies: unknown[]) =>
    parseNativeHostDependencies({
      value: { version: 1, dependencies },
      services,
    });
  expect(select(entries.slice(0, 128))).toHaveLength(128);
  expect(() => select(entries)).toThrow("values omitted");
  expect(
    select([
      { ...binding("service-0"), host_pid: 123 },
      { ...binding("service-1"), host_pid: 124 },
    ]).map((entry) => entry.slot)
  ).toEqual([0, 1]);
});
