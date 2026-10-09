const SERVICE = /^[A-Za-z0-9_.-]{1,128}$/;
/** Matches the native noninteractive exec domain; values never enter refusal text. */
export function nativeAuthoredExecOptions(
  service: unknown,
  command: unknown,
  workdir: unknown
): command is readonly string[] {
  const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
  return (
    typeof service === "string" &&
    SERVICE.test(service) &&
    Array.isArray(command) &&
    command.length >= 1 &&
    command.length <= 256 &&
    typeof command[0] === "string" &&
    command[0].length > 0 &&
    command.every(
      (s: unknown) =>
        typeof s === "string" && !s.includes("\0") && bytes(s) <= 16 * 1024
    ) &&
    command.reduce((sum: number, s: string) => sum + bytes(s), 0) <=
      64 * 1024 &&
    (workdir === undefined ||
      (typeof workdir === "string" &&
        workdir.startsWith("/") &&
        !workdir.includes("\0") &&
        bytes(workdir) <= 4096))
  );
}
