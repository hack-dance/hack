import { createHash } from "node:crypto";
import { isMap, isScalar, type Node, parseDocument, type YAMLMap } from "yaml";
import { HackCliError } from "./cli-result.ts";
import recipes from "./service-catalog.json";
import { TARGET_SERVICE_PATTERN } from "./target-inspect.ts";

function unsupported(): never {
  throw new HackCliError({
    code: "E_CONFIG_INVALID",
    message:
      "Use a block-style Compose services mapping without includes or YAML merges before adding a catalog service.",
  });
}

function splicePlan(
  text: string,
  offset: number,
  end: number,
  insertion: string,
  file: string
) {
  const updated = text.slice(0, offset) + insertion + text.slice(end);
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
  const diff = `--- a/${file}\n+++ b/${file}\n@@ -${first + Number(removed.length > 0)},${removed.length} +${first + 1},${added.length} @@\n${lines("-", removed)}${lines("+", added)}`;
  const revision = createHash("sha256")
    .update(JSON.stringify([file, text, updated]))
    .digest("hex");
  return { updated, diff, revision };
}

function indentation(text: string, offset: number): number {
  return offset - (text.lastIndexOf("\n", offset - 1) + 1);
}

function serviceInsertion(opts: {
  readonly root: YAMLMap;
  readonly services: Node | undefined;
  readonly text: string;
  readonly eol: string;
}): {
  readonly start: number;
  readonly end: number;
  readonly prefix: string;
  readonly indent: number;
} {
  const { root, services, text, eol } = opts;
  const [rootStart = 0, , rootEnd = text.length] = root.range ?? [];
  const rootIndent = indentation(text, rootStart);
  if (services === undefined) {
    return {
      start: rootEnd,
      end: rootEnd,
      prefix: `${" ".repeat(rootIndent)}services:${eol}`,
      indent: rootIndent + 2,
    };
  }
  if (
    isScalar(services) &&
    services.value === null &&
    services.source === "" &&
    services.range
  ) {
    const lineEnd = text.indexOf("\n", services.range[0]);
    const end = lineEnd < 0 ? text.length : lineEnd + 1;
    return { start: end, end, prefix: "", indent: rootIndent + 2 };
  }
  if (
    !(isMap(services) && services.range) ||
    services.has("<<") ||
    services.anchor
  ) {
    unsupported();
  }
  const [start, end, lineEnd] = services.range;
  if (!services.flow) {
    return {
      start: lineEnd,
      end: lineEnd,
      prefix: "",
      indent: indentation(text, start),
    };
  }
  if (services.items.length > 0) {
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
  const { start, end, prefix, indent } = serviceInsertion({
    root,
    services,
    text,
    eol,
  });
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
  const snippet = body.map((line) => " ".repeat(indent) + line).join(eol) + eol;
  const newline =
    start === end && !text.slice(0, start).endsWith("\n") ? eol : "";
  const edit = splicePlan(text, start, end, newline + prefix + snippet, file);
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
