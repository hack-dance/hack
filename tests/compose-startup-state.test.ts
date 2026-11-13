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
  const result = await waitForComposeStartupState({
    deadlineMs: opts.budgetMs ?? 1000,
    successfulCompletionServices: new Set(["init"]),
    now: () => elapsed,
    sleep: async (ms) => {
      elapsed += ms;
    },
    read: async () => {
      elapsed += opts.sampleMs ?? 10;
      const sample = opts.samples[Math.min(reads++, opts.samples.length - 1)];
      if (!sample) {
        throw new Error("Missing Docker sample");
      }
      return sample;
    },
  });
  return { ...result, reads, elapsed };
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

for (const budgetMs of [0, 5, 100]) {
  test(`healthy startup receives corroborating reads with ${budgetMs} ms remaining`, async () => {
    const result = await observe({
      samples: [job("exited")],
      sampleMs: 150,
      budgetMs,
    });
    expect(result.startup.completed).toEqual(["init"]);
    expect(result.startup.failed).toEqual([]);
    expect(result.reads).toBe(2);
  });
}

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

test("deadline names only the service whose container identity changed", async () => {
  const server = {
    containerId: "server",
    service: "api",
    state: "running",
    exitCode: 0,
  };
  const result = await observe({
    samples: [
      [server, ...job("exited", 0, "old")],
      [server, ...job("running")],
    ],
    budgetMs: 5,
  });
  expect(result.startup.running).toEqual(["api"]);
  expect(result.startup.failed).toEqual(["init"]);
});
test("a Docker inspection failure is propagated without retries", async () => {
  let reads = 0;
  await expect(
    waitForComposeStartupState({
      read: async () => {
        reads++;
        throw new Error("inspection failed");
      },
      successfulCompletionServices: new Set(),
      deadlineMs: 1000,
      now: () => 0,
    })
  ).rejects.toThrow("inspection failed");
  expect(reads).toBe(1);
});
