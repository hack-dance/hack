import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { parseNativeAuthoredReceipt } from "../src/backends/native-authored-graph-protocol.ts";
import {
  parseNativeAuthoredRecoveryResult,
  parseNativeAuthoredRecoverySelection,
} from "../src/backends/native-authored-recovery-protocol.ts";

function receipt() {
  const run = "a".repeat(32);
  const provenance = {
    version: 1,
    kind: "native",
    namespace: "b".repeat(64),
    run,
    input: {
      semantic_hash: "c".repeat(64),
      local_resolution_hash: "d".repeat(64),
      environment_policy_hash: "e".repeat(64),
      selected_profiles: [],
    },
  };
  return {
    version: 2,
    kind: "native-graph-runtime",
    owner: "f".repeat(32),
    boot: "00000000-0000-0000-0000-000000000001",
    review: {
      provenance,
      review_id: createHash("sha256")
        .update("hack.native-graph-review/v1\0")
        .update(JSON.stringify(provenance))
        .digest("hex"),
    },
    phase: "ready-observed",
    readiness: { web: "healthy" },
    resources: {
      "network:default": {
        kind: "network",
        key: "default",
        name: `hkn-${run}-network-0`,
        id: "1".repeat(64),
        image: null,
        phase: "created",
        outbound: true,
      },
      "container:web": {
        kind: "container",
        key: "web",
        name: `hkn-${run}-container-0`,
        id: "2".repeat(64),
        image: `sha256:${"3".repeat(64)}`,
        phase: "started",
        networks: ["default"],
      },
    },
  };
}
function selection() {
  const ready = receipt();
  return {
    version: 1,
    kind: "native-graph-recovery-selection",
    run: ready.review.provenance.run,
    receipt: ready,
    receipt_sha256: "4".repeat(64),
    owner_sha256: "5".repeat(64),
    host_boot_micros: 1_791_000_000_000_000,
  };
}
function result() {
  const removed = receipt();
  removed.phase = "removed";
  for (const resource of Object.values(removed.resources)) {
    resource.phase = "removed";
  }
  return {
    version: 1,
    kind: "native-graph-live-owner-recovered",
    run: removed.review.provenance.run,
    same_boot: true,
    publication_retired: true,
    receipt: removed,
  };
}
test("native recovery copies original selectors and binds exact Removed to durable Ready", () => {
  const input = selection();
  const admitted = parseNativeAuthoredReceipt(receipt());
  const expected = parseNativeAuthoredRecoverySelection({
    value: input,
    admitted,
  });
  input.receipt.resources["container:web"].id = "9".repeat(64);
  input.receipt_sha256 = "a".repeat(64);
  expect(expected.receipt.resources["container:web"]?.id).toBe("2".repeat(64));
  expect(expected.receipt_sha256).toBe("4".repeat(64));
  expect(
    parseNativeAuthoredRecoveryResult({ value: result(), expected }).receipt
      .phase
  ).toBe("removed");
});
test("native recovery selection refuses inherited unknown private or invalid boot/hash fields", () => {
  const admitted = parseNativeAuthoredReceipt(receipt());
  const canary = "private-recovery-wire-canary";
  for (const value of [
    { ...selection(), values: canary },
    { ...selection(), owner: canary },
    { ...selection(), version: 2 },
    { ...selection(), kind: "compose-graph-recovery-selection" },
    { ...selection(), host_boot_micros: 0 },
    { ...selection(), host_boot_micros: Number.MAX_SAFE_INTEGER + 1 },
    { ...selection(), host_boot_micros: 1.5 },
    { ...selection(), host_boot_micros: "1" },
    { ...selection(), receipt_sha256: canary },
    { ...selection(), owner_sha256: "F".repeat(64) },
    Object.create(selection()),
  ]) {
    try {
      parseNativeAuthoredRecoverySelection({ value, admitted });
      throw new Error("fixture admitted forbidden selection");
    } catch (error) {
      expect(String(error)).toContain("invalid");
      expect(String(error)).not.toContain(canary);
    }
  }
});
test("native recovery rejects self-consistent foreign membership and incomplete original Ready", () => {
  const admitted = parseNativeAuthoredReceipt(receipt());
  for (const change of [
    "id",
    "image",
    "owner",
    "boot",
    "readiness",
    "network",
  ]) {
    const selected = selection();
    const changed = selected.receipt;
    if (change === "id") {
      changed.resources["container:web"].id = "9".repeat(64);
    }
    if (change === "image") {
      changed.resources["container:web"].image = `sha256:${"9".repeat(64)}`;
    }
    if (change === "owner") {
      changed.owner = "9".repeat(32);
    }
    if (change === "boot") {
      changed.boot = "00000000-0000-0000-0000-000000000002";
    }
    if (change === "readiness") {
      changed.readiness.web = "started";
    }
    if (change === "network") {
      changed.resources["network:default"].outbound = false;
    }
    expect(() =>
      parseNativeAuthoredRecoverySelection({ value: selected, admitted })
    ).toThrow("invalid");
    // The same attack in a valid Removed reply still fails original membership.
    changed.phase = "removed";
    for (const resource of Object.values(changed.resources)) {
      resource.phase = "removed";
    }
    const expected = parseNativeAuthoredRecoverySelection({
      value: selection(),
      admitted,
    });
    expect(() =>
      parseNativeAuthoredRecoveryResult({
        value: { ...result(), receipt: changed },
        expected,
      })
    ).toThrow("invalid");
  }
  for (const phase of ["preparing", "stop-intent", "removed"]) {
    const selected = selection();
    selected.receipt.phase = phase;
    expect(() =>
      parseNativeAuthoredRecoverySelection({ value: selected, admitted })
    ).toThrow("invalid");
  }
});
test("native recovered result closes outcome flags unknown fields and nested private diagnostics", () => {
  const expected = parseNativeAuthoredRecoverySelection({
    value: selection(),
    admitted: parseNativeAuthoredReceipt(receipt()),
  });
  const canary = "private-recovery-result-canary";
  for (const value of [
    { ...result(), publication_retired: false },
    { ...result(), same_boot: false },
    { ...result(), run: "9".repeat(32) },
    { ...result(), values: canary },
    { ...result(), receipt: receipt() },
    Object.create(result()),
    {
      ...result(),
      receipt: {
        ...result().receipt,
        failure: {
          service: "web",
          observation: { state: "exited", code: 1, values: canary },
        },
      },
    },
  ]) {
    expect(() =>
      parseNativeAuthoredRecoveryResult({ value, expected })
    ).toThrow("invalid");
    try {
      parseNativeAuthoredRecoveryResult({ value, expected });
    } catch (error) {
      expect(String(error)).not.toContain(canary);
    }
  }
});
