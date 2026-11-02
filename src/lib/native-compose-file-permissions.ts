/** Closed backend permission subset; the compiler preserves broader intent separately. */
export type NativeComposeFileMode = "0444" | "0400" | "0600";
export type NativeComposeFileModeBits = 0o444 | 0o400 | 0o600;
export function nativeComposeFileMode(
  value: unknown
): NativeComposeFileMode | undefined {
  return value === "0444" || value === "0400" || value === "0600"
    ? value
    : undefined;
}
export function nativeComposeFileModeBits(
  value: NativeComposeFileMode
): NativeComposeFileModeBits;
export function nativeComposeFileModeBits(
  value: unknown
): NativeComposeFileModeBits | undefined;
export function nativeComposeFileModeBits(
  value: unknown
): NativeComposeFileModeBits | undefined {
  if (value === "0444") {
    return 0o444;
  }
  if (value === "0400") {
    return 0o400;
  }
  return value === "0600" ? 0o600 : undefined;
}
export function nativeComposeFileModeBitsValid(
  value: unknown
): value is NativeComposeFileModeBits {
  return value === 0o444 || value === 0o400 || value === 0o600;
}
