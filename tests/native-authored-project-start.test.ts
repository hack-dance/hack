import { test as bunTest, expect, spyOn } from "bun:test";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeAuthoredProjectPs } from "../src/backends/native-authored-project-observe.ts";
import {
  loadNativeAuthoredProjectRun,
  stopNativeAuthoredProject,
  withNativeAuthoredProjectAdmission,
} from "../src/backends/native-authored-project-run.ts";
import { NativeAuthoredProjectStartError } from "../src/backends/native-authored-project-start.ts";
import {
  nativeAuthoredUnreservedStartSelected,
  retireNativeAuthoredUnreservedStart,
} from "../src/backends/native-authored-unreserved-start.ts";
import {
  type invokeNativeRuntime,
  NativeRuntimeRequestError,
} from "../src/backends/native-runtime-client.ts";
import {
  type ComposeEnvFingerprintRecord,
  evaluateComposeServiceEnvFreshness,
} from "../src/lib/compose-env-fingerprint.ts";
import * as executionInputs from "../src/lib/native-execution-inputs.ts";
import { createNativeAuthoredStartHarness } from "./helpers/native-authored-start-fixture.ts";
import { NATIVE_FIXTURE_BUN_MARGIN_MS } from "./helpers/native-fixture-cases.ts";

const {
  run,
  CANARY,
  SETTLEMENT_BUDGET_MS,
  CASE_TIMEOUT_MS,
  STARTUP_TIMEOUT_MS,
  STOP_TIMEOUT_MS,
  cases,
  test,
  serveNativeAuthoredProject,
  fixture,
  artifacts,
  failure,
  macTest,
  confirmTestGroupAbsent,
  slowCompilerOnce,
  groupEnded,
} = createNativeAuthoredStartHarness();

const configurationRefusals = Array.from({ length: 12 }, (_, index) =>
  ["lockfiles", "runtime-files", "cache-volume", "bootstrap"].map((field) => ({
    text_fixed: true,
    service: `service${index}`,
    field: `labels.hack.dependencies.${field}`,
    message: "The dependency cache field is invalid.",
    fix: "Correct this field in the service configuration before starting the project. Use a declared, mounted named volume and relative file paths without variables or parent traversal.",
  }))
).flat();

test("authored startup keeps validated configuration findings and drops malformed batches", () => {
  expect(JSON.stringify(configurationRefusals).length).toBeGreaterThan(8192);
  const error = new NativeAuthoredProjectStartError({
    outcome: "not-started",
    canceled: false,
    stage: "native-plan",
    nativeCode: "invalid_dependency_cache",
    configurationRefusals,
  });
  expect(error.nativeCode).toBe("invalid_dependency_cache");
  expect(error.nativeConfigurationRefusals).toHaveLength(48);
  for (let index = 0; index < 12; index++) {
    expect(error.message).toContain(
      `Service service${index}, labels.hack.dependencies.`
    );
  }
  const malformed = new NativeAuthoredProjectStartError({
    outcome: "not-started",
    canceled: false,
    configurationRefusals: [...configurationRefusals, { message: CANARY }],
  });
  expect(malformed.nativeConfigurationRefusals).toBeUndefined();
  expect(JSON.stringify(malformed)).not.toContain(CANARY);
  expect(malformed.message).not.toContain(CANARY);
});

macTest(
  "authored up preserves a configuration refusal larger than 8 KiB before reservation",
  async () => {
    const selected = await fixture({
      planFailure: true,
      planFailureCode: "invalid_dependency_cache",
      planConfigurationRefusals: configurationRefusals,
    });
    const error = await failure(
      serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: STARTUP_TIMEOUT_MS,
      }),
      "not-started"
    );
    expect(error).toHaveProperty("stage", "native-plan");
    expect(error).toHaveProperty("nativeCode", "invalid_dependency_cache");
    if (!(error instanceof NativeAuthoredProjectStartError)) {
      throw new Error("Expected authored startup refusal");
    }
    expect(error.nativeConfigurationRefusals).toHaveLength(48);
    for (let index = 0; index < 12; index++) {
      expect(error.message).toContain(
        `Service service${index}, labels.hack.dependencies.`
      );
    }
    expect(await artifacts(selected.scope)).toEqual([]);
    expect(await Bun.file(selected.delivery).exists()).toBe(false);
    const calls = await Bun.file(selected.calls).text();
    expect(calls).toContain('"plan","--source-file"');
    expect(calls).not.toContain('"serve"');
    expect(JSON.stringify(error)).not.toContain("private-rejected-plan-detail");
  }
);

