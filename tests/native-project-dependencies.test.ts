import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compileNativeHostDependencySelection,
  discoverNativeHostDependency,
  nativeDependencyStartupWait,
  parseNativeHostDependencies,
  prepareNativeDependencyServices,
  readNativeHostDependencies,
} from "../src/backends/native-project-dependencies.ts";
import { NativeRuntimeRequestError } from "../src/backends/native-runtime-client.ts";
import {
  expectCodedRefusal,
  expectCodedThrow,
} from "./helpers/closed-refusal.ts";

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
  await expectCodedRefusal(
    discoverNativeHostDependency({
      ...discovery,
      wait: { deadlineMs: performance.now() + 2000, signal: late.signal },
      invoke: async () => {
        late.abort();
        return { host_pid: 456, endpoint_fingerprint: "e".repeat(64) };
      },
    }),
    "E_CONFIG_INVALID",
    "values omitted"
  );
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
  await expectCodedRefusal(
    discoverNativeHostDependency({ ...discovery, wait, invoke }),
    "E_CONFIG_INVALID",
    "values omitted"
  );
  const exhaustedCalls = calls;
  await expectCodedRefusal(
    discoverNativeHostDependency({
      ...discovery,
      hostPort: 8444,
      wait,
      invoke,
    }),
    "E_CONFIG_INVALID",
    "values omitted"
  );
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
  await expectCodedRefusal(
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
    }),
    "E_CONFIG_INVALID",
    "values omitted"
  );
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
  expectCodedThrow(
    () => prepareNativeDependencyServices({ dependencies, services: refused }),
    "E_NATIVE_PROJECT_UNSUPPORTED",
    "init: true"
  );
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

test("wrapped supervisors require an explicit bounded executable selector", () => {
  const selected = {
    ...binding(),
    host_executable: "/synthetic/tunnel",
    host_supervisor_depth: 2,
  };
  expect(parse([selected])[0]?.host_supervisor_depth).toBe(2);
  expect(
    parse([{ ...selected, host_supervisor_depth: 8 }])[0]?.host_supervisor_depth
  ).toBe(8);
  for (const depth of [
    null,
    "2",
    0,
    -1,
    1.5,
    9,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    expectCodedThrow(
      () => parse([{ ...selected, host_supervisor_depth: depth }]),
      "E_CONFIG_INVALID",
      "values omitted"
    );
  }
  expect(() => parse([{ ...binding(), host_supervisor_depth: 2 }])).toThrow(
    "values omitted"
  );
});

test("shared listener transports reject differing supervisor authority", () => {
  const first = { ...binding(), host_executable: "/synthetic/tunnel" };
  const second = { ...binding("worker"), host_executable: "/synthetic/tunnel" };
  expect(
    parse([first, { ...second, host_supervisor_depth: 1 }]).map(
      (item) => item.slot
    )
  ).toEqual([0, 0]);
  for (const replacement of [
    { ...second, host_supervisor_depth: 2 },
    { ...second, host_executable: "/synthetic/foreign" },
    binding("worker"),
  ]) {
    expectCodedThrow(
      () => parse([first, replacement]),
      "E_CONFIG_INVALID",
      "values omitted"
    );
  }
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
    expectCodedThrow(
      () => parse(entries),
      "E_CONFIG_INVALID",
      "values omitted"
    );
  }
  for (const value of [
    null,
    // Version 2 compiles to version 1 first (below); parsing takes version 1 only.
    { version: 2, dependencies: [binding()] },
    { version: 3, dependencies: [binding()] },
    {
      version: 1,
      dependencies: [binding()],
      password: "synthetic-do-not-print",
    },
  ]) {
    expectCodedThrow(
      () => parseNativeHostDependencies({ value, services: ["web"] }),
      "E_CONFIG_INVALID",
      "values omitted"
    );
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
    await expectCodedRefusal(
      readNativeHostDependencies({ path: candidate, services: ["web"] }),
      "E_CONFIG_INVALID",
      "values omitted"
    );
  }
  for (const body of ["synthetic-do-not-print", " ".repeat(65_537)]) {
    await writeFile(path, body);
    await expectCodedRefusal(
      readNativeHostDependencies({ path, services: ["web"] }),
      "E_CONFIG_INVALID",
      "values omitted"
    );
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
    return {
      ...intent,
      host_executable: executable,
      host_supervisor_depth: 2,
      // A longer wait on any entry sharing the listener applies to it.
      ...(entry.service === "worker" ? { host_wait_seconds: 240 } : {}),
    };
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
  expect(calls).toEqual([
    {
      hostPort: 8443,
      executable,
      waitSeconds: 240,
      service: "web",
      binding: "search",
    },
  ]);
  for (const entry of result) {
    expect(entry).not.toHaveProperty("host_wait_seconds");
  }
  expect(result.map((entry) => [entry.host_pid, entry.slot])).toEqual([
    [456, 0],
    [456, 0],
  ]);
  expect(result[0]?.host_executable).toBe(executable);
  expect(result.map((entry) => entry.host_supervisor_depth)).toEqual([2, 2]);
  await expectCodedRefusal(
    readNativeHostDependencies({ path, services: ["web", "worker"] }),
    "E_CONFIG_INVALID",
    "values omitted"
  );
  await expectCodedRefusal(
    readNativeHostDependencies({
      path,
      services: ["web", "worker"],
      discover: async () => ({
        host_pid: 456,
        endpoint_fingerprint: "invalid",
      }),
    }),
    "E_CONFIG_INVALID",
    "values omitted"
  );
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      dependencies: [{ ...selected[0], host_executable: "relative/tunnel" }],
    })
  );
  calls.length = 0;
  await expectCodedRefusal(
    readNativeHostDependencies({ path, services: ["web"], discover }),
    "E_CONFIG_INVALID",
    "values omitted"
  );
  expect(calls).toEqual([]);
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      dependencies: [{ ...selected[0], host_supervisor_depth: 9 }],
    })
  );
  await expectCodedRefusal(
    readNativeHostDependencies({ path, services: ["web"], discover }),
    "E_CONFIG_INVALID",
    "values omitted"
  );
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
  expectCodedThrow(() => select(entries), "E_CONFIG_INVALID", "values omitted");
  expect(
    select([
      { ...binding("service-0"), host_pid: 123 },
      { ...binding("service-1"), host_pid: 124 },
    ]).map((entry) => entry.slot)
  ).toEqual([0, 1]);
});

