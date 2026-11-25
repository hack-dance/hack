/** A module whose object export `tests/scoped-module-mock.test.ts` mocks. */
export const recorder = {
  label: "real",
  calls: [] as string[],
  record(message: string): string {
    this.calls.push(message);
    return `real:${message}`;
  },
};

/** Reads the export the way production code reads `logger`: a live import binding. */
export function recordThroughImport(message: string): string {
  return recorder.record(message);
}
