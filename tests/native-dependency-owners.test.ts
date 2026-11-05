import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNativeDependencyOwnerResolver,
  NATIVE_DEPENDENCY_OWNER_MISMATCH,
  NATIVE_DEPENDENCY_OWNER_UNAVAILABLE,
  type NativeDependencyOwner,
  type NativeDependencyOwnerReaders,
} from "../src/backends/native-dependency-owners.ts";
import {
  discoverNativeOwnedHostDependency,
  type NativeOwnedDiscovery,
  provisionalNativeHostDependencies,
  readNativeHostDependencies,
} from "../src/backends/native-project-dependencies.ts";
import { NativeRuntimeRequestError } from "../src/backends/native-runtime-client.ts";
import { HackCliError } from "../src/lib/cli-result.ts";
import type { LifecycleStateEntry } from "../src/lib/lifecycle-runtime.ts";
import type { ProjectSharedHelperConfig } from "../src/lib/project-shared-helpers.ts";
import {
  readOwnedSharedHostProcess,
  type SharedHostProcesses,
} from "../src/lib/shared-host-lifecycle.ts";
import { expectCodedRefusal } from "./helpers/closed-refusal.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const OWNER_PID = 4100;
const START = 1_700_000_000_123_456;
const FINGERPRINT = "f".repeat(64);

function ownedEntry(
  service: string,
  owner: Record<string, string> = { host_lifecycle: "tunnel" }
) {
  return {
    service,
    binding: "search",
    guest_port: 443,
    host_port: 8443,
    aliases: ["search.example.com"],
    ...owner,
  };
}

async function selection(dependencies: unknown[]): Promise<string> {
  const root = await scratch("native-dependency-owners-");
  const path = join(root, "selection.json");
  await writeFile(path, JSON.stringify({ version: 1, dependencies }));
  return path;
}

function discovered(
  overrides: Partial<NativeOwnedDiscovery> = {}
): NativeOwnedDiscovery {
  return {
    host_pid: 4321,
    endpoint_fingerprint: FINGERPRINT,
    executable: "/usr/local/bin/synthetic-tunnel",
    supervisor_depth: 3,
    ancestor_pid: OWNER_PID,
    ancestor_start_micros: START,
    ...overrides,
  };
}

function recordingOwners(opts: { readonly confirmFails?: boolean } = {}) {
  const events: string[] = [];
  return {
    events,
    owners: async (owner: NativeDependencyOwner) => {
      events.push(`resolve:${owner.kind}:${owner.name}`);
      return {
        pid: OWNER_PID,
        confirm: async () => {
          events.push("confirm");
          if (opts.confirmFails) {
            throw new HackCliError({
              code: "E_CONFIG_INVALID",
              message: NATIVE_DEPENDENCY_OWNER_UNAVAILABLE,
            });
          }
        },
      };
    },
  };
}

test("a lifecycle owner resolves one listener beneath it and pins the owner for review", async () => {
  const path = await selection([ownedEntry("web"), ownedEntry("worker")]);
  const { events, owners } = recordingOwners();
  const result = await readNativeHostDependencies({
    path,
    services: ["web", "worker"],
    owners,
    discoverOwned: async (request) => {
      events.push(`discover:${request.hostPort}:${request.ancestorPid}`);
      return discovered();
    },
  });
  // One resolution and discovery for the shared listener; ownership is
  // re-proved only after discovery.
  expect(events).toEqual([
    "resolve:lifecycle:tunnel",
    `discover:8443:${OWNER_PID}`,
    "confirm",
  ]);
  expect(result).toHaveLength(2);
  for (const entry of result) {
    expect(entry).toEqual({
      service: entry.service,
      binding: "search",
      slot: 0,
      guest_port: 443,
      host_port: 8443,
      host_pid: 4321,
      host_executable: "/usr/local/bin/synthetic-tunnel",
      host_supervisor_depth: 3,
      host_ancestor_pid: OWNER_PID,
      host_ancestor_start_micros: START,
      aliases: ["search.example.com"],
    });
    // Owner names never reach native review.
    expect(Object.keys(entry)).not.toContain("host_lifecycle");
  }
});

