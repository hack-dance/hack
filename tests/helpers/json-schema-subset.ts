/**
 * Minimal JSON Schema validator for the keyword subset that Hack's legacy
 * project config schema (`renderProjectConfigSchemaJson`) uses.
 *
 * It is closed: a schema keyword outside the supported set is reported as
 * `unsupported-keyword` instead of being ignored, so a schema change that this
 * helper cannot evaluate fails the caller rather than passing silently.
 * Issues carry a JSON pointer and a fixed code; instance values are never
 * echoed.
 */

export type SchemaIssue = {
  readonly pointer: string;
  readonly code: string;
};

const ANNOTATIONS = new Set(["$schema", "$id", "title", "description"]);
const SUPPORTED = new Set([
  "type",
  "properties",
  "additionalProperties",
  "required",
  "enum",
  "items",
  "anyOf",
  "minItems",
  "uniqueItems",
  "minimum",
]);

type Schema = Readonly<Record<string, unknown>>;

function isSchema(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainObject(
  value: unknown
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapePointer(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function matchesType(value: unknown, type: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    default:
      return false;
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Validate `value` against `schema`; an empty result means valid. */
export function validateJsonSchemaSubset(opts: {
  readonly schema: unknown;
  readonly value: unknown;
}): SchemaIssue[] {
  return validateAt(opts.schema, opts.value, "");
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One switch over the closed keyword set keeps the subset auditable.
function validateAt(
  schema: unknown,
  value: unknown,
  pointer: string
): SchemaIssue[] {
  if (schema === true) {
    return [];
  }
  if (schema === false) {
    return [{ pointer, code: "forbidden" }];
  }
  if (!isSchema(schema)) {
    return [{ pointer, code: "invalid-schema" }];
  }
  const issues: SchemaIssue[] = [];
  for (const keyword of Object.keys(schema)) {
    if (!(ANNOTATIONS.has(keyword) || SUPPORTED.has(keyword))) {
      issues.push({ pointer, code: "unsupported-keyword" });
    }
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      return [...issues, { pointer, code: "type" }];
    }
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((entry) => sameJson(entry, value))
  ) {
    issues.push({ pointer, code: "enum" });
  }
  if (
    typeof schema.minimum === "number" &&
    typeof value === "number" &&
    value < schema.minimum
  ) {
    issues.push({ pointer, code: "minimum" });
  }
  if (Array.isArray(schema.anyOf)) {
    const matched = schema.anyOf.some(
      (option) => validateAt(option, value, pointer).length === 0
    );
    if (!matched) {
      issues.push({ pointer, code: "any-of" });
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      issues.push({ pointer, code: "min-items" });
    }
    if (
      schema.uniqueItems === true &&
      new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length
    ) {
      issues.push({ pointer, code: "unique-items" });
    }
    if (schema.items !== undefined) {
      value.forEach((entry, index) => {
        issues.push(...validateAt(schema.items, entry, `${pointer}/${index}`));
      });
    }
  }
  if (isPlainObject(value)) {
    const properties = isSchema(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !Object.hasOwn(value, key)) {
          issues.push({
            pointer: `${pointer}/${escapePointer(key)}`,
            code: "required",
          });
        }
      }
    }
    for (const [key, entry] of Object.entries(value)) {
      const childPointer = `${pointer}/${escapePointer(key)}`;
      if (Object.hasOwn(properties, key)) {
        issues.push(...validateAt(properties[key], entry, childPointer));
      } else if (schema.additionalProperties === false) {
        issues.push({ pointer: childPointer, code: "additional-property" });
      } else if (schema.additionalProperties !== undefined) {
        issues.push(
          ...validateAt(schema.additionalProperties, entry, childPointer)
        );
      }
    }
  }
  return issues;
}
