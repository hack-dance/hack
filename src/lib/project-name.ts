/**
 * Canonical registry/CLI selector key. Legacy underscore, space and slash names
 * remain aliases of the same slug. Invalid selectors must never select a project
 * through a fallback name; generated display/runtime slugs own their own fallback.
 */
export function normalizeProjectName(input: string): string | null {
  const name = input
    .trim()
    .toLowerCase()
    .replaceAll("_", "-")
    .replaceAll(" ", "-")
    .replaceAll("/", "-")
    .replaceAll(/[^a-z0-9-]/g, "")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "");
  return name.length > 0 ? name : null;
}

/** A canonical project name: the fixed point of `normalizeProjectName`. */
export const PROJECT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * A project selector a user may type: a canonical name or a legacy alias
 * spelling (ASCII letters, digits, `-`, `_`, space and `/`). Anything else,
 * including any argument containing `=`, may be a pasted value and must be
 * refused with text that does not include it.
 */
export const PROJECT_SELECTOR_PATTERN = /^[A-Za-z0-9_ /-]+$/;

export class AmbiguousProjectNameError extends Error {
  constructor(name: string) {
    super(
      `Ambiguous project name "${name}". Multiple registrations share this name or alias; use --path and inspect 'hack projects' before renaming or pruning an entry.`
    );
  }
}