function refusalMessage(action: () => unknown): string {
  try {
    action();
  } catch (error: unknown) {
    expect(error).toHaveProperty("code", "E_CONFIG_INVALID");
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
}

test("selection refusals name the binding, alias, port and reason without listener values", () => {
  const cases: [unknown[], string][] = [
    [
      [{ ...binding(), guest_port: 70_000 }],
      "dependency #1 (service web, binding search, aliases search.example.com, host port 8443): guest_port must be an integer 1..65535",
    ],
    [
      [{ ...binding(), host_port: 0 }],
      "dependency #1 (service web, binding search, aliases search.example.com, guest port 443): host_port must be an integer 1..65535",
    ],
    [
      [binding(), { ...binding("missing", "db") }],
      "dependency #2 (service missing, binding db, aliases db.example.com, guest port 443, host port 8443): service is not declared in the Compose file",
    ],
    [
      [binding(), binding()],
      "dependency #2 (service web, binding search, aliases search.example.com, guest port 443, host port 8443): the binding is declared twice for this service",
    ],
    [
      [{ ...binding(), aliases: ["localhost"] }],
      "dependency #1 (service web, binding search, guest port 443, host port 8443): aliases must list 1..8 lowercase DNS hostnames",
    ],
    [
      [{ ...binding(), host_pid: 1 }],
      "host_pid must be a process ID greater than 1",
    ],
    [
      [{ ...binding(), token: "synthetic-do-not-print" }],
      "unsupported field token",
    ],
    [
      [{ ...binding(), "synthetic do-not-print": 1 }],
      "): unsupported field; listener values omitted.",
    ],
  ];
  for (const [entries, expected] of cases) {
    const message = refusalMessage(() => parse(entries));
    expect(message).toStartWith("Native host dependencies refused for ");
    expect(message).toContain(expected);
    expect(message).toEndWith("; listener values omitted.");
    expect(message).not.toContain("synthetic-do-not-print");
    expect(message).not.toContain("do-not-print");
    // Host process identity is never echoed.
    expect(message).not.toContain("123");
  }
  expect(
    refusalMessage(() =>
      parseNativeHostDependencies({
        value: { version: 2, dependencies: [binding()] },
        services: ["web"],
      })
    )
  ).toBe(
    "Native host dependencies refused: the selection must be {version: 1, dependencies: [1..128 entries]} with no other fields; listener values omitted."
  );
});

test("a listener missing past the discovery deadline names its binding and port", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-dependencies-"));
  roots.push(root);
  const path = join(root, "selection.json");
  const { host_pid: _pid, ...selected } = binding();
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      dependencies: [
        { ...selected, host_executable: "/synthetic/private-tunnel" },
      ],
    })
  );
  const wait = {
    deadlineMs: performance.now() + 20,
    signal: new AbortController().signal,
  };
  const failure = await readNativeHostDependencies({
    path,
    services: ["web"],
    discover: async ({ executable, hostPort }) =>
      await discoverNativeHostDependency({
        ...discovery,
        executable,
        hostPort,
        wait,
        invoke: async () => {
          throw unavailableListener();
        },
      }),
    listenerHooks: ["tunnels", "hook-2"],
  }).catch((error: unknown) => error);
  expect(failure).toHaveProperty("code", "E_CONFIG_INVALID");
  expect((failure as Error).message).toBe(
    "Native host dependencies refused for dependency #1 (service web, binding search, aliases search.example.com, guest port 443, host port 8443): no listener owned by host_executable answered on host_port before the discovery deadline (waited 60 s after the up.before hooks; persistent hooks and processes: tunnels, hook-2); if the listener starts more slowly, set host_wait_seconds on this binding (default 60, at most 900); listener values omitted."
  );
  expect((failure as Error).message).not.toContain("private-tunnel");

  const unhooked = await readNativeHostDependencies({
    path,
    services: ["web"],
    discover: async ({ executable, hostPort }) =>
      await discoverNativeHostDependency({
        ...discovery,
        executable,
        hostPort,
        wait: {
          deadlineMs: performance.now() + 20,
          signal: new AbortController().signal,
        },
        invoke: async () => {
          throw unavailableListener();
        },
      }),
  }).catch((error: unknown) => error);
  expect((unhooked as Error).message).toContain(
    "(waited 60 s after the up.before hooks; no persistent up.before hook or lifecycle process ran)"
  );

  const coded = await readNativeHostDependencies({
    path,
    services: ["web"],
    discover: async () => {
      throw new NativeRuntimeRequestError({
        message: "synthetic-do-not-print",
        nativeCode: "candidate_ownership",
      });
    },
  }).catch((error: unknown) => error);
  expect((coded as Error).message).toContain(
    "host port 8443): listener discovery failed (candidate_ownership); listener values omitted."
  );
  expect((coded as Error).message).not.toContain("synthetic-do-not-print");
});

