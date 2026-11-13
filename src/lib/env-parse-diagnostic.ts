import { type ParseError, parse } from "jsonc-parser";
import { parseDocument } from "yaml";

/**
 * Parser messages may quote secret input. Return only a fixed error kind and
 * coordinates from structured offsets. Bun's line/column describe the JS call
 * site, not the env file; diagnose the rejected input separately instead.
 */
export function envParseDiagnostic(opts: {
  readonly format: "YAML" | "JSON";
  readonly text: string;
}): string {
  let offset: number | undefined;
  if (opts.format === "JSON") {
    const errors: ParseError[] = [];
    parse(opts.text, errors, {
      disallowComments: true,
      allowTrailingComma: false,
    });
    offset = errors[0]?.offset;
  } else {
    offset = parseDocument(opts.text, { prettyErrors: false }).errors[0]
      ?.pos[0];
  }
  if (offset === undefined) {
    return `Invalid ${opts.format} syntax (location unavailable)`;
  }
  const before = opts.text.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n");
  return `Invalid ${opts.format} syntax at line ${line}, column ${column}`;
}
