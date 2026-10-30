const excludedRoots = new Set([
  "gateway",
  "node",
  "remote",
  "dispatch",
  "internal",
  "the",
  "ssh",
  "x",
]);
const excludedGroups = new Set([
  "## Beta",
  "## Internal",
  "## Fun",
  "## Extensions",
]);

/** Publish the declared public slice while retaining the hashed source intact. */
export function curateCliReference(markdown: string): string {
  const result: string[] = [];
  let excludedGroup = false;
  let omit = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("## ")) {
      const command = /^## `hack(?: ([a-z-]+))?/.exec(line);
      if (command) {
        omit = excludedGroup || excludedRoots.has(command[1] ?? "");
      } else {
        excludedGroup = excludedGroups.has(line);
        omit = excludedGroup;
      }
    }
    if (
      !omit &&
      line !== "hack — Local development without the port-collision tax"
    ) {
      result.push(line);
    }
  }
  return result.join("\n");
}
