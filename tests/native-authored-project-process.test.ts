import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseNativeAuthoredReceipt,
  parseNativeAuthoredReview,
} from "../src/backends/native-authored-graph-protocol.ts";
import { serveNativeAuthoredProjectGraph } from "../src/backends/native-project-process.ts";

const roots: string[] = [];
const run = "a".repeat(32);
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
function review() {
  const provenance = {
    version: 1,
    kind: "native",
    namespace: "b".repeat(64),
    run,
    input: {
      semantic_hash: "c".repeat(64),
      local_resolution_hash: "d".repeat(64),
      environment_policy_hash: "e".repeat(64),
      selected_profiles: [],
    },
  };
  return parseNativeAuthoredReview({
    provenance,
    review_id: createHash("sha256")
      .update("hack.native-graph-review/v1\0")
      .update(JSON.stringify(provenance))
      .digest("hex"),
  });
}
function receipt() {
  return parseNativeAuthoredReceipt({
    version: 2,
    kind: "native-graph-runtime",
    owner: "f".repeat(32),
    boot: "00000000-0000-0000-0000-000000000001",
    review: review(),
    phase: "ready-observed",
    readiness: { web: "healthy" },
    resources: {
      "network:default": {
        kind: "network",
        key: "default",
        name: `hkn-${run}-network-0`,
        id: "1".repeat(64),
        image: null,
        phase: "created",
        outbound: true,
      },
      "container:web": {
        kind: "container",
        key: "web",
        name: `hkn-${run}-container-0`,
        id: "2".repeat(64),
        image: `sha256:${"3".repeat(64)}`,
        phase: "started",
        networks: ["default"],
      },
    },
  });
}
function ready() {
  return {
    version: 2,
    kind: "native-graph-foreground-ready",
    run,
    review: review().review_id,
    receipt: receipt(),
  };
}
function status() {
  return {
    version: 2,
    kind: "native-graph-control-reply",
    run,
    review: review().review_id,
    result: {
      outcome: "status",
      snapshot: {
        receipt: receipt(),
        observations: { web: { state: "running", health: "healthy" } },
      },
    },
  };
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
async function fixture(
  opts: {
    readonly ready?: unknown;
    readonly control?: unknown;
    readonly controlDelayMs?: number;
    readonly controlFailure?: boolean;
    readonly controlKeeper?: boolean;
    readonly ownerExits?: boolean;
    readonly splitReady?: boolean;
    readonly padding?: string;
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), "native-authored-process-"));
  roots.push(root);
  const script = join(root, "fake.ts");
  const binary = join(root, "fake-native");
  const first = `${JSON.stringify(opts.ready ?? ready())}${opts.padding ?? ""}\n`;
  await writeFile(
    script,
    `
    import { appendFileSync, existsSync } from "node:fs";
    import { createHash } from "node:crypto";
    const args = process.argv.slice(2);
    appendFileSync("calls", JSON.stringify(args) + "\\n");
    if (args.includes("control")) {
      await Bun.write("authenticated-status-started", "status");
      if (${opts.controlKeeper ?? false}) {
        const keeper = Bun.spawn([process.execPath, "-e", 'await Bun.sleep(2000); await Bun.write("keeper-complete", "exited");'], {
          stdin: "ignore", stdout: "inherit", stderr: "inherit", detached: true,
        });
        keeper.unref();
        await Bun.write("keeper-pid", String(keeper.pid));
        console.error("synthetic-private-keeper-detail");
      }
      await Bun.sleep(${opts.controlDelayMs ?? 0});
      if (${opts.controlFailure ?? false}) {
        console.error(JSON.stringify({code:"graph_owner_recovery",message:"synthetic-private-control-detail"}));
        process.exit(2);
      }
      console.log(${JSON.stringify(JSON.stringify(opts.control ?? status()))});
      process.exit(0);
    }
    process.on("SIGTERM", async () => {
      await Bun.sleep(20);
      await Bun.write("cleanup-complete", "cleaned");
      process.exit(0);
    });
    if (args.includes("--environment-stdin")) {
      const input = await Bun.stdin.bytes();
      await Bun.write("input-digest", createHash("sha256").update(input).digest("hex"));
    }
    const line = ${JSON.stringify(first)};
    if (${opts.splitReady ?? false}) {
      process.stdout.write(line.slice(0, 23));
      await Bun.sleep(20);
      process.stdout.write(line.slice(23));
    } else {
      process.stdout.write(line);
    }
    if (${opts.ownerExits ?? false}) process.exit(0);
    while (!existsSync("finish-request")) await Bun.sleep(10);
    await Bun.write("completion-observed", "exited");
  `
  );
  await writeFile(
    binary,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`
  );
  await chmod(binary, 0o700);
  return {
    runtime: { binary, home: root },
    projectRoot: root,
    sourceFile: join(root, "source.json"),
    run,
    review: review(),
    startupTimeoutMs: 2000,
  };
}

test("native owner authenticates exact admitted status before publication and sends values only over stdin", async () => {
  const opts = await fixture({ splitReady: true });
  const input = new TextEncoder().encode("synthetic-private-input");
  let published = 0;
  const result = await serveNativeAuthoredProjectGraph({
    ...opts,
    privateInput: input,
    onReady: async (bound, assertRunning) => {
      expect(bound).toEqual(receipt());
      expect(
        await Bun.file(
          join(opts.projectRoot, "authenticated-status-started")
        ).text()
      ).toBe("status");
      assertRunning();
      published++;
      await Bun.write(join(opts.projectRoot, "finish-request"), "finish");
    },
  });
  expect(result).toBe(0);
  expect(published).toBe(1);
  expect(
    await Bun.file(join(opts.projectRoot, "completion-observed")).text()
  ).toBe("exited");
  expect(await Bun.file(join(opts.projectRoot, "input-digest")).text()).toBe(
    createHash("sha256").update(input).digest("hex")
  );
  const calls = (await Bun.file(join(opts.projectRoot, "calls")).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
  expect(calls).toEqual([
    [
      "--candidate-root",
      opts.runtime.home,
      "graph",
      "native",
      "serve",
      "--source-file",
      opts.sourceFile,
      "--expect-review",
      opts.review.review_id,
      "--timeout-seconds",
      "2",
      "--environment-stdin",
      "--json",
    ],
    [
      "--candidate-root",
      opts.runtime.home,
      "graph",
      "native",
      "control",
      "--run-id",
      run,
      "--action",
      "status",
      "--json",
    ],
  ]);
  expect(JSON.stringify(calls)).not.toContain("synthetic-private-input");
});

test.each([
  { kind: "graph_foreground_ready", run },
  { ...ready(), review: "9".repeat(64) },
])("legacy or foreign native readiness never requests control or publishes", async (wire) => {
  const opts = await fixture({ ready: wire });
  let published = false;
  await expect(
    serveNativeAuthoredProjectGraph({
      ...opts,
      onReady: async () => {
        published = true;
      },
    })
  ).rejects.toThrow("invalid");
  expect(published).toBe(false);
  expect(
    await Bun.file(
      join(opts.projectRoot, "authenticated-status-started")
    ).exists()
  ).toBe(false);
  expect(
    await Bun.file(join(opts.projectRoot, "cleanup-complete")).text()
  ).toBe("cleaned");
});

test("self-valid changed admitted resources refuse after status and await owner cleanup", async () => {
  const changed = status();
  const original = changed.result.snapshot.receipt.resources["container:web"];
  if (!original) {
    throw new Error("test fixture requires its web resource");
  }
  const opts = await fixture({
    control: {
      ...changed,
      result: {
        ...changed.result,
        snapshot: {
          ...changed.result.snapshot,
          receipt: {
            ...changed.result.snapshot.receipt,
            resources: {
              ...changed.result.snapshot.receipt.resources,
              "container:web": {
                ...original,
                image: `sha256:${"9".repeat(64)}`,
              },
            },
          },
        },
      },
    },
  });
  let published = false;
  await expect(
    serveNativeAuthoredProjectGraph({
      ...opts,
      onReady: async () => {
        published = true;
      },
    })
  ).rejects.toThrow("invalid");
  expect(published).toBe(false);
  expect(
    await Bun.file(join(opts.projectRoot, "cleanup-complete")).text()
  ).toBe("cleaned");
});

test("first runtime receipt is observed before a refused status without publishing", async () => {
  const opts = await fixture({ controlFailure: true });
  const observed: unknown[] = [];
  let published = false;
  await expect(
    serveNativeAuthoredProjectGraph({
      ...opts,
      onReceipt: (bound) => {
        observed.push(bound);
        expect(
          Bun.file(join(opts.projectRoot, "authenticated-status-started")).size
        ).toBe(0);
        return undefined;
      },
      onReady: async () => {
        published = true;
      },
    })
  ).rejects.toThrow("graph_owner_recovery");
  expect(observed).toEqual([receipt()]);
  expect(published).toBe(false);
  expect(
    await Bun.file(join(opts.projectRoot, "cleanup-complete")).text()
  ).toBe("cleaned");
});

test("receipt observation cannot mutate the owner's status admission", async () => {
  const opts = await fixture();
  expect(
    await serveNativeAuthoredProjectGraph({
      ...opts,
      onReceipt: (bound) => {
        Object.assign(bound, { owner: "9".repeat(32) });
        const resource = bound.resources["container:web"];
        if (!resource) {
          throw new Error("test fixture requires its web resource");
        }
        Object.assign(resource, { id: "9".repeat(64) });
        return undefined;
      },
      onReady: async (bound, assertRunning) => {
        expect(bound).toEqual(receipt());
        assertRunning();
        await Bun.write(join(opts.projectRoot, "finish-request"), "finish");
      },
    })
  ).toBe(0);
});

test("asynchronous first receipt observation refuses status and consumes private rejection", async () => {
  const opts = await fixture();
  const completed = Promise.withResolvers<void>();
  let published = false;
  const callback = async () => {
    await Bun.sleep(10);
    completed.resolve();
    throw new Error("synthetic-private-receipt-observer");
  };
  let failure = "";
  try {
    await serveNativeAuthoredProjectGraph({
      ...opts,
      // Deliberately bypass the public synchronous type to exercise the runtime fence.
      onReceipt: callback as unknown as () => undefined,
      onReady: async () => {
        published = true;
        await Bun.write(join(opts.projectRoot, "finish-request"), "finish");
      },
    });
  } catch (error) {
    failure = String(error);
  }
  await completed.promise;
  await Bun.sleep(0);
  expect(failure).toContain("must be synchronous");
  expect(failure).not.toContain("synthetic-private-receipt-observer");
  expect(published).toBe(false);
  expect(
    await Bun.file(
      join(opts.projectRoot, "authenticated-status-started")
    ).exists()
  ).toBe(false);
  expect(
    await Bun.file(join(opts.projectRoot, "cleanup-complete")).text()
  ).toBe("cleaned");
});

test("safe status failure code does not expose private diagnostics or publish", async () => {
  const opts = await fixture({ controlFailure: true });
  let failure = "";
  try {
    await serveNativeAuthoredProjectGraph({
      ...opts,
      onReady: async () => {
        throw new Error("must not publish");
      },
    });
  } catch (error) {
    failure = String(error);
  }
  expect(failure).toContain("graph_owner_recovery");
  expect(failure).not.toContain("synthetic-private-control-detail");
  expect(
    await Bun.file(join(opts.projectRoot, "cleanup-complete")).text()
  ).toBe("cleaned");
});

test("startup deadline cancels pending authentication before publication and awaits cleanup", async () => {
  const opts = await fixture({ controlDelayMs: 3000 });
  let published = false;
  const start = performance.now();
  await expect(
    serveNativeAuthoredProjectGraph({
      ...opts,
      startupTimeoutMs: 200,
      onReady: async () => {
        published = true;
      },
    })
  ).rejects.toThrow("canceled");
  expect(performance.now() - start).toBeLessThan(1500);
  expect(published).toBe(false);
  expect(
    await Bun.file(
      join(opts.projectRoot, "authenticated-status-started")
    ).text()
  ).toBe("status");
  expect(
    await Bun.file(join(opts.projectRoot, "cleanup-complete")).text()
  ).toBe("cleaned");
});

test("status descendant-held pipes cannot outlive startup admission or owned cleanup", async () => {
  const opts = await fixture({ controlKeeper: true });
  let published = false;
  let failure = "";
  const start = performance.now();
  try {
    await serveNativeAuthoredProjectGraph({
      ...opts,
      startupTimeoutMs: 200,
      onReady: async () => {
        published = true;
      },
    });
  } catch (error) {
    failure = String(error);
  }
  try {
    expect(performance.now() - start).toBeLessThan(1500);
    expect(failure).toContain("canceled");
    expect(failure).not.toContain("synthetic-private-keeper-detail");
    expect(published).toBe(false);
    expect(
      await Bun.file(join(opts.projectRoot, "cleanup-complete")).text()
    ).toBe("cleaned");
    const keeper = Number(
      await Bun.file(join(opts.projectRoot, "keeper-pid")).text()
    );
    expect(() => process.kill(keeper, 0)).not.toThrow();
    expect(
      await Bun.file(join(opts.projectRoot, "keeper-complete")).exists()
    ).toBe(false);
  } finally {
    // The stand-in descendant exits itself; retain its fixture until completion.
    const deadline = performance.now() + 4000;
    while (
      !(await Bun.file(join(opts.projectRoot, "keeper-complete")).exists()) &&
      performance.now() < deadline
    ) {
      await Bun.sleep(25);
    }
    expect(
      await Bun.file(join(opts.projectRoot, "keeper-complete")).text()
    ).toBe("exited");
  }
}, 6000);

test.each([
  { state: "created" },
  { state: "dead" },
  { state: "running", health: "starting" },
  { state: "running", health: "unhealthy" },
  { state: "exited", code: 1 },
  { state: "exited", code: 0 },
])("durable ready phase cannot publish from a failed current readiness observation", async (observation) => {
  const wire = status();
  const opts = await fixture({
    control: {
      ...wire,
      result: {
        ...wire.result,
        snapshot: {
          ...wire.result.snapshot,
          observations: { web: observation },
        },
      },
    },
  });
  let published = false;
  await expect(
    serveNativeAuthoredProjectGraph({
      ...opts,
      onReady: async () => {
        published = true;
        await Bun.write(join(opts.projectRoot, "finish-request"), "finish");
      },
    })
  ).rejects.toThrow("invalid");
  expect(published).toBe(false);
  expect(
    await Bun.file(join(opts.projectRoot, "cleanup-complete")).text()
  ).toBe("cleaned");
});

test.each([
  "started",
  "completed",
])("Rust %s readiness preserves a successfully exited job", async (condition) => {
  const bound = { ...receipt(), readiness: { web: condition } };
  const wire = status();
  const opts = await fixture({
    ready: { ...ready(), receipt: bound },
    control: {
      ...wire,
      result: {
        ...wire.result,
        snapshot: {
          receipt: bound,
          observations: { web: { state: "exited", code: 0 } },
        },
      },
    },
  });
  expect(
    await serveNativeAuthoredProjectGraph({
      ...opts,
      onReady: async (_bound, assertRunning) => {
        assertRunning();
        await Bun.write(join(opts.projectRoot, "finish-request"), "finish");
      },
    })
  ).toBe(0);
});

test("publication guard refuses cancellation during caller input checks", async () => {
  const opts = await fixture();
  const controller = new AbortController();
  let published = false;
  await expect(
    serveNativeAuthoredProjectGraph({
      ...opts,
      signal: controller.signal,
      onReady: async (_bound, assertRunning) => {
        controller.abort();
        await Bun.sleep(30);
        assertRunning();
        published = true;
      },
    })
  ).rejects.toThrow("canceled");
  expect(published).toBe(false);
  expect(
    await Bun.file(join(opts.projectRoot, "cleanup-complete")).text()
  ).toBe("cleaned");
});

test("an owner exiting after a ready line cannot publish from a later status reply", async () => {
  const opts = await fixture({ ownerExits: true, controlDelayMs: 500 });
  let published = false;
  await expect(
    serveNativeAuthoredProjectGraph({
      ...opts,
      onReady: async () => {
        published = true;
      },
    })
  ).rejects.toThrow();
  expect(published).toBe(false);
});

test("native complete first frames enforce a byte budget before authentication", async () => {
  const opts = await fixture({ padding: " ".repeat(64 * 1024) });
  let published = false;
  await expect(
    serveNativeAuthoredProjectGraph({
      ...opts,
      onReady: async () => {
        published = true;
      },
    })
  ).rejects.toThrow("budget");
  expect(published).toBe(false);
  expect(
    await Bun.file(
      join(opts.projectRoot, "authenticated-status-started")
    ).exists()
  ).toBe(false);
  expect(
    await Bun.file(join(opts.projectRoot, "cleanup-complete")).text()
  ).toBe("cleaned");
});

test("native selection and input budget refuse before spawning", async () => {
  const opts = await fixture();
  for (const patch of [
    { sourceFile: "relative.json" },
    { run: "9".repeat(32) },
    { startupTimeoutMs: 300_001 },
    { startupTimeoutMs: 0 },
    { privateInput: new Uint8Array(256 * 1024 + 1) },
  ]) {
    await expect(
      serveNativeAuthoredProjectGraph({
        ...opts,
        ...patch,
        onReady: async () => {
          throw new Error("must not publish");
        },
      })
    ).rejects.toThrow("invalid");
  }
  expect(await Bun.file(join(opts.projectRoot, "calls")).exists()).toBe(false);
});
