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
function sourceReceipt() {
  const project = "/private/project";
  const anchor = {
    device: 1,
    inode: 2,
    mode: 0o04_0700,
    uid: 502,
    gid: 20,
    kind: "directory",
  };
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
      mounts: { "a.peer": { source: "src/main.js", target: "/app/main.js" } },
      anchors: {
        ".": anchor,
        src: { ...anchor, inode: 3 },
        "src/main.js": { ...anchor, inode: 4, mode: 0o10_0600, kind: "file" },
      },
    },
  };
}

test("source-bearing native receipts bind host-mounted intent while retaining image-only v2", () => {
  const old = parseNativeAuthoredReceipt(receipt());
  expect(old.version).toBe(2);
  expect(Object.hasOwn(old, "source")).toBe(false);
  const raw = sourceReceipt();
  const admitted = parseNativeAuthoredReceipt(raw);
  expect(admitted.version).toBe(3);
  expect(
    parseNativeAuthoredReady(
      {
        version: 2,
        kind: "native-graph-foreground-ready",
        run,
        review: raw.review.review_id,
        receipt: raw,
      },
      parseNativeAuthoredReview(raw.review)
    )
  ).toEqual(admitted);
  const changed = sourceReceipt();
  changed.source.anchors["src/main.js"].inode += 1;
  expect(
    nativeAuthoredReceiptBinding(parseNativeAuthoredReceipt(changed))
  ).not.toBe(nativeAuthoredReceiptBinding(admitted));
  expect(() =>
    parseNativeAuthoredSnapshot({
      value: {
        receipt: changed,
        observations: { "a.peer": { state: "running", health: "healthy" } },
      },
      expectedReview: admitted.review,
      admitted,
    })
  ).toThrow("invalid or changed");
  expect(nativeAuthoredReceiptBinding(old)).toBe(
    JSON.stringify({
      owner: old.owner,
      boot: old.boot,
      review: old.review,
      readiness: old.readiness,
      resources: Object.fromEntries(
        Object.entries(old.resources).map(([key, item]) => [
          key,
          {
            kind: item.kind,
            key: item.key,
            name: item.name,
            id: item.id,
            image: item.image,
            networks: item.networks,
            outbound: item.outbound,
          },
        ])
      ),
    })
  );
});

test("source receipt refuses version, policy, selection, permission and private-field drift", () => {
  const cases = [
    (value: ReturnType<typeof sourceReceipt>) => {
      value.version = 2;
    },
    (value: ReturnType<typeof sourceReceipt>) => {
      value.source.policy = "immutable";
    },
    (value: ReturnType<typeof sourceReceipt>) => {
      value.source.share.inode += 1;
    },
    (value: ReturnType<typeof sourceReceipt>) => {
      value.source.share.unfiltered_source = false;
    },
    (value: ReturnType<typeof sourceReceipt>) => {
      value.source.share.guest_path = "/foreign";
    },
    (value: ReturnType<typeof sourceReceipt>) => {
      value.source.mounts["a.peer"].source = "../other";
    },
    (value: ReturnType<typeof sourceReceipt>) => {
      value.source.mounts["a.peer"].target = "/app/../foreign";
    },
    (value: ReturnType<typeof sourceReceipt>) => {
      value.source.anchors.src.kind = "file";
    },
    (value: ReturnType<typeof sourceReceipt>) => {
      value.source.anchors.src.mode |= 0o002;
    },
    (value: ReturnType<typeof sourceReceipt>) => {
      value.source.anchors.src.uid += 1;
    },
    (value: ReturnType<typeof sourceReceipt>) => {
      value.source.anchors.src.inode = Number.MAX_SAFE_INTEGER + 1;
    },
    (value: ReturnType<typeof sourceReceipt>) => {
      Object.assign(value.source.mounts["a.peer"], { access: "read-write" });
    },
    (value: ReturnType<typeof sourceReceipt>) => {
      Object.assign(value.source.anchors.src, {
        content: "synthetic-private-canary",
      });
    },
    (value: ReturnType<typeof sourceReceipt>) => {
      Object.assign(value.source.anchors, { extra: value.source.anchors.src });
    },
  ];
  for (const mutate of cases) {
    const value = sourceReceipt();
    mutate(value);
    expect(() => parseNativeAuthoredReceipt(value)).toThrow(
      "invalid or changed"
    );
  }
  expect(() =>
    parseNativeAuthoredReceipt({ ...receipt(), source: null })
  ).toThrow("invalid or changed");
  expect(() =>
    parseNativeAuthoredReceipt({ ...sourceReceipt(), source: null })
  ).toThrow("invalid or changed");
  expect(() =>
    parseNativeAuthoredReceipt({ ...receipt(), version: 3 })
  ).toThrow("invalid or changed");
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
