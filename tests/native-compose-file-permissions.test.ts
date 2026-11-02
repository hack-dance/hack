import { expect, test } from "bun:test";
import {
  nativeComposeFileMode,
  nativeComposeFileModeBits,
  nativeComposeFileModeBitsValid,
} from "../src/lib/native-compose-file-permissions.ts";

test.each([
  ["0444", 0o444],
  ["0400", 0o400],
  ["0600", 0o600],
] as const)("closed retained mode codec preserves %s", (mode, bits) => {
  expect(nativeComposeFileMode(mode)).toBe(mode);
  expect(nativeComposeFileModeBits(mode)).toBe(bits);
  expect(nativeComposeFileModeBitsValid(bits)).toBe(true);
});
test.each(
  ["0000", "0644", "0777", "400", "600", 0o400, 0o600, null, false, {}, []].map(
    (mode) => ({ mode })
  )
)("retained mode codec refuses unsupported %j", ({ mode }) => {
  expect(nativeComposeFileMode(mode)).toBeUndefined();
  expect(nativeComposeFileModeBits(mode)).toBeUndefined();
});
test.each(
  [0, 0o644, 0o777, "0444", null, false, {}, []].map((bits) => ({ bits }))
)("retained mode bits refuse unsupported %j", ({ bits }) => {
  expect(nativeComposeFileModeBitsValid(bits)).toBe(false);
});
