import { expect, test } from "bun:test";
import {
  errorResultFromUnknown,
  HackCliError,
  renderCliResult,
} from "../src/lib/cli-result.ts";
import {
  legacyComposeOrderedError,
  legacyComposeOrderedRefusal,
} from "../src/lib/native-compose-adoption-diagnostics.ts";
import { createCompletedJobFixtureStartDiagnostics } from "./e2e/scenarios/native-compose-adoption-job-diagnostics.ts";

function diagnostics(messages: string[]) {
  return createCompletedJobFixtureStartDiagnostics({
    operation: "restart",
    scope: "alpha",
    log: (message) => messages.push(message),
  });
}

test("completed-job start diagnostics distinguish CLI refusal from a later oracle", async () => {
  for (const failureStage of ["cli-result", "fresh-exit"] as const) {
    const messages: string[] = [];
    const diagnostic = diagnostics(messages);
    const original = new Error("private-original-refusal-canary");
    const calls: string[] = [];
    let observed: unknown;
    try {
      for (const stage of [
        "cli-result",
        "fresh-exit",
        "pending-clear",
      ] as const) {
        await diagnostic.step(stage, () => {
          calls.push(stage);
          if (stage === failureStage) {
            throw original;
          }
        });
      }
    } catch (error) {
      observed = error;
    }
    expect(observed).toBe(original);
    expect(calls).toEqual(
      failureStage === "cli-result"
        ? ["cli-result"]
        : ["cli-result", "fresh-exit"]
    );
    expect(messages.at(-1)).toBe(
      `start-operation=restart worktree=alpha stage=${failureStage} status=failed`
    );
    expect(messages.join("\n")).not.toContain("canary");
    expect(messages.join("\n")).not.toContain("pending-clear");
  }
});

test("completed-job start diagnostics preserve success order and callback results", async () => {
  const messages: string[] = [];
  const diagnostic = diagnostics(messages);
  const value = { privateValue: "private-result-canary" };
  for (const stage of [
    "prior-state",
    "cli-result",
    "fresh-state",
    "fresh-exit",
    "pending-clear",
    "sql-ready",
    "sql-counts",
    "sibling-isolation",
  ]) {
    expect(await diagnostic.step(stage, () => value)).toBe(value);
    expect(messages.slice(-2)).toEqual([
      `start-operation=restart worktree=alpha stage=${stage} status=begin`,
      `start-operation=restart worktree=alpha stage=${stage} status=end`,
    ]);
  }
  expect(messages).toHaveLength(16);
  expect(messages.join("\n")).not.toContain("private-result-canary");
});

test("completed-job start diagnostics omit reply values and unknown codes or labels", async () => {
  const messages: string[] = [];
  const diagnostic = diagnostics(messages);
  for (const code of ["E_CONFIG_INVALID", "private-code-canary"]) {
    diagnostic.cliOutcome({
      exitCode: 17,
      timedOut: false,
      stdout: JSON.stringify({
        ok: false,
        error: { code, message: "private-message-canary" },
        env: "private-env-canary",
        argv: ["private-argv-canary"],
      }),
    });
  }
  diagnostic.cliOutcome({
    exitCode: 0,
    timedOut: false,
    stdout: "private-malformed-canary",
  });
  diagnostic.cliOutcome({
    exitCode: 17,
    timedOut: true,
    stdout: "private-oversized-canary".repeat(10_000),
  });
  const unknown = createCompletedJobFixtureStartDiagnostics({
    operation: "private-operation-canary",
    scope: "private-scope-canary",
    log: (message) => messages.push(message),
  });
  let calls = 0;
  expect(await unknown.step("private-stage-canary", () => ++calls)).toBe(1);
  await unknown.step("fresh-exit", () => ++calls);
  expect(calls).toBe(2);
  expect(messages[0]).toContain("code=E_CONFIG_INVALID");
  expect(messages[0]).toContain(
    "ordered-stage=unavailable ordered-reason=unavailable"
  );
  expect(messages[1]).toContain("code=unavailable");
  expect(messages[3]).toContain(
    "timed-out=yes code=unavailable ordered-stage=unavailable ordered-reason=unavailable"
  );
  expect(messages.at(-1)).toBe(
    "start-operation=unavailable worktree=unavailable stage=fresh-exit status=end"
  );
  expect(messages.join("\n")).not.toContain("canary");
});

