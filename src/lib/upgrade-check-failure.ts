import { HackCliError } from "./cli-result.ts";
import { CommandError } from "./shell.ts";

/** Closed failure classes only: error messages, arbitrary names/codes and process output can contain values. */
export function upgradeCheckFailureClass(error: unknown): string {
  if (error instanceof CommandError) {
    return "command-error";
  }
  if (error instanceof HackCliError) {
    return "cli-refusal";
  }
  if (error instanceof TypeError) {
    return "type-error";
  }
  if (error instanceof SyntaxError) {
    return "parse-error";
  }
  if (error instanceof RangeError) {
    return "range-error";
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    switch (error.code) {
      case "EACCES":
      case "EPERM":
        return "permission-denied";
      case "ENOENT":
        return "missing-path";
      case "ENOTDIR":
        return "not-a-directory";
      case "EIO":
        return "io-error";
      case "ETIMEDOUT":
        return "timeout";
      default:
        break;
    }
  }
  return "unexpected-error";
}
