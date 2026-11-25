import { createHash } from "node:crypto";
import { isMap, isScalar, type Node, parseDocument, type YAMLMap } from "yaml";
import { HackCliError } from "./cli-result.ts";
import recipes from "./service-catalog.json";
import { TARGET_SERVICE_PATTERN } from "./target-inspect.ts";

function unsupported(): never {
  throw new HackCliError({
    code: "E_CONFIG_INVALID",
    message:
      "Use block-style Compose mappings without includes or YAML merges before adding a catalog service.",
  });
}

type Splice = {
  readonly start: number;
  readonly end: number;
  readonly insert: string;
};

function diffHunk(
  text: string,
  updated: string,
  oldLines: number,
  newLines: number
) {
  const split = (input: string) => input.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const before = split(text);
  const after = split(updated);
  let first = 0;
  while (first < before.length && before[first] === after[first]) {
    first += 1;
  }
  while (before.length > first && before.at(-1) === after.at(-1)) {
    before.pop();
    after.pop();
  }
  const removed = before.slice(first);
  const added = after.slice(first);
  const lines = (prefix: string, inputs: readonly string[]) =>
    inputs
      .map((line) =>
        line.endsWith("\n")
          ? prefix + line
          : `${prefix}${line}\n\\ No newline at end of file\n`
      )
      .join("");
  return `@@ -${oldLines + first + Number(removed.length > 0)},${removed.length} +${newLines + first + 1},${added.length} @@\n${lines("-", removed)}${lines("+", added)}`;
}

function splicePlan(text: string, edits: readonly Splice[], file: string) {
  const ordered = [...edits].sort((a, b) => a.start - b.start);
  let updated = "";
  let diff = `--- a/${file}\n+++ b/${file}\n`;
  let segment = "";
  let offset = 0;
  let oldStart = 0;
  let oldLines = 0;
  let newLines = 0;
  let previousStart = 0;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const finishSegment = (end: number) => {
    const before = text.slice(oldStart, end);
    const after = segment + text.slice(offset, end);
    diff += diffHunk(before, after, oldLines, newLines);
    updated += after;
    oldLines += before.split("\n").length - 1;
    newLines += after.split("\n").length - 1;
    oldStart = offset = end;
    segment = "";
  };
  for (const edit of ordered) {
    const lineStart = text.lastIndexOf("\n", edit.start - 1) + 1;
    // Separate distant changes so untouched lines stay out of the preview.
    if (segment && offset <= lineStart && previousStart < lineStart) {
      finishSegment(lineStart);
    }
    const newline =
      edit.start === edit.end &&
      !(text.slice(0, edit.start).endsWith("\n") || segment.endsWith("\n"))
        ? eol
        : "";
    segment += text.slice(offset, edit.start) + newline + edit.insert;
    offset = edit.end;
    previousStart = edit.start;
  }
  finishSegment(text.length);
  const revision = createHash("sha256")
    .update(JSON.stringify([file, text, updated]))
    .digest("hex");
  return { updated, diff, revision };
}

function indentation(text: string, offset: number): number {
  return offset - (text.lastIndexOf("\n", offset - 1) + 1);
}

function mappingInsertion(opts: {
  readonly root: YAMLMap;
  readonly key: "services" | "volumes";
  readonly node: Node | undefined;
  readonly text: string;
  readonly eol: string;
}): {
  readonly start: number;
  readonly end: number;
  readonly prefix: string;
  readonly indent: number;
} {
  const { root, key, node, text, eol } = opts;
  const [rootStart = 0, , rootEnd = text.length] = root.range ?? [];
  const rootIndent = indentation(text, rootStart);
  if (node === undefined) {
    return {
      start: rootEnd,
      end: rootEnd,
      prefix: `${" ".repeat(rootIndent)}${key}:${eol}`,
      indent: rootIndent + 2,
    };
  }
  if (
    isScalar(node) &&
    node.value === null &&
    node.source === "" &&
    node.range
  ) {
    const lineEnd = text.indexOf("\n", node.range[0]);
    const end = lineEnd < 0 ? text.length : lineEnd + 1;
    return { start: end, end, prefix: "", indent: rootIndent + 2 };
  }
  if (!(isMap(node) && node.range) || node.has("<<") || node.anchor) {
    unsupported();
  }
  const [start, end, lineEnd] = node.range;
  if (!node.flow) {
    return {
      start: lineEnd,
      end: lineEnd,
      prefix: "",
      indent: indentation(text, start),
    };
  }
  if (node.items.length > 0) {
    unsupported();
  }
  const suffix = text.slice(end, lineEnd);
  return {
    start,
    end: lineEnd,
    prefix: suffix.endsWith("\n") ? suffix : suffix + eol,
    indent: rootIndent + 2,
  };
}

