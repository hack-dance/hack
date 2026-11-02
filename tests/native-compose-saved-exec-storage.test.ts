import { expect, test } from "bun:test";
import { nativeComposeSavedExecUsesReadLease } from "../src/lib/native-compose-command-storage.ts";
import type { NativeComposeStorageWitnessState } from "../src/lib/native-compose-storage-witness-state.ts";

type Admission = Parameters<typeof nativeComposeSavedExecUsesReadLease>[0];
const volume = {
  name: "owned_data",
  storage: "data",
  createdAt: "2026-10-08T12:00:00Z",
};
const pending = {
  token: "a".repeat(32),
  operation: "up" as const,
  generationId: "b".repeat(32),
};
const expected: NativeComposeStorageWitnessState = {
  state: "expected",
  name: volume.name,
  storage: volume.storage,
  engineId: "fixture-engine:1",
  generationId: pending.generationId,
  pendingToken: pending.token,
  admission: "initial-create",
  originalVolume: null,
};
const imageOnly: Admission = {
  selected: [],
  current: {
    pending: null,
    beforeHooksPending: false,
    retainedStorage: null,
    storageWitnesses: null,
    storageWitnessesPending: false,
  },
};

test("known image-only saved exec retains a read lease for older and current empty receipts", () => {
  expect(nativeComposeSavedExecUsesReadLease(imageOnly)).toBe(true);
  expect(
    nativeComposeSavedExecUsesReadLease({
      selected: [],
      current: {
        ...imageOnly.current,
        retainedStorage: [],
        storageWitnesses: [],
      },
    })
  ).toBe(true);
});

test("selected storage cannot use the image-only saved exec lease", () => {
  expect(
    nativeComposeSavedExecUsesReadLease({
      ...imageOnly,
      selected: [{ name: volume.name, storage: volume.storage }],
    })
  ).toBe(false);
});

test.each([
  { name: "dropped retained volume", change: { retainedStorage: [volume] } },
  { name: "Expected enrollment", change: { storageWitnesses: [expected] } },
  {
    name: "enrolled witness after declaration removal",
    change: {
      storageWitnesses: [
        {
          ...expected,
          state: "enrolled" as const,
          reference: {
            version: 1 as const,
            volume,
            root: { dev: 1, ino: 2 },
            directory: { dev: 1, ino: 3 },
            expectation: { dev: 1, ino: 4, hash: "c".repeat(64) },
            completion: { dev: 1, ino: 5, hash: "d".repeat(64) },
          },
        },
      ],
    },
  },
  {
    name: "unfinished helper journal",
    change: { storageWitnessesPending: true },
  },
  { name: "pending generation", change: { pending } },
  { name: "unknown host hook", change: { beforeHooksPending: true } },
])("saved exec with $name cannot downgrade to a read lease", ({ change }) => {
  expect(
    nativeComposeSavedExecUsesReadLease({
      selected: [],
      current: { ...imageOnly.current, ...change },
    })
  ).toBe(false);
});
