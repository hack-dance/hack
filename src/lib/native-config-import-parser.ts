import {
  Composer,
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  LineCounter,
  Parser,
} from "yaml";
import { isRecord } from "./guards.ts";

export type ImportDocument =
  | "config"
  | "compose"
  | "primary_local"
  | "checkout_local";
export type ImportField = {
  readonly document: ImportDocument;
  readonly pointer: string;
  readonly line: number;
  readonly column: number;
  readonly status: "exact" | "normalized" | "refused";
  readonly code: string;
  readonly target?: string;
};
export type ParsedImportDocument = {
  readonly value?: Record<string, unknown>;
  readonly fields: readonly ImportField[];
};

export function importPointer(base: string, key: string | number): string {
  return `${base}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

type FieldFactory = (
  pointer: string,
  offset: number,
  code: string
) => ImportField;
type PendingNode = {
  readonly node: unknown;
  readonly pointer: string;
  readonly depth: number;
};

function parseSource(opts: {
  readonly text: string;
  readonly document: ImportDocument;
  readonly lines: LineCounter;
}) {
  const tokens = [...new Parser(opts.lines.addNewLine).parse(opts.text)];
  const directives = tokens.filter((token) => token.type === "directive");
  const composer = new Composer({
    version: "1.2",
    schema: opts.document === "compose" ? "core" : "json",
    compat: opts.document === "compose" ? "yaml-1.1" : null,
    strict: true,
    uniqueKeys: true,
    stringKeys: true,
    merge: false,
    prettyErrors: false,
    logLevel: "silent",
    lineCounter: opts.lines,
  });
  return {
    docs: [...composer.compose(tokens, true, opts.text.length)],
    directives,
  };
}

function children(opts: {
  readonly current: PendingNode;
  readonly fields: ImportField[];
  readonly field: FieldFactory;
}): PendingNode[] | undefined {
  const { node, pointer, depth } = opts.current;
  const pending: PendingNode[] = [];
  if (isMap(node)) {
    for (const pair of node.items) {
      if (
        !(isScalar(pair.key) && typeof pair.key.value === "string") ||
        pair.key.anchor ||
        pair.key.tag
      ) {
        opts.fields.push(
          opts.field(pointer, node.range?.[0] ?? 0, "invalid_key")
        );
        return undefined;
      }
      const child = importPointer(pointer, pair.key.value);
      opts.fields.push(
        opts.field(child, pair.key.range?.[0] ?? 0, "unsupported_field")
      );
      pending.push({ node: pair.value, pointer: child, depth: depth + 1 });
    }
  } else if (isSeq(node)) {
    for (const [index, entry] of node.items.entries()) {
      const child = importPointer(pointer, index);
      opts.fields.push(
        opts.field(
          child,
          isNode(entry) ? (entry.range?.[0] ?? 0) : 0,
          "unsupported_field"
        )
      );
      pending.push({ node: entry, pointer: child, depth: depth + 1 });
    }
  }
  return pending;
}

function inspectAst(
  contents: unknown,
  field: FieldFactory
): { readonly fields: ImportField[]; readonly safe: boolean } {
  const fields: ImportField[] = [];
  const pending: PendingNode[] = [{ node: contents, pointer: "", depth: 0 }];
  let nodes = 0;
  let safe = true;
  while (pending.length) {
    const current = pending.pop();
    if (!current) {
      break;
    }
    nodes++;
    if (nodes > 20_000 || current.depth > 48) {
      return { safe: false, fields: [field("", 0, "input_budget")] };
    }
    const { node, pointer } = current;
    if (!isNode(node)) {
      continue;
    }
    if (isAlias(node) || node.anchor || node.tag) {
      safe = false;
      fields.push(
        field(pointer, node.range?.[0] ?? 0, "unsupported_yaml_reference")
      );
      continue;
    }
    const nested = children({ current, fields, field });
    if (!nested) {
      safe = false;
      continue;
    }
    pending.push(...nested);
    if (
      isScalar(node) &&
      typeof node.value === "number" &&
      !Number.isFinite(node.value)
    ) {
      safe = false;
      fields.push(field(pointer, node.range?.[0] ?? 0, "invalid_scalar"));
    }
  }
  return { fields, safe };
}

/** Maintained AST parser owns syntax and decoded-key uniqueness; diagnostics omit excerpts. */
export function parseImportDocument(opts: {
  readonly text: string;
  readonly document: ImportDocument;
}): ParsedImportDocument {
  const lines = new LineCounter();
  const field: FieldFactory = (pointer, offset, code) => {
    const { line, col } = lines.linePos(offset);
    return {
      document: opts.document,
      pointer,
      line,
      column: col,
      status: "refused",
      code,
    };
  };
  try {
    if (Buffer.byteLength(opts.text) > 1024 * 1024) {
      return { fields: [field("", 0, "input_budget")] };
    }
    // JSON.parse owns strict JSON syntax; the AST catches decoded equivalent keys.
    if (opts.document !== "compose") {
      JSON.parse(opts.text);
    }
    const { docs, directives } = parseSource({ ...opts, lines });
    // Directive tokens preserve explicit default/rebound tag handles that the AST
    // merges into its defaults. Never infer directive absence from that merged map.
    if (directives.length) {
      return {
        fields: directives.map((token) =>
          field("", token.offset, "unsupported_yaml_directive")
        ),
      };
    }
    // Silent parseDocument suppresses MULTIPLE_DOCS; own the document-count fence.
    const doc = docs[0];
    if (docs.length !== 1 || !doc) {
      return { fields: [field("", 0, "invalid_document_count")] };
    }
    if (doc.errors.length || doc.warnings.length) {
      return {
        fields: [...doc.errors, ...doc.warnings].map((error) =>
          field(
            "",
            error.pos[0],
            error.code === "DUPLICATE_KEY" ? "duplicate_key" : "invalid_syntax"
          )
        ),
      };
    }
    const { fields, safe } = inspectAst(doc.contents, field);
    if (!safe) {
      return { fields };
    }
    const value: unknown =
      opts.document !== "compose"
        ? JSON.parse(opts.text)
        : doc.toJS({ maxAliasCount: 0 });
    return isRecord(value)
      ? { value, fields }
      : { fields: [field("", 0, "invalid_root")] };
  } catch {
    return { fields: [field("", 0, "invalid_syntax")] };
  }
}