macTest(
  "HACK-1272: a consumer refused before journal reservation retires its exact start intent",
  async () => {
    // next.5 host repro: a repository@digest image passes planning, then the
    // native consumer refuses native_graph_admission before reserving a journal.
    // Retirement inspection can never authenticate a Removed receipt; only the
    // exact native_graph_unreserved refusal may retire the attempt.
    const selected = await fixture({
      failBeforeReceipt: true,
      failBeforeReceiptCode: "native_graph_admission",
      unreservedInspection: true,
    });
    const error = await failure(
      serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: STARTUP_TIMEOUT_MS,
      }),
      "unreserved"
    );
    expect(error).toHaveProperty("nativeCode", "native_graph_admission");
    expect(error).toHaveProperty("stage", "runtime");
    expect(String(error)).toContain("never reserved");
    expect(await artifacts(selected.scope)).toEqual([]);
    const status = await nativeAuthoredProjectPs({
      runtime: selected.runtime,
      scope: selected.scope,
      invoke: () => {
        throw new Error("No runtime request for an absent attempt.");
      },
    });
    expect(status.status).toBe("not_started");
    const calls = (await readFile(selected.calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)[4]);
    // `--json` is the read-only `runtime status --json` check that runs after
    // review and before the startup intent is reserved.
    expect(calls).toEqual(["plan", "--json", "serve", "inspect"]);
  },
  CASE_TIMEOUT_MS
);

macTest(
  "HACK-1272: down --recover retires only a provably unreserved retained start",
  async () => {
    // Reproduce the next.5 retained state: inspection named the absent journal
    // native_graph_receipt, so start and source were retained and ps is pending.
    const selected = await fixture({
      failBeforeReceipt: true,
      failBeforeReceiptCode: "native_graph_admission",
    });
    await failure(
      serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: STARTUP_TIMEOUT_MS,
      }),
      "retained"
    );
    expect(await artifacts(selected.scope)).toHaveLength(2);
    const ps = () =>
      nativeAuthoredProjectPs({
        runtime: selected.runtime,
        scope: selected.scope,
        invoke: () => {
          throw new Error("No runtime request without a Ready mapping.");
        },
      });
    expect((await ps()).status).toBe("pending");
    expect(await nativeAuthoredUnreservedStartSelected(selected.scope)).toBe(
      true
    );
    const requests: string[][] = [];
    const refusing =
      (code: string | null): typeof invokeNativeRuntime =>
      (input) => {
        requests.push([...input.args]);
        if (code === null) {
          return Promise.resolve({ receipt: {}, observations: {} });
        }
        return Promise.reject(
          new NativeRuntimeRequestError({
            message: "synthetic refusal",
            nativeCode: code,
          })
        );
      };
    const recover = (code: string | null) =>
      retireNativeAuthoredUnreservedStart({
        scope: selected.scope,
        runtime: selected.runtime,
        timeoutMs: 10_000,
        request: refusing(code),
      });
    // Damaged/foreign receipt evidence, a published owner, a stopped runtime
    // and a present journal all keep every file.
    for (const code of [
      "native_graph_receipt",
      "native_graph_foreground",
      "runtime_not_running",
      null,
    ]) {
      expect(
        await recover(code).catch((caught: unknown) => caught)
      ).toBeInstanceOf(Error);
      expect(await artifacts(selected.scope)).toHaveLength(2);
      expect((await ps()).status).toBe("pending");
    }
    expect(await recover("native_graph_unreserved")).toEqual({ run });
    expect(requests.at(-1)).toEqual([
      "graph",
      "native",
      "inspect",
      "--run-id",
      run,
      "--json",
    ]);
    expect(await artifacts(selected.scope)).toEqual([]);
    expect((await ps()).status).toBe("not_started");
    expect(await nativeAuthoredUnreservedStartSelected(selected.scope)).toBe(
      false
    );
    // Nothing remains to retire; a second recovery refuses without a request.
    const before = requests.length;
    expect(
      await recover("native_graph_unreserved").catch(
        (caught: unknown) => caught
      )
    ).toBeInstanceOf(Error);
    expect(requests).toHaveLength(before);
  },
  CASE_TIMEOUT_MS
);