test("a malformed selection file reports JSON syntax without echoing its contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-dependencies-"));
  roots.push(root);
  const path = join(root, "selection.json");
  await writeFile(path, "synthetic-do-not-print");
  const failure = await readNativeHostDependencies({
    path,
    services: ["web"],
  }).catch((error: unknown) => error);
  expect((failure as Error).message).toBe(
    "Native host dependencies refused: the selection file is not valid UTF-8 JSON; listener values omitted."
  );
});

const declaredAliases = {
  web: ["api.example.test", "auth.example.test"],
  worker: ["api.example.test"],
  db: [],
};
function declarative(entry: Record<string, unknown> = {}) {
  return {
    binding: "api",
    guest_port: 443,
    host_port: 8443,
    host_executable: "/usr/local/bin/synthetic-tunnel",
    host_supervisor_depth: 2,
    aliases: ["api.example.test", "auth.example.test"],
    ...entry,
  };
}
function compile(dependencies: unknown[], hostAliases = declaredAliases) {
  return compileNativeHostDependencySelection({
    value: { version: 2, dependencies },
    hostAliases,
  });
}

test("a declarative binding expands to every service that declares its aliases", () => {
  const authority = {
    binding: "api",
    guest_port: 443,
    host_port: 8443,
    host_executable: "/usr/local/bin/synthetic-tunnel",
    host_supervisor_depth: 2,
  };
  expect(compile([declarative()])).toEqual({
    version: 1,
    dependencies: [
      {
        ...authority,
        service: "web",
        aliases: ["api.example.test", "auth.example.test"],
      },
      { ...authority, service: "worker", aliases: ["api.example.test"] },
    ],
  });
  expect(
    compile([
      declarative({ services: ["worker"], aliases: ["api.example.test"] }),
    ])
  ).toEqual({
    version: 1,
    dependencies: [
      { ...authority, service: "worker", aliases: ["api.example.test"] },
    ],
  });
  const v1 = { version: 1, dependencies: [binding()] };
  expect(
    compileNativeHostDependencySelection({
      value: v1,
      hostAliases: declaredAliases,
    })
  ).toBe(v1);
});

