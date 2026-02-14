import { expect, test } from "bun:test";
import { renderProjectConfigSchemaJson } from "../src/templates.ts";

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

  const processes = lifecycleProps.processes as Record<string, unknown>;
  const processItems = processes.items as Record<string, unknown>;
  expect(processItems.additionalProperties).toBe(false);
  expect(processItems.required).toEqual(["name", "command"]);
});