test("startup diagnostics accept only closed compiler codes", () => {
  const known = new NativeAuthoredProjectStartError({
    outcome: "not-started",
    canceled: false,
    stage: "inputs",
    compilerCode: "E_COMPILER_RESPONSE",
  });
  expect(known.stage).toBe("inputs");
  expect(known.compilerCode).toBe("E_COMPILER_RESPONSE");
  expect(known.message).toContain("stage inputs (E_COMPILER_RESPONSE)");
  const unknown = new NativeAuthoredProjectStartError({
    outcome: "not-started",
    canceled: false,
    stage: "inputs",
    compilerCode: CANARY,
  });
  expect(unknown.compilerCode).toBeUndefined();
  expect(String(unknown)).not.toContain(CANARY);
  expect(JSON.stringify(unknown)).not.toContain(CANARY);
});

macTest(
  "compiler input refusal retains a closed stage/code without reserving a runtime",
  async () => {
    const selected = await fixture({ compilerFailure: true });
    const error = await failure(
      serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: STARTUP_TIMEOUT_MS,
      }),
      "not-started"
    );
    expect(error).toHaveProperty("stage", "inputs");
    expect(error).toHaveProperty("compilerCode", "E_COMPILER_RESPONSE");
    expect(await artifacts(selected.scope)).toEqual([]);
    expect(await Bun.file(selected.calls).exists()).toBe(false);
    expect(await Bun.file(selected.delivery).exists()).toBe(false);
  }
);

macTest(
  "a stopped runtime refuses before the startup intent, so ps stays not_started",
  async () => {
    const selected = await fixture({ runtimeStopped: true });
    const error = await failure(
      serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: STARTUP_TIMEOUT_MS,
      }),
      "not-started"
    );
    expect(error).toHaveProperty("nativeCode", "runtime_not_running");
    expect(error).toHaveProperty("stage", "reservation");
    // Planning ran; the read-only status check refused before reservation, so
    // no graph was served and no environment was delivered.
    const calls = (await Bun.file(selected.calls).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(calls.map((args) => args.slice(2, 5).join(" "))).toEqual([
      "graph native plan",
      "runtime status --json",
    ]);
    expect(await Bun.file(selected.delivery).exists()).toBe(false);
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
  "native frontend observes value-free digests of the delivered managed selection before ready",
  async () => {
    const selected = await fixture();
    const events: string[] = [];
    let fingerprint: ComposeEnvFingerprintRecord | undefined;
    const code = await serveNativeAuthoredProject({
      ...selected,
      run,
      startupTimeoutMs: STARTUP_TIMEOUT_MS,
      onEnvironmentSelected: (value) => {
        events.push("selected");
        fingerprint = value;
        return undefined;
      },
      onReady: () => {
        events.push("ready");
        return undefined;
      },
    });
    expect(code).toBe(0);
    expect(events).toEqual(["selected", "ready"]);
    expect(Object.keys(fingerprint?.services ?? {})).toEqual(["web"]);
    expect(JSON.stringify(fingerprint)).not.toContain(CANARY);
    expect(JSON.stringify(fingerprint)).not.toContain("TOKEN");
    expect(
      evaluateComposeServiceEnvFreshness({
        record: fingerprint,
        service: "web",
        currentEnv: { TOKEN: CANARY },
      })
    ).toBe("unchanged");
    expect(
      evaluateComposeServiceEnvFreshness({
        record: fingerprint,
        service: "web",
        currentEnv: { TOKEN: "synthetic-edited" },
      })
    ).toBe("changed");
  }
);

