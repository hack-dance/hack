import { expect, test } from "bun:test";
import { sum } from "./sum.ts";

test("sum adds every value", () => {
  expect(sum([1, 2, 3])).toBe(6);
  expect(sum([])).toBe(0);
});
