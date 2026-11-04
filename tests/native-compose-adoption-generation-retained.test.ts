import { test as boundedTest, expect, spyOn } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tryLegacyComposeAdoptedCommand } from "../src/lib/native-compose-adoption-command.ts";
import { runLegacyComposeRetainedOperation } from "../src/lib/native-compose-adoption-execution.ts";
import { openLegacyComposeAdoptedGenerationStore } from "../src/lib/native-compose-adoption-generation.ts";
import * as adoptionRuntime from "../src/lib/native-compose-adoption-runtime.ts";
import { captureAdoptionDependencyFirstPrepare } from "./e2e/scenarios/native-compose-adoption-dependency-staged-read.ts";
import { restoreEnv } from "./helpers/env.ts";
import { createAdoptionGenerationFixture } from "./helpers/native-compose-adoption-generation-fixture.ts";

const context = createAdoptionGenerationFixture();
const {
  ADOPTION_CASE_TIMEOUT_MS,
  RETAINED_OPERATION_DEADLINE_MS,
  retainedOperationCaseTimeout,
  EXPIRING_OPERATION_DEADLINE_MS,
  DEADLINE_REFUSAL_SLACK_MS,
  CANCELLED_EFFECT_REFUSAL_BOUND_MS,
  CANARY,
  ID,
  CREATED,
  save,
  compiler,
  prepared,
  dependencyFixture,
  mutationCommands,
  refusal,
  linkedCheckout,
  readReceipt,
  originalSnapshots,
  expectOriginals,
} = context;

boundedTest(
  "v5 explicit preparation stop uses reverse original-ID order and can publish after verified completion",
  async () => {
    const worker = await dependencyFixture();
    context.fixture.states = { [ID]: true, [worker]: true };
    await save();
    const { store, generation } = await prepared();
    const controller = new AbortController();
    try {
      const binary = await compiler(),
        deadline = Date.now() + RETAINED_OPERATION_DEADLINE_MS;
      expect(
        await store.withPreparationStop({
          generation,
          binary,
          deadline,
          run: async (input) => {
            expect((await readReceipt()).pendingOperation.operation).toBe(
              "stop"
            );
            return await runLegacyComposeRetainedOperation({
              input,
              operation: "stop",
              deadline,
              signal: controller.signal,
            });
          },
        })
      ).toBe(0);
      expect(await mutationCommands()).toEqual([
        ["container", "stop", worker],
        ["container", "stop", ID],
      ]);
      expect((await readReceipt()).pendingOperation).toBeNull();
      await store.publish({ generation, binary });
      expect((await readReceipt()).publication.phase).toBe("active");
    } finally {
      await store.close();
    }
  },
  retainedOperationCaseTimeout(1)
);

boundedTest(
  "v5 expired aggregate deadline after callback keeps pending instead of acknowledging completion",
  async () => {
    await dependencyFixture();
    const { store, generation } = await prepared();
    try {
      const binary = await compiler();
      await store.publish({ generation, binary });
      const deadline = Date.now() + EXPIRING_OPERATION_DEADLINE_MS;
      await refusal(
        store.withMutation({
          generation,
          binary,
          operation: "stop",
          services: [],
          deadline,
          run: async () => {
            await Bun.sleep(Math.max(1, deadline - Date.now() + 5));
            return 0;
          },
        }),
        // Nothing drifted: expiry is not reported as a binding change (HACK-1340).
        "E_LEGACY_ADOPTION_DEADLINE"
      );
      expect((await readReceipt()).pendingOperation.operation).toBe("stop");
    } finally {
      await store.close();
    }
  },
  retainedOperationCaseTimeout(1)
);

boundedTest(
  "v5 requires one finite aggregate deadline before probing or journaling a mutation",
  async () => {
    await dependencyFixture();
    const { store, generation } = await prepared();
    try {
      const binary = await compiler();
      await store.publish({ generation, binary });
      const before = await readFile(join(context.root, "commands"), "utf8");
      let called = false;
      for (const deadline of [
        undefined,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Date.now() - 1,
      ]) {
        await refusal(
          store.withMutation({
            generation,
            binary,
            operation: "stop",
            services: [],
            deadline,
            run: async () => {
              called = true;
              return 0;
            },
          }),
          "E_LEGACY_ADOPTION_UNSUPPORTED"
        );
      }
      expect(called).toBe(false);
      expect(await readFile(join(context.root, "commands"), "utf8")).toBe(
        before
      );
      expect((await readReceipt()).pendingOperation).toBeNull();
    } finally {
      await store.close();
    }
  },
  ADOPTION_CASE_TIMEOUT_MS
);

