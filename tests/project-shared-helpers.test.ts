import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  readProcessIdentities,
  selectProcessTree,
  signalVerifiedProcessTree,
} from "../src/lib/process-tree.ts";
import { readProjectConfig } from "../src/lib/project.ts";
import {
  buildSharedHelperSpec,
  type ProjectSharedHelperConfig,
  parseProjectSharedHelpers,
  releaseProjectSharedHelpers,
  resolveSharedHelperHolder,
  resolveSharedHelperStateDir,
  SharedHelperStartError,
  startProjectSharedHelpers,
} from "../src/lib/project-shared-helpers.ts";
import {
  isSharedHostProcessRunning,
  parseSharedHostClaim,
} from "../src/lib/shared-host-lifecycle.ts";

/**
 * Project wiring for lifecycle.sharedHelpers. Two Compose projects
 * (`demo--branch-a`, `demo--branch-b`) stand in for two branches; the helper
 * is the portable fixture from tests/fixtures/shared-host-helper.ts. The CLI
 * path (`hack up`/`down` on two branches) is the e2e scenario
 * tests/e2e/scenarios/shared-host-helpers.ts.
 */

const HELPER = resolve(import.meta.dir, "fixtures/shared-host-helper.ts");
const TIMEOUT = 30_000;
const BRANCH_A = "demo--branch-a";
const BRANCH_B = "demo--branch-b";
const UPSTREAM_A = "https://issuer.branch-a.test";

const roots: string[] = [];
const foreign: Bun.Subprocess<"ignore", "pipe", "ignore">[] = [];

afterEach(async () => {
  for (const proc of foreign.splice(0)) {
    proc.kill("SIGKILL");
    await proc.exited;
  }
  // Reap any owned helper through birth-verified primitives, not the code
  // under test, so a failing run cannot leak fixture processes.
  const census = await readProcessIdentities();
  for (const root of roots) {
    for (const name of ["issuer-bridge", "second-bridge"]) {
      for (const claimPath of await claimFiles(root, name)) {
        const text = await readFile(claimPath, "utf8").catch(() => null);
        const claim = text === null ? null : parseSharedHostClaim(text);
        if (
          claim?.ownership === "owned" &&
          census.some(
            (row) => row.pid === claim.pid && row.birth === claim.birth
          )
        ) {
          await signalVerifiedProcessTree(
            selectProcessTree(census, claim.pid),
            "SIGKILL"
          );
        }
      }
    }
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function claimFiles(root: string, name: string): Promise<string[]> {
  const dir = join(root, "hack-home", "shared-helpers");
  const entries = await import("node:fs/promises")
    .then((fs) => fs.readdir(dir))
    .catch(() => [] as string[]);
  return entries
    .filter((entry) => entry.startsWith(`${name}-`))
    .map((entry) => join(dir, entry, `${name}.claim.json`));
}

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hack-project-shared-"));
  roots.push(root);
  return root;
}

function freePort(): number {
  const probe = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data() {
        // Bind probe only.
      },
    },
  });
  const port = probe.port;
  probe.stop(true);
  return port;
}

function helperConfig(opts: {
  readonly port: number;
  readonly name?: string;
  readonly mode?: "identity" | "placeholder";
  readonly upstream?: string;
  readonly readyTimeoutMs?: number;
}): ProjectSharedHelperConfig {
  const name = opts.name ?? "issuer-bridge";
  const upstream = opts.upstream ?? UPSTREAM_A;
  return {
    name,
    enabled: true,
    command: [
      process.execPath,
      HELPER,
      opts.mode ?? "identity",
      String(opts.port),
      name,
      upstream,
    ],
    port: opts.port,
    identityPath: "/__hack/identity",
    upstream,
    env: ["HOME"],
    readyTimeoutMs: opts.readyTimeoutMs ?? 10_000,
  };
}

function context(root: string) {
  return {
    projectRoot: root,
    env: {},
    hackDir: join(root, "hack-home"),
    // HOME is the scratch root: the fixture exits once it is removed.
    processEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root },
  };
}

