import type { ProjectContext } from "../lib/project.ts";
import {
  normalizeProjectName,
  PROJECT_NAME_PATTERN,
  PROJECT_SELECTOR_PATTERN,
} from "../lib/project-name.ts";
import { resolveRegisteredProjectByName } from "../lib/projects-registry.ts";
import { CliUsageError } from "./command.ts";

/**
 * Parsing and resolution of the shared `--project <name>` option.
 *
 * Invariant: a refusal never contains any part of a rejected argument, and an
 * "Unknown project" error names the project only when the user typed it in
 * canonical form. A `--project` argument is sometimes a mistyped `KEY=value`
 * or a value pasted into the wrong position; slugging it (case folding,
 * stripping punctuation) still reveals most of it, so a slug derived from a
 * non-canonical argument is never echoed, logged, passed to a child process
 * or used in a file name.
 *
 * `runCli` parses `--project` for every command that declares `optProject`
 * before the handler runs, so a malformed argument is refused before any
 * registry read, project discovery or child process. Handlers still resolve
 * through this module so the rule holds when they are called directly.
 */

export const INVALID_PROJECT_OPTION_MESSAGE =
  "Invalid --project value. Project names use ASCII letters, digits, hyphens, underscores, spaces or slashes; run 'hack projects' to see registered projects.";

export const UNKNOWN_PROJECT_HINT =
  "Run 'hack init' in that repo (or run 'hack projects' to see registered projects).";

export type ProjectSelector = {
  /** The canonical project name the argument selects. */
  readonly name: string;
  /** True when the argument was typed in canonical form (safe to echo). */
  readonly canonical: boolean;
};

/**
 * Parse a `--project` argument. An argument containing `=` or any character
 * outside `PROJECT_SELECTOR_PATTERN` may be a pasted value, so it is refused
 * with fixed text and is never slugged into a name. Legacy alias spellings
 * (`My_App`) still select their canonical slug (`my-app`).
 */
export function parseProjectSelectorOption(input: {
  readonly projectOpt: string;
}): ProjectSelector {
  const trimmed = input.projectOpt.trim();
  const name = PROJECT_SELECTOR_PATTERN.test(trimmed)
    ? normalizeProjectName(trimmed)
    : null;
  if (!name) {
    throw new CliUsageError(INVALID_PROJECT_OPTION_MESSAGE);
  }
  return { name, canonical: PROJECT_NAME_PATTERN.test(trimmed) };
}

/** "Unknown project" text that names only a canonically typed selector. */
export function unknownProjectMessage(selector: ProjectSelector): string {
  return selector.canonical
    ? `Unknown project "${selector.name}". ${UNKNOWN_PROJECT_HINT}`
    : `Unknown project. ${UNKNOWN_PROJECT_HINT}`;
}

/**
 * Resolve `--project` to a registered project, or throw a usage error that
 * follows the echo rule above. Malformed arguments are refused before the
 * registry is read.
 */
export async function resolveRegisteredProjectOption(input: {
  readonly projectOpt: string;
}): Promise<ProjectContext> {
  const selector = parseProjectSelectorOption({
    projectOpt: input.projectOpt,
  });
  const project = await resolveRegisteredProjectByName({
    name: selector.name,
  });
  if (!project) {
    throw new CliUsageError(unknownProjectMessage(selector));
  }
  return project;
}
