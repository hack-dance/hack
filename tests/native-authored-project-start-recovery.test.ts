import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeAuthoredProjectPs } from "../src/backends/native-authored-project-observe.ts";
import {
  loadNativeAuthoredProjectRun,
  stopNativeAuthoredProject,
  withNativeAuthoredProjectAdmission,
} from "../src/backends/native-authored-project-run.ts";
import {
  NativeAuthoredProjectStartError,
  serveNativeAuthoredProject as serveStart,
} from "../src/backends/native-authored-project-start.ts";
import { createNativeAuthoredStartHarness } from "./helpers/native-authored-start-fixture.ts";

const {
  run,
  CANARY,
  CASE_TIMEOUT_MS,
  STARTUP_TIMEOUT_MS,
  STOP_TIMEOUT_MS,
  DEADLINE_WALL_BOUND_MS,
  test,
  releaseOwner,
  serveNativeAuthoredProject,
  fixture,
  artifacts,
  failure,
  macTest,
  holdSecondFrontendPlan,
  holdFirstPaneQuery,
  groupEnded,
} = createNativeAuthoredStartHarness();

macTest(
  "startup keeps the native failure when missing receipt inspection also refuses",
  async () => {
    const selected = await fixture({ failBeforeReceipt: true });
    const error = await failure(
      serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: STARTUP_TIMEOUT_MS,
      }),
      "retained"
    );
    expect(error).toHaveProperty("nativeCode", "graph_network_intent");
    expect(error).toHaveProperty("stage", "runtime");
    const retained = await artifacts(selected.scope);
    expect(retained).toHaveLength(2);
    expect(retained.some((name) => name.endsWith(".start.json"))).toBe(true);
    expect(retained.some((name) => name.endsWith(".source.json"))).toBe(true);
  },
  CASE_TIMEOUT_MS
);

macTest(
  "HACK-1300: a planner image refusal retains nothing and never reaches serve",
  async () => {
    // The native planner now refuses a repository@digest or tag image with the
    // lowering's own native_graph_admission code, before any reservation.
    const selected = await fixture({
      planFailure: true,
      planFailureCode: "native_graph_admission",
    });
    const error = await failure(
      serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: STARTUP_TIMEOUT_MS,
      }),
      "not-started"
    );
    expect(error).toHaveProperty("nativeCode", "native_graph_admission");
    expect(error).toHaveProperty("stage", "native-plan");
    expect(String(error)).not.toContain("private-rejected-plan-detail");
    expect(await artifacts(selected.scope)).toEqual([]);
    expect(await Bun.file(selected.delivery).exists()).toBe(false);
    const calls = (await readFile(selected.calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)[4]);
    expect(calls).toEqual(["plan"]);
    const status = await nativeAuthoredProjectPs({
      runtime: selected.runtime,
      scope: selected.scope,
      invoke: () => {
        throw new Error("No runtime request for an absent attempt.");
      },
    });
    expect(status.status).toBe("not_started");
  }
);

macTest(
  "unscoped native frontend binds the canonical project namespace",
  async () => {
    const selected = await fixture({ branch: null });
    let ready = 0;
    expect(
      await serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: STARTUP_TIMEOUT_MS,
        onReady: (mapping) => {
          expect(mapping.record.receipt.review.provenance.namespace).toBe(
            createHash("sha256")
              .update(selected.scope.projectRoot)
              .digest("hex")
          );
          ready += 1;
          return undefined;
        },
      })
    ).toBe(0);
    expect(ready).toBe(1);
    expect(await artifacts(selected.scope)).toEqual([]);
  }
);

for (const cleanup of ["live", "missing", "foreign-id"] as const) {
  macTest(
    `native frontend ${cleanup} cleanup cannot retire ready mapping or startup intent`,
    async () => {
      const selected = await fixture({ cleanup });
      await failure(
        serveNativeAuthoredProject({
          ...selected,
          run,
          startupTimeoutMs: STARTUP_TIMEOUT_MS,
        }),
        "retained"
      );
      expect(await loadNativeAuthoredProjectRun(selected.scope)).not.toBeNull();
      const retained = await artifacts(selected.scope);
      expect(retained).toHaveLength(4);
      expect(retained.some((name) => name.endsWith(".live-stop.json"))).toBe(
        true
      );
      await failure(
        serveNativeAuthoredProject({
          ...selected,
          run: "9".repeat(32),
          startupTimeoutMs: STARTUP_TIMEOUT_MS,
        }),
        "retained"
      );
      const calls = (await Bun.file(selected.calls).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        calls.filter((args: string[]) => args.includes("serve"))
      ).toHaveLength(1);
    }
  );
}