async function readHelperClaim(
  root: string,
  helper: ProjectSharedHelperConfig
) {
  const text = await readFile(
    join(
      resolveSharedHelperStateDir({
        hackDir: join(root, "hack-home"),
        name: helper.name,
        port: helper.port,
      }),
      `${helper.name}.claim.json`
    ),
    "utf8"
  ).catch(() => null);
  return text === null ? null : parseSharedHostClaim(text);
}

async function ownedIdentity(root: string, helper: ProjectSharedHelperConfig) {
  const claim = await readHelperClaim(root, helper);
  if (claim?.ownership !== "owned") {
    throw new Error("expected an owned claim");
  }
  return { pid: claim.pid, birth: claim.birth };
}

async function isAlive(identity: { pid: number; birth: string }) {
  return isSharedHostProcessRunning(await readProcessIdentities(), identity);
}

async function startForeign(opts: {
  readonly root: string;
  readonly mode: "identity" | "tcp";
  readonly port: number;
  readonly upstream?: string;
}) {
  const proc = Bun.spawn(
    [
      process.execPath,
      HELPER,
      opts.mode,
      String(opts.port),
      "issuer-bridge",
      opts.upstream ?? UPSTREAM_A,
    ],
    {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: opts.root },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    }
  );
  foreign.push(proc);
  const reader = proc.stdout.getReader();
  let text = "";
  while (!text.includes("listening")) {
    const { done, value } = await reader.read();
    if (done) {
      throw new Error("foreign fixture exited before listening");
    }
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const identity = (await readProcessIdentities()).find(
    (row) => row.pid === proc.pid
  );
  if (!identity) {
    throw new Error("foreign fixture not in census");
  }
  return { proc, identity: { pid: identity.pid, birth: identity.birth } };
}

async function served(port: number): Promise<string> {
  return await (await fetch(`http://127.0.0.1:${port}/`)).text();
}

test("parses a minimal shared helper with defaults", () => {
  expect(
    parseProjectSharedHelpers([
      {
        name: "issuer-bridge",
        command: ["bun", "run", "bridge"],
        port: 4100,
        upstreamEnv: "ISSUER_UPSTREAM",
      },
    ])
  ).toEqual({
    helpers: [
      {
        name: "issuer-bridge",
        enabled: true,
        command: ["bun", "run", "bridge"],
        port: 4100,
        identityPath: "/__hack/identity",
        upstreamEnv: "ISSUER_UPSTREAM",
        env: [],
        readyTimeoutMs: 30_000,
      },
    ],
    errors: [],
  });
  expect(parseProjectSharedHelpers(undefined)).toEqual({ errors: [] });
});

test("refuses invalid shared helper entries instead of skipping them", () => {
  const base = {
    name: "issuer-bridge",
    command: ["bridge"],
    port: 4100,
    upstream: "https://issuer.test",
  };
  const cases: readonly [unknown, string][] = [
    [{}, "must be an array"],
    [[{ ...base, command: "bun run bridge" }], "argv, not a shell string"],
    [[{ ...base, upstreamEnv: "X" }], "exactly one of upstream"],
    [[{ ...base, upstream: undefined }], "exactly one of upstream"],
    [[{ ...base, singleton: { ports: [1] } }], 'unknown key "singleton"'],
    [[{ ...base, name: "../escape" }], ".name must match"],
    [[{ ...base, port: 70_000 }], ".port must be"],
    [[{ ...base, env: ["NOT-A-NAME"] }], ".env must be"],
    [[{ ...base, identityPath: "identity" }], ".identityPath must be"],
    [[{ ...base, readyTimeoutMs: 0 }], ".readyTimeoutMs must be"],
    [[base, { ...base, port: 4101 }], 'duplicates "issuer-bridge"'],
    [[base, { ...base, name: "other" }], ".port duplicates 4100"],
  ];
  for (const [value, message] of cases) {
    const parsed = parseProjectSharedHelpers(value);
    expect(parsed.helpers).toBeUndefined();
    expect(parsed.errors.join(" ")).toContain(message);
  }
});

