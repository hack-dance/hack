import { expect, test } from "bun:test";
import { recoverNativeInterruptedStartupCleanup } from "../src/backends/native-project-interrupted-cleanup.ts";
import type { invokeNativeRuntime } from "../src/backends/native-runtime-client.ts";

const run = {
  run: "a".repeat(32),
  owner: "b".repeat(32),
  namespace: "c".repeat(64),
  planId: "d".repeat(64),
};
const hash = "e".repeat(64);
const runtime = { binary: "/not-executed", home: "/not-used" };

function snapshot(stopped = false) {
  return {
    journal_incomplete: false,
    interrupted_start_cleanup_incomplete: false,
    receipt: {
      ...run,
      plan_id: run.planId,
      phase: stopped ? "stopped-data-retained" : "cleanup-intent",
      relay_cleanup: { phase: stopped ? "confirmed" : "pending" },
      resources: {
        "container:web": {
          kind: "container",
          key: "web",
          name: "selected-web",
          id: "f".repeat(64),
          phase: stopped ? "absent" : "uncertain",
        },
        "volume:data": {
          kind: "volume",
          key: "data",
          name: "selected-data",
          phase: "created",
        },
      },
    },
    observations: {
      "container:web": { state: stopped ? "absent" : "present" },
      "volume:data": { state: "present" },
    },
  };
}

function selection() {
  return {
    run: run.run,
    phase: "cleanup-intent",
    eligible: true,
    data_retained: true,
    same_boot: true,
    selection_sha256: hash,
  };
}

function recovered() {
  return {
    run: run.run,
    phase: "stopped-data-retained",
    recovered: true,
    data_retained: true,
    same_boot: true,
    publisher_retired: true,
    reservation_released: true,
  };
}

test("interrupted cleanup uses the exact native selection once and independently verifies retained data", async () => {
  const calls: string[][] = [];
  const result = await recoverNativeInterruptedStartupCleanup({
    runtime,
    projectRoot: "/not-used",
    run,
    snapshot: snapshot(),
    invoke: async ({ args }) => {
      calls.push([...args]);
      if (args[1] === "inspect-interrupted-start-cleanup") {
        return selection();
      }
      if (args[1] === "recover-interrupted-start-cleanup") {
        return recovered();
      }
      return snapshot(true);
    },
  });
  expect(result).toEqual(snapshot(true));
  expect(calls).toEqual([
    [
      "graph",
      "inspect-interrupted-start-cleanup",
      "--run-id",
      run.run,
      "--json",
    ],
    [
      "graph",
      "recover-interrupted-start-cleanup",
      "--run-id",
      run.run,
      "--expect-selection",
      hash,
      "--retain-data",
      "--json",
    ],
    ["graph", "inspect", "--run-id", run.run, "--json"],
  ]);
});

test("ordinary, completed and unenrolled graph states do not request recovery", async () => {
  for (const phase of [
    "ready-observed",
    "failed-retained",
    "stopped-data-retained",
  ]) {
    const value = snapshot();
    value.receipt.phase = phase;
    expect(
      await recoverNativeInterruptedStartupCleanup({
        runtime,
        projectRoot: "/not-used",
        run,
        snapshot: value,
        invoke: () => {
          throw new Error("unexpected recovery");
        },
      })
    ).toBeNull();
  }
});

test("a post-ACK journal hint revalidates selection and finishes exact retirement", async () => {
  const partial = snapshot(true);
  partial.interrupted_start_cleanup_incomplete = true;
  const selected = { ...selection(), phase: "stopped-data-retained" };
  const calls: string[][] = [];
  const result = await recoverNativeInterruptedStartupCleanup({
    runtime,
    projectRoot: "/not-used",
    run,
    snapshot: partial,
    invoke: async ({ args }) => {
      calls.push([...args]);
      if (args[1] === "inspect-interrupted-start-cleanup") {
        return selected;
      }
      if (args[1] === "recover-interrupted-start-cleanup") {
        return recovered();
      }
      return snapshot(true);
    },
  });
  expect(result).toEqual(snapshot(true));
  expect(calls.length).toBe(3);
  expect(calls[1]).toContain(hash);
});

test("a native journal hint cannot grant authority to a different graph phase", async () => {
  const partial = snapshot(true);
  partial.interrupted_start_cleanup_incomplete = true;
  partial.receipt.phase = "ready-observed";
  let calls = 0;
  await expect(
    recoverNativeInterruptedStartupCleanup({
      runtime,
      projectRoot: "/not-used",
      run,
      snapshot: partial,
      invoke: () => {
        calls++;
        throw new Error("unexpected recovery");
      },
    })
  ).rejects.toThrow("cleanup is unconfirmed");
  expect(calls).toBe(0);
});

