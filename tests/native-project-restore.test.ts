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
  ).rejects.toThrow("compatibility changed");
});

test("changed source review retains the old cache publication after native compatibility proof", async () => {
  const review = {
    ...options.review,
    planId: "f".repeat(64),
    projectArgs: ["--project", "/fixture"],
    report: {
      plan: {
        services: {
          deps: { active: true, dependency_cache: { volume: "deps" } },
        },
      },
    },
  };
  const result = await selectNativeProjectRestore({
    ...options,
    review,
    restore: saved,
    invoke: async ({ args }) => {
      if (args[1] === "restore-selection") {
        return selected;
      }
      expect(args).toEqual([
        "graph",
        "source-compatibility",
        "--project",
        "/fixture",
        "--expect-plan",
        review.planId,
        "--run-id",
        saved.run,
        "--json",
      ]);
      return {
        run: saved.run,
        owner: saved.owner,
        namespace: saved.namespace,
        plan: saved.planId,
        reviewed_plan: review.planId,
        source_revision: "1".repeat(64),
      };
    },
  });
  expect(result).toEqual({
    run: saved.run,
    restoring: true,
    flags: ["--expect-generation", selected.generation],
    sourceRevision: "1".repeat(64),
  });
});
