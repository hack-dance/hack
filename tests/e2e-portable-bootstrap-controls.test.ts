import { describe, expect, test } from "bun:test";
import { createDecipheriv, createHash } from "node:crypto";
import { encryptSynthetic } from "../scripts/portable-bootstrap-smoke.ts";
import {
  type AppIdentity,
  checkStageExpectation,
  classifyAppTransition,
  containsForbiddenValue,
  PORTABLE_BOOTSTRAP_EXPECTATIONS,
  PORTABLE_BOOTSTRAP_RECEIPT_SCHEMA,
  PORTABLE_BOOTSTRAP_STAGES,
  renderPortableBootstrapReceipt,
  type StageReceipt,
  unexpectedWorktreeChanges,
} from "./e2e/portable-bootstrap-controls.ts";
import { ALL_SCENARIOS } from "./e2e/run.ts";
import { E2E_DURATION_HINTS_SECONDS } from "./e2e/shard.ts";

const running = (id: string, startedAt = "t1"): AppIdentity => ({
  id,
  startedAt,
  running: true,
});

function receipt(
  stage: (typeof PORTABLE_BOOTSTRAP_STAGES)[number]
): StageReceipt {
  const expected = PORTABLE_BOOTSTRAP_EXPECTATIONS[stage];
  return {
    stage,
    outcome: expected.outcome,
    app: expected.app,
    durationMs: 1200,
    stdoutBytes: 10,
    stderrBytes: 20,
    trackedBytes: 4096,
    cacheBytes: expected.app === "absent" ? null : 128,
    cacheVolumes: 1,
  };
}

const complete = () => PORTABLE_BOOTSTRAP_STAGES.map(receipt);

