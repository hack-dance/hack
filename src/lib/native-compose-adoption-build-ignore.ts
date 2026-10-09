import createDockerignore from "@balena/dockerignore";

const LITERAL = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const LINES = /\r?\n/;
const MAX_RULES = 128;
const MAX_IGNORE_BYTES = 16 * 1024;

function refuse(): never {
  throw new Error(
    "Legacy retained build ignore mapping is unsupported; values omitted."
  );
}

/**
 * Deliberately closed Dockerignore grammar. The pinned Moby port owns matching;
 * qualification is limited to literal paths, their parent matches and bare **.
 * Other globs, escapes, whitespace paths and normalization ambiguities refuse.
 */
export function legacyComposeBuildIgnore(text: string) {
  if (Buffer.byteLength(text) > MAX_IGNORE_BYTES || text.includes("\uFEFF")) {
    refuse();
  }
  const rules: string[] = [];
  const literals: string[] = [];
  for (const raw of text.split(LINES)) {
    if (raw.startsWith("#") || !raw.trim()) {
      continue;
    }
    const rule = raw.trim();
    const literal = rule.startsWith("!") ? rule.slice(1) : rule;
    if (
      (rule !== "**" &&
        (!LITERAL.test(literal) ||
          literal.split("/").some((part) => part === "." || part === ".."))) ||
      rules.length >= MAX_RULES
    ) {
      refuse();
    }
    rules.push(rule);
    if (rule !== "**") {
      literals.push(literal);
    }
  }
  const matcher = createDockerignore({ ignorecase: false }).add(rules);
  // This name denotes the unmatched child region, rather than a filesystem
  // object. It cannot coincide with any admitted literal rule component.
  let unmatched = "__hack_build_unmatched__";
  const components = new Set(literals.flatMap((path) => path.split("/")));
  while (components.has(unmatched)) {
    unmatched += "_";
  }
  function excluded(path: string) {
    return matcher.ignores(path);
  }
  function subtreeExcluded(path: string) {
    const regions = new Set([path, `${path}/${unmatched}`]);
    for (const literal of literals) {
      if (literal.startsWith(`${path}/`)) {
        regions.add(literal);
        regions.add(`${literal}/${unmatched}`);
      }
    }
    // With this grammar, matching changes only at a literal prefix boundary.
    // Its own node and unmatched-child region cover every descendant decision.
    return [...regions].every(excluded);
  }
  return Object.freeze({ excluded, subtreeExcluded });
}
