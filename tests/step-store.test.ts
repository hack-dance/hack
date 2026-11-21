import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  canonicalDigest,
  canonicalJson,
  STEP_RECORD_DOMAIN,
} from "../src/lib/canonical-digest.ts";
import {
  inputDigest,
  StepKeyError,
  type StepKeyParts,
  stepKey,
} from "../src/lib/step-store/key.ts";
import {
  canonicalPath,
  stepStoreDirectory,
  stepStoreEnabled,
  stepStoreRuntimeArgs,
} from "../src/lib/step-store/location.ts";
import {
  decodeStepRecord,
  encodeStepRecord,
  newStepRecord,
} from "../src/lib/step-store/record.ts";

type KeyVector = StepKeyParts & { readonly name: string; readonly key: string };
type RecordVector = {
  readonly name: string;
  readonly keyIndex: number;
  readonly output: { readonly digest: string; readonly ref: "cas" | null };
  readonly observedAt: number;
  readonly run: string;
  readonly text: string;
};
const vectors = JSON.parse(
  readFileSync(
    resolve(import.meta.dir, "../packages/runtime-core/src/store/vectors.json"),
    "utf8"
  )
) as {
  readonly schema: string;
  readonly keys: readonly KeyVector[];
  readonly records: readonly RecordVector[];
};

const digestOf = (char: string) => inputDigest(`sha256:${char.repeat(64)}`);
const base: StepKeyParts = {
  step: "plan.compile",
  stepVersion: 1,
  class: "cas",
  inputs: { compose: digestOf("a"), branch: digestOf("b") },
  epoch: null,
  build: "runtime-build-1",
};

function keyFor(vector: KeyVector) {
  const { name: _name, key: _key, ...parts } = vector;
  return stepKey(parts);
}

describe("step store, shared vectors", () => {
  test("the vector file is the one the Rust store reads", () => {
    expect(vectors.schema).toBe("hack.step-store-vectors/1");
    expect(vectors.keys.length).toBeGreaterThan(0);
    expect(vectors.records.length).toBeGreaterThan(0);
  });

  for (const vector of vectors.keys) {
    test(`key: ${vector.name}`, () => {
      expect(keyFor(vector).digest).toBe(vector.key);
    });
  }

  for (const vector of vectors.records) {
    test(`record: ${vector.name}`, () => {
      const keyVector = vectors.keys[vector.keyIndex];
      if (!keyVector) {
        throw new Error("vector names a missing key");
      }
      const key = keyFor(keyVector);
      const record = newStepRecord({
        key,
        output: vector.output,
        observedAt: vector.observedAt,
        run: vector.run,
      });
      expect(encodeStepRecord(record)).toBe(vector.text);
      expect(decodeStepRecord(vector.text, key)).toEqual(record);
    });
  }
});

describe("step store, shared refused records", () => {
  const refused = (
    vectors as unknown as {
      readonly refused: readonly {
        readonly name: string;
        readonly keyIndex: number;
        readonly expect: string;
        readonly text: string;
      }[];
    }
  ).refused;
  test("the file lists records both readers must refuse", () => {
    expect(refused.length).toBeGreaterThan(0);
  });
  for (const vector of refused) {
    test(`refused: ${vector.name}`, () => {
      const keyVector = vectors.keys[vector.keyIndex];
      if (!keyVector) {
        throw new Error("vector names a missing key");
      }
      expect(decodeStepRecord(vector.text, keyFor(keyVector))).toBe(
        vector.expect as "torn-record"
      );
    });
  }
});

describe("step keys", () => {
  const reference = stepKey(base).digest;
  const changes: Record<string, Partial<StepKeyParts>> = {
    step: { step: "plan.review" },
    stepVersion: { stepVersion: 2 },
    class: { class: "slot" },
    "input name": {
      inputs: { compose: digestOf("a"), profile: digestOf("b") },
    },
    "input digest": {
      inputs: { compose: digestOf("a"), branch: digestOf("c") },
    },
    "added input": {
      inputs: {
        compose: digestOf("a"),
        branch: digestOf("b"),
        profile: digestOf("c"),
      },
    },
    "epoch null to set": { epoch: "boot-1" },
    "epoch set to another": { epoch: "boot-2" },
    build: { build: "runtime-build-2" },
  };
  for (const [field, change] of Object.entries(changes)) {
    test(`changing ${field} changes the key`, () => {
      expect(stepKey({ ...base, ...change }).digest).not.toBe(reference);
    });
  }

  test("equal parts give the same key, whatever the input order", () => {
    expect(
      stepKey({
        ...base,
        inputs: { branch: digestOf("b"), compose: digestOf("a") },
      }).digest
    ).toBe(reference);
  });

  test("malformed names, classes, versions and digests are refused", () => {
    for (const change of [
      { step: "Plan" },
      { step: ".plan" },
      { step: "a".repeat(65) },
      { inputs: { "Bad Name": digestOf("a") } },
      { class: "other" as never },
      { stepVersion: -1 },
      { stepVersion: 1.5 },
      { stepVersion: 2 ** 32 },
      { inputs: { compose: "sha256:abc" as never } },
      { inputs: { compose: "plain-value" as never } },
      { epoch: "" },
      { epoch: "has space" },
      { epoch: "a".repeat(129) },
      { build: "" },
      { build: "/path/to/build" },
      { build: "value=secret" },
    ]) {
      expect(() => stepKey({ ...base, ...change } as StepKeyParts)).toThrow(
        StepKeyError
      );
    }
  });
});

