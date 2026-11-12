import { expect, spyOn } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { nativeAuthoredProjectPs } from "../src/backends/native-authored-project-observe.ts";
import {
  loadNativeAuthoredProjectRun,
  stopNativeAuthoredProject,
  withNativeAuthoredProjectAdmission,
} from "../src/backends/native-authored-project-run.ts";
import { NativeAuthoredProjectStartError } from "../src/backends/native-authored-project-start.ts";
import { nativeCodesReportRuntimeNotRunning } from "../src/backends/native-runtime-client.ts";
import {
  type ComposeEnvFingerprintRecord,
  evaluateComposeServiceEnvFreshness,
} from "../src/lib/compose-env-fingerprint.ts";
import { awaitPidFile } from "./helpers/native-authored-settlement.ts";
import { createNativeAuthoredStartHarness } from "./helpers/native-authored-start-fixture.ts";

const {
  run,
  CANARY,
  CASE_TIMEOUT_MS,
  STARTUP_TIMEOUT_MS,
  STOP_TIMEOUT_MS,
  serveNativeAuthoredProject,
  fixture,
  artifacts,
  failure,
  macTest,
  confirmTestGroupAbsent,
  slowCompilerOnce,
} = createNativeAuthoredStartHarness();

macTest(
  "a runtime that stops during serve keeps the wrapped stopped-runtime cause",
  async () => {
    const selected = await fixture({ stoppedDuringServe: true });
    const error = await failure(
      serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: STARTUP_TIMEOUT_MS,
      }),
      "retained"
    );
    expect(error).toHaveProperty("nativeCode", "native_graph_foreground");
    expect(error).toHaveProperty("nativeCauseCode", "runtime_not_running");
    expect(error).toHaveProperty("stage", "runtime");
  }
);

macTest(
  "a wrapped stopped-runtime refusal from a runtime request keeps its cause code",
  async () => {
    const selected = await fixture({ runtimeStatusWrappedStop: true });
    const error = await failure(
      serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: STARTUP_TIMEOUT_MS,
      }),
      "not-started"
    );
    // failedAdmission takes both codes from the request error, so the CLI can
    // still classify the wrapped form as a stopped runtime.
    expect(error).toHaveProperty("nativeCode", "native_graph_foreground");
    expect(error).toHaveProperty("nativeCauseCode", "runtime_not_running");
    expect(error).toHaveProperty("stage", "reservation");
    expect(
      nativeCodesReportRuntimeNotRunning(
        error as { nativeCode?: string; nativeCauseCode?: string }
      )
    ).toBe(true);
    expect(await artifacts(selected.scope)).toEqual([]);
  }
);