describe("portable bootstrap negative controls", () => {
  test("is registered for the hosted Docker tier with a shard hint", () => {
    const scenario = ALL_SCENARIOS.find(
      (entry) => entry.name === "portable-bootstrap-negatives"
    );
    expect(scenario?.tier).toBe("docker");
    expect(scenario?.requiresExplicitSelection).toBeUndefined();
    expect(
      Object.hasOwn(E2E_DURATION_HINTS_SECONDS, "portable-bootstrap-negatives")
    ).toBe(true);
  });

  test("every refusal leaves the consumer absent or unchanged", () => {
    for (const stage of PORTABLE_BOOTSTRAP_STAGES) {
      const expected = PORTABLE_BOOTSTRAP_EXPECTATIONS[stage];
      expect(stage.startsWith("refuse-")).toBe(expected.outcome === "refused");
      if (expected.outcome === "refused") {
        expect(["absent", "unchanged"]).toContain(expected.app);
      }
    }
    expect(PORTABLE_BOOTSTRAP_EXPECTATIONS["bootstrap-repeat"].app).toBe(
      "unchanged"
    );
  });

  test("classifies consumer identity by container ID and start time", () => {
    expect(classifyAppTransition({ before: null, after: null })).toBe("absent");
    expect(classifyAppTransition({ before: null, after: running("a") })).toBe(
      "created"
    );
    expect(
      classifyAppTransition({ before: running("a"), after: running("a") })
    ).toBe("unchanged");
    expect(
      classifyAppTransition({ before: running("a"), after: running("b") })
    ).toBe("replaced");
    // A restart in place is not "unchanged": the refusal touched the consumer.
    expect(
      classifyAppTransition({
        before: running("a"),
        after: running("a", "t2"),
      })
    ).toBe("replaced");
    expect(classifyAppTransition({ before: running("a"), after: null })).toBe(
      "removed"
    );
  });

  test("checks exit, consumer transition and liveness per stage", () => {
    const ok = {
      stage: "refuse-stale-image" as const,
      exitCode: 1,
      timedOut: false,
      transition: "unchanged" as const,
      running: true,
    };
    expect(checkStageExpectation(ok)).toBeNull();
    expect(checkStageExpectation({ ...ok, exitCode: 0 })).toBe(
      "expected refused, observed bootstrapped"
    );
    expect(checkStageExpectation({ ...ok, transition: "replaced" })).toBe(
      "expected consumer unchanged, observed replaced"
    );
    expect(checkStageExpectation({ ...ok, running: false })).toBe(
      "consumer must be running after the stage"
    );
    expect(checkStageExpectation({ ...ok, timedOut: true })).toBe(
      "command timed out"
    );
    expect(
      checkStageExpectation({
        stage: "refuse-missing-key",
        exitCode: 1,
        timedOut: false,
        transition: "absent",
        running: false,
      })
    ).toBeNull();
    expect(
      checkStageExpectation({
        stage: "bootstrap-repeat",
        exitCode: 0,
        timedOut: false,
        transition: "replaced",
        running: true,
      })
    ).toBe("expected consumer unchanged, observed replaced");
  });

  test("reports worktree paths outside the allowed set", () => {
    const porcelain = [
      "?? .hack/.gitignore",
      " M package.json",
      "R  old.txt -> new.txt",
      "",
    ].join("\n");
    expect(unexpectedWorktreeChanges({ porcelain: "", allowed: [] })).toEqual(
      []
    );
    expect(
      unexpectedWorktreeChanges({
        porcelain,
        allowed: [".hack/.gitignore", "package.json", "new.txt"],
      })
    ).toEqual([]);
    expect(
      unexpectedWorktreeChanges({
        porcelain,
        allowed: [".hack/.gitignore"],
      })
    ).toEqual(["new.txt", "package.json"]);
  });

  test("detects forbidden values and ignores empty entries", () => {
    expect(
      containsForbiddenValue({ texts: ["ok", "has-key-x"], forbidden: ["key"] })
    ).toBe(true);
    expect(
      containsForbiddenValue({ texts: ["ok"], forbidden: ["", "absent"] })
    ).toBe(false);
  });

  test("renders a complete value-free receipt", () => {
    const parsed: unknown = JSON.parse(
      renderPortableBootstrapReceipt({ stages: complete(), imageBytes: 7 })
    );
    expect(parsed).toEqual({
      schema: PORTABLE_BOOTSTRAP_RECEIPT_SCHEMA,
      imageBytes: 7,
      stages: complete(),
    });
  });

  test("refuses incomplete, reordered or open-ended receipts", () => {
    const render =
      (stages: readonly unknown[], imageBytes: unknown = 1) =>
      () =>
        renderPortableBootstrapReceipt({ stages, imageBytes });
    const message = /Invalid portable bootstrap receipt/;
    expect(render(complete().slice(1))).toThrow(message);
    expect(render(complete().reverse())).toThrow(message);
    expect(render(complete(), -1)).toThrow(message);
    expect(render(complete(), 1.5)).toThrow(message);
    const mutate = (patch: Record<string, unknown>) =>
      complete().map((entry, index) =>
        index === 4 ? { ...entry, ...patch } : entry
      );
    expect(render(mutate({ outcome: "skipped" }))).toThrow(message);
    expect(render(mutate({ app: "restarted" }))).toThrow(message);
    expect(render(mutate({ durationMs: -1 }))).toThrow(message);
    expect(render(mutate({ stdoutBytes: 0.5 }))).toThrow(message);
    expect(render(mutate({ cacheBytes: "128" }))).toThrow(message);
    expect(render(mutate({ detail: "free text" }))).toThrow(message);
    const missing = complete().map(({ cacheVolumes: _, ...entry }) => entry);
    expect(render(missing)).toThrow(message);
    expect(render([...complete().slice(0, -1), null])).toThrow(message);
  });

  test("synthetic env values use the project v1 envelope", () => {
    const key = "synthetic-key";
    const sealed = encryptSynthetic({ key, secret: "synthetic-value" });
    const [prefix, iv, tag, ciphertext] = sealed.split(":");
    expect(prefix).toBe("v1");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      createHash("sha256").update(key).digest(),
      Buffer.from(iv ?? "", "base64")
    );
    decipher.setAuthTag(Buffer.from(tag ?? "", "base64"));
    expect(
      Buffer.concat([
        decipher.update(Buffer.from(ciphertext ?? "", "base64")),
        decipher.final(),
      ]).toString("utf8")
    ).toBe("synthetic-value");
    expect(sealed).not.toContain("synthetic-value");
  });
});
