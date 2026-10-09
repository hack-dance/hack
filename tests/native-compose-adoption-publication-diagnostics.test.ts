import { expect, spyOn, test } from "bun:test";
import { configAdoptCommand } from "../src/commands/config-adopt.ts";
import { errorResultFromUnknown } from "../src/lib/cli-result.ts";
import * as generation from "../src/lib/native-compose-adoption-generation.ts";
import {
  attachLegacyComposePublicationRefusal,
  legacyComposePublicationRefusal,
  retainLegacyComposePublicationRefusal,
} from "../src/lib/native-compose-adoption-publication-diagnostics.ts";

test("publication diagnostics snapshot only closed owner-issued stage and reason", () => {
  const error = new Error("private-source-and-resource-canary");
  const diagnostic = {
    stage: "publication-inputs",
    reason: "private-stale",
  };
  attachLegacyComposePublicationRefusal(error, diagnostic);
  diagnostic.reason = "private-mutated-canary";
  expect(legacyComposePublicationRefusal(error)).toEqual({
    stage: "publication-inputs",
    reason: "private-stale",
  });
  expect(Object.isFrozen(legacyComposePublicationRefusal(error))).toBe(true);
  expect(JSON.stringify(legacyComposePublicationRefusal(error))).not.toContain(
    "canary"
  );
});

test("publication diagnostic issuance rejects unknown keys and accessors without reading them", () => {
  let reads = 0;
  const getter = Object.defineProperty({ reason: "legacy-state" }, "stage", {
    enumerable: true,
    get: () => {
      reads += 1;
      return "publication-inputs";
    },
  });
  for (const detail of [
    getter,
    Object.create({ stage: "publication-inputs", reason: "legacy-state" }),
    { stage: "publication-inputs", reason: "private-error-canary" },
    { stage: "private-path-canary", reason: "legacy-state" },
    { stage: "publication-inputs", reason: "legacy-state", secret: "canary" },
    {
      stage: "publication-inputs",
      reason: "legacy-state",
      [Symbol("private-canary")]: true,
    },
  ]) {
    const error = new Error("fixed");
    expect(() => attachLegacyComposePublicationRefusal(error, detail)).toThrow(
      "values omitted"
    );
    expect(legacyComposePublicationRefusal(error)).toBeUndefined();
  }
  expect(reads).toBe(0);
});

test("copied error detail and prototypes cannot forge publication diagnostics", () => {
  const error = new Error("private-error-canary");
  attachLegacyComposePublicationRefusal(error, {
    stage: "publication-routing",
    reason: "legacy-busy",
  });
  let reads = 0;
  const getter = Object.defineProperty({}, "detail", {
    get: () => {
      reads += 1;
      throw new Error("private-getter-canary");
    },
  });
  for (const forged of [
    null,
    "private-primitive-canary",
    { ...error },
    Object.create(error),
    { detail: legacyComposePublicationRefusal(error) },
    getter,
  ]) {
    expect(legacyComposePublicationRefusal(forged)).toBeUndefined();
  }
  expect(reads).toBe(0);
});

test("optional diagnostic retention never throws for an unclassifiable original error", () => {
  const original = "private-primitive-canary";
  expect(() =>
    retainLegacyComposePublicationRefusal(original, {
      stage: "publication-inputs",
      reason: "unclassified",
    })
  ).not.toThrow();
  expect(legacyComposePublicationRefusal(original)).toBeUndefined();
});

test("config adopt exposes issued publication detail without changing code or fixed error text", async () => {
  const error = new generation.LegacyComposeAdoptedGenerationError(
    "E_LEGACY_ADOPTION_STATE"
  );
  attachLegacyComposePublicationRefusal(error, {
    stage: "publication-originals-directory",
    reason: "private-state",
  });
  const opened = spyOn(
    generation,
    "openLegacyComposeAdoptedGenerationStore"
  ).mockImplementation(() => Promise.reject(error));
  try {
    let caught: unknown;
    try {
      await configAdoptCommand.handler({
        ctx: {
          cwd: "/synthetic-owned-checkout",
          cli: {
            name: "hack",
            version: "synthetic",
            summary: "synthetic",
            commands: [],
            globalOptions: [],
          },
        },
        args: {
          options: {
            json: true,
            path: undefined,
            stop: false,
            dryRun: false,
            rollback: false,
            recover: false,
            branch: undefined,
          },
          positionals: {},
          raw: { argv: [], positionals: [] },
        },
      });
    } catch (value: unknown) {
      caught = value;
    }
    expect(opened).toHaveBeenCalledTimes(1);
    expect(errorResultFromUnknown({ error: caught })).toEqual({
      ok: false,
      error: {
        code: "E_CONFIG_INVALID",
        message: error.message,
        detail: {
          legacy_adoption_publication_refusal: {
            stage: "publication-originals-directory",
            reason: "private-state",
          },
        },
      },
    });
  } finally {
    opened.mockRestore();
  }
});