macTest(
  "native frontend admission blocks a second consumer across the ready callback",
  async () => {
    const selected = await fixture();
    const entered = Promise.withResolvers<void>();
    const first = serveNativeAuthoredProject({
      ...selected,
      run,
      startupTimeoutMs: STARTUP_TIMEOUT_MS,
      // The owner stays ready until the second consumer has been refused.
      holdOwner: true,
      onReady: () => {
        entered.resolve();
        return undefined;
      },
    });
    await entered.promise;
    try {
      await expect(
        withNativeAuthoredProjectAdmission(selected.scope, () =>
          Promise.resolve()
        )
      ).rejects.toThrow("unsafe");
    } finally {
      releaseOwner(selected.root, run);
    }
    await first;
    await withNativeAuthoredProjectAdmission(selected.scope, (admission) =>
      admission.assertHeld()
    );
  }
);

macTest(
  "private source selection failure after reservation retains intent without spawning the consumer",
  async () => {
    const selected = await fixture({ changeDuringPlan: true });
    await failure(
      serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: STARTUP_TIMEOUT_MS,
      }),
      "retained"
    );
    expect(await artifacts(selected.scope)).toHaveLength(2);
    expect(await loadNativeAuthoredProjectRun(selected.scope)).toBeNull();
    expect(await Bun.file(selected.delivery).exists()).toBe(false);
    expect(await Bun.file(selected.calls).text()).not.toContain('"serve"');
  }
);

macTest(
  "compiler-selected literal-only environment does not acquire private delivery",
  async () => {
    const selected = await fixture({ noManaged: true });
    expect(
      await serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: STARTUP_TIMEOUT_MS,
      })
    ).toBe(0);
    expect(await Bun.file(selected.delivery).exists()).toBe(false);
    expect(await artifacts(selected.scope)).toEqual([]);
  }
);

macTest(
  "native frontend keeps the original startup deadline through input acquisition",
  async () => {
    const selected = await fixture();
    const started = performance.now();
    await failure(
      serveNativeAuthoredProject({ ...selected, run, startupTimeoutMs: 50 }),
      "not-started"
    );
    // The caller's 50 ms deadline is kept while inputs are acquired; it is
    // never replaced by a fixture or source startup budget.
    expect(performance.now() - started).toBeLessThan(DEADLINE_WALL_BOUND_MS);
    expect(await Bun.file(selected.calls).exists()).toBe(false);
    expect(await Bun.file(selected.delivery).exists()).toBe(false);
  }
);

macTest(
  "caller selection mutation cannot redirect an admitted native frontend",
  async () => {
    const selected = await fixture();
    const input = {
      ...selected,
      runtime: { ...selected.runtime },
      scope: { ...selected.scope },
      run,
      startupTimeoutMs: STARTUP_TIMEOUT_MS,
      onReady: () => {
        releaseOwner(selected.root, run);
        return undefined;
      },
    };
    // Unwrapped on purpose: the observer's copy must not mask the source's own
    // selection snapshot. The owner PID file still settles this case.
    const pending = serveStart(input);
    input.runtime.binary = join(selected.root, "missing");
    input.runtime.home = join(selected.root, "different");
    input.scope.nativeHome = input.runtime.home;
    input.scope.branch = "different";
    input.run = "9".repeat(32);
    expect(await pending).toBe(0);
    const calls = await Bun.file(selected.calls).text();
    expect(calls).toContain(selected.runtime.home);
    expect(calls).not.toContain(input.runtime.home);
    expect(await artifacts(selected.scope)).toEqual([]);
  }
);

if (process.platform !== "darwin") {
  test("unsupported native frontend platform refuses before compiler inputs or provider work", async () => {
    const selected = await fixture();
    await failure(
      serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: STARTUP_TIMEOUT_MS,
      }),
      "not-started"
    );
    expect(await readdir(selected.scope.projectDir)).not.toContain(".internal");
    expect(await Bun.file(selected.calls).exists()).toBe(false);
  });
}

