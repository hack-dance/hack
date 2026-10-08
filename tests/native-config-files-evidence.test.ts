import { expect, test } from "bun:test";
import { normalizeNativeFileObservation } from "./e2e/scenarios/native-config-files.ts";

test("metadata normalization preserves optional mount names, complete rows, duplicates, counts and engine identity", () => {
  const bind = {
    type: "bind",
    name: null,
    source: "/synthetic/private",
    target: "/target",
    rw: false,
    extra: "preserved",
  };
  const volume = {
    type: "volume",
    name: "synthetic-volume",
    source: "/synthetic/data",
    target: "/data",
    rw: true,
  };
  const before = {
    id: "a".repeat(64),
    name: "fixture",
    image: `sha256:${"b".repeat(64)}`,
    createdAt: "original-birth",
    running: false,
    mounts: [volume, bind, bind],
    networks: [
      { name: "z", id: "2" },
      { name: "a", id: "1" },
    ],
  };
  const normalized = normalizeNativeFileObservation(before);
  expect(
    normalizeNativeFileObservation({
      ...before,
      mounts: [bind, volume, bind],
      networks: [...before.networks].reverse(),
    })
  ).toEqual(normalized);
  expect(normalized.mounts).toHaveLength(3);
  expect(before.mounts).toEqual([volume, bind, bind]);
  for (const changed of [
    { ...before, mounts: [volume, bind] },
    { ...before, mounts: [volume, { ...bind, rw: true }, bind] },
    { ...before, mounts: [volume, { ...bind, source: "/other" }, bind] },
    { ...before, createdAt: "replacement-birth" },
    { ...before, running: true },
    { ...before, id: "c".repeat(64) },
  ]) {
    expect(normalizeNativeFileObservation(changed)).not.toEqual(normalized);
  }
});