macTest(
  "cancel during the runtime status check refuses before the startup intent",
  async () => {
    const selected = await fixture({ runtimeStatusHangs: true });
    const signal = new AbortController();
    const started = serveNativeAuthoredProject({
      ...selected,
      run,
      signal: signal.signal,
      startupTimeoutMs: STARTUP_TIMEOUT_MS,
    });
    // Cancel once the status request is in flight and has published its PID.
    // The check treats the aborted request as inconclusive; the start must
    // still not reserve. The stand-in request hangs past the case budget, so
    // this waits on the request's own identity rather than a fixed window, and
    // the cancel cannot land while the stand-in is still recording it.
    await awaitPidFile(selected.statusPid, { budgetMs: CASE_TIMEOUT_MS });
    signal.abort();
    const error = await failure(started, "not-started");
    expect(error).toHaveProperty("canceled", true);
    expect(error).toHaveProperty("stage", "reservation");
    const calls = (await Bun.file(selected.calls).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(calls.map((args) => args.slice(2, 5).join(" "))).toEqual([
      "graph native plan",
      "runtime status --json",
    ]);
    expect(await artifacts(selected.scope)).toEqual([]);
    expect(
      await nativeAuthoredProjectPs({
        runtime: selected.runtime,
        scope: selected.scope,
      })
    ).toMatchObject({ status: "not_started", run: null, items: [] });
  }
);

macTest(
  "native frontend holds admission through exact ready publication and Removed retirement",
  async () => {
    const selected = await fixture({ branch: "feature" });
    let ready = 0;
    const code = await serveNativeAuthoredProject({
      ...selected,
      run,
      startupTimeoutMs: STARTUP_TIMEOUT_MS,
      onReady: (mapping, identity) => {
        ready += 1;
        expect(identity).toEqual({ projectName: "fixture" });
        expect(selected.scope.projectRoot.endsWith("/project")).toBe(true);
        expect(Object.isFrozen(mapping.record.receipt.resources)).toBe(true);
        expect(mapping.record.receipt.review.provenance.run).toBe(run);
        return undefined;
      },
    });
    expect(code).toBe(0);
    expect(ready).toBe(1);
    expect(await loadNativeAuthoredProjectRun(selected.scope)).toBeNull();
    expect(await artifacts(selected.scope)).toEqual([]);
    expect(await readdir(selected.scope.nativeHome)).toEqual([]);
    const delivery = await Bun.file(selected.delivery).json();
    expect(delivery.kind).toBe("native-graph-environment");
    expect(delivery.version).toBe(2);
    expect(delivery.run).toBe(run);
    expect(delivery.keys).toEqual({ web: ["TOKEN"] });
    expect(delivery.digests).toEqual({
      web: { TOKEN: delivery.expectedDigest },
    });
    expect(delivery.lifetime_seconds).toBeGreaterThan(0);
    expect(delivery.lifetime_seconds).toBeLessThan(STARTUP_TIMEOUT_MS / 1000);
    expect(await Bun.file(selected.calls).text()).not.toContain(CANARY);
  }
);

macTest(
  "a selection without managed keys digests an empty set and a throwing observer never fails startup",
  async () => {
    const selected = await fixture({ noManaged: true });
    let fingerprint: ComposeEnvFingerprintRecord | undefined;
    expect(
      await serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: STARTUP_TIMEOUT_MS,
        onEnvironmentSelected: (value) => {
          fingerprint = value;
          throw new Error("synthetic observer failure");
        },
      })
    ).toBe(0);
    expect(
      evaluateComposeServiceEnvFreshness({
        record: fingerprint,
        service: "web",
        currentEnv: {},
      })
    ).toBe("unchanged");
  }
);

for (const option of ["failedStatus", "changeDuringStatus"] as const) {
  macTest(
    `native frontend ${option} refuses ready publication and authenticates cleanup`,
    async () => {
      const selected = await fixture({ [option]: true });
      let ready = false;
      await failure(
        serveNativeAuthoredProject({
          ...selected,
          run,
          startupTimeoutMs: STARTUP_TIMEOUT_MS,
          onReady: () => {
            ready = true;
            return undefined;
          },
        }),
        "removed"
      );
      expect(ready).toBe(false);
      expect(await artifacts(selected.scope)).toEqual([]);
      expect(await Bun.file(join(selected.root, "owner-exited")).exists()).toBe(
        true
      );
    }
  );
}

