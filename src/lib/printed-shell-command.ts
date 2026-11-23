import { currentCandidateLauncher } from "./candidate-launcher.ts";
import { quoteShellWord } from "./logs.ts";
import { PROJECT_NAME_PATTERN } from "./project-name.ts";

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
  const argv = [currentCandidateLauncher().command, action];
  for (const [name, value] of Object.entries(selection)) {
    if (value !== undefined) {
      argv.push(`--${name}=${value}`);
    }
  }
  return printedShellCommand([...argv, ...rest]);
}

const ASSIGNMENT = /^\s*[A-Za-z_][A-Za-z0-9_]*=/;
const BRANCH_SELECTOR = /^[A-Za-z0-9][A-Za-z0-9_./-]*$/;
const SERVICE_SELECTOR = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Keep copyable paths, but omit paths that resemble pasted environment assignments. */
export function canPrintPathSelector(path: string | undefined): boolean {
  return path === undefined || !ASSIGNMENT.test(path);
}

/** A refusal must not print rejected selectors or their derived slugs. */
export function canPrintStartSelection(selection: {
  readonly path?: string;
  readonly project?: string;
  readonly branch?: string;
  readonly services?: readonly string[];
}): boolean {
  return (
    canPrintPathSelector(selection.path) &&
    (selection.project === undefined ||
      PROJECT_NAME_PATTERN.test(selection.project.trim())) &&
    (selection.branch === undefined ||
      BRANCH_SELECTOR.test(selection.branch)) &&
    (selection.services?.every((service) => SERVICE_SELECTOR.test(service)) ??
      true)
  );
}
