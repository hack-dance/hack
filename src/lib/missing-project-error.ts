import { HACK_PROJECT_DIR_PRIMARY } from "../constants.ts";
import { HackCliError } from "./cli-result.ts";

/** The message every project command reports for a path without a project. */
export const MISSING_PROJECT_MESSAGE = `No ${HACK_PROJECT_DIR_PRIMARY}/ (or legacy .dev/) found. Run: hack init`;

/**
 * No project at the selected path (`--path` or the working directory). It
 * carries the closed code `E_PROJECT_NOT_FOUND`, so every project command that
 * resolves its project through this error reports the same `--json` envelope
 * and, without `--json`, one closed `E_PROJECT_NOT_FOUND: ...` error line and
 * no stack. The logger adds its prefix (`ERROR: ` for the console logger;
 * gum and clack print their own markers). `docs/cli.md` lists the commands, and
 * `tests/missing-project-error-code.test.ts` pins each one.
 */
export class MissingProjectContextError extends HackCliError {
  constructor() {
    super({ code: "E_PROJECT_NOT_FOUND", message: MISSING_PROJECT_MESSAGE });
    this.name = "MissingProjectContextError";
  }
}