test("an owner that is itself the listener becomes a fixed PID with no replacement authority", async () => {
  const path = await selection([
    ownedEntry("web", { host_shared_helper: "search-proxy" }),
  ]);
  const { events, owners } = recordingOwners();
  const [entry] = await readNativeHostDependencies({
    path,
    services: ["web"],
    owners,
    discoverOwned: async () =>
      discovered({ host_pid: OWNER_PID, supervisor_depth: 0 }),
  });
  expect(events[0]).toBe("resolve:sharedHelper:search-proxy");
  expect(entry?.host_pid).toBe(OWNER_PID);
  expect(entry?.host_executable).toBeUndefined();
  expect(entry?.host_supervisor_depth).toBeUndefined();
  expect(entry?.host_ancestor_pid).toBeUndefined();
});

test("owner refusals keep their closed text; other failures stay generic", async () => {
  const path = await selection([ownedEntry("web")]);
  await expectCodedRefusal(
    readNativeHostDependencies({
      path,
      services: ["web"],
      owners: recordingOwners({ confirmFails: true }).owners,
      discoverOwned: async () => discovered(),
    }),
    "E_CONFIG_INVALID",
    NATIVE_DEPENDENCY_OWNER_UNAVAILABLE
  );
  await expectCodedRefusal(
    readNativeHostDependencies({
      path,
      services: ["web"],
      owners: recordingOwners().owners,
      discoverOwned: async () => {
        throw new NativeRuntimeRequestError({
          message: "Native runtime request failed (host_endpoint_owner)",
          nativeCode: "host_endpoint_owner",
        });
      },
    }),
    "E_CONFIG_INVALID",
    NATIVE_DEPENDENCY_OWNER_MISMATCH
  );
  // Without an owner resolver (for example an unsupported caller) owner
  // selections refuse rather than falling back to another authority.
  await expectCodedRefusal(
    readNativeHostDependencies({ path, services: ["web"] }),
    "E_CONFIG_INVALID",
    "values omitted"
  );
  for (const result of [
    discovered({ ancestor_pid: OWNER_PID + 1 }),
    discovered({ supervisor_depth: 9 }),
    discovered({ supervisor_depth: 0 }),
    discovered({ host_pid: OWNER_PID }),
    discovered({ executable: "relative/tunnel" }),
    discovered({ endpoint_fingerprint: "short" }),
    discovered({ ancestor_start_micros: 0 }),
  ]) {
    const { events, owners } = recordingOwners();
    await expectCodedRefusal(
      readNativeHostDependencies({
        path,
        services: ["web"],
        owners,
        discoverOwned: async () => result,
      }),
      "E_CONFIG_INVALID",
      "Native host dependencies require a bounded explicit listener selection"
    );
    expect(events).not.toContain("confirm");
  }
});

test("selection files name an owner instead of authority and cannot supply resolved fields", async () => {
  const invalid: unknown[][] = [
    [{ ...ownedEntry("web"), host_shared_helper: "proxy" }],
    [{ ...ownedEntry("web"), host_pid: 123 }],
    [{ ...ownedEntry("web"), host_executable: "/usr/local/bin/tunnel" }],
    [{ ...ownedEntry("web"), host_supervisor_depth: 2 }],
    [{ ...ownedEntry("web"), host_ancestor_pid: 4100 }],
    [
      {
        ...ownedEntry("web", {}),
        host_executable: "/usr/local/bin/tunnel",
        host_ancestor_pid: 4100,
        host_ancestor_start_micros: START,
      },
    ],
    [ownedEntry("web", { host_lifecycle: "" })],
    [ownedEntry("web", { host_lifecycle: " padded" })],
    [ownedEntry("web", { host_lifecycle: "line\nbreak" })],
    // Bindings sharing a host port must name the same owner.
    [
      ownedEntry("web"),
      {
        ...ownedEntry("worker", { host_lifecycle: "other" }),
        binding: "other",
      },
    ],
    [
      ownedEntry("web"),
      {
        ...ownedEntry("worker", {}),
        host_executable: "/usr/local/bin/tunnel",
      },
    ],
  ];
  for (const dependencies of invalid) {
    expect(() =>
      provisionalNativeHostDependencies({
        value: { version: 1, dependencies },
        services: ["web", "worker"],
      })
    ).toThrow("values omitted");
    let resolved = false;
    await expectCodedRefusal(
      readNativeHostDependencies({
        path: await selection(dependencies),
        services: ["web", "worker"],
        owners: async () => {
          resolved = true;
          throw new Error("must not resolve");
        },
        discoverOwned: async () => discovered(),
      }),
      "E_CONFIG_INVALID",
      "values omitted"
    );
    expect(resolved).toBe(false);
  }
  // The intent alone validates with a provisional PID for restart retries.
  expect(
    provisionalNativeHostDependencies({
      value: {
        version: 1,
        dependencies: [ownedEntry("web"), ownedEntry("worker")],
      },
      services: ["web", "worker"],
    }).map((entry) => [entry.service, entry.slot])
  ).toEqual([
    ["web", 0],
    ["worker", 0],
  ]);
});

