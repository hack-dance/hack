import { expect, test } from "bun:test";
import {
  mergeNativeComposeRetainedVolumes,
  nativeComposeRetainedVolumesValid,
  selectNativeComposeVolumePolicies,
} from "../src/lib/native-compose-retained-storage.ts";

const original = {
  name: "owned_data",
  storage: "data",
  createdAt: "2026-10-08T12:00:00Z",
};

test("storage provenance is monotonic across new declarations", () => {
  const added = { ...original, name: "owned_cache", storage: "cache" };
  const merged = mergeNativeComposeRetainedVolumes({
    retained: [original],
    observed: [original, added],
  });
  expect(merged).toEqual([added, original]);
  expect(Object.isFrozen(merged)).toBe(true);
  expect(Object.isFrozen(merged[0])).toBe(true);
  expect(merged[1]).not.toBe(original);
});

test.each([
  { observed: [] },
  { observed: [{ ...original, createdAt: "2026-10-08T12:00:01Z" }] },
  { observed: [{ ...original, storage: "rebound" }] },
])("storage facts cannot forget or rebind a retained volume", ({
  observed,
}) => {
  expect(() =>
    mergeNativeComposeRetainedVolumes({ retained: [original], observed })
  ).toThrow("Native retained storage changed; values omitted.");
});

test.each([
  { observed: [{ ...original, createdAt: "private-canary" }] },
  { observed: [{ ...original, createdAt: "2026-99-08T12:00:00Z" }] },
  { observed: [{ ...original, name: "../private-canary" }] },
  { observed: [{ ...original, extra: "private-canary" }] },
  { observed: [original, original] },
])("malformed engine provenance is refused without reflecting its values", ({
  observed,
}) => {
  expect(nativeComposeRetainedVolumesValid(observed)).toBe(false);
  expect(() =>
    mergeNativeComposeRetainedVolumes({ retained: [], observed })
  ).toThrow("Invalid native retained storage facts; values omitted.");
});

test("dropped declarations keep retained birth guards; cold volumes may be created", () => {
  expect(
    selectNativeComposeVolumePolicies({
      declared: [{ name: "owned_cache", storage: "cache" }],
      retained: [original],
      legacyNames: new Set(),
    })
  ).toEqual([
    { ...original, mustExist: true },
    { name: "owned_cache", storage: "cache" },
  ]);
});

test("legacy receipts require present storage before their first birth observation", () => {
  expect(
    selectNativeComposeVolumePolicies({
      declared: [original],
      retained: [],
      legacyNames: new Set([original.name]),
    })
  ).toEqual([
    { name: original.name, storage: original.storage, mustExist: true },
  ]);
});

test("a declaration cannot rename the logical owner of historical storage", () => {
  expect(() =>
    selectNativeComposeVolumePolicies({
      declared: [{ name: original.name, storage: "rebound" }],
      retained: [original],
      legacyNames: new Set(),
    })
  ).toThrow("Native retained storage changed; values omitted.");
});
