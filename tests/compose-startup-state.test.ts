import { expect, test } from "bun:test";
import {
  type ComposeServiceState,
  waitForComposeStartupState,
} from "../src/lib/compose-startup-state.ts";

/** Virtual Docker timeline: one initializer can finish between any two reads. */
async function observe(opts: {
  readonly samples: readonly (readonly ComposeServiceState[])[];
  readonly sampleMs?: number;
  readonly budgetMs?: number;
}) {
  let elapsed = 0;
  let reads = 0;
  const budgets: number[] = [];
  const result = await waitForComposeStartupState({
    deadlineMs: opts.budgetMs ?? 1000,
    successfulCompletionServices: new Set(["init"]),
    now: () => elapsed,
    sleep: async (ms) => {
      elapsed += ms;
    },
    read: async (timeoutMs) => {
      budgets.push(timeoutMs);
      elapsed += opts.sampleMs ?? 10;
      const sample = opts.samples[Math.min(reads++, opts.samples.length - 1)];
      if (!sample) {
        throw new Error("Missing Docker sample");
      }
      return sample;
    },
  });
  return { ...result, reads, elapsed, budgets };
}

function job(state: string, exitCode = 0, containerId = "current") {
  return [{ containerId, service: "init", state, exitCode }];
}

for (const samples of [
  [job("created"), job("running"), job("exited")],
  [job("created"), job("exited"), job("exited")],
  [job("exited"), job("exited")],
  [job("exited", 0, "old"), job("created"), job("exited"), job("exited")],
  [job("created", 0, "old"), [], job("exited"), job("exited")],
]) {
  test(`sub-second job succeeds at ${samples.map((s) => s[0]?.state ?? "absent").join(" -> ")}`, async () => {
    const result = await observe({ samples });
    expect(result.startup.failed).toEqual([]);
    expect(result.elapsed).toBeLessThan(1000);
    expect(result.states[0]?.containerId).toBe("current");
  });
}

test("old exit zero cannot mask a replacement that never starts", async () => {
  const result = await observe({
    samples: [job("exited", 0, "old"), job("created")],
  });
  expect(result.startup.failed).toEqual(["init"]);
  expect(result.startup.completed).toEqual([]);
  expect(result.elapsed).toBeGreaterThanOrEqual(1000);
  expect(result.budgets.at(-1)).toBeLessThan(1000);
});

test("replacement exit 17 remains a failure", async () => {
  const result = await observe({
    samples: [job("exited", 0, "old"), job("exited", 17)],
  });
  expect(result.startup.failed).toEqual(["init"]);
  expect(result.startup.completed).toEqual([]);
  expect(result.elapsed).toBeLessThan(1000);
});

test("zero exit without a completion hint remains a failure", async () => {
  const result = await observe({
    samples: [
      [{ containerId: "server", service: "api", state: "exited", exitCode: 0 }],
    ],
  });
  expect(result.startup.failed).toEqual(["api"]);
});

test("an exhausted start budget does not grant an uncorroborated success", async () => {
  const result = await observe({ samples: [job("exited")], budgetMs: 5 });
  expect(result.startup.failed).toEqual(["init"]);
  expect(result.reads).toBe(1);
});

test("other running services cannot mask an initializer missing during replacement", async () => {
  const server = {
    containerId: "server",
    service: "api",
    state: "running",
    exitCode: 0,
  };
  const result = await observe({
    samples: [[server, ...job("exited", 0, "old")], [server]],
  });
  expect(result.startup.failed).toEqual(["init"]);
  expect(result.startup.completed).toEqual([]);
  expect(result.elapsed).toBeGreaterThanOrEqual(1000);
});