test("owned discovery waits for a starting listener but never for a foreign one", async () => {
  const base = {
    runtime: { binary: "/synthetic/native", home: "/synthetic/home" },
    projectRoot: "/synthetic/project",
    hostPort: 8443,
    ancestorPid: OWNER_PID,
  };
  const args: string[][] = [];
  let calls = 0;
  const result = await discoverNativeOwnedHostDependency({
    ...base,
    invoke: async (request) => {
      args.push([...request.args]);
      if (++calls === 1) {
        throw new NativeRuntimeRequestError({
          message: "Native runtime request failed (host_endpoint_identity)",
          nativeCode: "host_endpoint_identity",
        });
      }
      return discovered();
    },
    wait: {
      deadlineMs: performance.now() + 2000,
      signal: new AbortController().signal,
    },
  });
  expect(result).toEqual(discovered());
  expect(args[0]).toEqual([
    "graph",
    "dependency-discover",
    "--host-port",
    "8443",
    "--ancestor-pid",
    String(OWNER_PID),
    "--json",
  ]);
  calls = 0;
  await expect(
    discoverNativeOwnedHostDependency({
      ...base,
      invoke: async () => {
        calls += 1;
        throw new NativeRuntimeRequestError({
          message: "Native runtime request failed (host_endpoint_owner)",
          nativeCode: "host_endpoint_owner",
        });
      },
      wait: {
        deadlineMs: performance.now() + 2000,
        signal: new AbortController().signal,
      },
    })
  ).rejects.toThrow("host_endpoint_owner");
  expect(calls).toBe(1);
});

function lifecycleState(
  overrides: Partial<LifecycleStateEntry> = {}
): LifecycleStateEntry {
  return {
    composeProject: "demo--feature",
    projectName: "demo",
    branch: "feature",
    sessionName: "hack-demo--feature",
    backend: "tmux",
    ownershipToken: "token-a",
    processes: [
      {
        name: "tunnel",
        windowName: "tunnel",
        logPath: "/synthetic/lifecycle.log",
        panePid: OWNER_PID,
      },
    ],
    updatedAt: "2026-11-05T00:00:00.000Z",
    ...overrides,
  };
}

function lifecycleReaders(state: {
  entries: LifecycleStateEntry[];
  token: string | null;
  panes: { pid: number; dead: boolean }[] | null;
}): Partial<NativeDependencyOwnerReaders> {
  return {
    readState: async () => state.entries,
    readOwnerToken: async () => state.token,
    readPanes: async () => state.panes,
  };
}

