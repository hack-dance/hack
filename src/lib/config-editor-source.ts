import { type Node, type ParseError, parseTree } from "jsonc-parser";
import { isAlias, isMap, isScalar, isSeq, parseDocument, visit } from "yaml";

const SECRET_KEY =
  /(?:access[_-]?key|auth(?:orization)?|credential|pass(?:word|phrase|wd)?\b|secret|secure|token|private[_-]?key|api[_-]?key)/i;
const SECRET_TEXT =
  /(?:[a-z][a-z\d+.-]*:\/\/[^\s/@]+:[^\s/@]+@|[?&](?:token|key|secret|password|signature)=|-----BEGIN [^-]+PRIVATE KEY-----)/i;
const PRIVATE_COMPOSE_FIELDS = /^(?:command|entrypoint|args|secrets|test)$/;
const PRIVATE_COMMENT =
  /(?:#|\/\/).*?(?:credential|password|secret|token|api[_-]?key)\s*[:=]/i;

export function isConfigSecret(key: string, value: unknown): boolean {
  return (
    SECRET_KEY.test(key) ||
    (typeof value === "string" && SECRET_TEXT.test(value))
  );
}

function secretProperty(key: string): boolean {
  // OAuth routing configuration is an object of public settings.
  return (
    key !== "oauth" &&
    key !== "secretsprovider" &&
    key !== "secretsProvider" &&
    isConfigSecret(key, null)
  );
}

export function configLine(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

export function jsonConfigTree(text: string) {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { disallowComments: true });
  return {
    root,
    error: errors[0],
    ok: root?.type === "object" && errors.length === 0,
  };
}

type Range = { readonly start: number; readonly length: number };

const PRIVATE_SLOT = /"\[redacted:\d+\]"/;

function sourceSlots(text: string, ranges: readonly Range[]) {
  return ranges
    .toSorted((left, right) => left.start - right.start)
    .map(({ start, length }, index) => {
      const value = text.slice(start, start + length);
      const lineBreaks = value.match(/\r?\n/g)?.join("") ?? "";
      return {
        start,
        length,
        value,
        marker: `"[redacted:${index + 1}]"${lineBreaks}`,
      };
    });
}

function redact(text: string, ranges: readonly Range[]) {
  let output = text;
  const slots = sourceSlots(text, ranges);
  for (const { start, length, marker } of slots.toReversed()) {
    output = `${output.slice(0, start)}${marker}${output.slice(start + length)}`;
  }
  return output;
}

function jsonSecretRanges(node: Node, ranges: Range[]): void {
  if (node.type === "property") {
    const [key, child] = node.children ?? [];
    if (child && typeof key?.value === "string" && secretProperty(key.value)) {
      ranges.push({ start: child.offset, length: child.length });
      return;
    }
  } else if (node.type === "string" && isConfigSecret("", node.value)) {
    ranges.push({ start: node.offset, length: node.length });
    return;
  }
  for (const child of node.children ?? []) {
    jsonSecretRanges(child, ranges);
  }
}

/** Location-preserving redaction. Invalid source is kept out of the JSON contract. */
function jsonRanges(text: string): Range[] | null {
  const tree = jsonConfigTree(text);
  if (!(tree.ok && tree.root)) {
    return null;
  }
  const ranges: Range[] = [];
  jsonSecretRanges(tree.root, ranges);
  return ranges;
}

export function safeJsonSource(text: string) {
  const ranges = jsonRanges(text);
  return ranges
    ? { source: redact(text, ranges), hidden: ranges.length > 0 }
    : { source: null, hidden: true };
}

function yamlSecretRanges(
  text: string,
  compose: boolean,
  privateKeys: ReadonlySet<string>
): Range[] | null {
  const doc = parseDocument(text, { prettyErrors: false });
  if (doc.errors.length > 0) {
    return null;
  }
  const ranges: Range[] = [];
  let aliases = false;
  visit(doc, {
    Alias() {
      aliases = true;
    },
    Pair(_, pair) {
      const key =
        isScalar(pair.key) && typeof pair.key.value === "string"
          ? pair.key.value
          : "";
      const node = pair.value;
      if (
        !(
          privateKeys.has(key) ||
          secretProperty(key) ||
          (compose && PRIVATE_COMPOSE_FIELDS.test(key))
        )
      ) {
        return;
      }
      if (isAlias(node)) {
        aliases = true;
      }
      if (isMap(node) || isSeq(node) || isScalar(node) || isAlias(node)) {
        const range = node.range;
        if (range) {
          ranges.push({ start: range[0], length: range[1] - range[0] });
          return visit.SKIP;
        }
      }
    },
    Scalar(_, node) {
      const value: unknown = node.value;
      if (typeof value !== "string" || !node.range) {
        return;
      }
      const separator = value.indexOf("=");
      const assignment =
        separator > 0 && secretProperty(value.slice(0, separator));
      if (assignment || isConfigSecret("", value)) {
        ranges.push({
          start: node.range[0],
          length: node.range[1] - node.range[0],
        });
      }
    },
  });
  // An alias can point at a secret in an otherwise unrelated part of a file.
  return aliases && ranges.length > 0 ? null : ranges;
}

export function safeYamlSource(
  text: string,
  compose: boolean,
  privateKeys: ReadonlySet<string> = new Set()
) {
  const ranges = yamlSecretRanges(text, compose, privateKeys);
  if (!ranges || PRIVATE_COMMENT.test(text)) {
    return { source: null, hidden: true };
  }
  return { source: redact(text, ranges), hidden: ranges.length > 0 };
}

/**
 * Keep private source text on disk and in the CLI. An editor gets numbered
 * slots. A save restores the original bytes, then re-runs the masking parser
 * to prove the same slots are still private and in the same order.
 */
export function restoreConfigSource(opts: {
  readonly original: string;
  readonly draft: string;
  readonly format: "json" | "yaml";
}): string | null {
  if (PRIVATE_SLOT.test(opts.original)) {
    return null;
  }
  const rangesFor =
    opts.format === "json"
      ? jsonRanges
      : (text: string) =>
          PRIVATE_COMMENT.test(text)
            ? null
            : yamlSecretRanges(text, true, new Set());
  const ranges = rangesFor(opts.original);
  if (!ranges) {
    return null;
  }
  const slots = sourceSlots(opts.original, ranges);
  let input = opts.draft;
  let output = "";
  for (const { marker, value } of slots) {
    const index = input.indexOf(marker);
    if (index < 0) {
      return null;
    }
    output += input.slice(0, index) + value;
    input = input.slice(index + marker.length);
  }
  if (PRIVATE_SLOT.test(input) || PRIVATE_SLOT.test(output)) {
    return null;
  }
  output += input;
  const next = rangesFor(output);
  if (!next || redact(output, next) !== opts.draft) {
    return null;
  }
  return output;
}
