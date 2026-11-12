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