/** Splice source ranges so existing YAML is never serialized or reformatted. */
export function planCatalogEdit(opts: {
  readonly text: string;
  readonly file: string;
  readonly id: string;
  readonly name?: string;
}) {
  const { text, file } = opts;
  const recipe = recipes.find((entry) => entry.name === opts.id);
  if (!recipe) {
    throw new HackCliError({
      code: "E_USAGE",
      message:
        "Unknown catalog ID. Choose redis, postgres, mysql, mongodb, minio, or mailpit.",
    });
  }
  const name = opts.name ?? recipe.name;
  if (!TARGET_SERVICE_PATTERN.test(name) || name.length > 128) {
    throw new HackCliError({
      code: "E_USAGE",
      message:
        "Provide a valid Compose service name (up to 128 letters, digits, dots, underscores or hyphens).",
    });
  }

  const doc = parseDocument(text);
  const root = doc.contents;
  if (
    doc.errors.length > 0 ||
    !isMap(root) ||
    root.flow ||
    root.has("include") ||
    root.has("<<") ||
    !root.range
  ) {
    unsupported();
  }
  const services = root.get("services", true);
  if (isMap(services) && services.has(name)) {
    throw new HackCliError({
      code: "E_PATH_CONFLICT",
      message: `Service "${name}" already exists.`,
    });
  }

  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const insertMapping = (
    key: "services" | "volumes",
    node: Node | undefined,
    lines: readonly string[]
  ): Splice => {
    const { start, end, prefix, indent } = mappingInsertion({
      root,
      key,
      node,
      text,
      eol,
    });
    const rendered = lines.map((line) => " ".repeat(indent) + line).join(eol);
    return { start, end, insert: prefix + rendered + eol };
  };
  const key = name === recipe.name ? name : JSON.stringify(name);
  const body = [`${key}:`, `  image: ${recipe.image}`];
  if (recipe.command) {
    body.push(`  command: ${recipe.command}`);
  }
  if (recipe.env_names.length > 0) {
    body.push(
      "  environment:",
      ...recipe.env_names.map((env) => `    ${env}: null`)
    );
  }
  const mounts = Object.entries(recipe.volumes).map(([suffix, path]) => ({
    name: `${name}-${suffix}`,
    path,
  }));
  const volumes = root.get("volumes", true);
  const edits: Splice[] = [];
  if (mounts.length > 0) {
    body.push(
      "  volumes:",
      ...mounts.map((mount) => `    - ${mount.name}:${mount.path}`)
    );
  }
  edits.push(insertMapping("services", services, body));
  if (mounts.length > 0) {
    if (isMap(volumes) && mounts.some((mount) => volumes.has(mount.name))) {
      throw new HackCliError({
        code: "E_PATH_CONFLICT",
        message:
          "A catalog volume name already exists. Choose a different service name.",
      });
    }
    edits.push(
      insertMapping(
        "volumes",
        volumes,
        mounts.map((mount) => `${mount.name}: {}`)
      )
    );
  }
  const edit = splicePlan(text, edits, file);
  const revised = parseDocument(edit.updated);
  const revisedServices = revised.get("services", true);
  if (
    revised.errors.length > 0 ||
    !(isMap(revisedServices) && revisedServices.has(name))
  ) {
    unsupported();
  }
  return { ...edit, file, service: name, credentials: recipe.env_names };
}
