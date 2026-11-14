import { HackCliError } from "./cli-result.ts";
import { ProjectEnvLayerRefusalError } from "./project-env-layer-path.ts";
import { CommandError } from "./shell.ts";

export type UpgradeCheckFailureClass =
  | "env-layer-refused"
  | "command-error"
  | "cli-refusal"
  | "type-error"
  | "parse-error"
  | "range-error"
  | "permission-denied"
  | "missing-path"
  | "not-a-directory"
  | "io-error"
  | "timeout"
  | "unexpected-error";

/** Closed failure classes only: error messages, arbitrary names/codes and process output can contain values. */
export function upgradeCheckFailureClass(
  error: unknown
): UpgradeCheckFailureClass {
  if (error instanceof ProjectEnvLayerRefusalError) {
    return "env-layer-refused";
  }
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
