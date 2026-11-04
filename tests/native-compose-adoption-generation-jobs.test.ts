import { test as boundedTest, expect } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HackCliError } from "../src/lib/cli-result.ts";
import { tryLegacyComposeAdoptedCommand } from "../src/lib/native-compose-adoption-command.ts";
import {
  type LegacyComposeRetainedOutcome,
  runLegacyComposeRetainedOperation,
} from "../src/lib/native-compose-adoption-execution.ts";
import { openLegacyComposeAdoptedGenerationStore } from "../src/lib/native-compose-adoption-generation.ts";
import { restoreEnv } from "./helpers/env.ts";
import { createAdoptionGenerationFixture } from "./helpers/native-compose-adoption-generation-fixture.ts";

const context = createAdoptionGenerationFixture();
const {
  ADOPTION_CASE_TIMEOUT_MS,
  RETAINED_OPERATION_DEADLINE_MS,
  retainedOperationCaseTimeout,
  CANARY,
  ID,
  VOLUME,
  CREATED,
  save,
  compiler,
  prepared,
  mutationCommands,
  completedJobFixture,
  maintainedCompletedJobFixture,
  maintainedJobCompiler,
  publicStatic7Case,
  publicStatic7Stages,
  refusal,
  readReceipt,
} = context;

boundedTest(
  "retained Compose fixture admits its explicit backend and preserves opposite-backend refusal before probes",
  async () => {
    await publicStatic7Case(async () => {
      expect(process.env.HACK_RUNTIME_BACKEND).toBe("compose");
      const binary = await compiler();
      const { store, generation } = await prepared(binary);
      const priorCompiler = process.env.HACK_CONFIG_COMPILER_BINARY;
      try {
        process.env.HACK_CONFIG_COMPILER_BINARY = binary;
        await store.publish({ generation, binary });
        const commands = await readFile(join(context.root, "commands"), "utf8");
        process.env.HACK_RUNTIME_BACKEND = "native";
        try {
          await expect(
            tryLegacyComposeAdoptedCommand({
              cwd: context.projectRoot,
              operation: "up",
              detach: true,
            })
          ).rejects.toMatchObject({ code: "E_NATIVE_PROJECT_UNSUPPORTED" });
          expect(await readFile(join(context.root, "commands"), "utf8")).toBe(
            commands
          );
          expect((await readReceipt()).pendingOperation).toBeNull();
        } finally {
          process.env.HACK_RUNTIME_BACKEND = "compose";
        }
        expect(
          await tryLegacyComposeAdoptedCommand({
            cwd: context.projectRoot,
            operation: "up",
            detach: true,
          })
        ).toBe(0);
        expect(await mutationCommands()).toEqual([["container", "start", ID]]);
      } finally {
        restoreEnv("HACK_CONFIG_COMPILER_BINARY", priorCompiler);
        await store.close();
      }
    });
  },
  retainedOperationCaseTimeout(1)
);

boundedTest.each(["no", ""] as const)(
  "public retained up dispatches the maintained static7 family with disabled policy %j",
  async (jobRestartPolicy) => {
    await publicStatic7Case(async () => {
      const stages = publicStatic7Stages();
      stages("prepare", "enter");
      const { app, job } = await maintainedCompletedJobFixture();
      const binary = await maintainedJobCompiler();
      const { store, generation } = await prepared(binary);
      stages("prepare", "settled");
      const priorCompiler = process.env.HACK_CONFIG_COMPILER_BINARY;
      try {
        process.env.HACK_CONFIG_COMPILER_BINARY = binary;
        stages("publish", "enter");
        await store.publish({ generation, binary });
        stages("publish", "settled");
        context.fixture.jobRestartPolicy = jobRestartPolicy;
        await save();
        expect(generation.report.adoption_generation_version).toBe(7);
        stages("start", "enter");
        expect(
          await tryLegacyComposeAdoptedCommand({
            cwd: context.projectRoot,
            operation: "up",
            detach: true,
          })
        ).toBe(0);
        stages("start", "settled");
        expect(await mutationCommands()).toEqual([
          ["container", "start", ID],
          ["container", "start", job],
          ["container", "start", app],
        ]);
        expect((await readReceipt()).pendingOperation).toBeNull();
        stages("stop", "enter");
        expect(
          await tryLegacyComposeAdoptedCommand({
            cwd: context.projectRoot,
            operation: "down",
          })
        ).toBe(0);
        stages("stop", "settled");
        expect((await mutationCommands()).slice(-3)).toEqual([
          ["container", "stop", app],
          ["container", "stop", job],
          ["container", "stop", ID],
        ]);
      } finally {
        restoreEnv("HACK_CONFIG_COMPILER_BINARY", priorCompiler);
        await store.close();
      }
    });
  },
  // Cover prepare/publish and separate bounded up/down operations without changing their deadlines.
  retainedOperationCaseTimeout(2)
);