test("declarative bindings refuse unused, ambiguous or unscoped authority before discovery", () => {
  for (const value of [
    { version: 2, dependencies: [] },
    { version: 2, dependencies: [declarative()], extra: true },
    { version: 2 },
    {
      version: 2,
      dependencies: Array.from({ length: 129 }, (_, i) =>
        declarative({ binding: `b${i}` })
      ),
    },
  ]) {
    expectCodedThrow(
      () =>
        compileNativeHostDependencySelection({
          value,
          hostAliases: declaredAliases,
        }),
      "E_CONFIG_INVALID",
      "values omitted"
    );
  }
  for (const dependencies of [
    // The same binding twice.
    [declarative(), declarative()],
    // A listed service declares none of the aliases.
    [declarative({ services: ["db"] })],
    // An alias no selected service declares.
    [declarative({ aliases: ["api.example.test", "other.example.test"] })],
    [declarative({ services: ["worker"] })],
    // Unknown, inactive, repeated or empty service scopes.
    [declarative({ services: ["missing"] })],
    [declarative({ services: ["web", "web"] })],
    [declarative({ services: [] })],
    [declarative({ services: "web" })],
    // Both service selectors, an inactive single service, or an unknown key.
    [declarative({ service: "web", services: ["web"] })],
    [declarative({ service: "missing" })],
    [declarative({ service: "db" })],
    [declarative({ value: "synthetic-do-not-print" })],
    [declarative({ aliases: [] })],
    [declarative({ aliases: ["api.example.test", "api.example.test"] })],
  ]) {
    const error = expectCodedThrow(
      () => compile(dependencies),
      "E_CONFIG_INVALID",
      "values omitted"
    );
    expect(error.message).not.toContain("synthetic");
  }
  expectCodedThrow(
    () =>
      compileNativeHostDependencySelection({
        value: { version: 2, dependencies: [declarative()] },
      }),
    "E_CONFIG_INVALID",
    "values omitted"
  );
});

test("limits apply after declarative expansion and one discovery serves every expanded binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-dependencies-v2-"));
  roots.push(root);
  const path = join(root, "selection.json");
  const many = Object.fromEntries(
    Array.from({ length: 129 }, (_, i) => [`s${i}`, ["api.example.test"]])
  );
  await writeFile(
    path,
    JSON.stringify({
      version: 2,
      dependencies: [declarative({ aliases: ["api.example.test"] })],
    })
  );
  await expectCodedRefusal(
    readNativeHostDependencies({
      path,
      services: Object.keys(many),
      hostAliases: many,
      discover: async () => ({
        host_pid: 456,
        endpoint_fingerprint: "e".repeat(64),
      }),
    }),
    "E_CONFIG_INVALID",
    "values omitted"
  );
  const discovered: unknown[] = [];
  await writeFile(
    path,
    JSON.stringify({ version: 2, dependencies: [declarative()] })
  );
  const selected = await readNativeHostDependencies({
    path,
    services: ["web", "worker", "db"],
    hostAliases: declaredAliases,
    discover: async (selection) => {
      discovered.push(selection);
      return { host_pid: 456, endpoint_fingerprint: "e".repeat(64) };
    },
  });
  expect(discovered).toEqual([
    {
      executable: "/usr/local/bin/synthetic-tunnel",
      hostPort: 8443,
      waitSeconds: 60,
      service: "web",
      binding: "api",
    },
  ]);
  expect(
    selected.map(({ service, slot, host_pid, aliases }) => ({
      service,
      slot,
      host_pid,
      aliases,
    }))
  ).toEqual([
    {
      service: "web",
      slot: 0,
      host_pid: 456,
      aliases: ["api.example.test", "auth.example.test"],
    },
    {
      service: "worker",
      slot: 0,
      host_pid: 456,
      aliases: ["api.example.test"],
    },
  ]);
  await expectCodedRefusal(
    readNativeHostDependencies({ path, services: ["web", "worker", "db"] }),
    "E_CONFIG_INVALID",
    "values omitted"
  );
});

