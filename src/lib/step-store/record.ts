/**
 * Step records: the TypeScript twin of
 * `packages/runtime-core/src/store/record.rs`.
 *
 * A record is canonical JSON with a `check` field: the canonical digest under
 * `STEP_RECORD_DOMAIN` of the record without `check`. A reader treats a record
 * that does not parse, has another version, fails its check or names another
 * key as a miss. Records are a cache, never authority, and hold digests and
 * value-free identifiers only.
 */
import {
  CanonicalValueError,
  canonicalDigest,
  canonicalJson,
  STEP_RECORD_DOMAIN,
} from "../canonical-digest.ts";
import type { InputDigest, StepClass, StepKey } from "./key.ts";

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** The record format version. */
export const STEP_RECORD_VERSION = 1;

/** A step's value-free output identity and optional storage reference. */
export type StepOutput = {
  readonly digest: string;
  readonly ref: "cas" | null;
};

/** One stored step result. */
export type StepRecord = {
  readonly v: 1;
  readonly step: string;
  readonly stepVersion: number;
  readonly class: StepClass;
  readonly key: string;
  readonly inputs: Readonly<Record<string, InputDigest>>;
  readonly epoch: string | null;
  readonly output: StepOutput;
  readonly observedAt: number;
  readonly producedBy: { readonly build: string; readonly run: string };
};

/** Why a stored record did not decode for this key. */
export type RecordMiss = "torn-record" | "version-changed";

const FIELDS = [
  "check",
  "class",
  "epoch",
  "inputs",
  "key",
  "observedAt",
  "output",
  "producedBy",
  "step",
  "stepVersion",
  "v",
].join();

/** Build the record a step writes after its effect was observed. */
export function newStepRecord(opts: {
  readonly key: StepKey;
  readonly output: StepOutput;
  readonly observedAt: number;
  readonly run: string;
}): StepRecord {
  if (opts.key.class === "cas" && opts.output.ref !== "cas") {
    throw new CanonicalValueError("A cas step needs a cas output reference.");
  }
  return {
    v: STEP_RECORD_VERSION,
    step: opts.key.step,
    stepVersion: opts.key.stepVersion,
    class: opts.key.class,
    key: opts.key.digest,
    inputs: opts.key.inputs,
    epoch: opts.key.epoch,
    output: opts.output,
    observedAt: opts.observedAt,
    producedBy: { build: opts.key.build, run: opts.run },
  };
}

/** The canonical bytes of a record, with its check. */
export function encodeStepRecord(record: StepRecord): string {
  const check = canonicalDigest(STEP_RECORD_DOMAIN, record);
  return canonicalJson({ ...record, check });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameInputs(
  left: unknown,
  right: Readonly<Record<string, InputDigest>>
): boolean {
  if (!isRecord(left)) {
    return false;
  }
  const keys = Object.keys(left).sort();
  const expected = Object.keys(right).sort();
  return (
    keys.join() === expected.join() &&
    keys.every((name) => left[name] === right[name])
  );
}

function sameOutput(value: unknown): value is StepOutput {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join() === "digest,ref" &&
    typeof value.digest === "string" &&
    DIGEST.test(value.digest) &&
    (value.ref === "cas" || value.ref === null)
  );
}

/** Decode and verify a record read for `key`. */
export function decodeStepRecord(
  text: string,
  key: StepKey
): StepRecord | RecordMiss {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "torn-record";
  }
  if (!isRecord(value)) {
    return "torn-record";
  }
  if (value.v !== STEP_RECORD_VERSION) {
    return value.v === undefined ? "torn-record" : "version-changed";
  }
  if (Object.keys(value).sort().join() !== FIELDS) {
    return "torn-record";
  }
  const { check, ...rest } = value;
  let expected: string;
  try {
    expected = canonicalDigest(STEP_RECORD_DOMAIN, rest);
  } catch {
    return "torn-record";
  }
  const producedBy = rest.producedBy;
  if (
    check !== expected ||
    rest.key !== key.digest ||
    rest.step !== key.step ||
    rest.stepVersion !== key.stepVersion ||
    rest.class !== key.class ||
    rest.epoch !== key.epoch ||
    !sameInputs(rest.inputs, key.inputs) ||
    !sameOutput(rest.output) ||
    typeof rest.observedAt !== "number" ||
    !isRecord(producedBy) ||
    Object.keys(producedBy).sort().join() !== "build,run" ||
    producedBy.build !== key.build ||
    typeof producedBy.run !== "string"
  ) {
    return "torn-record";
  }
  return rest as unknown as StepRecord;
}
