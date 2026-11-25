import { expect, test } from "bun:test";
import {
  nativeRecoveryGuidance,
  withNativeRecoveryGuidance,
} from "../src/backends/native-project-recovery-guidance.ts";
import { NativeRuntimeRequestError } from "../src/backends/native-runtime-client.ts";

test("unconfirmed publisher identity explains the wait and names retaining recovery", async () => {
  for (const nativeCode of ["publisher_identity_unconfirmed"]) {
    const hint = nativeRecoveryGuidance(nativeCode);
    expect(hint).toContain(
      "process holding the recorded publisher PID to exit"
    );
    expect(hint).toContain("rerun hack down --recover");
    const invoke = withNativeRecoveryGuidance(async () => {
      throw new NativeRuntimeRequestError({
        nativeCode,
        message: "Native publisher recovery refused.",
      });
    });
    await expect(
      invoke({
        runtime: { binary: "/not-invoked", home: "/not-invoked" },
        cwd: "/",
        args: [],
      })
    ).rejects.toThrow(hint);
  }
});

test("provider identity failures never claim that the failed process was a publisher", () => {
  for (const code of [
    "process_identity_unavailable",
    "process_identity_mismatch",
    "publisher_stop_uncertain",
  ]) {
    expect(nativeRecoveryGuidance(code)).not.toContain(
      "recorded publisher PID"
    );
  }
});

test("a runtime that is not running names the next commands without claiming what runs (HACK-2420)", () => {
  const hint = nativeRecoveryGuidance("runtime_not_running");
  expect(hint).toContain("Run hack ps --json");
  expect(hint).toContain("hack up starts the project again");
  expect(hint).toContain("hack down --recover");
  // A booting or quiescing pool may still run containers: never claim none run.
  expect(hint).not.toContain("containers are running");
  expect(hint).not.toContain("confirm that the native runtime is stopped");
});

test("a refused same-boot recovery names a working sequence, not a fresh home (HACK-2097)", () => {
  const hint = nativeRecoveryGuidance("graph_live_owner_recovery");
  expect(hint).toContain("Data and evidence are kept");
  expect(hint).toContain("run hack down --recover again");
  expect(hint).toContain(
    "native-candidate.md#explicit-cleanup-after-a-dead-foreground-owner"
  );
  expect(hint).toContain("keeps the data in this home");
  // Not every exited owner had an unsettled start, and the explicit cleanup
  // does not admit a restore or restart in progress.
  expect(hint).not.toContain("never settled");
  expect(hint).toContain("cannot be recovered in this boot");
  expect(hint).toContain("an owner that died during its own stop");
  expect(hint).toContain(
    "An owner that died while restoring or restarting a retained run has no supported retirement"
  );
  // The old answer abandoned the run: a second checkout in a fresh home.
  expect(hint).not.toContain("separate project checkout");
  expect(hint).not.toContain("fresh native home");
});
