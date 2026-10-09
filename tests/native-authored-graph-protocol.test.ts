import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  nativeAuthoredReceiptBinding,
  parseNativeAuthoredControl,
  parseNativeAuthoredReady,
  parseNativeAuthoredReceipt,
  parseNativeAuthoredReview,
  parseNativeAuthoredSnapshot,
} from "../src/backends/native-authored-graph-protocol.ts";
import { parseNativePersistentTool } from "../src/backends/native-authored-persistent-data-protocol.ts";
import { parseNativeAuthoredRecoverySelection } from "../src/backends/native-authored-recovery-protocol.ts";

const run = "a".repeat(32);
function review(profiles: string[] = []) {
  const provenance = {
    version: 1,
    kind: "native",
    namespace: "b".repeat(64),
    run,
    input: {
      semantic_hash: "c".repeat(64),
      local_resolution_hash: "d".repeat(64),
      environment_policy_hash: "e".repeat(64),
      selected_profiles: profiles,
    },
  };
  return {
    provenance,
    review_id: createHash("sha256")
      .update("hack.native-graph-review/v1\0")
      .update(JSON.stringify(provenance))
      .digest("hex"),
  };
}
function receipt() {
  return {
    version: 2,
    kind: "native-graph-runtime",
    owner: "f".repeat(32),
    boot: "00000000-0000-0000-0000-000000000001",
    review: review(),
    phase: "ready-observed",
    readiness: { "a.peer": "healthy" },
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
      "container:a.peer": {
        kind: "container",
        key: "a.peer",
        name: `hkn-${run}-container-0`,
        id: "2".repeat(64),
        image: `sha256:${"3".repeat(64)}`,
        phase: "started",
        networks: ["default"],
      },
    },
  };
}