for (const linked of [false, true]) {
  boundedTest(
    `rolled-back v5 can reprepare a verified plain generation with ${linked ? "linked" : "directory"} checkout receipt version`,
    async () => {
      const captureStages =
        process.env.HACK_TEST_ADOPTION_REPREPARE_STAGES === "1";
      const started = performance.now();
      const stage = (
        value:
          | "entry"
          | "checkout"
          | "dependencies"
          | "v5-prepared"
          | "v5-published"
          | "v5-rolled-back"
          | "plain-source"
          | "plain-prepared"
          | "plain-loaded-prepared"
          | "plain-published"
          | "plain-loaded-active"
          | "closed"
      ) => {
        if (captureStages) {
          // Opt-in diagnostic only: fixed stages and elapsed time, no fixture
          // path, source, private receipt, child argv or resource values.
          process.stderr.write(
            `${JSON.stringify({
              diagnostic: "v5-reprepare-stage",
              layout: linked ? "linked" : "directory",
              stage: value,
              elapsedMs: Math.round(performance.now() - started),
            })}\n`
          );
        }
      };
      stage("entry");
      if (linked) {
        await linkedCheckout();
      }
      stage("checkout");
      const worker = await dependencyFixture();
      stage("dependencies");
      const { store, generation } = await prepared();
      stage("v5-prepared");
      try {
        const binary = await compiler();
        await store.publish({ generation, binary });
        stage("v5-published");
        await store.rollback();
        stage("v5-rolled-back");
        const composePath = join(
          context.projectRoot,
          ".hack/docker-compose.yml"
        );
        const authored = JSON.parse(await readFile(composePath, "utf8"));
        authored.services.web.depends_on = undefined;
        authored.services.db.healthcheck = undefined;
        await writeFile(composePath, JSON.stringify(authored));
        stage("plain-source");
        // The synthetic engine config-hash owner continues to attest the new source.
        const plain = await store.prepare({ binary });
        stage("plain-prepared");
        expect(plain.report.adoption_generation_version).toBe(1);
        expect((await readReceipt()).adoption_receipt_version).toBe(
          linked ? 2 : 1
        );
        expect(
          (await store.loadPrepared())?.report.adoption_generation_version
        ).toBe(1);
        stage("plain-loaded-prepared");
        await store.publish({ generation: plain, binary });
        stage("plain-published");
        expect(
          (await store.loadActive())?.report.adoption_generation_version
        ).toBe(1);
        stage("plain-loaded-active");
        expect(await mutationCommands()).toEqual([]);
        expect(context.fixture.container.map((row) => row.id)).toEqual([
          ID,
          worker,
        ]);
        expect(context.fixture.volume[0]?.createdAt).toBe(CREATED);
      } finally {
        await store.close();
        stage("closed");
      }
    },
    ADOPTION_CASE_TIMEOUT_MS
  );
}

for (const stage of ["per-effect freshness", "final observation"] as const) {
  boundedTest(
    `v5 remaining aggregate clock terminates held ${stage} and retains pending`,
    async () => {
      await dependencyFixture();
      const { store, generation } = await prepared();
      try {
        const binary = await compiler();
        await store.publish({ generation, binary });
        const deadline = Date.now() + EXPIRING_OPERATION_DEADLINE_MS;
        let reachedCallback = false;
        await refusal(
          store.withMutation({
            generation,
            binary,
            operation: "stop",
            services: [],
            deadline,
            run: async (input) => {
              reachedCallback = true;
              context.fixture.mode =
                stage === "per-effect freshness" ? "hang" : "hang-state";
              await save();
              if (stage === "per-effect freshness") {
                await input.assertFresh();
              }
              return 0;
            },
          }),
          "E_LEGACY_ADOPTION_DEADLINE"
        );
        expect(reachedCallback).toBe(true);
        expect(Date.now()).toBeLessThan(deadline + DEADLINE_REFUSAL_SLACK_MS);
        const pid = Number(
          (await readFile(join(context.root, "started"), "utf8")).trim()
        );
        expect(Number.isSafeInteger(pid)).toBe(true);
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
        expect(alive).toBe(false);
        expect((await readReceipt()).pendingOperation.operation).toBe("stop");
        expect(await mutationCommands()).toEqual([]);
        expect(context.fixture.volume[0]?.createdAt).toBe(CREATED);
      } finally {
        await store.close();
      }
    },
    retainedOperationCaseTimeout(1)
  );
}