test("an invalid sharedHelpers entry is a project config parse error", async () => {
  const root = await scratch();
  await mkdir(join(root, ".hack"), { recursive: true });
  await writeFile(
    join(root, ".hack", "hack.config.json"),
    JSON.stringify({
      name: "demo",
      lifecycle: {
        sharedHelpers: [{ name: "issuer-bridge", command: "bridge", port: 1 }],
      },
    })
  );
  const cfg = await readProjectConfig({
    projectRoot: root,
    projectDir: join(root, ".hack"),
  } as Parameters<typeof readProjectConfig>[0]);
  expect(cfg.parseError).toContain("lifecycle.sharedHelpers[0].command");
  expect(cfg.lifecycle?.sharedHelpers).toBeUndefined();
});

test("the claim directory depends on helper and port only; the holder is the compose project", () => {
  const dir = resolveSharedHelperStateDir({
    hackDir: "/h",
    name: "issuer-bridge",
    port: 4100,
  });
  expect(dir).toBe("/h/shared-helpers/issuer-bridge-4100");
  expect(resolveSharedHelperHolder(BRANCH_A)).toBe(BRANCH_A);
  expect(() => resolveSharedHelperHolder("demo/branch a")).toThrow(
    "Compose project name"
  );
});

test("the helper gets PATH and only its listed env; upstreamEnv reads lifecycle env first", () => {
  const spec = buildSharedHelperSpec({
    helper: {
      ...helperConfig({ port: 4100 }),
      upstream: undefined,
      upstreamEnv: "ISSUER_UPSTREAM",
      env: ["ISSUER_TOKEN"],
    },
    projectRoot: "/repo",
    env: { ISSUER_UPSTREAM: "https://lifecycle.test", ISSUER_TOKEN: "t" },
    processEnv: {
      PATH: "/bin",
      ISSUER_UPSTREAM: "https://process.test",
      RUNNER_ONLY: "x",
    },
    hackDir: "/h",
  });
  expect(spec.env).toEqual({ PATH: "/bin", ISSUER_TOKEN: "t" });
  expect(spec.expected).toEqual({
    helper: "issuer-bridge",
    upstream: "https://lifecycle.test",
  });
  expect(spec.stateDir).toBe("/h/shared-helpers/issuer-bridge-4100");
  expect(() =>
    buildSharedHelperSpec({
      helper: { ...helperConfig({ port: 4100 }), env: ["MISSING_NAME"] },
      projectRoot: "/repo",
      env: {},
      processEnv: { PATH: "/bin" },
    })
  ).toThrow("lists env MISSING_NAME, but it is not set");
});

test(
  "two branches share one owned helper; the last branch release stops it",
  async () => {
    const root = await scratch();
    const helper = helperConfig({ port: freePort() });
    const a = await startProjectSharedHelpers({
      ...context(root),
      helpers: [helper],
      composeProject: BRANCH_A,
    });
    expect(a.started[0]?.result).toMatchObject({
      state: "ready",
      ownership: "owned",
      spawned: true,
      holderAdded: true,
    });
    const owned = await ownedIdentity(root, helper);
    const b = await startProjectSharedHelpers({
      ...context(root),
      helpers: [helper],
      composeProject: BRANCH_B,
    });
    expect(b.started[0]?.result).toMatchObject({
      state: "ready",
      ownership: "owned",
      spawned: false,
      pid: owned.pid,
    });
    expect(await served(helper.port)).toBe(`served:${UPSTREAM_A}`);
    expect((await readHelperClaim(root, helper))?.holders).toEqual([
      BRANCH_A,
      BRANCH_B,
    ]);

    const releaseA = await releaseProjectSharedHelpers({
      helpers: [helper],
      composeProject: BRANCH_A,
      hackDir: join(root, "hack-home"),
    });
    expect(releaseA.map((entry) => entry.result.state)).toEqual(["retained"]);
    expect(await isAlive(owned)).toBe(true);
    expect(await served(helper.port)).toBe(`served:${UPSTREAM_A}`);

    const releaseB = await releaseProjectSharedHelpers({
      helpers: [helper],
      composeProject: BRANCH_B,
      hackDir: join(root, "hack-home"),
    });
    expect(releaseB.map((entry) => entry.result.state)).toEqual(["stopped"]);
    expect(await isAlive(owned)).toBe(false);
    expect(await readHelperClaim(root, helper)).toBeNull();
  },
  TIMEOUT
);

