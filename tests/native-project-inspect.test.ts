import { expect, test } from "bun:test";
import { inspectNativeProjectGraph } from "../src/backends/native-project-inspect.ts";

const opts = {
  runtime: { binary: "/unused", home: "/unused" },
  projectRoot: "/fixture",
  run: "a".repeat(32),
};
test("read-only inspect retries explicit provider contention without replaying cleanup", async () => {
  let calls = 0;
  const result = await inspectNativeProjectGraph({
    ...opts,
    invoke: async (request) => {
      expect(request.args.slice(0, 2)).toEqual(["graph", "inspect"]);
      calls++;
      if (calls === 1) {
        throw new Error(
          "Native runtime request failed (provider_busy); inspect owned state before retrying."
        );
      }
      return { ready: true };
    },
  });
  expect(result).toEqual({ ready: true });
  expect(calls).toBe(2);
});
test("unknown inspection failures are never retried", async () => {
  let calls = 0;
  await expect(
    inspectNativeProjectGraph({
      ...opts,
      invoke: async () => {
        calls++;
        throw new Error("unknown");
      },
    })
  ).rejects.toThrow("unknown");
  expect(calls).toBe(1);
});