boundedTest(
  "final prepared anchor cannot authorize the earlier staged query; old temporal guard refuses before effects",
  async () => {
    await dependencyFixture();
    context.fixture.dependencyReadScope = {
      projectRoot: context.projectRoot,
      first: await captureAdoptionDependencyFirstPrepare({
        projectRoot: context.projectRoot,
      }),
      allowFirstPrepare: false,
    };
    await save();
    await refusal(prepared(), "E_LEGACY_ADOPTION_STATE");
    const stages = (await readFile(join(context.root, "read-stages"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(stages.at(-1)).toEqual({ stage: "staged", allowed: false });
    expect((await readReceipt()).prepared).toBeNull();
    expect((await readReceipt()).pendingOperation).toBeNull();
    expect(await mutationCommands()).toEqual([]);
    expect(context.fixture.volume[0]?.createdAt).toBe(CREATED);
  },
  ADOPTION_CASE_TIMEOUT_MS
);

boundedTest(
  "dependency fixture admits first preparation before publication and checks later reads against their current receipt",
  async () => {
    await dependencyFixture();
    context.fixture.dependencyReadScope = {
      projectRoot: context.projectRoot,
      first: await captureAdoptionDependencyFirstPrepare({
        projectRoot: context.projectRoot,
      }),
      allowFirstPrepare: true,
    };
    await save();
    const { store, generation } = await prepared();
    try {
      await store.publish({ generation, binary: await compiler() });
      const stages = (await readFile(join(context.root, "read-stages"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        stages.filter((row) => row.stage === "staged").length
      ).toBeGreaterThan(0);
      expect(
        stages.filter((row) => row.stage === "published").length
      ).toBeGreaterThan(0);
      expect(stages.every((row) => row.allowed)).toBe(true);
      expect(await mutationCommands()).toEqual([]);
      expect(context.fixture.volume[0]?.createdAt).toBe(CREATED);
    } finally {
      await store.close();
    }
  },
  ADOPTION_CASE_TIMEOUT_MS
);

boundedTest(
  "v5 retained dispatch orders exact originals and reverses stops without creating data",
  async () => {
    const worker = await dependencyFixture(),
      original = await originalSnapshots();
    context.fixture.dependencyReadScope = {
      projectRoot: context.projectRoot,
      first: await captureAdoptionDependencyFirstPrepare({
        projectRoot: context.projectRoot,
      }),
      allowFirstPrepare: true,
    };
    await save();
    const { store, generation } = await prepared();
    const priorCompiler = process.env.HACK_CONFIG_COMPILER_BINARY;
    try {
      const binary = await compiler();
      process.env.HACK_CONFIG_COMPILER_BINARY = binary;
      expect(generation.report.adoption_generation_version).toBe(5);
      expect((await readReceipt()).adoption_receipt_version).toBe(5);
      expect(JSON.stringify(generation)).not.toContain(CANARY);
      await store.publish({ generation, binary });
      expect(
        await tryLegacyComposeAdoptedCommand({
          cwd: context.projectRoot,
          operation: "up",
          detach: true,
        })
      ).toBe(0);
      expect(await mutationCommands()).toEqual([
        ["container", "start", ID],
        ["container", "start", worker],
      ]);
      expect(
        await tryLegacyComposeAdoptedCommand({
          cwd: context.projectRoot,
          operation: "down",
        })
      ).toBe(0);
      expect((await mutationCommands()).slice(2)).toEqual([
        ["container", "stop", worker],
        ["container", "stop", ID],
      ]);
      context.fixture = JSON.parse(
        await readFile(join(context.root, "fixture.json"), "utf8")
      );
      expect(context.fixture.volume[0]?.createdAt).toBe(CREATED);
      expect(context.fixture.container.map((row) => row.id)).toEqual([
        ID,
        worker,
      ]);
      expect((await readReceipt()).pendingOperation).toBeNull();
      const reads = (await readFile(join(context.root, "read-stages"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(reads.length).toBeGreaterThan(20);
      expect(reads.every((row) => row.allowed)).toBe(true);
      await store.rollback();
      await expectOriginals(original);
    } finally {
      restoreEnv("HACK_CONFIG_COMPILER_BINARY", priorCompiler);
      await store.close();
    }
  },
  retainedOperationCaseTimeout(2)
);

boundedTest(
  "v5 partial selection refuses before a journal or effect; private recheck expires at callback return",
  async () => {
    await dependencyFixture();
    const { store, generation } = await prepared();
    try {
      const binary = await compiler();
      await store.publish({ generation, binary });
      let calls = 0;
      await refusal(
        store.withMutation({
          deadline: Date.now() + RETAINED_OPERATION_DEADLINE_MS,
          generation,
          binary,
          operation: "start",
          services: ["db"],
          run: async () => {
            calls++;
            return 0;
          },
        }),
        "E_LEGACY_ADOPTION_UNSUPPORTED"
      );
      expect(calls).toBe(0);
      expect((await readReceipt()).pendingOperation).toBeNull();
      let retained: (() => Promise<void>) | undefined;
      await store.withMutation({
        deadline: Date.now() + RETAINED_OPERATION_DEADLINE_MS,
        generation,
        binary,
        operation: "stop",
        services: [],
        run: async (input) => {
          expect(Object.keys(input)).toEqual([]);
          expect(JSON.stringify(input)).toBe("{}");
          retained = input.assertFresh;
          await input.assertFresh();
          return 0;
        },
      });
      const before = await readFile(join(context.root, "commands"), "utf8");
      if (!retained) {
        throw new Error("missing test capability");
      }
      await expect(retained()).rejects.toThrow("values omitted");
      expect(await readFile(join(context.root, "commands"), "utf8")).toBe(
        before
      );
    } finally {
      await store.close();
    }
  },
  retainedOperationCaseTimeout(2)
);

boundedTest(
  "v5 source drift between ordered effects retains pending evidence and explicit repair permits stop recovery",
  async () => {
    const worker = await dependencyFixture();
    const { store, generation } = await prepared();
    const priorCompiler = process.env.HACK_CONFIG_COMPILER_BINARY;
    try {
      const binary = await compiler();
      process.env.HACK_CONFIG_COMPILER_BINARY = binary;
      await store.publish({ generation, binary });
      const candidate = await readFile(
        join(context.projectRoot, ".hack/hack.project.json"),
        "utf8"
      );
      context.fixture.sourceRace = true;
      await save();
      await expect(
        tryLegacyComposeAdoptedCommand({
          cwd: context.projectRoot,
          operation: "up",
          detach: true,
        })
      ).rejects.toThrow("values omitted");
      expect(await mutationCommands()).toEqual([["container", "start", ID]]);
      expect((await readReceipt()).pendingOperation.operation).toBe("start");
      context.fixture = JSON.parse(
        await readFile(join(context.root, "fixture.json"), "utf8")
      );
      context.fixture.sourceRace = false;
      await save();
      await writeFile(
        join(context.projectRoot, ".hack/hack.project.json"),
        candidate
      );
      expect(
        await tryLegacyComposeAdoptedCommand({
          cwd: context.projectRoot,
          operation: "down",
          recover: true,
        })
      ).toBe(0);
      expect((await mutationCommands()).slice(1)).toEqual([
        ["container", "stop", worker],
        ["container", "stop", ID],
      ]);
      expect((await readReceipt()).pendingOperation).toBeNull();
      expect(context.fixture.volume[0]?.createdAt).toBe(CREATED);
    } finally {
      restoreEnv("HACK_CONFIG_COMPILER_BINARY", priorCompiler);
      await store.close();
    }
  },
  retainedOperationCaseTimeout(2)
);

boundedTest(
  "v5 final unhealthy observation cannot acknowledge a successful effect",
  async () => {
    await dependencyFixture();
    const { store, generation } = await prepared();
    try {
      const binary = await compiler();
      await store.publish({ generation, binary });
      await refusal(
        store.withMutation({
          deadline: Date.now() + RETAINED_OPERATION_DEADLINE_MS,
          generation,
          binary,
          operation: "start",
          services: [],
          run: async () => {
            context.fixture.states = Object.fromEntries(
              context.fixture.container.map((row) => [String(row.id), true])
            );
            context.fixture.health = { [ID]: "unhealthy" };
            await save();
            return 0;
          },
        }),
        "E_LEGACY_ADOPTION_CHANGED"
      );
      expect((await readReceipt()).pendingOperation.operation).toBe("start");
      await refusal(store.loadActive(), "E_LEGACY_ADOPTION_BUSY");
      expect(context.fixture.volume[0]?.createdAt).toBe(CREATED);
    } finally {
      await store.close();
    }
  },
  retainedOperationCaseTimeout(1)
);

boundedTest(
  "v5 recheck cancellation refuses a next effect and retains the journal",
  async () => {
    await dependencyFixture();
    const controller = new AbortController();
    const store = await openLegacyComposeAdoptedGenerationStore({
      projectRoot: context.projectRoot,
      signal: controller.signal,
    });
    try {
      const binary = await compiler(),
        generation = await store.prepare({ binary });
      await store.publish({ generation, binary });
      let effects = 0;
      await refusal(
        store.withMutation({
          deadline: Date.now() + RETAINED_OPERATION_DEADLINE_MS,
          generation,
          binary,
          operation: "start",
          services: [],
          run: async (input) => {
            effects++;
            controller.abort(CANARY);
            await input.assertFresh();
            effects++;
            return 0;
          },
        }),
        "E_LEGACY_ADOPTION_CANCELLED"
      );
      expect(effects).toBe(1);
      expect((await readReceipt()).pendingOperation.operation).toBe("start");
    } finally {
      await store.close();
    }
  },
  retainedOperationCaseTimeout(1)
);

boundedTest(
  "v5 active captured signal reaps the actual retained effect and keeps pending",
  async () => {
    await dependencyFixture();
    const controller = new AbortController();
    const store = await openLegacyComposeAdoptedGenerationStore({
      projectRoot: context.projectRoot,
      signal: controller.signal,
    });
    try {
      const binary = await compiler(),
        generation = await store.prepare({ binary });
      await store.publish({ generation, binary });
      context.fixture.hangMutation = true;
      await save();
      const deadline = Date.now() + RETAINED_OPERATION_DEADLINE_MS;
      let effectStartedAt = 0;
      await refusal(
        store.withMutation({
          generation,
          binary,
          operation: "start",
          services: [],
          deadline,
          run: async (input) => {
            const operation = runLegacyComposeRetainedOperation({
              input,
              operation: "start",
              deadline,
              signal: controller.signal,
            });
            // Handshake, not a timed wait: the effect child publishes its PID,
            // or the operation settles without one (HACK-1319).
            let settled = false;
            operation.then(
              () => {
                settled = true;
              },
              () => {
                settled = true;
              }
            );
            while (
              !(
                (await Bun.file(
                  join(context.root, "effect-started")
                ).exists()) || settled
              )
            ) {
              await Bun.sleep(10);
            }
            expect(
              await Bun.file(join(context.root, "effect-started")).exists()
            ).toBe(true);
            effectStartedAt = Date.now();
            controller.abort(CANARY);
            return await operation;
          },
        }),
        "E_LEGACY_ADOPTION_CANCELLED"
      );
      expect(Date.now() - effectStartedAt).toBeLessThan(
        CANCELLED_EFFECT_REFUSAL_BOUND_MS
      );
      const pid = Number(
        await Bun.file(join(context.root, "effect-started")).text()
      );
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
      expect(await mutationCommands()).toEqual([["container", "start", ID]]);
      expect((await readReceipt()).pendingOperation.operation).toBe("start");
      expect(context.fixture.volume[0]?.createdAt).toBe(CREATED);
    } finally {
      await store.close();
    }
  },
  retainedOperationCaseTimeout(1)
);

boundedTest.skipIf(!process.env.HACK_TEST_OLD_ADOPTION_BINARY)(
  "v5 supplied previous upgraded owner refuses before compiler, key or engine reads",
  async () => {
    await dependencyFixture();
    const { store, generation } = await prepared();
    try {
      const binary = await compiler();
      await store.publish({ generation, binary });
      const oldBinary = process.env.HACK_TEST_OLD_ADOPTION_BINARY;
      if (!oldBinary) {
        throw new Error("required previous binary unavailable");
      }
      const before = await readFile(join(context.root, "commands"), "utf8");
      const child = Bun.spawn(
        [oldBinary, "--path", context.projectRoot, "ps", "--json"],
        {
          env: {
            PATH: `${context.root}:/usr/bin:/bin`,
            HOME: context.root,
            HACK_HOME: join(context.root, "old-owner-home"),
            HACK_CONFIG_COMPILER_BINARY: binary,
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000,
        }
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).not.toBe(0);
      expect(stdout + stderr).toContain("Legacy adoption selection");
      expect(stdout + stderr).not.toContain(CANARY);
      expect(await readFile(join(context.root, "commands"), "utf8")).toBe(
        before
      );
    } finally {
      await store.close();
    }
  },
  ADOPTION_CASE_TIMEOUT_MS
);

for (const abortAt of ["generation", "binding"] as const) {
  boundedTest(
    `HACK-1810: an early deadline timer abort reaches ${abortAt} as a deadline, not caller cancellation`,
    async () => {
      await dependencyFixture();
      const { store, generation } = await prepared();
      const originalTimeout = globalThis.setTimeout;
      let fireDeadline: (() => void) | undefined;
      let timer: { mockRestore: () => void } | undefined;
      let stateSpy: { mockRestore: () => void } | undefined;
      let bindingAborted = false;
      try {
        const binary = await compiler();
        await store.publish({ generation, binary });
        timer = spyOn(globalThis, "setTimeout").mockImplementation(
          Object.assign(
            (handler: TimerHandler, delay?: number, ...args: unknown[]) => {
              if (
                typeof handler === "function" &&
                handler.name === "adoptionDeadlineAbort"
              ) {
                fireDeadline = () => handler(...args);
              }
              return originalTimeout(handler, delay, ...args);
            },
            { __promisify__: originalTimeout.__promisify__ }
          ) as typeof setTimeout
        );
        const deadline = Date.now() + RETAINED_OPERATION_DEADLINE_MS;
        await refusal(
          store.withMutation({
            generation,
            binary,
            operation: "stop",
            services: [],
            deadline,
            run: async (input) => {
              expect(Date.now()).toBeLessThan(deadline);
              expect(fireDeadline).toBeDefined();
              if (abortAt === "generation") {
                fireDeadline?.();
                // The timer can win the final rounded millisecond before the
                // wall clock. Exercise cancelled() before its date guard.
                input.assertActive();
              } else {
                const inspect =
                  adoptionRuntime.inspectLegacyComposeContainerStates;
                stateSpy = spyOn(
                  adoptionRuntime,
                  "inspectLegacyComposeContainerStates"
                ).mockImplementation(async (opts) => {
                  expect(Date.now()).toBeLessThan(deadline);
                  expect(opts.signal?.aborted).toBe(false);
                  fireDeadline?.();
                  bindingAborted = true;
                  // Let the real lower layer classify its aborted probe. The
                  // generation's cancelled() does not see this signal here.
                  return await inspect(opts);
                });
              }
              return 0;
            },
          }),
          "E_LEGACY_ADOPTION_DEADLINE"
        );
        expect(bindingAborted).toBe(abortAt === "binding");
        expect((await readReceipt()).pendingOperation.operation).toBe("stop");
        expect(await mutationCommands()).toEqual([]);
      } finally {
        stateSpy?.mockRestore();
        timer?.mockRestore();
        await store.close();
      }
    },
    retainedOperationCaseTimeout(1)
  );
}