for (const option of [
  "planFailure",
  "foreignPlan",
  "foreignNamespace",
] as const) {
  macTest(
    `native frontend ${option} refuses before reservation or private delivery`,
    async () => {
      const selected = await fixture({ [option]: true });
      const error = await failure(
        serveNativeAuthoredProject({
          ...selected,
          run,
          startupTimeoutMs: STARTUP_TIMEOUT_MS,
        }),
        "not-started"
      );
      expect(error).toHaveProperty(
        "stage",
        option === "planFailure" ? "native-plan" : "review"
      );
      expect(await artifacts(selected.scope)).toEqual([]);
      expect(await Bun.file(selected.delivery).exists()).toBe(false);
      expect(await Bun.file(selected.calls).text()).not.toContain('"serve"');
    }
  );
}

macTest(
  "native frontend cancellation awaits owned cleanup after ready publication",
  async () => {
    const selected = await fixture();
    const signal = new AbortController();
    let ready = false;
    await failure(
      serveNativeAuthoredProject({
        ...selected,
        run,
        signal: signal.signal,
        startupTimeoutMs: STARTUP_TIMEOUT_MS,
        onReady: () => {
          ready = true;
          signal.abort();
          return undefined;
        },
      }),
      "removed"
    );
    expect(ready).toBe(true);
    expect(await artifacts(selected.scope)).toEqual([]);
    expect(await Bun.file(join(selected.root, "owner-exited")).exists()).toBe(
      true
    );
  }
);

test("invalid or pre-canceled native frontend selection has no input or runtime effects", async () => {
  const selected = await fixture();
  const signal = AbortSignal.abort();
  await failure(
    serveNativeAuthoredProject({
      ...selected,
      run,
      signal,
      startupTimeoutMs: STARTUP_TIMEOUT_MS,
    }),
    "not-started"
  );
  await failure(
    serveNativeAuthoredProject({
      ...selected,
      run: "invalid",
      startupTimeoutMs: STARTUP_TIMEOUT_MS,
    }),
    "not-started"
  );
  expect(await Bun.file(selected.calls).exists()).toBe(false);
  expect(await Bun.file(selected.delivery).exists()).toBe(false);
  expect(await readdir(selected.scope.projectDir)).not.toContain(".internal");
});

macTest(
  "asynchronous exit observation cannot leak diagnostics or replace confirmed cleanup",
  async () => {
    const selected = await fixture();
    const completed = Promise.withResolvers<void>();
    expect(
      await serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: STARTUP_TIMEOUT_MS,
        onExitDiagnostic: async () => {
          await Bun.sleep(10);
          completed.resolve();
          throw new Error(CANARY);
        },
      })
    ).toBe(0);
    await completed.promise;
    await Bun.sleep(0);
    expect(await artifacts(selected.scope)).toEqual([]);
  }
);

macTest(
  "authored four-phase hooks execute once around ready/Removed and ordinary down uses the live owner",
  async () => {
    const selected = await fixture({ finiteHooks: true });
    let stop: Promise<void> | undefined;
    const code = await serveNativeAuthoredProject({
      ...selected,
      run,
      startupTimeoutMs: STARTUP_TIMEOUT_MS,
      onReady: () => {
        stop = stopNativeAuthoredProject({
          scope: selected.scope,
          timeoutMs: STOP_TIMEOUT_MS,
        });
        return undefined;
      },
    });
    await stop;
    expect(code).toBe(0);
    expect(
      await Bun.file(join(selected.scope.projectRoot, "hook-order")).text()
    ).toBe("up-before\nup-after\ndown-before\ndown-after\n");
    expect(await loadNativeAuthoredProjectRun(selected.scope)).toBeNull();
    const calls = await Bun.file(selected.calls).text();
    expect(calls).toContain('"frontend-plan"');
    expect(calls).toContain('"frontend-serve"');
    expect(calls).not.toContain(CANARY);
    const files = await artifacts(selected.scope);
    expect(files.filter((name) => name.endsWith("-intent.json"))).toHaveLength(
      4
    );
    expect(
      files.filter((name) => name.endsWith("-complete.json"))
    ).toHaveLength(4);
    expect(files.some((name) => name.endsWith(".hooks.json"))).toBe(false);
  },
  CASE_TIMEOUT_MS
);

