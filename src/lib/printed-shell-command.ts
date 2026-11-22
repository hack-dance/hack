import { quoteShellWord } from "./logs.ts";

const SHELL_LINE_CONTROLS = /[\p{Cc}\u2028\u2029]/u;

/** Format argv as one POSIX shell line, preserving even trailing newlines in arguments. */
export function printedShellCommand(argv: readonly string[]): string {
  const command = argv.map(quoteShellWord).join(" ");
  if (!SHELL_LINE_CONTROLS.test(command)) {
    return command;
  }
  // Encode the quoted command rather than each argument. Its final shell
  // quote survives command substitution, which otherwise trims trailing LFs.
  const encoded = Array.from(
    new TextEncoder().encode(command),
    (byte) => `\\0${byte.toString(8).padStart(3, "0")}`
  ).join("");
  return `sh -c "$(printf '%b' '${encoded}')"`;
}

export function scopedHackCommand(
  action: string,
  selection: {
    readonly path?: string;
    readonly project?: string;
    readonly branch?: string;
  },
  rest: readonly string[] = []
): string {
  const argv = ["hack", action];
  for (const [name, value] of Object.entries(selection)) {
    if (value !== undefined) {
      argv.push(`--${name}`, value);
    }
  }
  return printedShellCommand([...argv, ...rest]);
}