for (const option of ["failedStatus", "changeDuringStatus"] as const) {
  for (const cleanup of ["foreign-id", "foreign-owner"] as const) {
    macTest(
      `pre-publication ${option} cannot retire from ${cleanup} cleanup`,
      async () => {
        const selected = await fixture({ [option]: true, cleanup });
        let ready = false;
        await failure(
          serveNativeAuthoredProject({
            ...selected,
            run,
            startupTimeoutMs: STARTUP_TIMEOUT_MS,
            onReady: () => {
              ready = true;
              return undefined;
            },
          }),
          "retained"
        );
        expect(ready).toBe(false);
        expect(await loadNativeAuthoredProjectRun(selected.scope)).toBeNull();
        const retained = await artifacts(selected.scope);
        expect(retained).toHaveLength(2);
        expect(retained.some((name) => name.endsWith(".start.json"))).toBe(
          true
        );
        expect(retained.some((name) => name.endsWith(".source.json"))).toBe(
          true
        );
        expect(
          await Bun.file(join(selected.root, "owner-exited")).exists()
        ).toBe(true);
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
}

macTest(
  "untyped asynchronous ready observation refuses and consumes private rejection",
  async () => {
    const selected = await fixture();
    const completed = Promise.withResolvers<void>();
    const callback = async () => {
      await Bun.sleep(10);
      completed.resolve();
      throw new Error(CANARY);
    };
    await failure(
      serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: STARTUP_TIMEOUT_MS,
        onReady: callback as unknown as () => undefined,
      }),
      "removed"
    );
    await completed.promise;
    await Bun.sleep(0);
    expect(await artifacts(selected.scope)).toEqual([]);
  }
);

macTest(
  "missing storage bundle refuses before hooks, native planning, reservation or private delivery",
  async () => {
    const selected = await fixture({
      finiteHooks: true,
      storage: true,
      noManaged: true,
    });
    const error = await failure(
      serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: STARTUP_TIMEOUT_MS,
      }),
      "not-started"
    );
    expect(error).toHaveProperty("stage", "storage-tool");
    expect(
      await Bun.file(join(selected.scope.projectRoot, "hook-order")).exists()
    ).toBe(false);
    expect(await Bun.file(selected.calls).exists()).toBe(false);
    expect(await Bun.file(selected.delivery).exists()).toBe(false);
    expect(await artifacts(selected.scope)).toEqual([]);
  },
  CASE_TIMEOUT_MS
);

macTest(
  "failed down.before retains the supervised runtime and cannot replay before explicit hard cancellation",
  async () => {
    const selected = await fixture({ finiteHooks: true, failDownBefore: true });
    const force = new AbortController();
    let stop: Promise<void> | undefined;
    let retainedAtFailure = false;
    const stages: unknown[] = [];
    const code = await serveNativeAuthoredProject({
      ...selected,
      run,
      startupTimeoutMs: STARTUP_TIMEOUT_MS,
      forceSignal: force.signal,
      onHookDiagnostic: (event) => stages.push(event),
      onReady: () => {
        stop = (async () => {
          await expect(
            stopNativeAuthoredProject({
              scope: selected.scope,
              timeoutMs: STOP_TIMEOUT_MS,
            })
          ).rejects.toThrow();
          retainedAtFailure =
            (await loadNativeAuthoredProjectRun(selected.scope)) !== null;
          force.abort();
        })();
        return undefined;
      },
    }).catch((error: unknown) => error);
    await stop;
    expect(JSON.parse(JSON.stringify(stages))).toEqual([
      { phase: "up.before", boundary: "acquire" },
      { phase: "up.before", boundary: "prepare" },
      { phase: "up.before", boundary: "complete" },
      { phase: "up.after", boundary: "acquire" },
      { phase: "up.after", boundary: "prepare" },
      { phase: "up.after", boundary: "complete" },
      { phase: "down.before", boundary: "stop-request" },
      { phase: "down.before", boundary: "acquire" },
      { phase: "down.before", boundary: "prepare" },
      { phase: "down.before", boundary: "complete" },
      { phase: "down.before", boundary: "stop-operation" },
    ]);
    expect(retainedAtFailure).toBe(true);
    expect(code).toBeInstanceOf(NativeAuthoredProjectStartError);
    expect(
      await Bun.file(join(selected.scope.projectRoot, "hook-order")).text()
    ).toBe("up-before\nup-after\ndown-before\n");
  },
  CASE_TIMEOUT_MS
);