test("completed-job CLI diagnostics report only the owner-issued closed ordered refusal", () => {
  const messages: string[] = [];
  const diagnostic = diagnostics(messages);
  for (const issued of [
    { stage: "ordered-observation", reason: "probe-child" },
    { stage: "ordered-scheduler", reason: "job-refused" },
  ] as const) {
    const original = legacyComposeOrderedError({
      diagnostic: issued,
      message: "private-original-message-canary",
    });
    const detail = legacyComposeOrderedRefusal(original);
    expect(detail).toEqual(issued);
    diagnostic.cliOutcome({
      exitCode: 1,
      timedOut: false,
      stdout: renderCliResult({
        result: errorResultFromUnknown({
          error: new HackCliError({
            code: "E_CONFIG_INVALID",
            message: "private-envelope-message-canary",
            detail: { legacy_adoption_refusal: detail },
          }),
        }),
      }),
    });
    expect(messages.at(-1)).toBe(
      `start-operation=restart worktree=alpha stage=cli-result exit=nonzero timed-out=no code=E_CONFIG_INVALID ordered-stage=${issued.stage} ordered-reason=${issued.reason}`
    );
  }
  expect(messages.join("\n")).not.toContain("canary");
});

test("completed-job CLI diagnostics refuse malformed, extra and unrelated detail", () => {
  const messages: string[] = [];
  const diagnostic = diagnostics(messages);
  const closed = { stage: "ordered-scheduler", reason: "job-refused" };
  for (const [code, detail] of [
    [
      "E_CONFIG_INVALID",
      {
        legacy_adoption_refusal: { ...closed, reason: "private-reason-canary" },
      },
    ],
    [
      "E_CONFIG_INVALID",
      { legacy_adoption_refusal: { ...closed, stage: "ordered-observation" } },
    ],
    [
      "E_CONFIG_INVALID",
      { legacy_adoption_refusal: { ...closed, raw: "private-field-canary" } },
    ],
    ["E_CONFIG_INVALID", { legacy_adoption_refusal: [closed] }],
    [
      "E_CONFIG_INVALID",
      { legacy_adoption_refusal: closed, env: "private-env-canary" },
    ],
    ["E_NATIVE_COMPOSE_OWNERSHIP", { legacy_adoption_refusal: closed }],
  ] as const) {
    diagnostic.cliOutcome({
      exitCode: 1,
      timedOut: false,
      stdout: JSON.stringify({
        ok: false,
        error: { code, detail, message: "private-message-canary" },
      }),
    });
    expect(messages.at(-1)).toBe(
      `start-operation=restart worktree=alpha stage=cli-result exit=nonzero timed-out=no code=${code} ordered-stage=unavailable ordered-reason=unavailable`
    );
  }
  expect(messages.join("\n")).not.toContain("canary");
});

test("completed-job start diagnostics cannot replace an outcome when the logger throws", async () => {
  const diagnostic = createCompletedJobFixtureStartDiagnostics({
    operation: "up",
    scope: "beta",
    log: () => {
      throw new Error("private-logger-canary");
    },
  });
  const original = new Error("private-original-canary");
  expect(await diagnostic.step("prior-state", () => 42)).toBe(42);
  let observed: unknown;
  try {
    await diagnostic.step("cli-result", () => {
      diagnostic.cliOutcome({
        exitCode: 17,
        timedOut: false,
        stdout: "private-reply-canary",
      });
      throw original;
    });
  } catch (error) {
    observed = error;
  }
  expect(observed).toBe(original);
});

test("completed-job CLI diagnostics treat an unreadable reply as unavailable", () => {
  const messages: string[] = [];
  const diagnostic = diagnostics(messages);
  const result = { exitCode: 1, timedOut: false, stdout: "" };
  Object.defineProperty(result, "stdout", {
    get: () => {
      throw new Error("private-unreadable-reply-canary");
    },
  });
  expect(() => diagnostic.cliOutcome(result)).not.toThrow();
  expect(messages).toEqual([
    "start-operation=restart worktree=alpha stage=cli-result exit=unavailable timed-out=unavailable code=unavailable ordered-stage=unavailable ordered-reason=unavailable",
  ]);
});