function persistentReceipt() {
  const base = receipt();
  const namespace = base.review.provenance.namespace;
  const owner = "9".repeat(32);
  return {
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
      "a.peer": [{ storage: "database", target: "/data", read_only: false }],
    },
  };
}
test("inactive storage tool codec is graph4-only and cannot claim readiness before installed identity", () => {
  const pending = {
    version: 1 as const,
    artifact: "a".repeat(64),
    bytes: 8192,
    root: null,
    helper: null,
  };
  expect(parseNativePersistentTool(pending)).toEqual(pending);
  expect(() =>
    parseNativeAuthoredReceipt({ ...receipt(), data_tool: pending })
  ).toThrow();
  expect(() =>
    parseNativeAuthoredReceipt({ ...receipt(), data_tool: null })
  ).toThrow();
  expect(() =>
    parseNativeAuthoredReceipt({ ...persistentReceipt(), data_tool: pending })
  ).toThrow();
  const installed = {
    ...pending,
    root: { device: 0, inode: 1 },
    helper: { device: 0, inode: 2 },
  };
  const qualifiedAssertion = parseNativeAuthoredReceipt({
    ...persistentReceipt(),
    data_tool: installed,
  });
  expect(qualifiedAssertion.data_tool).toEqual(installed);
  const changed = parseNativeAuthoredReceipt({
    ...persistentReceipt(),
    data_tool: { ...installed, artifact: "b".repeat(64) },
  });
  expect(nativeAuthoredReceiptBinding(changed)).not.toBe(
    nativeAuthoredReceiptBinding(qualifiedAssertion)
  );
  for (const wrong of [
    null,
    { ...pending, version: 2 },
    { ...pending, extra: true },
    { ...pending, helper: { device: 0, inode: 2 } },
    { ...pending, artifact: `${"a".repeat(64)}\n` },
    { ...installed, helper: { device: 0, inode: 0 } },
  ]) {
    expect(() => parseNativePersistentTool(wrong)).toThrow();
  }
  let calls = 0;
  const getter = Object.defineProperty({ ...pending }, "root", {
    enumerable: true,
    get() {
      calls += 1;
      return null;
    },
  });
  expect(() => parseNativePersistentTool(getter)).toThrow();
  expect(calls).toBe(0);
});
test("persistent graph4 keeps stable data across independent compute membership and excludes graph2/3 recovery", () => {
  const first = parseNativeAuthoredReceipt(persistentReceipt());
  const later = persistentReceipt();
  const newRun = "8".repeat(32);
  later.review.provenance.run = newRun;
  later.review.review_id = createHash("sha256")
    .update("hack.native-graph-review/v1\0")
    .update(JSON.stringify(later.review.provenance))
    .digest("hex");
  later.resources["network:default"].name = `hkn-${newRun}-network-0`;
  later.resources["container:a.peer"].name = `hkn-${newRun}-container-0`;
  later.resources["network:default"].id = "7".repeat(64);
  later.resources["container:a.peer"].id = "6".repeat(64);
  const second = parseNativeAuthoredReceipt(later);
  expect(second.data).toEqual(first.data);
  expect(nativeAuthoredReceiptBinding(second)).not.toBe(
    nativeAuthoredReceiptBinding(first)
  );
  const selector = {
    version: 2,
    kind: "native-graph-recovery-selection",
    run,
    receipt: first,
    receipt_sha256: "1".repeat(64),
    owner_sha256: "2".repeat(64),
    host_boot_uuid: "00000000-0000-0000-0000-000000000003",
  };
  // An otherwise valid selector reaches the graph-family gate; shape refusal
  // cannot disguise a missing graph4 recovery exclusion.
  const imageOnly = parseNativeAuthoredReceipt(receipt());
  expect(
    parseNativeAuthoredRecoverySelection({
      value: { ...selector, receipt: imageOnly },
      admitted: imageOnly,
    }).version
  ).toBe(2);
  expect(() =>
    parseNativeAuthoredRecoverySelection({ value: selector, admitted: first })
  ).toThrow();
  expect(() =>
    parseNativeAuthoredRecoverySelection({
      value: selector,
      admitted: imageOnly,
    })
  ).toThrow();
  for (const version of [2, 3, 5]) {
    expect(() =>
      parseNativeAuthoredReceipt({ ...persistentReceipt(), version })
    ).toThrow();
  }
  expect(() =>
    parseNativeAuthoredReceipt({ ...receipt(), version: 4 })
  ).toThrow();
});
test("persistent graph4 closes fields and retains exact birth, directory, guest and mount membership", () => {
  const original = persistentReceipt();
  const first = parseNativeAuthoredReceipt(original);
  const changes: ((value: ReturnType<typeof persistentReceipt>) => void)[] = [
    (value) => {
      value.data.database.binding.scope.namespace = "1".repeat(64);
    },
    (value) => {
      value.data.database.binding.guest.owner = "1".repeat(32);
    },
    (value) => {
      value.data.database.binding.guest.boot_id =
        "00000000-0000-0000-0000-000000000000";
    },
    (value) => {
      value.data.database.binding.guest.storage.inode = 0;
    },
    (value) => {
      value.data.database.state.volume.directory.inode = 0;
    },
    (value) => {
      value.data.database.state.volume.created_at = "0001-01-01T00:00:00.000Z";
    },
    (value) => {
      value.data.database.state.volume.created_at = "2026-02-30T00:00:01Z";
    },
    (value) => {
      const mount = value.data_mounts["a.peer"][0];
      if (!mount) {
        throw new Error("Missing fixture mount.");
      }
      mount.storage = "missing";
    },
    (value) => {
      const mount = value.data_mounts["a.peer"][0];
      if (!mount) {
        throw new Error("Missing fixture mount.");
      }
      mount.target = "/data/../other";
    },
  ];
  for (const change of changes) {
    const value = structuredClone(original);
    change(value);
    expect(() => parseNativeAuthoredReceipt(value)).toThrow();
  }
  for (const state of [
    { status: "reserved", intent: "1".repeat(32) },
    {
      status: "enrolled",
      volume: {
        ...original.data.database.state.volume,
        extra: "private-canary",
      },
    },
  ]) {
    expect(() =>
      parseNativeAuthoredReceipt({
        ...original,
        data: { database: { ...original.data.database, state } },
      })
    ).toThrow();
  }
  const replaced = persistentReceipt();
  replaced.data.database.state.volume.created_at = "2026-10-08T00:00:02Z";
  const parsed = parseNativeAuthoredReceipt(replaced);
  expect(nativeAuthoredReceiptBinding(parsed)).not.toBe(
    nativeAuthoredReceiptBinding(first)
  );
  expect(() =>
    parseNativeAuthoredControl(
      {
        ...status(),
        result: {
          outcome: "status",
          snapshot: {
            receipt: replaced,
            observations: status().result.snapshot.observations,
          },
        },
      },
      first,
      "status"
    )
  ).toThrow();
  let calls = 0;
  const accessor = { ...original.data.database.binding.scope };
  Object.defineProperty(accessor, "owner", {
    enumerable: true,
    get() {
      calls += 1;
      return "1".repeat(32);
    },
  });
  expect(() =>
    parseNativeAuthoredReceipt({
      ...original,
      data: {
        database: {
          ...original.data.database,
          binding: { ...original.data.database.binding, scope: accessor },
        },
      },
    })
  ).toThrow();
  expect(calls).toBe(0);
  const mounts = [...original.data_mounts["a.peer"]];
  Object.defineProperty(mounts, "0", {
    enumerable: true,
    get() {
      calls += 1;
      return original.data_mounts["a.peer"][0];
    },
  });
  expect(() =>
    parseNativeAuthoredReceipt({
      ...original,
      data_mounts: { "a.peer": mounts },
    })
  ).toThrow();
  expect(calls).toBe(0);
  const extra = {
    ...original.data.database.binding.scope,
    [Symbol("extra")]: "private-canary",
  };
  expect(() =>
    parseNativeAuthoredReceipt({
      ...original,
      data: {
        database: {
          ...original.data.database,
          binding: { ...original.data.database.binding, scope: extra },
        },
      },
    })
  ).toThrow();
  const interrupted = new Proxy(original.data.database.binding.scope, {
    ownKeys() {
      throw new Error("private-canary");
    },
  });
  expect(() =>
    parseNativeAuthoredReceipt({
      ...original,
      data: {
        database: {
          ...original.data.database,
          binding: { ...original.data.database.binding, scope: interrupted },
        },
      },
    })
  ).toThrow("values omitted");
});
test("image-only graph2 receipt binding retains its pre-storage serialized bytes", () => {
  const bound = parseNativeAuthoredReceipt(receipt());
  expect(nativeAuthoredReceiptBinding(bound)).toBe(
    JSON.stringify({
      owner: bound.owner,
      boot: bound.boot,
      review: bound.review,
      readiness: bound.readiness,
      resources: {
        "network:default": {
          kind: "network",
          key: "default",
          name: `hkn-${run}-network-0`,
          id: "1".repeat(64),
          image: null,
          outbound: true,
        },
        "container:a.peer": {
          kind: "container",
          key: "a.peer",
          name: `hkn-${run}-container-0`,
          id: "2".repeat(64),
          image: `sha256:${"3".repeat(64)}`,
          networks: ["default"],
          outbound: false,
        },
      },
    })
  );
});
test("graph2 refuses every present storage field, including empty and null", () => {
  for (const fields of [
    { data: {} },
    { data_mounts: {} },
    { data: {}, data_mounts: {} },
    { data: null },
    { data_mounts: null },
    { data: null, data_mounts: null },
  ]) {
    expect(() =>
      parseNativeAuthoredReceipt({ ...receipt(), ...fields })
    ).toThrow();
  }
  expect(parseNativeAuthoredReceipt(receipt()).version).toBe(2);
});
function status(bound = receipt()) {
  return {
    version: 2,
    kind: "native-graph-control-reply",
    run,
    review: bound.review.review_id,
    result: {
      outcome: "status",
      snapshot: {
        receipt: bound,
        observations: { "a.peer": { state: "running", health: "healthy" } },
      },
    },
  };
}
function cleaned() {
  const bound = receipt();
  bound.phase = "removed";
  for (const resource of Object.values(bound.resources)) {
    resource.phase = "removed";
  }
  return {
    version: 2,
    kind: "native-graph-control-reply",
    run,
    review: bound.review.review_id,
    result: { outcome: "cleaned", receipt: bound },
  };
}

