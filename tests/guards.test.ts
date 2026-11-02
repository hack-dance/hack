import { expect, test } from "bun:test";
import { deepFreeze } from "../src/lib/guards.ts";

test("deepFreeze freezes nested objects and arrays in place", () => {
  const value = {
    name: "web",
    nested: { ports: [8080, { host: 443 }] },
    list: [{ id: 1 }],
  };
  deepFreeze(value);
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.isFrozen(value.nested)).toBe(true);
  expect(Object.isFrozen(value.nested.ports)).toBe(true);
  expect(Object.isFrozen(value.nested.ports[1])).toBe(true);
  expect(Object.isFrozen(value.list[0])).toBe(true);
  expect(() => {
    (value.nested as { ports: unknown }).ports = [];
  }).toThrow();
});

test("deepFreeze ignores primitives and null", () => {
  expect(() => deepFreeze(null)).not.toThrow();
  expect(() => deepFreeze(undefined)).not.toThrow();
  expect(() => deepFreeze("text")).not.toThrow();
  expect(() => deepFreeze(42)).not.toThrow();
});