test("lifecycle owners require a live pane in this instance's owned tmux session", async () => {
  const state = {
    entries: [lifecycleState()],
    token: "token-a" as string | null,
    panes: [{ pid: OWNER_PID, dead: false }] as
      | { pid: number; dead: boolean }[]
      | null,
  };
  const resolve = createNativeDependencyOwnerResolver({
    projectDir: "/synthetic/project/.hack",
    composeProject: "demo--feature",
    sharedHelpers: [],
    readers: lifecycleReaders(state),
  });
  const proof = await resolve({ kind: "lifecycle", name: "tunnel" });
  expect(proof.pid).toBe(OWNER_PID);
  await proof.confirm();
  // The pane exited and its PID could be reused: confirmation refuses.
  state.panes = [{ pid: OWNER_PID, dead: true }];
  await expectCodedRefusal(
    proof.confirm(),
    "E_CONFIG_INVALID",
    NATIVE_DEPENDENCY_OWNER_UNAVAILABLE
  );
  // A restarted window under the same name is a different owner.
  state.panes = [{ pid: OWNER_PID + 7, dead: false }];
  state.entries = [
    lifecycleState({
      processes: [
        {
          name: "tunnel",
          windowName: "tunnel",
          logPath: "/synthetic/lifecycle.log",
          panePid: OWNER_PID + 7,
        },
      ],
    }),
  ];
  await expectCodedRefusal(
    proof.confirm(),
    "E_CONFIG_INVALID",
    NATIVE_DEPENDENCY_OWNER_UNAVAILABLE
  );

  const refusals: {
    entries: LifecycleStateEntry[];
    token: string | null;
    panes: { pid: number; dead: boolean }[] | null;
    name?: string;
  }[] = [
    { entries: [], token: "token-a", panes: [{ pid: OWNER_PID, dead: false }] },
    {
      entries: [lifecycleState({ composeProject: "demo" })],
      token: "token-a",
      panes: [{ pid: OWNER_PID, dead: false }],
    },
    {
      entries: [lifecycleState({ backend: "zellij" })],
      token: "token-a",
      panes: [{ pid: OWNER_PID, dead: false }],
    },
    {
      entries: [lifecycleState({ ownershipToken: undefined })],
      token: null,
      panes: [{ pid: OWNER_PID, dead: false }],
    },
    {
      entries: [lifecycleState()],
      token: "token-b",
      panes: [{ pid: OWNER_PID, dead: false }],
    },
    { entries: [lifecycleState()], token: "token-a", panes: null },
    {
      entries: [lifecycleState()],
      token: "token-a",
      panes: [
        { pid: OWNER_PID, dead: false },
        { pid: OWNER_PID + 1, dead: false },
      ],
    },
    {
      entries: [lifecycleState()],
      token: "token-a",
      panes: [{ pid: OWNER_PID, dead: false }],
      name: "other",
    },
    {
      entries: [
        lifecycleState({
          processes: [
            {
              name: "tunnel",
              windowName: "tunnel",
              logPath: "/synthetic/lifecycle.log",
            },
          ],
        }),
      ],
      token: "token-a",
      panes: [{ pid: OWNER_PID, dead: false }],
    },
  ];
  for (const refusal of refusals) {
    const resolver = createNativeDependencyOwnerResolver({
      projectDir: "/synthetic/project/.hack",
      composeProject: "demo--feature",
      sharedHelpers: [],
      readers: lifecycleReaders(refusal),
    });
    await expectCodedRefusal(
      resolver({ kind: "lifecycle", name: refusal.name ?? "tunnel" }),
      "E_CONFIG_INVALID",
      NATIVE_DEPENDENCY_OWNER_UNAVAILABLE
    );
  }
});

function helperConfig(
  overrides: Partial<ProjectSharedHelperConfig> = {}
): ProjectSharedHelperConfig {
  return {
    name: "search-proxy",
    enabled: true,
    command: ["/usr/local/bin/synthetic-proxy"],
    port: 18_443,
    identityPath: "/__hack/identity",
    upstream: "https://search.example.com",
    env: [],
    readyTimeoutMs: 1000,
    ...overrides,
  };
}

