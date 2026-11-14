import { expect, spyOn, test } from "bun:test";
import { traceLifecycleRetirement } from "../src/lib/lifecycle-retirement-trace.ts";
import { restoreEnv } from "./helpers/env.ts";

test("retirement trace is opt-in and never serializes error details", () => {
  const previous = process.env.HACK_LIFECYCLE_RETIREMENT_TRACE;
  const output = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    restoreEnv("HACK_LIFECYCLE_RETIREMENT_TRACE", undefined);
    traceLifecycleRetirement("abort-failed", { processes: 1 });
    expect(output).not.toHaveBeenCalled();
    process.env.HACK_LIFECYCLE_RETIREMENT_TRACE = "1";
    traceLifecycleRetirement(
      "group-signal-failed",
      { group: 42, probe: true },
      Object.assign(new Error("synthetic-private-message"), {
        code: "EPERM",
        cause: "synthetic-private-cause",
        path: "/synthetic/private/path",
      })
    );
    expect(output).toHaveBeenCalledWith(
      "[lifecycle-retirement]",
      JSON.stringify({
        event: "group-signal-failed",
        group: 42,
        probe: true,
        failed: true,
        eperm: true,
        esrch: false,
        timedOut: false,
      })
    );
  } finally {
    output.mockRestore();
    restoreEnv("HACK_LIFECYCLE_RETIREMENT_TRACE", previous);
  }
});