test(
  "a later helper's failure rolls back only the holders this run added; foreign listeners survive",
  async () => {
    const root = await scratch();
    const first = helperConfig({ port: freePort() });
    const second = helperConfig({
      port: freePort(),
      name: "second-bridge",
    });
    // The second port is held by a different helper kind (foreign).
    const other = await startForeign({
      root,
      mode: "identity",
      port: second.port,
    });

    // Branch A already holds the first helper from an earlier successful up.
    await startProjectSharedHelpers({
      ...context(root),
      helpers: [first],
      composeProject: BRANCH_A,
    });
    const owned = await ownedIdentity(root, first);

    // Branch B's up acquires the first helper, then the second is refused:
    // B's new holder on the first helper is rolled back.
    const failedUp = startProjectSharedHelpers({
      ...context(root),
      helpers: [first, second],
      composeProject: BRANCH_B,
    });
    await expect(failedUp).rejects.toBeInstanceOf(SharedHelperStartError);
    await expect(failedUp).rejects.toThrow("(foreign-listener)");
    expect((await readHelperClaim(root, first))?.holders).toEqual([BRANCH_A]);
    expect(await isAlive(owned)).toBe(true);
    expect(await isAlive(other.identity)).toBe(true);

    // Branch A re-runs up with the same failure: its rollback must not drop
    // the holder its earlier up recorded, so the helper keeps running.
    await expect(
      startProjectSharedHelpers({
        ...context(root),
        helpers: [first, second],
        composeProject: BRANCH_A,
      })
    ).rejects.toThrow("(foreign-listener)");
    expect((await readHelperClaim(root, first))?.holders).toEqual([BRANCH_A]);
    expect(await isAlive(owned)).toBe(true);
    expect(await isAlive(other.identity)).toBe(true);
    expect(await served(first.port)).toBe(`served:${UPSTREAM_A}`);
  },
  TIMEOUT
);