test("standalone native journal snapshots bind the review before ready and admitted resources afterward", () => {
  const selected = parseNativeAuthoredReview(review());
  const admitted = parseNativeAuthoredReceipt(receipt());
  const snapshot = status().result.snapshot;
  expect(
    parseNativeAuthoredSnapshot({ value: snapshot, expectedReview: selected })
      .receipt
  ).toEqual(admitted);
  const removed = cleaned().result.receipt;
  const after = { receipt: removed, observations: { "a.peer": null } };
  expect(
    parseNativeAuthoredSnapshot({
      value: after,
      expectedReview: selected,
      admitted,
    }).receipt.phase
  ).toBe("removed");
  const changed = receipt();
  changed.resources["container:a.peer"].id = "9".repeat(64);
  // The runtime authenticates pre-ready journals; once admitted, immutable IDs are also required.
  expect(
    parseNativeAuthoredSnapshot({
      value: { ...snapshot, receipt: changed },
      expectedReview: selected,
    }).receipt.resources["container:a.peer"]?.id
  ).toBe("9".repeat(64));
  expect(() =>
    parseNativeAuthoredSnapshot({
      value: { ...snapshot, receipt: changed },
      expectedReview: selected,
      admitted,
    })
  ).toThrow("invalid");
  expect(() =>
    parseNativeAuthoredSnapshot({
      value: snapshot,
      expectedReview: parseNativeAuthoredReview(review(["other"])),
    })
  ).toThrow("invalid");
});

