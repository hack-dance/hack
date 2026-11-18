import { expect, test } from "bun:test";
import {
  beginTerminalHandoff,
  runWithTerminalHandoff,
} from "../src/tui/terminal-handoff.ts";

/** A renderer and child that record the order of every terminal step. */
function harness(opts: {
  readonly suspend?: () => Promise<void>;
  readonly child?: () => Promise<number>;
  readonly active?: () => boolean;
}) {
  const steps: string[] = [];
  return {
    steps,
    run: (handoff: boolean) =>
      runWithTerminalHandoff({
        handoff,
        suspend:
          opts.suspend ??
          (async () => {
            await Bun.sleep(5);
            steps.push("suspended");
          }),
        resume: async () => {
          steps.push("resumed");
        },
        child: async () => {
          steps.push("child");
          return (await opts.child?.()) ?? 0;
        },
        isActive: opts.active ?? (() => true),
        afterResume: () => steps.push("redrawn"),
      }),
  };
}

test("suspension completes before the child starts, and resume follows it", async () => {
  const h = harness({});
  expect(await h.run(true)).toBe(0);
  expect(h.steps).toEqual(["suspended", "child", "resumed", "redrawn"]);
});

test("a failed or throwing child is still paired with resume", async () => {
  const failed = harness({ child: async () => 2 });
  expect(await failed.run(true)).toBe(2);
  expect(failed.steps).toEqual(["suspended", "child", "resumed", "redrawn"]);

  const thrown = harness({
    child: async () => {
      throw new Error("spawn failed");
    },
  });
  await expect(thrown.run(true)).rejects.toThrow("spawn failed");
  expect(thrown.steps).toEqual(["suspended", "child", "resumed", "redrawn"]);
});

test("a synchronous suspend refusal starts nothing and keeps the terminal", async () => {
  const h = harness({
    suspend: () => {
      throw new Error(
        "Native scene suspension requires completed terminal setup and no pending transition"
      );
    },
  });
  expect(await h.run(true)).toBeNull();
  expect(h.steps).toEqual([]);
});

test("a rejected suspension starts nothing and is rethrown", async () => {
  const h = harness({
    suspend: async () => {
      throw new Error("native terminal transition failed");
    },
  });
  await expect(h.run(true)).rejects.toThrow(
    "native terminal transition failed"
  );
  expect(h.steps).toEqual([]);
});

test("without a handover (tmux switch-client) the renderer is not touched", async () => {
  const h = harness({});
  expect(await h.run(false)).toBe(0);
  expect(h.steps).toEqual(["child"]);
});

test("a dashboard shut down during the child is not resumed", async () => {
  let active = true;
  const h = harness({
    child: async () => {
      active = false;
      return 0;
    },
    active: () => active,
  });
  expect(await h.run(true)).toBe(0);
  expect(h.steps).toEqual(["suspended", "child"]);
});

test("beginTerminalHandoff distinguishes refusal from completion", async () => {
  expect(await beginTerminalHandoff(async () => undefined)).toBe("handed_over");
  expect(
    await beginTerminalHandoff(() => {
      throw new Error("refused");
    })
  ).toBe("not_handed_over");
});
