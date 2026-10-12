import { existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Offline link contract for the packaged plugin skills.
 *
 * Every markdown file under `<pluginRoot>/skills` is checked:
 * - relative links resolve to an existing file inside the plugin root (no
 *   `../` escape into the repository, no `docs/` path that mirrors repository
 *   docs, no absolute paths);
 * - external URLs appear only under a "Further reading" heading, so core
 *   guidance never depends on the network;
 * - every `skills/<skill>/references/*.md` file is linked from that skill's
 *   SKILL.md.
 *
 * Inline code and fenced blocks are literals (commands, schema ids), not
 * links, and are ignored. Issues carry closed codes and plugin-relative paths.
 */
export type SkillLinkIssueCode =
  | "absolute-link"
  | "escapes-plugin"
  | "repo-docs-link"
  | "missing-target"
  | "external-outside-further-reading"
  | "unlinked-reference"
  | "missing-skill";

export type SkillLinkIssue = {
  readonly file: string;
  readonly code: SkillLinkIssueCode;
};

const FENCED_BLOCK = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]*`/g;
const HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/;
const MARKDOWN_LINK = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s)>\]]+/gi;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const FURTHER_READING = /^further reading$/i;

export async function findSkillLinkIssues(opts: {
  readonly pluginRoot: string;
}): Promise<SkillLinkIssue[]> {
  const issues: SkillLinkIssue[] = [];
  const files: string[] = [];
  for await (const path of new Bun.Glob("skills/**/*.md").scan({
    cwd: opts.pluginRoot,
    onlyFiles: true,
  })) {
    files.push(path);
  }
  files.sort();

  const linkedFromSkill = new Map<string, ReadonlySet<string>>();
  for (const file of files) {
    const absolute = resolve(opts.pluginRoot, file);
    const targets = new Set<string>();
    for (const link of scanLinks(await Bun.file(absolute).text())) {
      const outcome = classifyLink({
        pluginRoot: opts.pluginRoot,
        from: absolute,
        ...link,
      });
      if (outcome.kind === "issue") {
        issues.push({ file, code: outcome.code });
      } else if (outcome.kind === "local") {
        targets.add(outcome.path);
      }
    }
    if (file.endsWith("/SKILL.md")) {
      linkedFromSkill.set(dirname(absolute), targets);
    }
  }

  for (const file of files) {
    const code = referenceLinkIssue({
      pluginRoot: opts.pluginRoot,
      file,
      linkedFromSkill,
    });
    if (code) {
      issues.push({ file, code });
    }
  }
  return issues;
}

type LinkOutcome =
  | { readonly kind: "ignored" }
  | { readonly kind: "local"; readonly path: string }
  | { readonly kind: "issue"; readonly code: SkillLinkIssueCode };

function classifyLink(opts: {
  readonly pluginRoot: string;
  readonly from: string;
  readonly target: string;
  readonly furtherReading: boolean;
}): LinkOutcome {
  if (SCHEME.test(opts.target) || opts.target.startsWith("//")) {
    return opts.furtherReading
      ? { kind: "ignored" }
      : { kind: "issue", code: "external-outside-further-reading" };
  }
  const path = opts.target.split("#")[0]?.split("?")[0] ?? "";
  if (path === "") {
    return { kind: "ignored" };
  }
  if (isAbsolute(path) || path.startsWith("~")) {
    return { kind: "issue", code: "absolute-link" };
  }
  const resolved = resolve(dirname(opts.from), path);
  const inside = relative(opts.pluginRoot, resolved);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    return { kind: "issue", code: "escapes-plugin" };
  }
  if (path.split("/").includes("docs")) {
    return { kind: "issue", code: "repo-docs-link" };
  }
  if (!existsSync(resolved)) {
    return { kind: "issue", code: "missing-target" };
  }
  return { kind: "local", path: resolved };
}

/** A `skills/<skill>/references/<file>.md` must be linked from its SKILL.md. */
function referenceLinkIssue(opts: {
  readonly pluginRoot: string;
  readonly file: string;
  readonly linkedFromSkill: ReadonlyMap<string, ReadonlySet<string>>;
}): SkillLinkIssueCode | null {
  const parts = opts.file.split("/");
  if (parts.length !== 4 || parts[2] !== "references") {
    return null;
  }
  const links = opts.linkedFromSkill.get(
    resolve(opts.pluginRoot, "skills", parts[1] ?? "")
  );
  if (!links) {
    return "missing-skill";
  }
  return links.has(resolve(opts.pluginRoot, opts.file))
    ? null
    : "unlinked-reference";
}

/** Yield link targets and URLs with whether they sit under "Further reading". */
function* scanLinks(
  text: string
): Generator<{ readonly target: string; readonly furtherReading: boolean }> {
  const prose = text
    .replace(FENCED_BLOCK, (block) => block.replace(/[^\n]/g, " "))
    .replace(INLINE_CODE, (code) => " ".repeat(code.length));
  let furtherReading = false;
  for (const line of prose.split("\n")) {
    const heading = HEADING.exec(line);
    if (heading) {
      furtherReading = FURTHER_READING.test(heading[1] ?? "");
      continue;
    }
    const seen = new Set<string>();
    for (const match of line.matchAll(MARKDOWN_LINK)) {
      const target = match[1] ?? "";
      seen.add(target);
      yield { target, furtherReading };
    }
    for (const match of line.matchAll(URL)) {
      if (!seen.has(match[0])) {
        yield { target: match[0], furtherReading };
      }
    }
  }
}
