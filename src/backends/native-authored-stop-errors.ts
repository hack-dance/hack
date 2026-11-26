/** No stop request was dispatched. This is a routing hint, never recovery proof. */
export class NativeAuthoredStopUnavailableError extends Error {
  constructor() {
    super(
      "Native stop owner is unavailable; values omitted. No stop request was dispatched."
    );
    this.name = "NativeAuthoredStopUnavailableError";
  }
}

/**
 * A stop request was dispatched, the owner's cleanup did not remove the run (its
 * pool stopped under it, for example), and the owner process then exited
 * (HACK-2715 review round 2). The run is retained for the dead-owner recovery;
 * this is a routing hint, never recovery proof.
 */
export class NativeAuthoredStopOwnerExitedError extends Error {
  constructor() {
    super(
      "Native stop owner exited without removing its run; the run is retained for recovery. Values omitted."
    );
    this.name = "NativeAuthoredStopOwnerExitedError";
  }
}

/** Inspection or a settled selection found a journal; cleanup still needs its own proof. */
export class NativeAuthoredReservedStartError extends Error {
  constructor() {
    super(
      "Native startup has reserved runtime state; stored-generation recovery is required. Values omitted."
    );
    this.name = "NativeAuthoredReservedStartError";
  }
}