test("standalone native snapshots refuse unknown fields foreign observation names and private failure details", () => {
  const expectedReview = parseNativeAuthoredReview(review());
  const snapshot = status().result.snapshot;
  const canary = "private-synthetic-native-snapshot-canary";
  for (const value of [
    { ...snapshot, planId: "9".repeat(64) },
    { ...snapshot, observations: {} },
    { ...snapshot, observations: { "a.peer": null, foreign: null } },
    { ...snapshot, observations: Object.create({ "a.peer": null }) },
    {
      ...snapshot,
      observations: {
        "a.peer": { state: "running", health: "healthy", values: canary },
      },
    },
    {
      ...snapshot,
      receipt: {
        ...snapshot.receipt,
        failure: {
          service: "a.peer",
          observation: { state: "dead", values: canary },
        },
      },
    },
  ]) {
    let error: unknown;
    try {
      parseNativeAuthoredSnapshot({ value, expectedReview });
    } catch (value: unknown) {
      error = value;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("invalid");
    expect(String(error)).not.toContain(canary);
    expect(JSON.stringify(error)).not.toContain(canary);
  }
});

test("native provenance hashes canonical public fields and preserves UTF8 profile order", () => {
  const selected = review(["\uE000", "\u{10000}"]);
  expect(
    parseNativeAuthoredReview(selected).provenance.input.selected_profiles
  ).toEqual(["\uE000", "\u{10000}"]);
  expect(() =>
    parseNativeAuthoredReview(review(["\u{10000}", "\uE000"]))
  ).toThrow("invalid");
  expect(() => parseNativeAuthoredReview(review(["C1\u0085control"]))).toThrow(
    "invalid"
  );
  for (const field of [
    "semantic_hash",
    "local_resolution_hash",
    "environment_policy_hash",
  ] as const) {
    const changed = review();
    changed.provenance.input[field] = "9".repeat(64);
    expect(() => parseNativeAuthoredReview(changed)).toThrow("invalid");
  }
  expect(() =>
    parseNativeAuthoredReview({ ...review(), plan_id: "9".repeat(64) })
  ).toThrow("invalid");
  const legacy = review();
  legacy.provenance.kind = "normalized-compose";
  expect(() => parseNativeAuthoredReview(legacy)).toThrow("invalid");
});

test("native ready and cleanup carry the same admitted binding through mutable phases", () => {
  const expected = parseNativeAuthoredReceipt(receipt());
  const selected = parseNativeAuthoredReview(review());
  expect(
    parseNativeAuthoredReady(
      {
        version: 2,
        kind: "native-graph-foreground-ready",
        run,
        review: selected.review_id,
        receipt: receipt(),
      },
      selected
    ).owner
  ).toBe(expected.owner);
  expect(
    parseNativeAuthoredControl(status(), expected, "status").observations?.[
      "a.peer"
    ]
  ).toEqual({ state: "running", health: "healthy" });
  expect(
    parseNativeAuthoredControl(cleaned(), expected, "cleanup").receipt.phase
  ).toBe("removed");
  expect(() =>
    parseNativeAuthoredControl(status(), expected, "cleanup")
  ).toThrow("invalid");
  expect(() =>
    parseNativeAuthoredControl(cleaned(), expected, "status")
  ).toThrow("invalid");
  expect(() =>
    parseNativeAuthoredReady({ kind: "graph_foreground_ready", run }, selected)
  ).toThrow("invalid");
});

test("self-valid foreign images IDs readiness owner and boot refuse against original membership", () => {
  const expected = parseNativeAuthoredReceipt(receipt());
  for (const mutate of [
    (bound: ReturnType<typeof receipt>) => {
      bound.resources["container:a.peer"].image = `sha256:${"4".repeat(64)}`;
    },
    (bound: ReturnType<typeof receipt>) => {
      bound.resources["container:a.peer"].id = "4".repeat(64);
    },
    (bound: ReturnType<typeof receipt>) => {
      bound.readiness["a.peer"] = "started";
    },
    (bound: ReturnType<typeof receipt>) => {
      bound.owner = "4".repeat(32);
    },
    (bound: ReturnType<typeof receipt>) => {
      bound.boot = "00000000-0000-0000-0000-000000000002";
    },
  ]) {
    const bound = receipt();
    mutate(bound);
    expect(parseNativeAuthoredReceipt(bound).phase).toBe("ready-observed");
    expect(() =>
      parseNativeAuthoredControl(status(bound), expected, "status")
    ).toThrow("invalid");
  }
});

test("native nested failures observations terminal evidence and unknown intent stay closed", () => {
  const expected = parseNativeAuthoredReceipt(receipt());
  const failed = {
    ...receipt(),
    failure: { service: "a.peer", observation: { state: "exited", code: 1 } },
  };
  expect(parseNativeAuthoredReceipt(failed).failure?.service).toBe("a.peer");
  for (const observed of [
    { state: "exited", code: 1, values: "private-wire-canary" },
    { state: "dead", values: "private-wire-canary" },
    { state: "created", values: "private-wire-canary" },
  ]) {
    expect(() =>
      parseNativeAuthoredReceipt({
        ...failed,
        failure: { service: "a.peer", observation: observed },
      })
    ).toThrow("invalid");
  }
  const badStatus = status();
  const snapshot = {
    ...badStatus.result.snapshot,
    observations: {
      "a.peer": {
        state: "running",
        health: "healthy",
        values: "private-wire-canary",
      },
    },
  };
  expect(() =>
    parseNativeAuthoredControl(
      { ...badStatus, result: { outcome: "status", snapshot } },
      expected,
      "status"
    )
  ).toThrow("invalid");
  expect(() =>
    parseNativeAuthoredReceipt({ ...receipt(), plan_id: "9".repeat(64) })
  ).toThrow("invalid");
  expect(() =>
    parseNativeAuthoredReceipt({
      ...receipt(),
      terminal: {
        "container:a.peer": {
          id: "4".repeat(64),
          exit_code: 0,
          oom_killed: false,
          stop_requested: false,
        },
      },
    })
  ).toThrow("invalid");
  for (const patch of [
    { outbound: false },
    { routing: {} },
    { networks: ["custom"] },
  ]) {
    const bound = receipt();
    expect(() =>
      parseNativeAuthoredReceipt({
        ...bound,
        resources: {
          ...bound.resources,
          "network:default": {
            ...bound.resources["network:default"],
            ...patch,
          },
        },
      })
    ).toThrow("invalid");
  }
});

test("required native resources and terminal members must be exact own keys", () => {
  const bound = receipt();
  const inherited = Object.create(bound.resources);
  inherited.foo = bound.resources["network:default"];
  inherited.bar = bound.resources["container:a.peer"];
  expect(() =>
    parseNativeAuthoredReceipt({ ...bound, resources: inherited })
  ).toThrow("invalid");
  const terminal = {
    id: "2".repeat(64),
    exit_code: 0,
    oom_killed: false,
    stop_requested: false,
  };
  expect(
    parseNativeAuthoredReceipt({
      ...bound,
      terminal: { "container:a.peer": terminal },
    }).terminal?.["container:a.peer"]?.id
  ).toBe(terminal.id);
  expect(() =>
    parseNativeAuthoredReceipt({
      ...bound,
      terminal: { constructor: terminal },
    })
  ).toThrow("invalid");
});

test("prototype resource membership cannot admit a foreign terminal", () => {
  const bound = receipt();
  const key = "container:foreign-prototype-test";
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, key);
  Object.defineProperty(Object.prototype, key, {
    value: bound.resources["container:a.peer"],
    configurable: true,
  });
  try {
    const terminal = {
      id: "2".repeat(64),
      exit_code: 0,
      oom_killed: false,
      stop_requested: false,
    };
    expect(() =>
      parseNativeAuthoredReceipt({ ...bound, terminal: { [key]: terminal } })
    ).toThrow("invalid");
  } finally {
    if (previous) {
      Object.defineProperty(Object.prototype, key, previous);
    } else {
      Reflect.deleteProperty(Object.prototype, key);
    }
  }
});