describe("step records", () => {
  const key = stepKey(base);
  const record = newStepRecord({
    key,
    output: { digest: `sha256:${"e".repeat(64)}`, ref: "cas" },
    observedAt: 1_763_650_000_000,
    run: "run-1",
  });
  const text = encodeStepRecord(record);

  test("a written record decodes for its own key", () => {
    expect(decodeStepRecord(text, key)).toEqual(record);
  });

  test("truncated, edited, unchecked and extra-field records are torn", () => {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const { check: _check, ...unchecked } = parsed;
    for (const torn of [
      text.slice(0, -5),
      text.replace('"run-1"', '"run-2"'),
      JSON.stringify(unchecked),
      JSON.stringify({ ...parsed, extra: 1 }),
      "[]",
      "",
    ]) {
      expect(decodeStepRecord(torn, key)).toBe("torn-record");
    }
  });

  test("a record with a valid check for another key is torn", () => {
    const other = stepKey({ ...base, build: "runtime-build-2" });
    expect(decodeStepRecord(text, other)).toBe("torn-record");
  });

  test("another format version is version-changed", () => {
    const { check: _check, ...rest } = JSON.parse(text) as Record<
      string,
      unknown
    >;
    const v2 = { ...rest, v: 2 };
    const reChecked = canonicalJson({
      ...v2,
      check: canonicalDigest(STEP_RECORD_DOMAIN, v2),
    });
    expect(decodeStepRecord(reChecked, key)).toBe("version-changed");
  });

  test("non-canonical text and missing optional fields are torn", () => {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const { check: _c, epoch: _e, ...withoutEpoch } = parsed;
    for (const torn of [
      `${text} `,
      text.replace('"stepVersion":1', '"stepVersion":1.0'),
      text.replace('"v":1', '"v":1.0'),
      JSON.stringify({
        ...withoutEpoch,
        check: canonicalDigest(STEP_RECORD_DOMAIN, withoutEpoch),
      }),
    ]) {
      expect(decodeStepRecord(torn, key)).toBe("torn-record");
    }
  });

  test("a record needs a run identifier, a time and an output digest", () => {
    for (const change of [
      { run: "" },
      { run: "run with space" },
      { observedAt: -5 },
      { observedAt: 1.5 },
      { observedAt: 2 ** 53 },
      { output: { digest: "not-a-digest", ref: "cas" as const } },
    ]) {
      expect(() =>
        newStepRecord({
          key,
          output: { digest: `sha256:${"e".repeat(64)}`, ref: "cas" },
          observedAt: 1,
          run: "run-1",
          ...change,
        })
      ).toThrow();
    }
  });

  test("a record too large to read back is refused when encoded", () => {
    const inputs = Object.fromEntries(
      Array.from({ length: 600 }, (_, index) => [
        `input-${String(index).padStart(58, "0")}`,
        digestOf("1"),
      ])
    );
    const big = stepKey({ ...base, inputs });
    const record = newStepRecord({
      key: big,
      output: { digest: `sha256:${"e".repeat(64)}`, ref: "cas" },
      observedAt: 1,
      run: "run-1",
    });
    expect(() => encodeStepRecord(record)).toThrow();
  });

  test("a cas step needs a cas reference", () => {
    expect(() =>
      newStepRecord({
        key,
        output: { digest: `sha256:${"e".repeat(64)}`, ref: null },
        observedAt: 1,
        run: "run-1",
      })
    ).toThrow();
  });
});

describe("step store location and switch", () => {
  test("off unless HACK_STEP_STORE=on, and no runtime arguments when off", () => {
    for (const value of [undefined, "", "off", "1", "true", "ON"]) {
      const env = { HACK_STEP_STORE: value };
      expect(stepStoreEnabled(env)).toBe(false);
      expect(stepStoreRuntimeArgs(env)).toEqual([]);
    }
  });

  test("on passes the per-user store under the global Hack directory, canonical", () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "step-store-location-"))
    );
    const previous = process.env.HACK_HOME;
    try {
      // An unresolved Hack home: its parent is a symlink and the home itself does
      // not exist yet (as under the macOS temporary directory).
      mkdirSync(join(root, "real"));
      symlinkSync(join(root, "real"), join(root, "alias"));
      process.env.HACK_HOME = join(root, "alias", "hack-home");
      const expected = join(root, "real", "hack-home", "store");
      expect(stepStoreDirectory()).toBe(expected);
      expect(stepStoreRuntimeArgs({ HACK_STEP_STORE: "on" })).toEqual([
        "--step-store",
        expected,
      ]);
      // An existing home behind the symlink resolves the same way.
      mkdirSync(join(root, "real", "hack-home"));
      expect(stepStoreDirectory()).toBe(expected);
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, "HACK_HOME");
      } else {
        process.env.HACK_HOME = previous;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("canonicalPath keeps an unresolvable path as it is", () => {
    expect(canonicalPath("/")).toBe("/");
  });
});