macTest(
  "known failed down.after retires the hook owner and bindings while preserving failure and permits a fresh run",
  async () => {
    const selected = await fixture({ finiteHooks: true, failDownAfter: true });
    for (const currentRun of [run, "b".repeat(32)]) {
      let stop: Promise<unknown> | undefined;
      const error = await failure(
        serveNativeAuthoredProject({
          ...selected,
          run: currentRun,
          startupTimeoutMs: STARTUP_TIMEOUT_MS,
          onReady: () => {
            stop = stopNativeAuthoredProject({
              scope: selected.scope,
              timeoutMs: STOP_TIMEOUT_MS,
            }).catch((caught: unknown) => caught);
            return undefined;
          },
        }),
        "removed"
      );
      expect(error).toHaveProperty("stage", "hook-down-after");
      expect(await stop).toBeInstanceOf(Error);
      expect(await loadNativeAuthoredProjectRun(selected.scope)).toBeNull();
      await withNativeAuthoredProjectAdmission(
        selected.scope,
        async (admission) => {
          expect(await admission.loadStart()).toBeNull();
          expect(await admission.hooksRetained()).toBe(false);
        }
      );
    }
    expect(
      await Bun.file(join(selected.scope.projectRoot, "hook-order")).text()
    ).toBe("up-before\nup-after\ndown-before\ndown-after\n".repeat(2));
    const calls = (await Bun.file(selected.calls).text())
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)[4]);
    expect(calls.filter((action) => action === "frontend-serve")).toHaveLength(
      2
    );
  },
  // Two full start and stop cycles. The case ceiling leaves no room for a
  // second case budget; a passing cycle takes a small part of one.
  CASE_TIMEOUT_MS
);

macTest(
  "unknown down.after completion keeps frontend bindings and hook intent together without replay",
  async () => {
    const selected = await fixture({
      finiteHooks: true,
      changeHookOwnerAfter: true,
    });
    let stop: Promise<unknown> | undefined;
    await failure(
      serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: STARTUP_TIMEOUT_MS,
        onReady: () => {
          stop = stopNativeAuthoredProject({
            scope: selected.scope,
            timeoutMs: STOP_TIMEOUT_MS,
          }).catch((caught: unknown) => caught);
          return undefined;
        },
      }),
      "retained"
    );
    expect(await stop).toBeInstanceOf(Error);
    expect(await loadNativeAuthoredProjectRun(selected.scope)).not.toBeNull();
    await withNativeAuthoredProjectAdmission(
      selected.scope,
      async (admission) => {
        expect(await admission.loadStart()).not.toBeNull();
        expect(await admission.hooksRetained()).toBe(true);
      }
    );
    const files = await artifacts(selected.scope);
    expect(files).toContain(`${run}.hook-down.after-intent.json`);
    expect(files).not.toContain(`${run}.hook-down.after-complete.json`);
    expect(files).toContain(`${run}.source.json`);
    expect(
      await Bun.file(join(selected.scope.projectRoot, "hook-order")).text()
    ).toBe("up-before\nup-after\ndown-before\ndown-after\n");
  },
  CASE_TIMEOUT_MS
);

macTest(
  "no-host Removed with unconfirmed original group retains all frontend bindings",
  async () => {
    const selected = await fixture({ liveStop: true });
    const original = process.kill.bind(process);
    let stop: Promise<void> | undefined;
    let group: number | undefined;
    let spy: ReturnType<typeof spyOn<typeof process, "kill">> | undefined;
    try {
      const error = await failure(
        serveNativeAuthoredProject({
          ...selected,
          run,
          startupTimeoutMs: STARTUP_TIMEOUT_MS,
          onReady: () => {
            stop = stopNativeAuthoredProject({
              scope: selected.scope,
              timeoutMs: STOP_TIMEOUT_MS,
            });
            void stop.catch(() => undefined);
            return undefined;
          },
          onExitDiagnostic: () => {
            spy = spyOn(process, "kill").mockImplementation((pid, signal) => {
              if (pid < 0 && signal === 0) {
                group = pid;
                throw Object.assign(new Error("synthetic group uncertainty"), {
                  code: "EPERM",
                });
              }
              return original(pid, signal);
            });
          },
        }),
        "retained"
      );
      expect(error).toHaveProperty("stage", "runtime");
      const files = await artifacts(selected.scope);
      expect(files).toContain(`${run}.source.json`);
      expect(files.some((name) => name.endsWith(".start.json"))).toBe(true);
      expect(files.some((name) => name.endsWith(".live-stop.json"))).toBe(true);
      expect(await loadNativeAuthoredProjectRun(selected.scope)).not.toBeNull();
      expect(
        (await Bun.file(join(selected.root, "journal.json")).json()).phase
      ).toBe("removed");
    } finally {
      // Independently settle the injected test uncertainty; no signal or reap.
      await stop?.catch(() => undefined);
      confirmTestGroupAbsent(group, original);
      spy?.mockRestore();
    }
  },
  CASE_TIMEOUT_MS
);

