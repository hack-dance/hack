import { expect } from "bun:test";

/** Assert the public boundary before tests inspect command-specific payload fields. */
export function machineData(text: string, schema: string) {
  const result = JSON.parse(text);
  expect(Object.keys(result).sort()).toEqual(["data", "ok"]);
  expect(result.ok).toBe(true);
  expect(result.data.schema).toBe(schema);
  return result.data;
}

export function machineError(text: string, code: string) {
  const result = JSON.parse(text);
  expect(Object.keys(result).sort()).toEqual(["error", "ok"]);
  expect(result.ok).toBe(false);
  expect(result.error.code).toBe(code);
  expect(result.error.message).toBeString();
  return result.error;
}