boundedTest.each([
  "shape",
  "timestamp",
  "restart-policy",
  "membership",
  "probe",
] as const)(
  "public static7 observer refuses %s with only closed diagnostics and keeps pending",
  async (reason) => {
    await publicStatic7Case(async () => {
      await maintainedCompletedJobFixture();
      const binary = await maintainedJobCompiler();
      const { store, generation } = await prepared(binary);
      const priorCompiler = process.env.HACK_CONFIG_COMPILER_BINARY;
      try {
        process.env.HACK_CONFIG_COMPILER_BINARY = binary;
        await store.publish({ generation, binary });
        context.fixture.jobObservation = reason;
        await save();
        let rejection: unknown;
        try {
          await tryLegacyComposeAdoptedCommand({
            cwd: context.projectRoot,
            operation: "up",
            detach: true,
          });
        } catch (error: unknown) {
          rejection = error;
        }
        expect(rejection).toBeInstanceOf(HackCliError);
        if (!(rejection instanceof HackCliError)) {
          throw new Error("missing public refusal");
        }
        expect(rejection.code).toBe("E_CONFIG_INVALID");
        expect(rejection.detail).toEqual({
          legacy_adoption_refusal: {
            stage: "ordered-observation",
            reason: reason === "probe" ? "probe-child" : reason,
          },
        });
        expect(
          JSON.stringify({
            message: rejection.message,
            detail: rejection.detail,
          })
        ).not.toContain(CANARY);
        expect((await readReceipt()).pendingOperation.operation).toBe("start");
        expect(
          (await mutationCommands()).some(
            (args) => args[2] === "e".repeat(64) || args[2] === "c".repeat(64)
          )
        ).toBe(false);
      } finally {
        restoreEnv("HACK_CONFIG_COMPILER_BINARY", priorCompiler);
        await store.close();
      }
    });
  },
  retainedOperationCaseTimeout(1)
);

boundedTest(
  "public static7 scheduler classifies actual nonzero job exit without starting its dependent",
  async () => {
    await publicStatic7Case(async () => {
      const { job, app } = await maintainedCompletedJobFixture();
      const binary = await maintainedJobCompiler();
      const { store, generation } = await prepared(binary);
      const priorCompiler = process.env.HACK_CONFIG_COMPILER_BINARY;
      try {
        process.env.HACK_CONFIG_COMPILER_BINARY = binary;
        await store.publish({ generation, binary });
        const jobState = context.fixture.jobs?.[job];
        if (!jobState) {
          throw new Error("missing job state");
        }
        jobState.exitCode = 17;
        await save();
        let rejection: unknown;
        try {
          await tryLegacyComposeAdoptedCommand({
            cwd: context.projectRoot,
            operation: "up",
            detach: true,
          });
        } catch (error: unknown) {
          rejection = error;
        }
        expect(rejection).toBeInstanceOf(HackCliError);
        if (!(rejection instanceof HackCliError)) {
          throw new Error("missing public refusal");
        }
        expect(rejection.detail).toEqual({
          legacy_adoption_refusal: {
            stage: "ordered-scheduler",
            reason: "job-failed",
          },
        });
        expect(await mutationCommands()).toEqual([
          ["container", "start", ID],
          ["container", "start", job],
        ]);
        expect((await mutationCommands()).some((args) => args[2] === app)).toBe(
          false
        );
        expect((await readReceipt()).pendingOperation.operation).toBe("start");
      } finally {
        restoreEnv("HACK_CONFIG_COMPILER_BINARY", priorCompiler);
        await store.close();
      }
    });
  },
  retainedOperationCaseTimeout(1)
);