macTest(
  "authored semantic drift after up.before refuses before reservation or native execution",
  async () => {
    const selected = await fixture({
      finiteHooks: true,
      semanticAfterHook: true,
    });
    await failure(
      serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: STARTUP_TIMEOUT_MS,
      }),
      "not-started"
    );
    expect(
      await Bun.file(join(selected.scope.projectRoot, "hook-order")).text()
    ).toBe("up-before\n");
    expect(await loadNativeAuthoredProjectRun(selected.scope)).toBe(null);
    expect(
      await withNativeAuthoredProjectAdmission(selected.scope, (admission) =>
        admission.loadStart()
      )
    ).toBe(null);
    expect(
      (await Bun.file(selected.calls).text())
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)[4])
    ).toEqual(["frontend-plan"]);
  },
  CASE_TIMEOUT_MS
);

macTest(
  "no-host storage generations use the live stop owner and preserve data across down/up",
  async () => {
    const selected = await fixture({ storage: true, liveStop: true });
    const data = join(selected.root, "synthetic-retained-data");
    await writeFile(data, "stand-in seed once", { mode: 0o600 });
    const identities: string[] = [];
    for (const currentRun of [run, "b".repeat(32)]) {
      let stop: Promise<void> | undefined;
      const code = await serveNativeAuthoredProject({
        ...selected,
        run: currentRun,
        startupTimeoutMs: STARTUP_TIMEOUT_MS,
        onReady: (mapping) => {
          const data = mapping.record.receipt.data?.data;
          if (!data || data.state.status !== "enrolled") {
            throw new Error("Expected enrolled stand-in data.");
          }
          identities.push(data.state.volume.name);
          stop = stopNativeAuthoredProject({
            scope: selected.scope,
            timeoutMs: STOP_TIMEOUT_MS,
          });
          return undefined;
        },
      });
      await stop;
      expect(code).toBe(0);
      expect(await artifacts(selected.scope)).toEqual([]);
      expect(await Bun.file(data).text()).toBe("stand-in seed once");
    }
    expect(identities[0]).toBe(identities[1]);
    expect(identities[0]).toStartWith("hkp-");
    const calls = await Bun.file(selected.calls).text();
    expect(calls).not.toContain('"frontend-serve"');
    expect(calls).not.toContain('"frontend-plan"');
    expect(
      await Bun.file(join(selected.scope.projectRoot, "hook-order")).exists()
    ).toBe(false);
  },
  CASE_TIMEOUT_MS
);

macTest(
  "HACK-1458: a startup compiler call may outlast the compiler's 10 s default while the startup deadline remains",
  async () => {
    const selected = await fixture({ noManaged: true });
    const slow = await slowCompilerOnce({
      root: selected.root,
      operation: "compile",
    });
    slow.install();
    expect(
      await serveNativeAuthoredProject({
        ...selected,
        run,
        startupTimeoutMs: STARTUP_TIMEOUT_MS,
      })
    ).toBe(0);
    expect(await Bun.file(slow.slept).exists()).toBe(true);
    expect(await artifacts(selected.scope)).toEqual([]);
  }
);

