/** No stop request was dispatched. This is a routing hint, never recovery proof. */
export class NativeAuthoredStopUnavailableError extends Error {
  constructor() {
    super(
      "Native stop owner is unavailable; values omitted. No stop request was dispatched."
    );
    this.name = "NativeAuthoredStopUnavailableError";
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