test("shared helper owners require an owned, live claim held by this instance", async () => {
  let owned: { pid: number; birth: string } | null = {
    pid: OWNER_PID,
    birth: "Thu Nov  5 10:00:00 2026",
  };
  const holders: string[] = [];
  const resolve = createNativeDependencyOwnerResolver({
    projectDir: "/synthetic/project/.hack",
    composeProject: "demo--feature",
    sharedHelpers: [helperConfig()],
    readers: {
      readHelper: async ({ helper, holder }) => {
        holders.push(`${helper.name}:${holder}`);
        return owned;
      },
    },
  });
  const proof = await resolve({ kind: "sharedHelper", name: "search-proxy" });
  expect(proof.pid).toBe(OWNER_PID);
  expect(holders).toEqual(["search-proxy:demo--feature"]);
  owned = { pid: OWNER_PID, birth: "Thu Nov  5 10:00:09 2026" };
  await expectCodedRefusal(
    proof.confirm(),
    "E_CONFIG_INVALID",
    NATIVE_DEPENDENCY_OWNER_UNAVAILABLE
  );
  owned = null;
  await expectCodedRefusal(
    resolve({ kind: "sharedHelper", name: "search-proxy" }),
    "E_CONFIG_INVALID",
    NATIVE_DEPENDENCY_OWNER_UNAVAILABLE
  );
  for (const sharedHelpers of [
    [],
    [helperConfig({ enabled: false })],
    [helperConfig({ name: "other" })],
  ]) {
    const resolver = createNativeDependencyOwnerResolver({
      projectDir: "/synthetic/project/.hack",
      composeProject: "demo--feature",
      sharedHelpers,
      readers: { readHelper: async () => ({ pid: OWNER_PID, birth: "b" }) },
    });
    await expectCodedRefusal(
      resolver({ kind: "sharedHelper", name: "search-proxy" }),
      "E_CONFIG_INVALID",
      NATIVE_DEPENDENCY_OWNER_UNAVAILABLE
    );
  }
});

test("the owned-helper reader accepts only a ready owned claim with a live birth", async () => {
  const stateDir = join(await scratch("native-owner-helper-"), "state");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const spec = { name: "search-proxy", stateDir };
  const claimPath = join(stateDir, "search-proxy.claim.json");
  const birth = "Thu Nov  5 10:00:00 2026";
  const write = async (value: unknown) => {
    await writeFile(claimPath, JSON.stringify(value), { mode: 0o600 });
    await chmod(claimPath, 0o600);
  };
  const claim = {
    version: 1,
    helper: "search-proxy",
    port: 18_443,
    ownership: "owned",
    phase: "ready",
    pid: OWNER_PID,
    birth,
    holders: ["demo--feature"],
  };
  const self = {
    pid: process.pid,
    parentPid: 1,
    birth: "Thu Nov  5 09:00:00 2026",
    zombie: false,
  };
  let rows = [self, { pid: OWNER_PID, parentPid: 1, birth, zombie: false }];
  const processes: SharedHostProcesses = {
    census: async () => rows,
    signalTree: async () => {
      throw new Error("the reader never signals");
    },
  };
  const read = (holder = "demo--feature") =>
    readOwnedSharedHostProcess({ spec, holder, processes });
  expect(await read()).toBeNull();
  await write(claim);
  expect(await read()).toEqual({ pid: OWNER_PID, birth });
  expect(await read("demo--other")).toBeNull();
  rows = [self, { pid: OWNER_PID, parentPid: 1, birth, zombie: true }];
  expect(await read()).toBeNull();
  rows = [
    self,
    { pid: OWNER_PID, parentPid: 1, birth: "later", zombie: false },
  ];
  expect(await read()).toBeNull();
  rows = [{ pid: OWNER_PID, parentPid: 1, birth, zombie: false }];
  // A census that did not observe this process is unusable, not "absent".
  expect(await read()).toBeNull();
  rows = [self, { pid: OWNER_PID, parentPid: 1, birth, zombie: false }];
  await write({ ...claim, phase: "starting" });
  expect(await read()).toBeNull();
  await write({
    version: 1,
    helper: "search-proxy",
    port: 18_443,
    ownership: "adopted",
    holders: ["demo--feature"],
  });
  expect(await read()).toBeNull();
  await write(claim);
  await chmod(claimPath, 0o644);
  expect(await read()).toBeNull();
});
