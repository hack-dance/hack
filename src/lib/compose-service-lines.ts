/**
 * Line positions of Compose service keys and `environment` entries, for
 * diagnostics that name a file and line (HACK-2323).
 *
 * This is a deliberately small indentation scanner for block-style YAML, the
 * form `hack init` generates and most hand-written Compose files use. It does
 * not interpret values: callers read semantics from the parsed document and
 * use these positions only to point at a line. Flow-style maps, anchors and
 * merge keys are not followed; an entry the scanner cannot place simply has
 * no line.
 */

/** One `environment` entry of a service, map (`KEY: v`) or list (`- KEY=v`). */
export type ComposeEnvLine = {
  readonly key: string;
  /** 1-based line number. */
  readonly line: number;
  readonly form: "map" | "list";
  /** The raw text after `KEY:` (map) or `KEY=` (list), without a list item's quotes. */
  readonly raw: string;
};

export type ComposeServiceLines = {
  /** 1-based line of the service key. */
  readonly line: number;
  /** 1-based line of each direct service property (`image`, `platform`, ...). */
  readonly keys: ReadonlyMap<string, number>;
  /** The line of `environment:` when it opens a block (no inline value). */
  readonly environmentBlock: number | null;
  /** Indentation of the service's properties. */
  readonly propertyIndent: number | null;
  readonly environment: readonly ComposeEnvLine[];
};

type MutableService = {
  line: number;
  keys: Map<string, number>;
  environmentBlock: number | null;
  propertyIndent: number | null;
  environment: ComposeEnvLine[];
};

const KEY_PATTERN =
  /^(?:"([^"]+)"|'([^']+)'|([^\s"'#:][^:]*?))\s*:(?:\s+(.*))?$/;

/** Splits `key: rest` (quoted or plain key), else null. */
export function splitYamlKey(
  text: string
): { readonly key: string; readonly rest: string } | null {
  const match = KEY_PATTERN.exec(text);
  if (!match) {
    return null;
  }
  const key = match[1] ?? match[2] ?? match[3] ?? "";
  return key ? { key, rest: (match[4] ?? "").trim() } : null;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isSkippable(trimmed: string): boolean {
  return trimmed.length === 0 || trimmed.startsWith("#");
}

function unquoteListItem(text: string): string {
  if (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("'") && text.endsWith("'")))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function envEntry(opts: {
  readonly trimmed: string;
  readonly line: number;
}): ComposeEnvLine | null {
  if (opts.trimmed.startsWith("-")) {
    const item = unquoteListItem(opts.trimmed.slice(1).trim());
    const eq = item.indexOf("=");
    const key = (eq === -1 ? item : item.slice(0, eq)).trim();
    return key
      ? {
          key,
          line: opts.line,
          form: "list",
          raw: eq === -1 ? "" : item.slice(eq + 1),
        }
      : null;
  }
  const split = splitYamlKey(opts.trimmed);
  return split
    ? { key: split.key, line: opts.line, form: "map", raw: split.rest }
    : null;
}

const SERVICES_KEY = /^services\s*:\s*(#.*)?$/;

/** Indentation state while walking the `services:` block. */
class ServiceLineScanner {
  readonly services = new Map<string, MutableService>();
  private inServices = false;
  private serviceIndent: number | null = null;
  private current: MutableService | null = null;
  private currentProperty: string | null = null;
  private envIndent: number | null = null;

  visit(line: string, lineNumber: number): void {
    const trimmed = line.trim();
    if (isSkippable(trimmed)) {
      return;
    }
    const indent = indentOf(line);
    if (indent === 0) {
      this.inServices = SERVICES_KEY.test(trimmed);
      this.serviceIndent = null;
      this.current = null;
      this.currentProperty = null;
      return;
    }
    if (!this.inServices) {
      return;
    }
    this.serviceIndent ??= indent;
    if (indent <= this.serviceIndent) {
      this.openService({ trimmed, indent, lineNumber });
      return;
    }
    if (this.current) {
      this.visitServiceLine({
        service: this.current,
        trimmed,
        indent,
        lineNumber,
      });
    }
  }

  private openService(opts: {
    readonly trimmed: string;
    readonly indent: number;
    readonly lineNumber: number;
  }): void {
    const split =
      opts.indent === this.serviceIndent ? splitYamlKey(opts.trimmed) : null;
    this.current = split
      ? {
          line: opts.lineNumber,
          keys: new Map(),
          environmentBlock: null,
          propertyIndent: null,
          environment: [],
        }
      : null;
    if (split && this.current) {
      this.services.set(split.key, this.current);
    }
    this.currentProperty = null;
  }

  private visitServiceLine(opts: {
    readonly service: MutableService;
    readonly trimmed: string;
    readonly indent: number;
    readonly lineNumber: number;
  }): void {
    const { service, trimmed, indent, lineNumber } = opts;
    service.propertyIndent ??= indent;
    const isProperty =
      indent === service.propertyIndent && !trimmed.startsWith("-");
    if (isProperty) {
      const split = splitYamlKey(trimmed);
      this.currentProperty = split?.key ?? null;
      this.envIndent = null;
      if (split) {
        service.keys.set(split.key, lineNumber);
        if (split.key === "environment" && isBlockOpener(split.rest)) {
          service.environmentBlock = lineNumber;
        }
      }
      return;
    }
    if (
      this.currentProperty !== "environment" ||
      service.environmentBlock === null
    ) {
      return;
    }
    this.envIndent ??= indent;
    if (indent !== this.envIndent) {
      return;
    }
    const entry = envEntry({ trimmed, line: lineNumber });
    if (entry) {
      service.environment.push(entry);
    }
  }
}

/** Service positions under the top-level `services:` key, by service name. */
export function scanComposeServiceLines(
  text: string
): ReadonlyMap<string, ComposeServiceLines> {
  const scanner = new ServiceLineScanner();
  for (const [index, line] of text.split("\n").entries()) {
    scanner.visit(line, index + 1);
  }
  return scanner.services;
}

function isBlockOpener(rest: string): boolean {
  return rest.length === 0 || rest.startsWith("#");
}
