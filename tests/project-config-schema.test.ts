import { expect, test } from "bun:test";
import {
  renderProjectConfigSchemaJson,
  renderProjectManagedEnvSchemaJson,
} from "../src/templates.ts";

test("project config schema includes startup validation", () => {
  const schema = JSON.parse(renderProjectConfigSchemaJson()) as Record<
    string,
    unknown
  >;
  const properties = schema.properties as Record<string, unknown>;
  const startup = properties.startup as Record<string, unknown>;
  const startupItems = startup.items as Record<string, unknown>;
  const startupAnyOf = startupItems.anyOf as Record<string, unknown>[];
  const startupObject = startupAnyOf.find((entry) => entry.type === "object");

  expect(startupObject).toBeTruthy();
  expect(startupObject?.additionalProperties).toBe(false);
  const startupProps = startupObject?.properties as Record<string, unknown>;
  expect(startupProps.persistent).toEqual({ type: "boolean" });
  expect(startupProps.singleton).toEqual({
    type: "object",
    additionalProperties: false,
    properties: {
      ports: {
        type: "array",
        minItems: 1,
        uniqueItems: true,
        items: { type: "integer", minimum: 1 },
      },
      onConflict: {
        type: "string",
        enum: ["adopt", "fail"],
      },
    },
    required: ["ports"],
  });
  const startupRequired = startupObject?.anyOf as Record<string, unknown>[];
  expect(startupRequired).toEqual([
    { required: ["run"] },
    { required: ["command"] },
  ]);
});

test("project config schema includes strict lifecycle hooks and processes", () => {
  const schema = JSON.parse(renderProjectConfigSchemaJson()) as Record<
    string,
    unknown
  >;
  const properties = schema.properties as Record<string, unknown>;
  const lifecycle = properties.lifecycle as Record<string, unknown>;
  expect(lifecycle.additionalProperties).toBe(false);

  const lifecycleProps = lifecycle.properties as Record<string, unknown>;
  const up = lifecycleProps.up as Record<string, unknown>;
  const upProps = up.properties as Record<string, unknown>;
  const before = upProps.before as Record<string, unknown>;
  const beforeItems = before.items as Record<string, unknown>;
  const beforeAnyOf = beforeItems.anyOf as Record<string, unknown>[];
  const hookObject = beforeAnyOf.find((entry) => entry.type === "object");
  expect(hookObject?.additionalProperties).toBe(false);
  expect(hookObject?.required).toEqual(["command"]);
  const hookProps = hookObject?.properties as Record<string, unknown>;
  expect(hookProps.persistent).toEqual({ type: "boolean" });
  expect(hookProps.singleton).toEqual({
    type: "object",
    additionalProperties: false,
    properties: {
      ports: {
        type: "array",
        minItems: 1,
        uniqueItems: true,
        items: { type: "integer", minimum: 1 },
      },
      onConflict: {
        type: "string",
        enum: ["adopt", "fail"],
      },
    },
    required: ["ports"],
  });

  const processes = lifecycleProps.processes as Record<string, unknown>;
  const processItems = processes.items as Record<string, unknown>;
  expect(processItems.additionalProperties).toBe(false);
  expect(processItems.required).toEqual(["name", "command"]);
  const processProps = processItems.properties as Record<string, unknown>;
  expect(processProps.singleton).toEqual({
    type: "object",
    additionalProperties: false,
    properties: {
      ports: {
        type: "array",
        minItems: 1,
        uniqueItems: true,
        items: { type: "integer", minimum: 1 },
      },
      onConflict: {
        type: "string",
        enum: ["adopt", "fail"],
      },
    },
    required: ["ports"],
  });
});

test("managed env schema models entry kind, metadata, and service scope", () => {
  const schema = JSON.parse(renderProjectManagedEnvSchemaJson()) as Record<
    string,
    unknown
  >;
  const properties = schema.properties as Record<string, unknown>;

  expect(schema.additionalProperties).toBe(false);
  expect(schema.required).toEqual([
    "version",
    "environment",
    "metadata",
    "entries",
  ]);

  const metadata = properties.metadata as Record<string, unknown>;
  expect(metadata.additionalProperties).toBe(false);
  const metadataProperties = metadata.properties as Record<string, unknown>;
  expect(metadataProperties.updatedAt).toEqual({
    type: "string",
    format: "date-time",
  });

  const entries = properties.entries as Record<string, unknown>;
  expect(entries.description).toContain("Duplicate keys");
  expect(entries.description).toContain("unsorted entries");
  const entry = entries.items as Record<string, unknown>;
  expect(entry.additionalProperties).toBe(false);
  expect(entry.required).toEqual(["key", "value", "required"]);

  const entryProperties = entry.properties as Record<string, unknown>;
  const value = entryProperties.value as Record<string, unknown>;
  expect(value.additionalProperties).toBe(false);
  const valueProperties = value.properties as Record<string, unknown>;
  expect(valueProperties.kind).toEqual({
    type: "string",
    enum: ["plaintext", "secret"],
  });

  const services = entryProperties.services as Record<string, unknown>;
  expect(services.anyOf).toEqual([
    { type: "null" },
    {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
      uniqueItems: true,
    },
  ]);
});
