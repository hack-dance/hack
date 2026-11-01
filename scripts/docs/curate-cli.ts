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
  "## Experimental (unsupported)",
  "## Internal",
  "## Fun",
  "## Extensions",
]);

/** Compatibility commands excluded from the default tutorial selection. */
export const agentCompatibilityCommands = new Set([
  "mcp install",
  "setup cursor",
  "setup claude",
  "setup codex",
  "setup agents",
  "setup sync",
  "setup mcp",
  "agent prime",
]);

/** Publish the declared public slice while retaining the hashed source intact. */
export function curateCliReference(
  markdown: string,
  options: { readonly version: "v4" | "v5" }
): string {
  const result: string[] = [];
  let excludedGroup = false;
  let omit = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("## ")) {
      const command = /^## `hack(?: ([a-z-]+))?/.exec(line);
      if (command) {
        const path = /^## `hack ([^`]+)`/.exec(line)?.[1] ?? "";
        omit =
          excludedGroup ||
          excludedRoots.has(command[1] ?? "") ||
          (options.version === "v5" && agentCompatibilityCommands.has(path));
      } else {
        excludedGroup = excludedGroups.has(line);
        omit = excludedGroup;
      }
    }
    const child = /^\| `hack ([^`]+)` \|/.exec(line)?.[1];
    if (
      options.version === "v5" &&
      ((child !== undefined && agentCompatibilityCommands.has(child)) ||
        line.startsWith("| `--with "))
    ) {
      continue;
    }
    if (
      !omit &&
      line !== "hack — Local development without the port-collision tax"
    ) {
      result.push(
        options.version === "v5" &&
          line === "Install integrations for coding agents"
          ? "Optional workspace setup; retiring agent exports are excluded from this selection"
          : line
      );
    }
  }
  return result.join("\n");
}
