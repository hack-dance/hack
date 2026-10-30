/** Search results must stay on the selected version's index or descendants. */
export function isVersionedSearchUrl(
  value: unknown,
  version: "v4" | "v5"
): boolean {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  ) {
    return false;
  }
  const parsed = new URL(value, "https://hack.foo");
  if (parsed.origin !== "https://hack.foo") return false;
  const path = parsed.pathname;
  const root = `/docs/${version}`;
  return path === root || path.startsWith(`${root}/`);
}
