/**
 * Doc pages that show a checked-in example file mark the code block with an
 * include comment on the line before its opening fence:
 *
 *     <!-- include: examples/configs/web-postgres/.hack/docker-compose.yml -->
 *     ```yaml
 *     ...exact file contents...
 *     ```
 *
 * The block may be indented (for example inside a list item); the fence's
 * indentation is removed from every block line before comparison. The block
 * body must equal the file exactly, apart from the file's final newline.
 *
 * Parsing is line-based and deliberately small: an include comment must be
 * followed immediately by a backtick fence, and the block ends at the first
 * line that is the same fence at the same indentation.
 */

const INCLUDE = /^(\s*)<!-- include: (\S+) -->\s*$/;
const FENCE = /^(\s*)(`{3,})(\S*)\s*$/;

/** One include marker and the code block it governs. */
export type DocInclude = {
  /** Repository-relative path named by the marker. */
  readonly path: string;
  /** 1-based line of the marker comment. */
  readonly line: number;
  /** Block body with the fence indentation removed, or null when malformed. */
  readonly body: string | null;
  /** Index of the opening fence line, or -1 when missing. */
  readonly openIndex: number;
  /** Index of the closing fence line, or -1 when missing. */
  readonly closeIndex: number;
  /** Indentation of the fence. */
  readonly indent: string;
};

/** Find every include marker in a Markdown document. */
export function parseDocIncludes(markdown: string): DocInclude[] {
  const lines = markdown.split("\n");
  const found: DocInclude[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const marker = INCLUDE.exec(lines[index] ?? "");
    if (!marker) {
      continue;
    }
    const path = marker[2] ?? "";
    const open = FENCE.exec(lines[index + 1] ?? "");
    if (!open) {
      found.push({
        path,
        line: index + 1,
        body: null,
        openIndex: -1,
        closeIndex: -1,
        indent: marker[1] ?? "",
      });
      continue;
    }
    const indent = open[1] ?? "";
    const fence = open[2] ?? "```";
    let close = -1;
    for (let cursor = index + 2; cursor < lines.length; cursor += 1) {
      if ((lines[cursor] ?? "") === `${indent}${fence}`) {
        close = cursor;
        break;
      }
    }
    if (close === -1) {
      found.push({
        path,
        line: index + 1,
        body: null,
        openIndex: index + 1,
        closeIndex: -1,
        indent,
      });
      continue;
    }
    const body = lines
      .slice(index + 2, close)
      .map((line) =>
        line.startsWith(indent) ? line.slice(indent.length) : line
      )
      .join("\n");
    found.push({
      path,
      line: index + 1,
      body,
      openIndex: index + 1,
      closeIndex: close,
      indent,
    });
  }
  return found;
}

/** The file text as it should appear in a block: without its final newline. */
export function includeText(fileText: string): string {
  return fileText.endsWith("\n") ? fileText.slice(0, -1) : fileText;
}

/**
 * Compare every include in a document with the named files. `readFile`
 * returns null for a missing file. Returns closed, value-free issue strings.
 */
export async function docIncludeIssues(opts: {
  readonly markdown: string;
  readonly readFile: (path: string) => Promise<string | null>;
}): Promise<string[]> {
  const issues: string[] = [];
  for (const include of parseDocIncludes(opts.markdown)) {
    const where = `line ${include.line} (${include.path})`;
    if (include.body === null) {
      issues.push(`${where}: include-without-code-block`);
      continue;
    }
    const file = await opts.readFile(include.path);
    if (file === null) {
      issues.push(`${where}: include-file-missing`);
      continue;
    }
    if (include.body !== includeText(file)) {
      issues.push(`${where}: include-out-of-date`);
    }
  }
  return issues;
}

/**
 * Rewrite every well-formed include block with the current file contents.
 * Malformed markers and missing files are left unchanged.
 */
export async function refreshDocIncludes(opts: {
  readonly markdown: string;
  readonly readFile: (path: string) => Promise<string | null>;
}): Promise<string> {
  const lines = opts.markdown.split("\n");
  const includes = parseDocIncludes(opts.markdown).reverse();
  for (const include of includes) {
    if (include.body === null) {
      continue;
    }
    const file = await opts.readFile(include.path);
    if (file === null) {
      continue;
    }
    const replacement = includeText(file)
      .split("\n")
      .map((line) => (line.length > 0 ? `${include.indent}${line}` : line));
    lines.splice(
      include.openIndex + 1,
      include.closeIndex - include.openIndex - 1,
      ...replacement
    );
  }
  return lines.join("\n");
}
