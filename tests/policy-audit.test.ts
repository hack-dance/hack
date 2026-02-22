import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { appendPolicyAuditEvent } from "../src/control-plane/policy/audit.ts";

test("appendPolicyAuditEvent persists JSONL event", async () => {
  const tempRoot = await mkdtemp(resolve(tmpdir(), "hack-policy-audit-"));
  const previous = process.env.HACK_GLOBAL_CONFIG_PATH;
  process.env.HACK_GLOBAL_CONFIG_PATH = resolve(tempRoot, "hack.config.json");

  try {
    const event = await appendPolicyAuditEvent({
      actor: "tester",
      operation: "dispatch.run",
      level: "high",
      requiresApproval: true,
      approved: false,
      mode: "prompt",
      reasons: ["matched high-risk operation: git push"],
      command: ["git", "push", "origin", "feature/test"],
      runner: "generic",
      runId: "run-123",
      projectSelector: "my-project",
      error: "Approval denied for high-risk dispatch.",
    });

    const path = resolve(tempRoot, "registry", "policy-audit.jsonl");
    const text = await Bun.file(path).text();
    const line = text.trim().split("\n").at(-1);
    expect(line).toBeDefined();
    const parsed = JSON.parse(line ?? "{}") as Record<string, unknown>;

    expect(parsed.eventId).toBe(event.eventId);
    expect(parsed.actor).toBe("tester");
    expect(parsed.operation).toBe("dispatch.run");
    expect(parsed.level).toBe("high");
    expect(parsed.approved).toBe(false);
    expect(parsed.runId).toBe("run-123");
  } finally {
    if (previous === undefined) {
      process.env.HACK_GLOBAL_CONFIG_PATH = undefined;
    } else {
      process.env.HACK_GLOBAL_CONFIG_PATH = previous;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});
