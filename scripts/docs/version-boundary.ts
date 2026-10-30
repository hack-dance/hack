/** Search results must stay on the selected version's index or descendants. */
export function isVersionedSearchUrl(
  value: unknown,
  version: "v4" | "v5"
): boolean {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//")
  ) {
    return false;
  }
  const path = new URL(value, "https://hack.foo").pathname;
  const root = `/docs/${version}`;
  return path === root || path.startsWith(`${root}/`);
}