boundedTest.each(["start", "restart", "stop"] as const)(
  "v7 %s preserves original IDs, fresh job proof and stopped rollback",
  async (operation) => {
    const { app, job } = await completedJobFixture(),
      { store, generation } = await prepared();
    const signal = new AbortController().signal;
    try {
      const binary = await compiler();
      expect(generation.report.adoption_generation_version).toBe(7);
      await store.publish({ generation, binary });
      expect((await readReceipt()).adoption_receipt_version).toBe(7);
      // Restart/stop independently exercise retained running facts, not an inferred prior start effect.
      if (operation !== "start") {
        context.fixture.states = { [ID]: true, [app]: true, [job]: false };
        await save();
      }
      const deadline = Date.now() + RETAINED_OPERATION_DEADLINE_MS;
      expect(
        await store.withMutation({
          generation,
          binary,
          operation,
          services: [],
          deadline,
          run: (input) =>
            runLegacyComposeRetainedOperation({
              input,
              operation,
              deadline,
              signal,
            }),
        })
      ).toBe(0);
      const forward = [
        ["container", "start", ID],
        ["container", "start", job],
        ["container", "start", app],
      ];
      const reverse = [
        ["container", "stop", app],
        ["container", "stop", job],
        ["container", "stop", ID],
      ];
      let expected = forward;
      if (operation === "restart") {
        expected = [...reverse, ...forward];
      } else if (operation === "stop") {
        expected = reverse;
      }
      expect(await mutationCommands()).toEqual(expected);
      expect((await readReceipt()).pendingOperation).toBeNull();
      const observed: unknown = JSON.parse(
        await readFile(join(context.root, "fixture.json"), "utf8")
      );
      expect(observed).toMatchObject({
        container: [{ id: ID }, { id: app }, { id: job }],
        volume: [{ id: VOLUME, createdAt: CREATED }],
        jobs: { [job]: { attempts: operation === "stop" ? 0 : 1 } },
        states: {
          [ID]: operation !== "stop",
          [job]: false,
          [app]: operation !== "stop",
        },
      });
      if (operation === "stop") {
        await store.rollback();
        expect((await readReceipt()).publication.phase).toBe("rolled-back");
        expect(
          await Bun.file(
            join(context.projectRoot, ".hack/hack.project.json")
          ).exists()
        ).toBe(false);
      }
    } finally {
      await store.close();
    }
  },
  retainedOperationCaseTimeout(1)
);

boundedTest(
  "v7 old exit0 and callback numeric0 cannot clear the pending job attempt; recovery never starts jobs",
  async () => {
    const { app, job } = await completedJobFixture(),
      { store, generation } = await prepared();
    try {
      const binary = await compiler();
      await store.publish({ generation, binary });
      await expect(
        store.withMutation({
          generation,
          binary,
          operation: "start",
          services: [],
          deadline: Date.now() + RETAINED_OPERATION_DEADLINE_MS,
          run: async () => {
            context.fixture.states = { [ID]: true, [app]: true, [job]: false };
            await save();
            return 0;
          },
        })
      ).rejects.toThrow("values omitted");
      expect((await readReceipt()).pendingOperation.operation).toBe("start");
      expect(await mutationCommands()).toEqual([]);
      const deadline = Date.now() + RETAINED_OPERATION_DEADLINE_MS;
      expect(
        await store.withMutation({
          generation,
          binary,
          operation: "stop",
          recover: true,
          services: [],
          deadline,
          run: (input) =>
            runLegacyComposeRetainedOperation({
              input,
              operation: "stop",
              deadline,
              signal: new AbortController().signal,
            }),
        })
      ).toBe(0);
      expect(await mutationCommands()).toEqual([
        ["container", "stop", app],
        ["container", "stop", job],
        ["container", "stop", ID],
      ]);
      expect((await readReceipt()).pendingOperation).toBeNull();
    } finally {
      await store.close();
    }
  },
  retainedOperationCaseTimeout(2)
);

