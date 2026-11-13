/** No stop request was dispatched. This is a routing hint, never recovery proof. */
export class NativeAuthoredStopUnavailableError extends Error {
  constructor() {
    super(
      "Native stop owner is unavailable; values omitted. No stop request was dispatched."
    );
    this.name = "NativeAuthoredStopUnavailableError";
  }
}
