import { HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";

/** Interpolation key Compose reserves for the project name. */
export const COMPOSE_PROJECT_NAME_VARIABLE = "COMPOSE_PROJECT_NAME";

/** Compose's project-name rule, which `docker compose -p` enforces. */
const COMPOSE_PROJECT_NAME = /^[a-z0-9][a-z0-9_-]*$/;
const NAME_BYTE = /[A-Za-z0-9_]/;

/**
 * Whether one Compose string references `COMPOSE_PROJECT_NAME`, including inside
 * a default such as `${A:-${COMPOSE_PROJECT_NAME}}`. `$$` is Compose's literal
 * escape. This mirrors native review's reference lexer; native review stays the
 * authority, so a miss here only leaves the name unbound and execution refuses.
 */
function textReferences(text: string): boolean {
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "$") {
      index += 1;
      continue;
    }
    index += 1;
    if (text[index] === "$") {
      index += 1;
      continue;
    }
    if (text[index] === "{") {
      index += 1;
    }
    const start = index;
    while (index < text.length && NAME_BYTE.test(text[index] ?? "")) {
      index += 1;
    }
    if (text.slice(start, index) === COMPOSE_PROJECT_NAME_VARIABLE) {
      return true;
    }
  }
  return false;
}

/** Whether any service string value references `COMPOSE_PROJECT_NAME`. */
export function referencesComposeProjectName(value: unknown): boolean {
  if (typeof value === "string") {
    return textReferences(value);
  }
  if (Array.isArray(value)) {
    return value.some(referencesComposeProjectName);
  }
  if (isRecord(value)) {
    return Object.values(value).some(referencesComposeProjectName);
  }
  return false;
}

/**
 * Declare the instance's Compose project name as the document's top-level
 * `name`, as `docker compose -p` does for the Compose backend, when a service
 * references `COMPOSE_PROJECT_NAME`. Native review then binds the variable to
 * that name and gives each service its Compose container name
 * (`<name>-<service>-1`) as a network alias. Documents without the reference
 * are left untouched, so their normalized bytes and retained graphs stay
 * identical. Mutates and returns whether the document changed.
 */
export function declareNativeComposeProjectName(opts: {
  readonly compose: Record<string, unknown>;
  /** `<project>` for the base instance, `<project>--<branch>` for a branch. */
  readonly composeProject: string;
}): boolean {
  if (!referencesComposeProjectName(opts.compose.services)) {
    return false;
  }
  if (!COMPOSE_PROJECT_NAME.test(opts.composeProject)) {
    throw new HackCliError({
      code: "E_NATIVE_PROJECT_UNSUPPORTED",
      message:
        "COMPOSE_PROJECT_NAME requires a Compose project name of lowercase letters, digits, '-' or '_' that starts with a letter or digit; no graph was started.",
    });
  }
  opts.compose.name = opts.composeProject;
  return true;
}