boundedTest(
  "v7 immediate job exit17 keeps pending and prevents every dependent start",
  async () => {
    const { job } = await completedJobFixture();
    if (!context.fixture.jobs?.[job]) {
      throw new Error("missing job fixture");
    }
    context.fixture.jobs[job].exitCode = 17;
    await save();
    const { store, generation } = await prepared();
    try {
      const binary = await compiler();
      await store.publish({ generation, binary });
      const deadline = Date.now() + RETAINED_OPERATION_DEADLINE_MS;
      await expect(
        store.withMutation({
          generation,
          binary,
          operation: "start",
          services: [],
          deadline,
          run: (input) =>
            runLegacyComposeRetainedOperation({
              input,
              operation: "start",
              deadline,
              signal: new AbortController().signal,
            }),
        })
      ).rejects.toThrow("values omitted");
      expect(await mutationCommands()).toEqual([
        ["container", "start", ID],
        ["container", "start", job],
      ]);
      expect((await readReceipt()).pendingOperation.operation).toBe("start");
      expect(context.fixture.volume[0]?.createdAt).toBe(CREATED);
    } finally {
      await store.close();
    }
  },
  retainedOperationCaseTimeout(1)
);

boundedTest(
  "v7 consumed production completion cannot acknowledge a later invocation",
  async () => {
    await completedJobFixture();
    const { store, generation } = await prepared();
    try {
      const binary = await compiler();
      await store.publish({ generation, binary });
      let previous: LegacyComposeRetainedOutcome | undefined;
      const deadline = Date.now() + RETAINED_OPERATION_DEADLINE_MS;
      expect(
        await store.withMutation({
          generation,
          binary,
          operation: "start",
          services: [],
          deadline,
          run: async (input) => {
            previous = await runLegacyComposeRetainedOperation({
              input,
              operation: "start",
              deadline,
              signal: new AbortController().signal,
            });
            expect(JSON.stringify(previous)).toBe("{}");
            return previous;
          },
        })
      ).toBe(0);
      const before = await mutationCommands();
      await expect(
        store.withMutation({
          generation,
          binary,
          operation: "start",
          services: [],
          deadline: Date.now() + RETAINED_OPERATION_DEADLINE_MS,
          run: async () => {
            if (!previous) {
              throw new Error("missing completion");
            }
            return previous;
          },
        })
      ).rejects.toThrow("values omitted");
      expect(await mutationCommands()).toEqual(before);
      expect((await readReceipt()).pendingOperation.operation).toBe("start");
    } finally {
      await store.close();
    }
  },
  retainedOperationCaseTimeout(2)
);

boundedTest(
  "v7 cloned production completion cannot acknowledge otherwise ready original workloads",
  async () => {
    await completedJobFixture();
    const { store, generation } = await prepared();
    try {
      const binary = await compiler();
      await store.publish({ generation, binary });
      const deadline = Date.now() + RETAINED_OPERATION_DEADLINE_MS;
      await expect(
        store.withMutation({
          generation,
          binary,
          operation: "start",
          services: [],
          deadline,
          run: async (input) => {
            const outcome = await runLegacyComposeRetainedOperation({
              input,
              operation: "start",
              deadline,
              signal: new AbortController().signal,
            });
            if (typeof outcome !== "object") {
              throw new Error("missing completion");
            }
            return { ...outcome };
          },
        })
      ).rejects.toThrow("values omitted");
      expect(
        (await mutationCommands()).filter((args) => args[1] === "start")
      ).toHaveLength(3);
      expect((await readReceipt()).pendingOperation.operation).toBe("start");
    } finally {
      await store.close();
    }
  },
  retainedOperationCaseTimeout(1)
);

