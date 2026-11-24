import { type Node, type ParseError, parseTree } from "jsonc-parser";
import {
  isAlias,
  isMap,
  isPair,
  isScalar,
  isSeq,
  parseDocument,
  visit,
} from "yaml";
import { isRecord } from "./guards.ts";
import {
  normalizeEnvConfigName,
  readAuthoredProjectOverlaySettings,
} from "./project.ts";

const SECRET_KEY =
  /(?:access[_-]?key|auth(?:orization)?|credential|pass(?:word|phrase|wd)?\b|secret|secure|token|private[_-]?key|api[_-]?key|(?:^|[_-])pat(?:$|[_-]))/i;
const SECRET_TEXT =
  /(?:(?<![a-z\d+.-])[a-z][a-z\d+.-]*:\/\/[^\s/?#@]+@|[?&](?:token|key|secret|password|signature)=|-----BEGIN [^-]+PRIVATE KEY-----|\bauthorization(?:\s*:\s*|\s+)(?:bearer|basic)\s+\S)/i;
const PROVIDER_CREDENTIAL =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{30,}|AGE-SECRET-KEY-[A-Z0-9]{20,})\b/;
const PRIVATE_COMPOSE_FIELDS = /^(?:command|entrypoint|args|secrets|test)$/;
const CADDY_HEADER =
  /^caddy(?:[._].*)?[._](?:header_up|header_down|header|request_header)(?:[._]|$)/i;
const PRIVATE_COMMENT =
  /(?:authorization|credential|password|secret|token|api[_-]?key)\s*[:=]/i;

export function isConfigSecret(key: string, value: unknown): boolean {
  return (
    SECRET_KEY.test(key) ||
    (typeof value === "string" &&
      (SECRET_TEXT.test(value) || PROVIDER_CREDENTIAL.test(value)))
  );
}

export function redactConfigPath(path: readonly string[]): string[] {
  return path.map((part) => (isConfigSecret("", part) ? "[redacted]" : part));
}

export function privateProjectOverlayNames(
  project: Record<string, unknown>
): ReadonlySet<string> {
  const { current, legacy } = readAuthoredProjectOverlaySettings(project);
  return new Set(
    [...current, ...legacy]
      .filter(
        (value): value is string =>
          value !== undefined && isConfigSecret("", value)
      )
      .map(normalizeEnvConfigName)
      .filter((name) => name !== null)
  );
}

export function isPrivateOverlayValue(
  value: unknown,
  names: ReadonlySet<string>
): boolean {
  if (names.size === 0 || typeof value !== "string") {
    return false;
  }
  const name = normalizeEnvConfigName(value);
  return name !== null && names.has(name);
}

/** A project must retain the redaction source for any surviving private value. */
export function hasPrivateOverlayValue(
  project: Record<string, unknown>,
  names: ReadonlySet<string>
): boolean {
  const pending = Object.values(project);
  while (pending.length > 0) {
    const value = pending.pop();
    if (isPrivateOverlayValue(value, names)) {
      return true;
    }
    if (isRecord(value) || Array.isArray(value)) {
      for (const child of Object.values(value)) {
        pending.push(child);
      }
    }
  }
  return false;
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
  const duplicate =
    root && errors.length === 0 ? duplicateJsonProperty(root) : undefined;
  return {
    root,
    error: errors[0],
    duplicate,
    ok:
      root?.type === "object" && errors.length === 0 && duplicate === undefined,
  };
}

export function jsonConfigDiagnostic(text: string) {
  const tree = jsonConfigTree(text);
  return tree.ok
    ? null
    : {
        line: configLine(
          text,
          tree.duplicate?.offset ?? tree.error?.offset ?? 0
        ),
        message: tree.duplicate
          ? "Each JSON field must appear once."
          : "Expected a valid JSON object.",
      };
}

function duplicateJsonProperty(root: Node): Node | undefined {
  const stack = [root];
  for (let node = stack.pop(); node; node = stack.pop()) {
    const children = node.children ?? [];
    if (node.type === "object") {
      const keys = new Set<string>();
      for (const child of children) {
        const key = child.children?.[0];
        if (key && typeof key.value === "string") {
          if (keys.has(key.value)) {
            return key;
          }
          keys.add(key.value);
        }
      }
    }
    for (const child of children) {
      stack.push(child);
    }
  }
  return undefined;
}
type SourcePath = readonly (string | number)[];
type Range = {
  readonly start: number;
  readonly length: number;
  readonly path: SourcePath;
};

const PRIVATE_SLOT = /"\[redacted:\d+\]"/;

function sourceSlots(text: string, ranges: readonly Range[]) {
  return ranges
    .toSorted((left, right) => left.start - right.start)
    .map(({ start, length, path }, index) => {
      const value = text.slice(start, start + length);
      const lineBreaks = value.match(/\r?\n/g)?.join("") ?? "";
      return {
        start,
        length,
        path,
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

function privateProjectCommand(path: SourcePath): boolean {
  return (
    path[0] === "startup" ||
    (path[0] === "lifecycle" && path.length > 1 && path[1] !== "runner")
  );
}

function jsonSecretRanges(
  node: Node,
  path: SourcePath,
  ranges: Range[],
  privateOverlays: ReadonlySet<string>
): boolean {
  const key = path.at(-1);
  if (isConfigSecret("", key)) {
    return true;
  }
  if (
    (typeof key === "string" && secretProperty(key)) ||
    (node.type === "string" &&
      (privateProjectCommand(path) ||
        isConfigSecret("", node.value) ||
        isPrivateOverlayValue(node.value, privateOverlays)))
  ) {
    ranges.push({ start: node.offset, length: node.length, path });
    return false;
  }
  let hasPrivateKey = false;
  (node.children ?? []).forEach((child, index) => {
    if (child.type === "property") {
      const [property, value] = child.children ?? [];
      if (value && typeof property?.value === "string") {
        hasPrivateKey =
          jsonSecretRanges(
            value,
            [...path, property.value],
            ranges,
            privateOverlays
          ) || hasPrivateKey;
      }
    } else {
      hasPrivateKey =
        jsonSecretRanges(child, [...path, index], ranges, privateOverlays) ||
        hasPrivateKey;
    }
  });
  return hasPrivateKey;
}

function jsonRedactions(text: string) {
  const tree = jsonConfigTree(text);
  if (!(tree.ok && tree.root)) {
    return null;
  }
  const ranges: Range[] = [];
  const project: unknown = JSON.parse(text);
  const privateOverlays = isRecord(project)
    ? privateProjectOverlayNames(project)
    : new Set<string>();
  const hasPrivateKey = jsonSecretRanges(
    tree.root,
    [],
    ranges,
    privateOverlays
  );
  return { ranges, hasPrivateKey };
}

function jsonRanges(text: string): Range[] | null {
  const redactions = jsonRedactions(text);
  return redactions && !redactions.hasPrivateKey ? redactions.ranges : null;
}

/** Keep ordinary fields available when an unsafe key hides the Source preview. */
export function safeJsonProject(text: string): Record<string, unknown> | null {
  const redactions = jsonRedactions(text);
  if (!redactions) {
    return null;
  }
  const project: unknown = JSON.parse(
    redact(text, redactions.ranges),
    (key, value: unknown) => (isConfigSecret("", key) ? undefined : value)
  );
  return isRecord(project) ? project : null;
}

/** Location-preserving redaction. Invalid source is kept out of the JSON contract. */
export function safeJsonSource(text: string) {
  const ranges = jsonRanges(text);
  return ranges
    ? { source: redact(text, ranges), hidden: ranges.length > 0 }
    : { source: null, hidden: true };
}

function yamlPath(parents: readonly unknown[], key: unknown): SourcePath {
  const path: (string | number)[] = [];
  parents.forEach((parent, index) => {
    const child = parents[index + 1];
    if (isPair(parent) && isScalar(parent.key)) {
      path.push(String(parent.key.value));
    } else if (isSeq(parent)) {
      const position = child === undefined ? key : parent.items.indexOf(child);
      if (typeof position === "number") {
        path.push(position);
      }
    }
  });
  return path;
}

function yamlSecretRanges(
  text: string,
  compose: boolean,
  privateKeys: ReadonlySet<string>
): Range[] | null {
  const doc = parseDocument(text, { prettyErrors: false });
  if (doc.errors.length > 0 || privateYamlComment(doc)) {
    return null;
  }
  const ranges: Range[] = [];
  let aliases = false;
  let hiddenSource = false;
  // Check even nodes underneath a private parent which the masking pass skips.
  visit(doc, (index, node) => {
    if (isAlias(node)) {
      aliases = true;
    }
    if (
      (index === "key" && isScalar(node) && isConfigSecret("", node.value)) ||
      ((isAlias(node) || isMap(node) || isScalar(node) || isSeq(node)) &&
        privateYamlComment(node))
    ) {
      hiddenSource = true;
      return visit.BREAK;
    }
  });
  if (hiddenSource) {
    return null;
  }
  visit(doc, {
    Pair(index, pair, parents) {
      const key =
        isScalar(pair.key) && typeof pair.key.value === "string"
          ? pair.key.value
          : "";
      const node = pair.value;
      if (
        !(
          privateKeys.has(key) ||
          secretProperty(key) ||
          (compose &&
            (PRIVATE_COMPOSE_FIELDS.test(key) || CADDY_HEADER.test(key)))
        )
      ) {
        return;
      }
      if (isMap(node) || isSeq(node) || isScalar(node) || isAlias(node)) {
        const range = node.range;
        if (range && range[0] < range[1]) {
          ranges.push({
            start: range[0],
            length: range[1] - range[0],
            path: [...yamlPath(parents, index), key],
          });
          return visit.SKIP;
        }
      }
    },
    Scalar(index, node, parents) {
      const value: unknown = node.value;
      if (typeof value !== "string" || !node.range || index === "key") {
        return;
      }
      const separator = value.indexOf("=");
      const key = separator > 0 ? value.slice(0, separator) : "";
      const assignment =
        key !== "" &&
        (secretProperty(key) || (compose && CADDY_HEADER.test(key)));
      if (assignment || isConfigSecret("", value)) {
        ranges.push({
          start: node.range[0],
          length: node.range[1] - node.range[0],
          path: yamlPath(parents, index),
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
  if (!ranges) {
    return { source: null, hidden: true };
  }
  return { source: redact(text, ranges), hidden: ranges.length > 0 };
}

function privateYamlComment(node: {
  readonly comment?: string | null;
  readonly commentBefore?: string | null;
}): boolean {
  return [node.comment, node.commentBefore].some(
    (comment) =>
      typeof comment === "string" &&
      (PRIVATE_COMMENT.test(comment) || isConfigSecret("", comment))
  );
}

/**
 * Keep private source text on disk and in the CLI. An editor gets numbered
 * slots. A save restores the original bytes, then re-runs the masking parser
 * to prove the same slots are still private, at the same paths and in order.
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
      : (text: string) => yamlSecretRanges(text, true, new Set());
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
  if (
    !next ||
    redact(output, next) !== opts.draft ||
    sourceSlots(output, next).some(
      (slot, index) =>
        JSON.stringify(slot.path) !== JSON.stringify(slots[index]?.path)
    )
  ) {
    return null;
  }
  return output;
}