test("native receipts require at least one Rust workload", () => {
  const empty = receipt();
  expect(() =>
    parseNativeAuthoredReceipt({
      ...empty,
      readiness: {},
      resources: { "network:default": empty.resources["network:default"] },
    })
  ).toThrow("invalid");
});

test.each([
  ".web",
  "\u2603",
  "w".repeat(129),
])("native receipt rejects a self-consistent invalid service name %s", (name) => {
  const bound = receipt();
  const container = { ...bound.resources["container:a.peer"], key: name };
  expect(() =>
    parseNativeAuthoredReceipt({
      ...bound,
      readiness: { [name]: "healthy" },
      resources: {
        "network:default": bound.resources["network:default"],
        [`container:${name}`]: container,
      },
    })
  ).toThrow("invalid");
});

test.each([
  "_web",
  "-web",
  "A_B-9",
  "web.",
  "w".repeat(128),
])("native receipt preserves a valid Rust service identifier %s", (name) => {
  const bound = receipt();
  const container = { ...bound.resources["container:a.peer"], key: name };
  const parsed = parseNativeAuthoredReceipt({
    ...bound,
    readiness: { [name]: "healthy" },
    resources: {
      "network:default": bound.resources["network:default"],
      [`container:${name}`]: container,
    },
  });
  expect(Object.keys(parsed.readiness)).toEqual([name]);
});

test("native profile names require scalar strings including valid surrogate pairs", () => {
  expect(
    parseNativeAuthoredReview(review(["\u{10000}"])).provenance.input
      .selected_profiles
  ).toEqual(["\u{10000}"]);
  for (const name of ["\uD800", "\uDC00"]) {
    expect(() => parseNativeAuthoredReview(review([name]))).toThrow("invalid");
  }
});