boundedTest(
  "v7 source drift in the final job probe prevents pending publication after successful children",
  async () => {
    const { app, job } = await completedJobFixture(),
      { store, generation } = await prepared();
    try {
      const binary = await compiler();
      await store.publish({ generation, binary });
      const original = await readFile(
        join(context.projectRoot, ".hack/hack.project.json"),
        "utf8"
      );
      const deadline = Date.now() + RETAINED_OPERATION_DEADLINE_MS;
      await refusal(
        store.withMutation({
          generation,
          binary,
          operation: "start",
          services: [],
          deadline,
          run: async (input) => {
            const outcome = await runLegacyComposeRetainedOperation({
              input,
              operation: "start",
              deadline,
              signal: new AbortController().signal,
            });
            context.fixture = JSON.parse(
              await readFile(join(context.root, "fixture.json"), "utf8")
            );
            context.fixture.jobFinalRace = true;
            await save();
            return outcome;
          },
        }),
        "E_LEGACY_ADOPTION_STATE"
      );
      expect(await mutationCommands()).toEqual([
        ["container", "start", ID],
        ["container", "start", job],
        ["container", "start", app],
      ]);
      expect((await readReceipt()).pendingOperation.operation).toBe("start");
      context.fixture.jobFinalRace = false;
      await save();
      await writeFile(
        join(context.projectRoot, ".hack/hack.project.json"),
        original
      );
      const recoveryDeadline = Date.now() + RETAINED_OPERATION_DEADLINE_MS;
      expect(
        await store.withMutation({
          generation,
          binary,
          operation: "stop",
          recover: true,
          services: [],
          deadline: recoveryDeadline,
          run: (input) =>
            runLegacyComposeRetainedOperation({
              input,
              operation: "stop",
              deadline: recoveryDeadline,
              signal: new AbortController().signal,
            }),
        })
      ).toBe(0);
    } finally {
      await store.close();
    }
  },
  retainedOperationCaseTimeout(2)
);

boundedTest(
  "v7 final historical exit0 cannot clear pending even after a minted successful attempt",
  async () => {
    const { job } = await completedJobFixture(),
      { store, generation } = await prepared();
    try {
      const binary = await compiler();
      await store.publish({ generation, binary });
      const deadline = Date.now() + RETAINED_OPERATION_DEADLINE_MS;
      await expect(
        store.withMutation({
          generation,
          binary,
          operation: "start",
          services: [],
          deadline,
          run: async (input) => {
            const outcome = await runLegacyComposeRetainedOperation({
              input,
              operation: "start",
              deadline,
              signal: new AbortController().signal,
            });
            context.fixture = JSON.parse(
              await readFile(join(context.root, "fixture.json"), "utf8")
            );
            const state = context.fixture.jobs?.[job];
            if (!state) {
              throw new Error("missing job fixture");
            }
            state.startedAt = "2026-10-08T00:00:01.000Z";
            await save();
            return outcome;
          },
        })
      ).rejects.toThrow("values omitted");
      expect(
        (await mutationCommands()).filter((args) => args[1] === "start")
      ).toHaveLength(3);
      expect((await readReceipt()).pendingOperation.operation).toBe("start");
    } finally {
      await store.close();
    }
  },
  retainedOperationCaseTimeout(1)
);

boundedTest(
  "v7 managed layout refuses before compiler/value acquisition or engine probe",
  async () => {
    await completedJobFixture();
    await writeFile(
      join(context.projectRoot, ".hack/hack.env.prod.yaml"),
      "synthetic-private-unqualified-managed-input"
    );
    const store = await openLegacyComposeAdoptedGenerationStore({
      projectRoot: context.projectRoot,
    });
    try {
      await expect(store.prepare({ binary: await compiler() })).rejects.toThrow(
        "values omitted"
      );
      expect(await Bun.file(join(context.root, "commands")).exists()).toBe(
        false
      );
      expect(
        await Bun.file(join(context.root, "candidate-received")).exists()
      ).toBe(false);
      expect((await readReceipt()).prepared).toBeNull();
    } finally {
      await store.close();
    }
  },
  ADOPTION_CASE_TIMEOUT_MS
);
