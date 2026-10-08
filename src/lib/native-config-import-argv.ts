/** Decode complete Compose dollar pairs once; ambient interpolation is refused. */
export function literalComposeArg(value: unknown): string | undefined {
  if (typeof value !== "string" || value.includes("\0")) {
    return undefined;
  }
  let decoded = "";
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== "$") {
      decoded += value[index];
      continue;
    }
    if (value[index + 1] !== "$") {
      return undefined;
    }
    decoded += "$";
    index++;
  }
  return decoded;
}
