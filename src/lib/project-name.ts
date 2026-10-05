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

export class AmbiguousProjectNameError extends Error {
  constructor(name: string) {
    super(
      `Ambiguous project name "${name}". Multiple registrations share this name or alias; use --path and inspect 'hack projects' before renaming or pruning an entry.`
    );
  }
}