for (const proof of [
  "removed",
  "live",
  "foreign",
  "hard-canceled",
  "unconfirmed-group",
] as const) {
  macTest(
    `pre-Ready host retirement requires settled authenticated removal: ${proof}`,
    async () => {
      const selected = await fixture({
        finiteHooks: true,
        hostProcesses: true,
        removedBeforeReady: true,
        releaseHostAfterTest: true,
        cleanup: proof === "live" ? "live" : "removed",
        foreignRemovalReview: proof === "foreign",
      });
      const signal = new AbortController();
      const force = new AbortController();
      let ready = false;
      const acquired = executionInputs.acquireNativeExecutionInputs;
      const teardownSignals: AbortSignal[] = [];
      const acquireSpy = spyOn(
        executionInputs,
        "acquireNativeExecutionInputs"
      ).mockImplementation((opts) => {
        if (signal.signal.aborted && opts.signal) {
          teardownSignals.push(opts.signal);
        }
        return acquired(opts);
      });
      const originalKill = process.kill.bind(process);
      let group: number | undefined;
      let killSpy: ReturnType<typeof spyOn<typeof process, "kill">> | undefined;
      try {
        const error = await failure(
          serveNativeAuthoredProject({
            ...selected,
            run,
            signal: signal.signal,
            forceSignal: force.signal,
            startupTimeoutMs: STARTUP_TIMEOUT_MS,
            onReady: () => {
              ready = true;
              return undefined;
            },
            onExitDiagnostic: () => {
              signal.abort();
              if (proof === "unconfirmed-group") {
                killSpy = spyOn(process, "kill").mockImplementation(
                  (pid, signal) => {
                    // Refuse only the consumer's first settlement probe. A later
                    // real ESRCH must not replace its missing onSettled event.
                    if (pid < 0 && signal === 0 && group === undefined) {
                      group = pid;
                      throw Object.assign(
                        new Error("synthetic group uncertainty"),
                        { code: "EPERM" }
                      );
                    }
                    return originalKill(pid, signal);
                  }
                );
              }
              if (proof === "hard-canceled") {
                force.abort();
              }
            },
          }),
          proof === "removed" ? "removed" : "retained"
        );
        expect(error).toHaveProperty("canceled", true);
        expect(ready).toBe(false);
        // Retention alone is weak evidence: stale canceled startup inputs also
        // retain everything. Each case must reach the fresh teardown admission.
        expect(teardownSignals.length).toBe(
          proof === "unconfirmed-group" ? 0 : 1
        );
        if (proof !== "unconfirmed-group") {
          expect(teardownSignals[0]?.aborted).toBe(proof === "hard-canceled");
          expect(teardownSignals[0]).not.toBe(signal.signal);
        }
        expect(
          await Bun.file(
            join(selected.scope.projectRoot, "process-order")
          ).text()
        ).toBe(proof === "removed" ? "started\nstopped\n" : "started\n");
        const files = await artifacts(selected.scope);
        expect(files.some((name) => name.endsWith(".start.json"))).toBe(
          proof !== "removed"
        );
        expect(
          files.some((name) => name.endsWith(".host-process-owner.json"))
        ).toBe(proof !== "removed");
      } finally {
        acquireSpy.mockRestore();
        if (killSpy) {
          confirmTestGroupAbsent(group, originalKill);
          killSpy.mockRestore();
        }
        // Only this test's cooperating stand-in observes this marker. It does not
        // turn an unproved production cleanup into an accepted stop.
        await Bun.write(
          join(selected.scope.projectRoot, "release-host-test"),
          "release"
        );
      }
    }
  );
}

// HACK-1458 item 4: a failed case must not leave the stand-in groups running.
// Bun runs this body outside `cases.test`, because the guarded case fails here.
bunTest.skipIf(process.platform !== "darwin")(
  "HACK-1458: a failed case ends the stand-in mux groups it left running",
  async () => {
    let group: number | undefined;
    let root: string | undefined;
    try {
      await expect(
        cases.run(async () => {
          const selected = await fixture({ hostProcesses: true });
          root = selected.root;
          const mux = join(selected.root, "bin", "tmux");
          for (const args of [
            ["new-session", "-s", "failed-case", "-c", selected.root],
            ["new-window", "-n", "held", "-c", selected.root, "sleep 300"],
          ]) {
            const child = Bun.spawn([mux, ...args], {
              env: process.env,
              stdout: "ignore",
              stderr: "ignore",
            });
            expect(await child.exited).toBe(0);
          }
          const state = JSON.parse(
            await readFile(join(selected.root, "mux.json"), "utf8")
          ) as {
            readonly windows: { readonly held: { readonly pid: number } };
          };
          group = state.windows.held.pid;
          process.kill(-group, 0);
          throw new Error("deliberate case failure");
        }, CASE_TIMEOUT_MS)
      ).rejects.toThrow("deliberate case failure");
      if (group === undefined) {
        throw new Error("the stand-in window was never recorded");
      }
      expect(await groupEnded(group)).toBe(true);
    } finally {
      await cases.drain();
      if (root !== undefined) {
        await rm(root, { recursive: true, force: true });
      }
    }
  },
  CASE_TIMEOUT_MS + SETTLEMENT_BUDGET_MS + NATIVE_FIXTURE_BUN_MARGIN_MS
);
