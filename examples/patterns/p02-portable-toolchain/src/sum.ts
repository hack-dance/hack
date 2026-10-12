/** Tiny library code so the toolchain service has something to check. */
export function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