// A compact services list (#598) is the version 2 `services` selector: each
// listed service receives the binding's aliases it declares, so a list whose
// services declare every alias equals the repeated version 1 entries.
const compactAliases = {
  web: ["search.example.com", "content.example.com"],
  worker: ["search.example.com"],
  api: ["search.example.com"],
};
function parseCompact(
  value: unknown,
  services: readonly string[],
  hostAliases: Readonly<Record<string, readonly string[]>> = compactAliases
) {
  return parseNativeHostDependencies({
    value: compileNativeHostDependencySelection({ value, hostAliases }),
    services,
  });
}

test("a version 2 entry with services expands to the same plan as version 1 entries", () => {
  const { service: _web, ...shared } = binding();
  const services = ["web", "worker", "api"];
  const v1 = parseNativeHostDependencies({
    value: {
      version: 1,
      dependencies: [
        ...services.map((service) => binding(service)),
        binding("web", "content"),
      ],
    },
    services,
  });
  const v2 = parseCompact(
    {
      version: 2,
      dependencies: [{ ...shared, services }, binding("web", "content")],
    },
    services
  );
  expect(v2).toEqual(v1);
  // Shared listeners still get one transport per service, as in version 1.
  expect(v2.map((entry) => [entry.service, entry.slot])).toEqual([
    ["web", 0],
    ["worker", 0],
    ["api", 0],
    ["web", 1],
  ]);
  // Version 1 values pass through unchanged.
  const value = { version: 1, dependencies: [binding()] };
  expect(
    compileNativeHostDependencySelection({
      value,
      hostAliases: compactAliases,
    })
  ).toBe(value);
});

test("version 2 limits and duplicate checks apply after expansion", () => {
  const { service: _web, ...shared } = binding();
  const many = Array.from({ length: 65 }, (_, index) => `svc-${index}`);
  const hostAliases = Object.fromEntries(
    ["web", "worker", ...many].map((service) => [
      service,
      ["search.example.com", "other.example.com"],
    ])
  );
  const refusals: unknown[] = [
    // 130 expanded bindings exceed the 128-binding limit.
    {
      version: 2,
      dependencies: [
        { ...shared, services: many },
        {
          ...shared,
          binding: "other",
          aliases: ["other.example.com"],
          services: many,
        },
      ],
    },
    // A service listed twice for one binding is a duplicate binding.
    { version: 2, dependencies: [{ ...shared, services: ["web", "web"] }] },
    // The same binding from a services list and a single entry is a duplicate.
    {
      version: 2,
      dependencies: [{ ...shared, services: ["web", "worker"] }, binding()],
    },
    // At most one of service and services.
    {
      version: 2,
      dependencies: [{ ...shared, service: "web", services: ["worker"] }],
    },
    { version: 2, dependencies: [{ ...shared, services: [] }] },
    { version: 2, dependencies: [{ ...shared, services: "web" }] },
    { version: 2, dependencies: [{ ...shared, services: ["web"], extra: 1 }] },
    { version: 2, dependencies: [] },
    {
      version: 2,
      dependencies: [binding()],
      password: "synthetic-do-not-print",
    },
    { version: 3, dependencies: [binding()] },
  ];
  for (const value of refusals) {
    expectCodedThrow(
      () => parseCompact(value, ["web", "worker", ...many], hostAliases),
      "E_CONFIG_INVALID",
      "values omitted"
    );
  }
  // Naming neither selector applies the binding to every service that
  // declares its alias (the declarative form above), not a refusal.
  expect(
    parseCompact(
      { version: 2, dependencies: [shared] },
      ["web", "worker", ...many],
      hostAliases
    )
  ).toHaveLength(67);
  expect(
    parseCompact(
      {
        version: 2,
        dependencies: [
          { ...shared, services: many.slice(0, 64) },
          {
            ...shared,
            binding: "other",
            aliases: ["other.example.com"],
            services: many.slice(0, 64),
          },
        ],
      },
      many,
      hostAliases
    )
  ).toHaveLength(128);
});