test("foreign or incomplete graph selection refuses before native requests", async () => {
  for (const field of [
    "run",
    "owner",
    "namespace",
    "plan_id",
    "journal",
  ] as const) {
    const value = snapshot();
    if (field === "journal") {
      value.journal_incomplete = true;
    } else {
      value.receipt[field] = "invalid";
    }
    let calls = 0;
    await expect(
      recoverNativeInterruptedStartupCleanup({
        runtime,
        projectRoot: "/not-used",
        run,
        snapshot: value,
        invoke: () => {
          calls++;
          throw new Error("synthetic-private-canary");
        },
      })
    ).rejects.toThrow("cleanup is unconfirmed");
    expect(calls).toBe(0);
  }
});

test("malformed native selection never admits a recovery effect", async () => {
  for (const field of [
    "run",
    "phase",
    "eligible",
    "data_retained",
    "same_boot",
    "selection_sha256",
  ]) {
    const selected: Record<string, unknown> = selection();
    selected[field] = "synthetic-private-canary";
    let calls = 0;
    const failure = await recoverNativeInterruptedStartupCleanup({
      runtime,
      projectRoot: "/not-used",
      run,
      snapshot: snapshot(),
      invoke: async () => {
        calls++;
        return selected;
      },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain("synthetic-private-canary");
    expect(calls).toBe(1);
  }
});

test("lost recovery replies are never replayed and private diagnostics are omitted", async () => {
  let calls = 0;
  const failure = await recoverNativeInterruptedStartupCleanup({
    runtime,
    projectRoot: "/not-used",
    run,
    snapshot: snapshot(),
    invoke: async () => {
      if (++calls === 1) {
        return selection();
      }
      throw new Error("synthetic-private-canary");
    },
  }).catch((error: unknown) => error);
  expect(calls).toBe(2);
  expect(String(failure)).toContain("cleanup is unconfirmed");
  expect(Bun.inspect(failure)).not.toContain("synthetic-private-canary");
});

test("graph-only confirmation cannot claim publisher or dependency retirement", async () => {
  for (const field of [
    "run",
    "phase",
    "recovered",
    "data_retained",
    "same_boot",
    "publisher_retired",
    "reservation_released",
  ]) {
    const reply: Record<string, unknown> = recovered();
    reply[field] = "synthetic-private-canary";
    let calls = 0;
    const failure = await recoverNativeInterruptedStartupCleanup({
      runtime,
      projectRoot: "/not-used",
      run,
      snapshot: snapshot(),
      invoke: async () => (++calls === 1 ? selection() : reply),
    }).catch((error: unknown) => error);
    expect(calls).toBe(2);
    expect(String(failure)).toContain("cleanup is unconfirmed");
    expect(Bun.inspect(failure)).not.toContain("synthetic-private-canary");
  }
});

test("recovery acknowledgement does not replace fresh exact retained-data observations", async () => {
  for (const fault of [
    "container",
    "volume",
    "name",
    "id",
    "missing",
    "foreign",
    "journal",
    "phase",
    "unfinished",
  ]) {
    const final = snapshot(true);
    if (fault === "container") {
      final.observations["container:web"].state = "running";
    }
    if (fault === "volume") {
      final.observations["volume:data"].state = "absent";
    }
    if (fault === "name") {
      final.receipt.resources["volume:data"].name = "changed";
    }
    if (fault === "id") {
      final.receipt.resources["container:web"].id = "1".repeat(64);
    }
    if (fault === "missing") {
      Reflect.deleteProperty(final.receipt.resources, "volume:data");
    }
    if (fault === "foreign") {
      final.receipt.owner = "1".repeat(32);
    }
    if (fault === "journal") {
      final.journal_incomplete = true;
    }
    if (fault === "phase") {
      final.receipt.phase = "cleanup-intent";
    }
    if (fault === "unfinished") {
      final.interrupted_start_cleanup_incomplete = true;
    }
    const invoke: typeof invokeNativeRuntime = async ({ args }) => {
      if (args[1] === "inspect-interrupted-start-cleanup") {
        return selection();
      }
      if (args[1] === "recover-interrupted-start-cleanup") {
        return recovered();
      }
      return final;
    };
    await expect(
      recoverNativeInterruptedStartupCleanup({
        runtime,
        projectRoot: "/not-used",
        run,
        snapshot: snapshot(),
        invoke,
      })
    ).rejects.toThrow("cleanup is unconfirmed");
  }
});
