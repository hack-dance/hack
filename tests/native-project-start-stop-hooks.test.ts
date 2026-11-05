import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadNativeDownHookRecord,
  NATIVE_DOWN_HOOK_UNKNOWN,
  replaceNativeDownHookRecord,
} from "../src/backends/native-project-down-hooks.ts";
import { startNativeProject } from "../src/backends/native-project-start.ts";
import { HackCliError } from "../src/lib/cli-result.ts";

// Foreground Ctrl-C runs the project's down hooks around graph cleanup, as
// `hack down` does on Compose. The fake graph owner below follows the serve
// contract: a stop request after readiness first awaits `beforeStop`; one
// observed before readiness publication takes the forced path without it.

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

type Options = Parameters<typeof startNativeProject>[0];
type Serve = NonNullable<NonNullable<Options["dependencies"]>["serve"]>;
type ServeOptions = Parameters<Serve>[0];

async function fixture(opts: {
  readonly downBefore?: (signal: AbortSignal) => Promise<number>;
  readonly downAfter?: (signal: AbortSignal) => Promise<number>;
  readonly upAfter?: () => Promise<void>;
  /** Called once the fake owner is ready and waiting for a stop request. */
  readonly whenServing?: (serve: ServeOptions) => void;
}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-stop-hooks-"))
  );
  roots.push(root);
  await mkdir(join(root, ".hack"));
  await writeFile(join(root, "hack-relay-guest"), "synthetic test artifact");
  const events: string[] = [];
  let run = "";
  let ready = false;
  const planId = "a".repeat(64),
    namespace = "b".repeat(64),
    owner = "c".repeat(32);
  const scope = {
    projectRoot: root,
    projectDir: join(root, ".hack"),
    nativeHome: root,
    branch: null,
  };
  const serve: Serve = async (args) => {
    run = args.run;
    ready = true;
    try {
      await args.onReady();
      const forced = args.signal?.aborted === true;
      opts.whenServing?.(args);
      if (!args.signal?.aborted) {
        await new Promise<void>((resolve) =>
          args.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          })
        );
      }
      events.push("stop requested");
      if (!forced && args.beforeStop) {
        expect(args.requireGroupSettlement).toBe(false);
        await args.beforeStop();
      }
      events.push("owner stop");
      return 0;
    } finally {
      ready = false;
    }
  };
  const startup: Options = {
    runtime: { binary: join(root, "hack-local"), home: root },
    scope,
    composeFile: join(root, ".hack/docker-compose.yml"),
    sharedSource: true,
    before: async () => {
      events.push("up.before");
      return {
        cleanup: async () => {
          events.push("lifecycle stopped");
        },
        ready: async () => {
          events.push("up.after");
          await opts.upAfter?.();
        },
        stop: {
          before:
            opts.downBefore ??
            (async () => {
              events.push("down.before");
              return 0;
            }),
          after:
            opts.downAfter ??
            (async () => {
              events.push("down.after");
              return 0;
            }),
        },
      };
    },
    dependencies: {
      prepareStorage: async () => {},
      retainedImages: async () => new Map(),
      load: async () => null,
      loadRestart: async () => null,
      save: async () => {
        events.push("save");
      },
      remove: async () => {
        events.push("remove");
      },
      prepare: async () => ({
        originalSha256: "d".repeat(64),
        normalizedComposeJson: JSON.stringify({
          services: { web: { image: `sha256:${"e".repeat(64)}` } },
        }),
        managedEnvironment: {},
        lifecycleHostEnvironment: {},
        environmentFiles: [],
        effectiveEnvName: null,
        serviceNames: ["web"],
      }),
      review: async (request) =>
        request.run({
          planId,
          namespace,
          projectArgs: ["--project", root],
          report: {
            plan: {
              enrollment_compatible: true,
              services: { web: { active: true } },
            },
          },
        }),
      invoke: async (request) => {
        if (request.args[1] === "check-project-share") {
          return { source_admitted: true, pool_initialized: false };
        }
        if (request.args[1] === "admit-image") {
          return { reference: request.args[3], kind: "docker_hub" };
        }
        if (request.args[1] === "dependency-plan") {
          return { dependency_plan_id: "f".repeat(64) };
        }
        if (request.args[1] === "inspect") {
          events.push("graph inspect");
          return {
            journal_incomplete: false,
            receipt: {
              run,
              owner,
              namespace,
              plan_id: planId,
              phase: ready ? "ready-observed" : "stopped-data-retained",
              resources: {
                "container:web": {
                  kind: "container",
                  key: "web",
                  id: "f".repeat(64),
                  phase: "started",
                },
              },
            },
            observations: {
              "container:web": { state: ready ? "running" : "absent" },
            },
          };
        }
        return {};
      },
      serve,
    },
  };
  return { startup, events, scope };
}

/** Deliver a real process signal event to the frontend's own listener only. */
function interrupt(): void {
  expect(process.listenerCount("SIGINT")).toBe(1);
  process.emit("SIGINT");
}

