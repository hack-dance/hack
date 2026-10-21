import { expect, test } from "bun:test";
import { preflightNativeProjectSource } from "../src/backends/native-project-source-preflight.ts";
import { ClosedCliError } from "../src/lib/cli-result.ts";

const runtime = { binary: "/candidate/hack-native", home: "/candidate/home" };

test("source admission asks the selected runtime to validate the exact root", async () => {
  await preflightNativeProjectSource({
    runtime,
    projectRoot: "/worktrees/branch/project",
    invoke: async (request) => {
      expect(request.runtime).toEqual(runtime);
      expect(request.args).toEqual([
        "runtime",
        "check-project-share",
        "--project-share",
        "/worktrees/branch/project",
        "--unfiltered-source",
        "--json",
      ]);
      expect(request.timeoutMs).toBe(5000);
      return { source_admitted: true, pool_initialized: false };
    },
  });
});

test("invalid and refused source admission never counts as startup permission", async () => {
  for (const result of [
    null,
    true,
    {},
    { source_admitted: false, pool_initialized: true },
    { source_admitted: true },
  ]) {
    const refusal = await preflightNativeProjectSource({
      runtime,
      projectRoot: "/project",
      invoke: async () => result,
    }).catch((error: unknown) => error);
    // A closed refusal: the CLI prints this one line without a stack.
    expect(refusal).toBeInstanceOf(ClosedCliError);
    expect(String(refusal)).toContain("invalid receipt");
  }
  await expect(
    preflightNativeProjectSource({
      runtime,
      projectRoot: "/project",
      invoke: async () => {
        throw new Error("source pool mismatch");
      },
    })
  ).rejects.toThrow("source pool mismatch");
});
