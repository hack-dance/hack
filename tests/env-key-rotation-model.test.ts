import { expect, test } from "bun:test";
import {
  explore,
  type Fault,
  reader,
  recoverySteps,
  type State,
  violation,
} from "./models/env-key-rotation/model.ts";

test("proposed paired rotation blocks mixed reads at every modeled crash cut", () => {
  const result = explore();
  expect(result.failure).toBeNull();
  expect(result.states.length).toBeGreaterThan(15);
  expect(result.states.some((state) => state.key !== state.store)).toBe(true);
  expect(
    result.states.some((state) => state.finished && reader(state) === 0)
  ).toBe(true);
  expect(
    result.states.some((state) => state.finished && reader(state) === 1)
  ).toBe(true);
});

test("recovery converges idempotently to the durable decision after every crash", () => {
  for (const state of explore().states.filter((item) => !item.running)) {
    let current = state;
    for (let step = 0; step < 4 && !current.finished; step++) {
      const next = recoverySteps(current);
      expect(next).toHaveLength(1);
      current = next[0]!.state;
      expect(violation(current)).toBeNull();
    }
    expect(current.finished).toBe(true);
    expect(reader(current)).toBe(state.committed ? 1 : 0);
    expect(recoverySteps(current)).toEqual([]);
  }
});

for (const fault of [
  "unguarded-reader",
  "late-journal",
  "early-commit",
] satisfies Fault[]) {
  test(`negative control exposes ${fault}`, () => {
    const failure = explore(fault).failure;
    expect(failure).not.toBeNull();
    expect(failure?.trace.length).toBeGreaterThan(1);
  });
}

test("a foreign member blocks recovery without rewriting it or discarding snapshots", () => {
  const prepared = explore().states.find(
    (state) => state.journal === "prepared" && !state.running
  );
  expect(prepared).toBeDefined();
  const changed: State = { ...prepared!, key: 2 };
  expect(reader(changed)).toBe("blocked");
  expect(recoverySteps(changed)).toEqual([]);
  expect(changed.key).toBe(2);
  expect(changed.oldSnapshot).toBe(true);
});