macTest(
  "failed up.before records known completion and starts no native consumer or later hook",
  async () => {
    const selected = await fixture({ finiteHooks: true, failBefore: true });
    const error = await failure(
      serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: STARTUP_TIMEOUT_MS,
      }),
      "not-started"
    );
    expect(error).toHaveProperty("stage", "hook-up-before");
    expect(
      await Bun.file(join(selected.scope.projectRoot, "hook-order")).text()
    ).toBe("up-before\n");
    expect(await Bun.file(selected.calls).text()).not.toContain(
      '"frontend-serve"'
    );
    expect(
      (await artifacts(selected.scope)).some((name) =>
        name.endsWith(".hooks.json")
      )
    ).toBe(false);
  },
  CASE_TIMEOUT_MS
);

macTest(
  "malformed unnormalized host processes refuse before any hook or native operation",
  async () => {
    const selected = await fixture({ finiteHooks: true, persistent: true });
    await failure(
      serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: STARTUP_TIMEOUT_MS,
      }),
      "not-started"
    );
    expect(
      await Bun.file(join(selected.scope.projectRoot, "hook-order")).exists()
    ).toBe(false);
    expect(await Bun.file(selected.calls).exists()).toBe(false);
  }
);

macTest(
  "Source5 supervised persistent process spans ready and ordinary down without private argv values",
  async () => {
    const selected = await fixture({ finiteHooks: true, hostProcesses: true });
    let stop: Promise<void> | undefined;
    let readyValue: string | undefined;
    const code = await serveNativeAuthoredProject({
      ...selected,
      run,
      startupTimeoutMs: STARTUP_TIMEOUT_MS,
      onReady: () => {
        stop = (async () => {
          readyValue = await Bun.file(
            join(selected.scope.projectRoot, "process-value")
          ).text();
          await stopNativeAuthoredProject({
            scope: selected.scope,
            timeoutMs: STOP_TIMEOUT_MS,
          });
        })();
        return undefined;
      },
    });
    await stop;
    expect(code).toBe(0);
    expect(readyValue).toBe(CANARY);
    expect(
      await Bun.file(join(selected.scope.projectRoot, "process-order")).text()
    ).toBe("started\nstopped\n");
    expect(
      await Bun.file(join(selected.scope.projectRoot, "hook-order")).text()
    ).toBe("up-before\nup-after\ndown-before\ndown-after\n");
    expect(await loadNativeAuthoredProjectRun(selected.scope)).toBeNull();
    const files = await artifacts(selected.scope);
    expect(
      files.some((name) => name.endsWith(".host-process-owner.json"))
    ).toBe(false);
    expect(files.some((name) => name.endsWith(".hooks.json"))).toBe(false);
    expect(
      await Bun.file(join(selected.root, "mux.json.calls")).text()
    ).not.toContain(CANARY);
  },
  CASE_TIMEOUT_MS
);

macTest(
  "Source5 failed up.before leaves no host intent or mux effect",
  async () => {
    const selected = await fixture({
      finiteHooks: true,
      hostProcesses: true,
      failBefore: true,
    });
    const error = await failure(
      serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: STARTUP_TIMEOUT_MS,
      }),
      "not-started"
    );
    expect(error).toHaveProperty("stage", "hook-up-before");
    expect(await Bun.file(join(selected.root, "mux.json.calls")).exists()).toBe(
      false
    );
    const files = await artifacts(selected.scope);
    expect(
      files.some((name) => name.endsWith(".host-process-intent.json"))
    ).toBe(false);
    expect(
      files.some((name) => name.endsWith(".host-process-owner.json"))
    ).toBe(false);
  },
  CASE_TIMEOUT_MS
);

macTest(
  "Source5 cancellation after readiness settles exact host processes before retiring hooks",
  async () => {
    const selected = await fixture({ finiteHooks: true, hostProcesses: true });
    const signal = new AbortController();
    expect(
      await serveNativeAuthoredProject({
        ...selected,
        run,
        signal: signal.signal,
        startupTimeoutMs: STARTUP_TIMEOUT_MS,
        onReady: () => {
          signal.abort();
          return undefined;
        },
      })
    ).toBe(0);
    expect(
      await Bun.file(join(selected.scope.projectRoot, "process-order")).text()
    ).toBe("started\nstopped\n");
    const files = await artifacts(selected.scope);
    expect(
      files.some((name) => name.endsWith(".host-process-owner.json"))
    ).toBe(false);
    expect(files.some((name) => name.endsWith(".hooks.json"))).toBe(false);
  },
  CASE_TIMEOUT_MS
);

