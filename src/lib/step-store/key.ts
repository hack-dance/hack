/**
 * Step keys for the step store (HACK-2461): the TypeScript twin of
 * `packages/runtime-core/src/store/key.rs`.
 *
 * A key is `canonicalDigest(STEP_DOMAIN, {step, stepVersion, class, inputs,
 * epoch, build})`. Inputs are digests only, never values: an identity derived
 * from a secret is a keyed digest made by the Rust store. Both languages are
 * checked against `packages/runtime-core/src/store/vectors.json`.
 */
import { canonicalDigest, STEP_DOMAIN } from "../canonical-digest.ts";

/** Which evidence a lookup needs before a record may replace the work. */
export type StepClass = "cas" | "slot" | "boot" | "file-identity";

const STEP_CLASSES: ReadonlySet<string> = new Set([
  "cas",
  "slot",
  "boot",
  "file-identity",
]);

/** A `sha256:<64 lowercase hex>` digest of one step input. */
export type InputDigest = string & { readonly __inputDigest: unique symbol };

/** The identity of the running build. */
export type StepBuild = string & { readonly __stepBuild: unique symbol };

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const NAME = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const IDENTIFIER = /^[A-Za-z0-9._:+-]{1,128}$/;

/** Maximum input count, so a key and its metadata can fit in one record. */
export const MAX_STEP_INPUTS = 256;

/**
 * A value-free identifier stored in plain text (build, boot epoch, run): 1 to 128
 * ASCII letters, digits and `.`, `_`, `:`, `+`, `-`. Same rule as `key.rs`.
 */
export function validStepIdentifier(text: string): boolean {
  return IDENTIFIER.test(text);
}

/** A malformed key part; the message never contains the value. */
export class StepKeyError extends Error {
  readonly code = "step_store_invalid";
}

/** Accept a digest text as an input digest. */
export function inputDigest(text: string): InputDigest {
  if (!DIGEST.test(text)) {
    throw new StepKeyError("A step input must be a sha256 digest.");
  }
  return text as InputDigest;
}

/** The parts of a step key. */
export type StepKeyParts = {
  readonly step: string;
  readonly stepVersion: number;
  readonly class: StepClass;
  readonly inputs: Readonly<Record<string, InputDigest>>;
  readonly epoch: string | null;
  /** Pass the build from `stepStoreBuild()`. Skip caching if it returns null. */
  readonly build: StepBuild;
};

/** A validated step key and its digest. */
export type StepKey = StepKeyParts & { readonly digest: string };

/** Validate the parts and derive the key digest. */
export function stepKey(parts: StepKeyParts): StepKey {
  const names = Object.keys(parts.inputs);
  if (names.length > MAX_STEP_INPUTS) {
    throw new StepKeyError("Too many step inputs.");
  }
  if (!(NAME.test(parts.step) && names.every((name) => NAME.test(name)))) {
    throw new StepKeyError("Invalid step or input name.");
  }
  if (
    !validStepIdentifier(parts.build) ||
    (parts.epoch !== null && !validStepIdentifier(parts.epoch))
  ) {
    throw new StepKeyError("Invalid step build or epoch identifier.");
  }
  if (!STEP_CLASSES.has(parts.class)) {
    throw new StepKeyError("Invalid step class.");
  }
  if (
    !Number.isInteger(parts.stepVersion) ||
    parts.stepVersion < 0 ||
    parts.stepVersion > 0xff_ff_ff_ff
  ) {
    throw new StepKeyError("Invalid step version.");
  }
  const inputs: Readonly<Record<string, InputDigest>> = Object.fromEntries(
    names.map((name) => [name, inputDigest(parts.inputs[name] ?? "")])
  );
  const identity = {
    step: parts.step,
    stepVersion: parts.stepVersion,
    class: parts.class,
    inputs,
    epoch: parts.epoch,
    build: parts.build,
  };
  return {
    ...parts,
    inputs,
    digest: canonicalDigest(STEP_DOMAIN, identity),
  };
}
