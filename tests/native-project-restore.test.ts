import { expect, test } from "bun:test";
import { selectNativeProjectRestore } from "../src/backends/native-project-restore.ts";

const saved = {
  run: "a".repeat(32),
  owner: "b".repeat(32),
  namespace: "c".repeat(64),
  planId: "d".repeat(64),
};
const options = {
  runtime: { binary: "/not-invoked", home: "/private/fixture" },
  projectRoot: "/fixture",
  review: {
    namespace: saved.namespace,
    planId: saved.planId,
    report: {},
    projectArgs: [],
  },
};
const selected = {
  run: saved.run,
  owner: saved.owner,
  namespace: saved.namespace,
  plan: saved.planId,
  generation: "e".repeat(64),
};

test("fresh selection makes a new run without touching retained state", async () => {
  const result = await selectNativeProjectRestore({
    ...options,
    invoke: async () => {
      throw new Error("unexpected access");
    },
  });
  expect(result.run).toMatch(/^[a-f0-9]{32}$/);
  expect(result.restoring).toBe(false);
  expect(result.flags).toEqual([]);
});
test("restore binds the same run to exact owner plan and generation", async () => {
  const result = await selectNativeProjectRestore({
    ...options,
    restore: saved,
    invoke: async (request) => {
      expect(request.args).toEqual([
        "graph",
        "restore-selection",
        "--run-id",
        saved.run,
        "--json",
      ]);
      return selected;
    },
  });
  expect(result).toEqual({
    run: saved.run,
    restoring: true,
    flags: ["--expect-generation", selected.generation],
  });
});
test("changed retained identity refuses without adopting volumes", async () => {
  for (const key of ["run", "owner", "namespace", "plan", "generation"]) {
    await expect(
      selectNativeProjectRestore({
        ...options,
        restore: saved,
        invoke: async () => ({ ...selected, [key]: "changed" }),
      })
    ).rejects.toThrow("selection changed");
  }
  await expect(
    selectNativeProjectRestore({
      ...options,
      restore: saved,
      review: { ...options.review, planId: "f".repeat(64) },
      invoke: async () => selected,
    })
  ).rejects.toThrow("selection changed");
});