test("Ctrl-C runs down.before, graph cleanup, lifecycle retirement and down.after in order", async () => {
  const { startup, events, scope } = await fixture({
    whenServing: () => queueMicrotask(interrupt),
  });
  expect(await startNativeProject(startup)).toBe(130);
  const stop = events.slice(events.indexOf("stop requested"));
  expect(stop).toEqual([
    "stop requested",
    "down.before",
    "owner stop",
    "graph inspect",
    "lifecycle stopped",
    "down.after",
  ]);
  expect(events.filter((event) => event.startsWith("down."))).toHaveLength(2);
  expect((await loadNativeDownHookRecord(scope))?.state).toBe("complete");
  expect(process.listenerCount("SIGINT")).toBe(0);
});

test("a second Ctrl-C cancels a running down.before, still stops and never runs down.after", async () => {
  let canceled = false;
  const { startup, events, scope } = await fixture({
    whenServing: () => queueMicrotask(interrupt),
    downBefore: async (signal) => {
      events.push("down.before");
      interrupt();
      await new Promise<void>((resolve) =>
        signal.aborted
          ? resolve()
          : signal.addEventListener("abort", () => resolve(), { once: true })
      );
      canceled = signal.aborted;
      return 130;
    },
  });
  expect(await startNativeProject(startup)).toBe(130);
  expect(canceled).toBe(true);
  expect(events).toContain("owner stop");
  expect(events).toContain("lifecycle stopped");
  expect(events).not.toContain("down.after");
  expect((await loadNativeDownHookRecord(scope))?.state).toBe("before-failed");
});

test("a failed down.before still stops the graph and reports a lifecycle failure", async () => {
  const { startup, events, scope } = await fixture({
    whenServing: () => queueMicrotask(interrupt),
    downBefore: async () => {
      events.push("down.before");
      return 3;
    },
  });
  const failure = await startNativeProject(startup).then(
    () => undefined,
    (error: unknown) => error
  );
  expect(failure).toBeInstanceOf(HackCliError);
  expect((failure as HackCliError).code).toBe("E_LIFECYCLE_FAILED");
  expect(String(failure)).toContain("graph was stopped and data retained");
  expect(events).toContain("owner stop");
  expect(events).toContain("lifecycle stopped");
  expect(events).not.toContain("down.after");
  expect((await loadNativeDownHookRecord(scope))?.state).toBe("before-failed");
});

test("a failed down.after is reported after confirmed cleanup and is not rerun", async () => {
  const { startup, events, scope } = await fixture({
    whenServing: () => queueMicrotask(interrupt),
    downAfter: async () => {
      events.push("down.after");
      return 4;
    },
  });
  await expect(startNativeProject(startup)).rejects.toThrow(
    "Native down after hook failed; native graph cleanup was confirmed"
  );
  expect(events.at(-1)).toBe("down.after");
  expect((await loadNativeDownHookRecord(scope))?.state).toBe("complete");
});

test("Ctrl-C during up.after never runs or owes down hooks", async () => {
  const { startup, events, scope } = await fixture({
    upAfter: async () => interrupt(),
  });
  expect(await startNativeProject(startup)).toBe(130);
  expect(events.filter((event) => event.startsWith("down."))).toEqual([]);
  expect(events).toContain("lifecycle stopped");
  expect(await loadNativeDownHookRecord(scope)).toBeNull();
});

test("a graph that ends without a stop request leaves its down hooks owed for down", async () => {
  const { startup, events, scope } = await fixture({});
  // The owner exits on its own: no interrupt reaches the frontend.
  const run = startNativeProject({
    ...startup,
    dependencies: {
      ...startup.dependencies,
      serve: async (args) => {
        const original = startup.dependencies?.serve;
        if (!original) {
          throw new Error("missing fake owner");
        }
        const controller = new AbortController();
        // Stop the fake owner without a frontend stop request.
        queueMicrotask(() => controller.abort());
        return await original({
          ...args,
          signal: controller.signal,
          beforeStop: undefined,
        });
      },
    },
  });
  expect(await run).toBe(0);
  expect(events.filter((event) => event.startsWith("down."))).toEqual([]);
  expect((await loadNativeDownHookRecord(scope))?.state).toBe("owed");
});

test("unknown down hook completion of an earlier generation refuses before any hook", async () => {
  const { startup, events, scope } = await fixture({});
  await replaceNativeDownHookRecord(scope, null, {
    run: "1".repeat(32),
    generation: "2".repeat(32),
    state: "before-started",
  });
  const failure = await startNativeProject(startup).then(
    () => undefined,
    (error: unknown) => error
  );
  expect(failure).toBeInstanceOf(HackCliError);
  expect((failure as Error).message).toBe(NATIVE_DOWN_HOOK_UNKNOWN);
  expect(events).toEqual([]);
});

test("projects without down hooks keep the attached owner and need no journal", async () => {
  const { startup, events, scope } = await fixture({
    whenServing: (serve) => {
      expect(serve.beforeStop).toBeUndefined();
      expect(serve.forceSignal).toBeUndefined();
      queueMicrotask(interrupt);
    },
  });
  const before = startup.before;
  expect(
    await startNativeProject({
      ...startup,
      before: async (input) => {
        const hooks = await before(input);
        return { cleanup: hooks.cleanup, ready: hooks.ready };
      },
    })
  ).toBe(130);
  expect(events.filter((event) => event.startsWith("down."))).toEqual([]);
  expect(await loadNativeDownHookRecord(scope)).toBeNull();
});