test("a version 2 file discovers one PID per shared executable listener", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-dependencies-v2-"));
  roots.push(root);
  const path = join(root, "selection.json");
  const executable = "/usr/local/bin/synthetic-tunnel";
  const { service: _web, host_pid: _pid, ...shared } = binding();
  await writeFile(
    path,
    JSON.stringify({
      version: 2,
      dependencies: [
        { ...shared, host_executable: executable, services: ["web", "worker"] },
      ],
    })
  );
  const calls: unknown[] = [];
  const result = await readNativeHostDependencies({
    path,
    services: ["web", "worker"],
    hostAliases: compactAliases,
    discover: async (request) => {
      calls.push(request);
      return { host_pid: 456, endpoint_fingerprint: "a".repeat(64) };
    },
  });
  expect(calls).toEqual([
    {
      hostPort: 8443,
      executable,
      waitSeconds: 60,
      service: "web",
      binding: "search",
    },
  ]);
  expect(result.map((entry) => [entry.service, entry.host_pid])).toEqual([
    ["web", 456],
    ["worker", 456],
  ]);
});

async function selectionFile(value: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "native-dependencies-wait-"));
  roots.push(root);
  const path = join(root, "selection.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}
function executableBinding(extra: Record<string, unknown> = {}) {
  const { host_pid: _pid, ...intent } = binding();
  return {
    ...intent,
    host_executable: "/synthetic/private-tunnel",
    ...extra,
  };
}

test("host_wait_seconds is bounded and needs a discovered listener", async () => {
  for (const value of [0, 901, 1.5, "120", null]) {
    await expectCodedRefusal(
      readNativeHostDependencies({
        path: await selectionFile({
          version: 1,
          dependencies: [executableBinding({ host_wait_seconds: value })],
        }),
        services: ["web"],
        discover: async () => {
          throw new Error("discovery must not run for an invalid selection");
        },
      }),
      "E_CONFIG_INVALID",
      "host port 8443): host_wait_seconds must be an integer 1..900; listener values omitted."
    );
  }
  await expectCodedRefusal(
    readNativeHostDependencies({
      path: await selectionFile({
        version: 1,
        dependencies: [{ ...binding(), host_wait_seconds: 120 }],
      }),
      services: ["web"],
    }),
    "E_CONFIG_INVALID",
    "host_wait_seconds requires host_executable, host_lifecycle or host_shared_helper; a fixed host_pid is never waited for"
  );
  // Version 2 entries accept the same field for every expanded binding.
  const calls: unknown[] = [];
  await readNativeHostDependencies({
    path: await selectionFile({
      version: 2,
      dependencies: [
        {
          binding: "search",
          guest_port: 443,
          aliases: ["search.example.com"],
          host_port: 8443,
          host_executable: "/synthetic/private-tunnel",
          host_wait_seconds: 900,
        },
      ],
    }),
    services: ["web", "worker"],
    hostAliases: {
      web: ["search.example.com"],
      worker: ["search.example.com"],
    },
    discover: async (request) => {
      calls.push(request.waitSeconds);
      return { host_pid: 456, endpoint_fingerprint: "e".repeat(64) };
    },
  });
  expect(calls).toEqual([900]);
});

test("each binding waits its own host_wait_seconds from the end of the hooks", () => {
  const signal = new AbortController().signal;
  const target = {
    hostPort: 8443,
    service: "web",
    binding: "search",
  };
  expect(
    nativeDependencyStartupWait({
      target: { ...target, waitSeconds: 60 },
      startedAtMs: 1000,
      signal,
    }).deadlineMs
  ).toBe(61_000);
  // A later binding is not cut short by the time an earlier one took.
  expect(
    nativeDependencyStartupWait({
      target: { ...target, waitSeconds: 300 },
      startedAtMs: 1000,
      signal,
    }).deadlineMs
  ).toBe(301_000);
});

test("startup wait reports progress on the first retry and then every ten seconds", () => {
  let now = 5000;
  const reports: unknown[] = [];
  const wait = nativeDependencyStartupWait({
    target: {
      hostPort: 8443,
      waitSeconds: 180,
      service: "web",
      binding: "search",
    },
    startedAtMs: 1000,
    signal: new AbortController().signal,
    now: () => now,
    report: (progress) => {
      reports.push(progress);
      throw new Error("an observer failure never changes discovery");
    },
  });
  for (const at of [5000, 5500, 14_999, 15_000, 20_000, 25_000]) {
    now = at;
    wait.onRetry?.();
  }
  const progress = (waitedSeconds: number) => ({
    service: "web",
    binding: "search",
    hostPort: 8443,
    waitedSeconds,
    limitSeconds: 180,
  });
  expect(reports).toEqual([progress(4), progress(14), progress(24)]);
});

test("a listener that appears 61 s after the hooks needs a longer host_wait_seconds", async () => {
  // The hooks ended 61 s ago; the listener answers on the second query.
  const startedAtMs = performance.now() - 61_000;
  const read = async (extra: Record<string, unknown>) => {
    let calls = 0;
    const reports: unknown[] = [];
    const result = await readNativeHostDependencies({
      path: await selectionFile({
        version: 1,
        dependencies: [executableBinding(extra)],
      }),
      services: ["web"],
      discover: async (selection) =>
        await discoverNativeHostDependency({
          ...discovery,
          executable: selection.executable,
          hostPort: selection.hostPort,
          wait: nativeDependencyStartupWait({
            target: selection,
            startedAtMs,
            signal: new AbortController().signal,
            report: (progress) => reports.push(progress),
          }),
          invoke: async () => {
            if (++calls === 1) {
              throw unavailableListener();
            }
            return { host_pid: 456, endpoint_fingerprint: "e".repeat(64) };
          },
        }),
      listenerHooks: ["tunnels"],
    }).catch((error: unknown) => error);
    return { result, calls, reports };
  };
  const fixed = await read({});
  expect((fixed.result as Error).message).toContain(
    "(waited 60 s after the up.before hooks; persistent hooks and processes: tunnels); if the listener starts more slowly, set host_wait_seconds"
  );
  expect(fixed.calls).toBe(0);

  const longer = await read({ host_wait_seconds: 120 });
  expect(longer.calls).toBe(2);
  expect(longer.result).toEqual([
    expect.objectContaining({ binding: "search", host_pid: 456 }),
  ]);
  expect(longer.reports).toEqual([
    {
      service: "web",
      binding: "search",
      hostPort: 8443,
      waitedSeconds: 61,
      limitSeconds: 120,
    },
  ]);
});

test("a listener reparented to PID 1 refuses at discovery with its binding and reason", async () => {
  let calls = 0;
  const failure = await readNativeHostDependencies({
    path: await selectionFile({
      version: 1,
      dependencies: [executableBinding()],
    }),
    services: ["web"],
    discover: async (selection) =>
      await discoverNativeHostDependency({
        ...discovery,
        executable: selection.executable,
        hostPort: selection.hostPort,
        wait: {
          deadlineMs: performance.now() + 2000,
          signal: new AbortController().signal,
        },
        invoke: async () => {
          calls++;
          throw new NativeRuntimeRequestError({
            message: "synthetic-do-not-print",
            nativeCode: "host_endpoint_unsupervised",
          });
        },
      }),
  }).catch((error: unknown) => error);
  // Not retried: the parent cannot come back, and no runtime work follows.
  expect(calls).toBe(1);
  expect(failure).toHaveProperty("code", "E_CONFIG_INVALID");
  expect((failure as Error).message).toBe(
    "Native host dependencies refused for dependency #1 (service web, binding search, aliases search.example.com, guest port 443, host port 8443): the listener on host_port has no supervising parent process (its parent is PID 1, as after nohup … &, ssh -f or a daemonizing fork); keep it under a parent that stays running, such as a persistent up.before hook that waits for it; listener values omitted."
  );
});

test("a pinned listener refusal names binding aliases and port without private process values", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-dependencies-"));
  roots.push(root);
  const path = join(root, "selection.json");
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      dependencies: [
        {
          service: "web",
          binding: "api",
          guest_port: 443,
          aliases: ["api.example.test"],
          host_pid: 12_345,
          host_port: 8443,
        },
      ],
    })
  );
  const failure = await readNativeHostDependencies({
    path,
    services: ["web"],
    checkPinned: async () => {
      throw new NativeRuntimeRequestError({
        nativeCode: "host_endpoint_identity",
        message: "private process detail",
      });
    },
  }).catch((error: unknown) => error);
  expect((failure as Error).message).toContain(
    "service web, binding api, aliases api.example.test, guest port 443, host port 8443"
  );
  expect((failure as Error).message).toContain("host_endpoint_identity");
  expect((failure as Error).message).not.toContain("12345");
  expect((failure as Error).message).not.toContain("private process detail");
});
