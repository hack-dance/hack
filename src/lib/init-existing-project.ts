import { HackCliError } from "./cli-result.ts";

/**
 * Refusal for `hack init --auto` when the project directory already exists.
 *
 * Init never overwrites an existing project directory and has no overwrite
 * flag, so the message says the project is already initialized and names
 * commands that work without a terminal. It is an expected outcome, so it is
 * a {@link HackCliError} (`E_PROJECT_EXISTS`): text output is one line without
 * a stack trace.
 *
 * @param projectDirName The existing directory name, such as `.hack`.
 * @param nextCommand The start command for the selected backend.
 */
export function initProjectExistsError(opts: {
  readonly projectDirName: string;
  readonly nextCommand: string;
}): HackCliError {
  const dir = `${opts.projectDirName}/`;
  return new HackCliError({
    code: "E_PROJECT_EXISTS",
    message: [
      `${dir} already exists, so this project is already initialized; nothing was written.`,
      `\`hack init --auto\` never overwrites ${dir} and has no overwrite flag.`,
      `Next: ${opts.nextCommand}.`,
      "To hand the existing setup to an agent, run `hack init --auto --with <claude|codex|both>`.",
      `To scaffold again from scratch, move ${dir} aside yourself, then rerun \`hack init --auto\`.`,
    ].join(" "),
  });
}
