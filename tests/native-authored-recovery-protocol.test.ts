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
function sessionSelection() {
  const { host_boot_micros: _legacy, ...common } = selection();
  return {
    ...common,
    version: 2,
    host_boot_uuid: "12345678-abcd-abcd-abcd-123456789abc",
  };
}
function sourceReceipt() {
  const project = "/private/native-source-fixture";
  return {
    ...receipt(),
    version: 3,
    source: {
      version: 1,
      policy: "host-mounted",
      share: {
        project,
        guest_path: `/mnt/hack-projects/${createHash("sha256").update(project).digest("hex")}`,
        device: 1,
        inode: 2,
        unfiltered_source: true,
      },
      mounts: { web: { source: ".", target: "/app" } },
      anchors: {
        ".": {
          device: 1,
          inode: 2,
          mode: 0o04_0700,
          uid: 502,
          gid: 20,
          kind: "directory",
        },
      },
    },
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
test("valid source-bearing v3 parsing grants no dead-owner recovery selection", () => {
  const source = sourceReceipt();
  const sourceAdmitted = parseNativeAuthoredReceipt(source);
  const imageAdmitted = parseNativeAuthoredReceipt(receipt());
  expect(sourceAdmitted.version).toBe(3);
  for (const selector of [selection(), sessionSelection()]) {
    for (const [selected, admitted] of [
      [source, sourceAdmitted],
      [source, imageAdmitted],
      [receipt(), sourceAdmitted],
    ] as const) {
      const value = { ...selector, receipt: selected };
      const before = structuredClone(value);
      expect(() =>
        parseNativeAuthoredRecoverySelection({ value, admitted })
      ).toThrow("Native recovery response is invalid");
      expect(value).toEqual(before);
    }
  }
});
test("session selection is closed version two and preserves original qualifier without migration", () => {
  const admitted = parseNativeAuthoredReceipt(receipt());
  const expected = parseNativeAuthoredRecoverySelection({
    value: sessionSelection(),
    admitted,
  });
  expect(expected.version).toBe(2);
  expect(expected).toHaveProperty(
    "host_boot_uuid",
    sessionSelection().host_boot_uuid
  );
  expect(expected).not.toHaveProperty("host_boot_micros");
  expect(
    parseNativeAuthoredRecoveryResult({ value: result(), expected }).version
  ).toBe(1);
  const canary = "private-boot-qualifier-canary";
  const { host_boot_uuid: _missing, ...missing } = sessionSelection();
  for (const value of [
    missing,
    { ...sessionSelection(), version: 1 },
    { ...sessionSelection(), version: 3 },
    { ...sessionSelection(), host_boot_micros: 1 },
    { ...selection(), host_boot_uuid: sessionSelection().host_boot_uuid },
    ...[
      null,
      1,
      canary,
      "12345678-ABCD-ABCD-ABCD-123456789ABC",
      "00000000-0000-0000-0000-000000000000",
      "12345678-abcd-abcd-abcd-123456789abg",
      "12345678-abcd-abcd-abcd-123456789abc\n",
      "12345678-abcd-abcd-abcd-123456789abc ",
    ].map((host_boot_uuid) => ({ ...sessionSelection(), host_boot_uuid })),
  ]) {
    try {
      parseNativeAuthoredRecoverySelection({ value, admitted });
      throw new Error("fixture admitted forbidden qualifier");
    } catch (error) {
      expect(String(error)).toContain("invalid");
      expect(String(error)).not.toContain(canary);
    }
  }
});
test("selector dispatch refuses missing own fields before reading version getters", () => {
  const admitted = parseNativeAuthoredReceipt(receipt());
  let calls = 0;
  const prototype = {
    get version() {
      calls++;
      return 2;
    },
  };
  const ownPartial = Object.create(null);
  Object.defineProperties(ownPartial, {
    version: {
      enumerable: true,
      get() {
        calls++;
        return 2;
      },
    },
    host_boot_uuid: {
      enumerable: true,
      value: sessionSelection().host_boot_uuid,
    },
  });
  for (const value of [Object.create(prototype), ownPartial]) {
    expect(() =>
      parseNativeAuthoredRecoverySelection({ value, admitted })
    ).toThrow("invalid");
    expect(calls).toBe(0);
  }
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

test("graph4 recovery mirrors enrolled data and installed tool admission without widening other receipt families", () => {
  const base = receipt();
  const namespace = base.review.provenance.namespace,
    owner = "9".repeat(32);
  const value = {
    ...base,
    version: 4,
    data: {
      database: {
        binding: {
          scope: { namespace, storage: "database", owner },
          guest: {
            owner: base.owner,
            boot_id: base.boot,
            storage: {
              device: 0,
              inode: 14,
              bytes: 128,
              uuid: "00000000-0000-0000-0000-000000000002",
            },
          },
          policy: { driver: "local", scope: "local", options: {} },
        },
        state: {
          status: "enrolled",
          volume: {
            name: `hkp-${namespace}-${owner}-database`,
            created_at: "2026-10-08T00:00:01Z",
            directory: { device: 0, inode: 15 },
          },
        },
      },
    },
    data_mounts: {
      web: [{ storage: "database", target: "/data", read_only: false }],
    },
    data_tool: {
      version: 1,
      artifact: "a".repeat(64),
      bytes: 8192,
      root: { device: 0, inode: 1 },
      helper: { device: 0, inode: 2 },
    },
  };
  const admitted = parseNativeAuthoredReceipt(value);
  expect(
    parseNativeAuthoredRecoverySelection({
      value: { ...sessionSelection(), receipt: admitted },
      admitted,
    }).receipt
  ).toEqual(admitted);
  for (const candidate of [
    { ...value, data_tool: undefined },
    { ...value, data_tool: { ...value.data_tool, root: null, helper: null } },
    {
      ...value,
      data: {
        database: {
          ...value.data.database,
          state: { status: "reserved", intent: "1".repeat(32) },
        },
      },
    },
    { ...value, data_tool: { ...value.data_tool, helper: null } },
    { ...value, version: 5 },
  ]) {
    expect(() => {
      const other = parseNativeAuthoredReceipt(candidate);
      parseNativeAuthoredRecoverySelection({
        value: { ...sessionSelection(), receipt: other },
        admitted: other,
      });
    }).toThrow();
  }
  const changed = parseNativeAuthoredReceipt({
    ...value,
    data_tool: { ...value.data_tool, artifact: "b".repeat(64) },
  });
  expect(() =>
    parseNativeAuthoredRecoverySelection({
      value: { ...sessionSelection(), receipt: changed },
      admitted,
    })
  ).toThrow();
});