macTest(
  "a retained no-host stop record blocks startup before compiler or provider work",
  async () => {
    const selected = await fixture();
    await withNativeAuthoredProjectAdmission(
      selected.scope,
      async () => undefined
    );
    const root = join(
      selected.scope.projectDir,
      ".internal",
      "native-authored-runs"
    );
    const key = createHash("sha256")
      .update(JSON.stringify(selected.scope.branch))
      .digest("hex");
    await writeFile(join(root, `${key}.live-stop.json`), "{}", { mode: 0o600 });
    const error = await failure(
      serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: STARTUP_TIMEOUT_MS,
      }),
      "retained"
    );
    expect(error).toHaveProperty("stage", "retained-state");
    expect(await Bun.file(selected.calls).exists()).toBe(false);
    expect(await Bun.file(join(root, `${key}.live-stop.json`)).text()).toBe(
      "{}"
    );
  },
  CASE_TIMEOUT_MS
);

// HACK-1458: a cancel (or the startup deadline, which aborts the same signal)
// after the host processes started and before the startup intent exists must
// stop them. Their teardown freshness check used the startup inputs, bound to
// the aborted startup signal, so it always refused and left the groups running.
macTest(
  "HACK-1458: cancellation after host processes start and before reservation stops them",
  async () => {
    const selected = await fixture({ finiteHooks: true, hostProcesses: true });
    const hold = await holdSecondFrontendPlan({
      root: selected.root,
      binary: selected.runtime.binary,
    });
    const signal = new AbortController();
    let settled = false;
    const pending = serveNativeAuthoredProject({
      ...selected,
      runtime: { ...selected.runtime, binary: hold.binary },
      run,
      signal: signal.signal,
      startupTimeoutMs: STARTUP_TIMEOUT_MS,
    })
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    while (!(settled || (await Bun.file(hold.held).exists()))) {
      await Bun.sleep(20);
    }
    expect(await Bun.file(hold.held).exists()).toBe(true);
    signal.abort();
    const error = await pending;
    expect(error).toBeInstanceOf(NativeAuthoredProjectStartError);
    expect(error).toHaveProperty("canceled", true);
    expect(
      await Bun.file(join(selected.scope.projectRoot, "process-order")).text()
    ).toBe("started\nstopped\n");
    const files = await artifacts(selected.scope);
    expect(files.some((name) => name.endsWith(".start.json"))).toBe(false);
    expect(
      files.some((name) => name.endsWith(".host-process-owner.json"))
    ).toBe(false);
  }
);

// HACK-1458: a start that failed after the host process launch began but
// before its ready record left the launched group running: teardown required
// a ready record, and recovery never converts a bare launch intent into
// authority. The launch now ends what it started through its session token.
macTest(
  "HACK-1458: cancellation during the host process launch ends the launched group",
  async () => {
    const selected = await fixture({ finiteHooks: true, hostProcesses: true });
    const held = await holdFirstPaneQuery(selected.root);
    const signal = new AbortController();
    let settled = false;
    const pending = serveNativeAuthoredProject({
      ...selected,
      run,
      signal: signal.signal,
      startupTimeoutMs: STARTUP_TIMEOUT_MS,
    })
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    while (!(settled || (await Bun.file(held).exists()))) {
      await Bun.sleep(20);
    }
    expect(await Bun.file(held).exists()).toBe(true);
    // The window exists now; record its group before the launch can end it.
    const state = JSON.parse(
      await readFile(join(selected.root, "mux.json"), "utf8")
    ) as { readonly windows: Record<string, { readonly pid: number }> };
    const groups = Object.values(state.windows).map((row) => row.pid);
    expect(groups).toHaveLength(1);
    signal.abort();
    const error = await pending;
    expect(error).toBeInstanceOf(NativeAuthoredProjectStartError);
    expect(error).toHaveProperty("canceled", true);
    for (const group of groups) {
      expect(await groupEnded(group)).toBe(true);
    }
    // The owned session was ended through its token. Its owner record stays
    // unless every launched group was recorded and proven absent; a launch
    // cancelled this early may not have recorded its command group yet.
    expect(await Bun.file(join(selected.root, "mux.json")).exists()).toBe(
      false
    );
  }
);