test(
  "wrong upstream and a foreign port fail the start, spawn nothing and leave the listener running",
  async () => {
    const root = await scratch();
    const wrongPort = freePort();
    const wrong = await startForeign({
      root,
      mode: "identity",
      port: wrongPort,
      upstream: "https://issuer.branch-b.test",
    });
    await expect(
      startProjectSharedHelpers({
        ...context(root),
        helpers: [helperConfig({ port: wrongPort })],
        composeProject: BRANCH_A,
      })
    ).rejects.toThrow("(wrong-upstream)");
    expect(await isAlive(wrong.identity)).toBe(true);
    expect(await served(wrongPort)).toBe("served:https://issuer.branch-b.test");

    const tcpPort = freePort();
    const tcp = await startForeign({ root, mode: "tcp", port: tcpPort });
    const error = await startProjectSharedHelpers({
      ...context(root),
      helpers: [helperConfig({ port: tcpPort, readyTimeoutMs: 3000 })],
      composeProject: BRANCH_A,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SharedHelperStartError);
    expect(String(error)).toContain("(foreign-listener)");
    expect(String(error)).not.toContain("branch-b.test");
    expect(await isAlive(tcp.identity)).toBe(true);
    expect(
      await readHelperClaim(root, helperConfig({ port: tcpPort }))
    ).toBeNull();
  },
  TIMEOUT
);

test(
  "a healthy helper started elsewhere is adopted and never stopped by down",
  async () => {
    const root = await scratch();
    const port = freePort();
    const existing = await startForeign({ root, mode: "identity", port });
    const helper = helperConfig({ port });
    const up = await startProjectSharedHelpers({
      ...context(root),
      helpers: [helper],
      composeProject: BRANCH_A,
    });
    expect(up.started[0]?.result).toMatchObject({
      state: "ready",
      ownership: "adopted",
    });
    const down = await releaseProjectSharedHelpers({
      helpers: [helper],
      composeProject: BRANCH_A,
      hackDir: join(root, "hack-home"),
    });
    expect(down.map((entry) => entry.result.state)).toEqual([
      "released-adopted",
    ]);
    expect(await isAlive(existing.identity)).toBe(true);
    expect(await served(port)).toBe(`served:${UPSTREAM_A}`);
  },
  TIMEOUT
);

test(
  "shutdown during readiness retry cancels, stops the owned child and leaves no claim",
  async () => {
    const root = await scratch();
    const helper = helperConfig({
      port: freePort(),
      mode: "placeholder",
      readyTimeoutMs: 20_000,
    });
    const controller = new AbortController();
    const pending = startProjectSharedHelpers({
      ...context(root),
      helpers: [helper],
      composeProject: BRANCH_A,
      signal: controller.signal,
    });
    let child: { pid: number; birth: string } | null = null;
    const deadline = performance.now() + 10_000;
    while (child === null && performance.now() < deadline) {
      const claim = await readHelperClaim(root, helper);
      if (claim?.ownership === "owned") {
        child = { pid: claim.pid, birth: claim.birth };
      }
      await Bun.sleep(50);
    }
    if (child === null) {
      throw new Error("the placeholder was never claimed");
    }
    await Bun.sleep(300);
    controller.abort();
    await expect(pending).rejects.toThrow("(cancelled)");
    expect(await isAlive(child)).toBe(false);
    expect(await readHelperClaim(root, helper)).toBeNull();
  },
  TIMEOUT
);

test("a disabled helper starts nothing and down still releases a recorded holder", async () => {
  const root = await scratch();
  const helper = { ...helperConfig({ port: freePort() }), enabled: false };
  const up = await startProjectSharedHelpers({
    ...context(root),
    helpers: [helper],
    composeProject: BRANCH_A,
  });
  expect(up.started[0]?.result).toEqual({
    state: "disabled",
    ownership: "disabled",
  });
  expect(await readHelperClaim(root, helper)).toBeNull();
  const down = await releaseProjectSharedHelpers({
    helpers: [helper],
    composeProject: BRANCH_A,
    hackDir: join(root, "hack-home"),
  });
  expect(down.map((entry) => entry.result.state)).toEqual(["absent"]);
});

test(
  "an overlapping start of the same instance is never revoked by the earlier run's rollback",
  async () => {
    const root = await scratch();
    const helper = helperConfig({ port: freePort() });
    // Run 1 adds the holder; run 2 of the same instance reuses it.
    const first = await startProjectSharedHelpers({
      ...context(root),
      helpers: [helper],
      composeProject: BRANCH_A,
    });
    const owned = await ownedIdentity(root, helper);
    const second = await startProjectSharedHelpers({
      ...context(root),
      helpers: [helper],
      composeProject: BRANCH_A,
    });
    expect(second.started[0]?.result).toMatchObject({
      state: "ready",
      holderAdded: false,
    });
    // Run 1 then fails later (Compose): its rollback must not stop the
    // helper under run 2.
    expect(await first.rollback()).toEqual([]);
    expect(await isAlive(owned)).toBe(true);
    expect((await readHelperClaim(root, helper))?.holders).toEqual([BRANCH_A]);
    expect(await served(helper.port)).toBe(`served:${UPSTREAM_A}`);
    // Without a newer start, a rollback releases what its run added.
    await releaseProjectSharedHelpers({
      helpers: [helper],
      composeProject: BRANCH_A,
      hackDir: join(root, "hack-home"),
    });
    const fresh = await startProjectSharedHelpers({
      ...context(root),
      helpers: [helper],
      composeProject: BRANCH_A,
    });
    const freshOwned = await ownedIdentity(root, helper);
    expect((await fresh.rollback()).map((entry) => entry.result.state)).toEqual(
      ["stopped"]
    );
    expect(await isAlive(freshOwned)).toBe(false);
  },
  TIMEOUT
);

test("a disabled helper needs none of its runtime env", async () => {
  const root = await scratch();
  const helper: ProjectSharedHelperConfig = {
    ...helperConfig({ port: freePort() }),
    enabled: false,
    upstream: undefined,
    upstreamEnv: "UNSET_ISSUER_UPSTREAM",
    env: ["UNSET_ISSUER_TOKEN"],
  };
  const up = await startProjectSharedHelpers({
    ...context(root),
    helpers: [helper],
    composeProject: BRANCH_A,
  });
  expect(up.started[0]?.result).toEqual({
    state: "disabled",
    ownership: "disabled",
  });
});

test(
  "a signal anywhere in a guarded start runs its cleanup, then is re-raised",
  async () => {
    const root = await scratch();
    const script = join(root, "guard.ts");
    const marker = join(root, "cleaned");
    const module = resolve(
      import.meta.dir,
      "../src/lib/project-shared-helpers.ts"
    );
    await writeFile(
      script,
      `import { writeFileSync } from "node:fs";
import { withTerminationAbort } from ${JSON.stringify(module)};
await withTerminationAbort(
  async () => {
    // A step that does not watch the abort signal, like mux session setup.
    console.log("running");
    await Bun.sleep(1500);
  },
  { onSignalled: async () => writeFileSync(${JSON.stringify(marker)}, "yes") }
);
console.log("not reached");
`
    );
    const proc = Bun.spawn([process.execPath, script], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const reader = proc.stdout.getReader();
    let text = "";
    while (!text.includes("running")) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      text += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(143);
    expect(await readFile(marker, "utf8")).toBe("yes");
  },
  TIMEOUT
);

test(
  "a release waits for a start of the same instance, so up and down never split the helper set",
  async () => {
    const root = await scratch();
    const first = helperConfig({ port: freePort() });
    // The second helper never becomes ready, so the start holds the
    // instance for its whole deadline after the first helper is up.
    const second = helperConfig({
      port: freePort(),
      name: "second-bridge",
      mode: "placeholder",
      readyTimeoutMs: 2000,
    });
    let startSettledAt = 0;
    const start = startProjectSharedHelpers({
      ...context(root),
      helpers: [first, second],
      composeProject: BRANCH_A,
    })
      .catch((error: unknown) => error)
      .finally(() => {
        startSettledAt = performance.now();
      });
    const deadline = performance.now() + 10_000;
    while (!(await isReadyOwned(root, first)) && performance.now() < deadline) {
      await Bun.sleep(25);
    }
    const owned = await ownedIdentity(root, first);
    const releases = await releaseProjectSharedHelpers({
      helpers: [first, second],
      composeProject: BRANCH_A,
      hackDir: join(root, "hack-home"),
    });
    const releasedAt = performance.now();
    expect(String(await start)).toContain("(deadline)");
    // The release ran only after the start settled (and rolled back).
    expect(startSettledAt).toBeGreaterThan(0);
    expect(releasedAt).toBeGreaterThanOrEqual(startSettledAt);
    expect(releases.every((entry) => entry.result.state === "absent")).toBe(
      true
    );
    expect(await isAlive(owned)).toBe(false);
  },
  TIMEOUT
);

async function isReadyOwned(
  root: string,
  helper: ProjectSharedHelperConfig
): Promise<boolean> {
  const claim = await readHelperClaim(root, helper);
  return claim?.ownership === "owned" && claim.phase === "ready";
}