for (const [httpsPort, branch, url] of [
  [8443, "main", "https://main.fixture.hack.local:8443"],
  [undefined, "main", "https://main.fixture.hack.local"],
  [8443, null, "https://fixture.hack.local:8443"],
] as const) {
  macTest(
    `authored native source carries public runtime host metadata (port ${httpsPort ?? "none"}, branch ${branch ?? "none"})`,
    async () => {
      const selected = await fixture({ branch });
      expect(
        await serveNativeAuthoredProject({
          ...selected,
          run,
          httpsPort,
          startupTimeoutMs: STARTUP_TIMEOUT_MS,
        })
      ).toBe(0);
      const recorded = (await Bun.file(selected.sources).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(recorded.length).toBeGreaterThan(0);
      for (const metadata of recorded) {
        expect(Object.keys(metadata.runtime).sort()).toEqual(["off", "web"]);
        const web = metadata.runtime.web;
        expect(web.HACK_BRANCH).toBe(branch ?? "");
        expect(web.HACK_COMPOSE_PROJECT).toBe(
          branch ? `fixture--${branch}` : "fixture"
        );
        expect(web.HACK_DEV_URL).toBe(url);
        expect(web.HACK_SERVICE_NAME).toBe("web");
        expect(metadata.runtime.off.HACK_SERVICE_NAME).toBe("off");
        expect(JSON.stringify(metadata)).not.toContain(CANARY);
      }
    }
  );
}

// HACK-1458: the loaded hang of "Source5 cancellation after readiness". The
// cancel's down.before acquisition kept the compiler's fixed 10 s default, so
// a slow compiler failed the graceful stop, and the start then retained the
// live owner and host processes until a hard cancellation that never came.
macTest(
  "HACK-1458: Source5 cancellation after readiness settles when its down acquisition compiler is slow",
  async () => {
    const selected = await fixture({ finiteHooks: true, hostProcesses: true });
    const slow = await slowCompilerOnce({ root: selected.root });
    const signal = new AbortController();
    const stages: string[] = [];
    expect(
      await serveNativeAuthoredProject({
        ...selected,
        run,
        signal: signal.signal,
        startupTimeoutMs: STARTUP_TIMEOUT_MS,
        onHookDiagnostic: (event) => {
          stages.push(`${event.phase}:${event.boundary}`);
        },
        onReady: () => {
          // The next compiler invocation is the cancel's down acquisition.
          slow.install();
          signal.abort();
          return undefined;
        },
      })
    ).toBe(0);
    expect(await Bun.file(slow.slept).exists()).toBe(true);
    expect(stages).not.toContain("down.before:stop-operation");
    expect(stages).toContain("down.after:complete");
    expect(
      await Bun.file(join(selected.scope.projectRoot, "process-order")).text()
    ).toBe("started\nstopped\n");
    expect(
      await Bun.file(join(selected.scope.projectRoot, "hook-order")).text()
    ).toBe("up-before\nup-after\ndown-before\ndown-after\n");
    const files = await artifacts(selected.scope);
    expect(
      files.some((name) => name.endsWith(".host-process-owner.json"))
    ).toBe(false);
    expect(files.some((name) => name.endsWith(".hooks.json"))).toBe(false);
  }
);
