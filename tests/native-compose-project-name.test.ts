import { expect, test } from "bun:test";
import {
  declareNativeComposeProjectName,
  referencesComposeProjectName,
} from "../src/backends/native-compose-project-name.ts";
import type { NativeProjectInput } from "../src/backends/native-project-input.ts";
import { applyNativeRuntimeMetadata } from "../src/backends/native-runtime-metadata.ts";
import { expectCodedThrow } from "./helpers/closed-refusal.ts";

const SELECTION = {
  devHost: "app.hack.local",
  aliasHost: null,
  projectName: "app",
} as const;

function input(compose: Record<string, unknown>): NativeProjectInput {
  return {
    originalSha256: "d".repeat(64),
    normalizedComposeJson: JSON.stringify(compose),
    managedEnvironment: {},
    lifecycleHostEnvironment: {},
    effectiveEnvName: null,
    environmentFiles: [],
    serviceNames: Object.keys(compose.services ?? {}),
  };
}

test("references follow Compose interpolation and its $$ escape", () => {
  for (const text of [
    "${COMPOSE_PROJECT_NAME}-queue-1:9000",
    "$COMPOSE_PROJECT_NAME",
    "${COMPOSE_PROJECT_NAME:-fallback}",
    "${OTHER:-${COMPOSE_PROJECT_NAME}}",
    "$$${COMPOSE_PROJECT_NAME}",
  ]) {
    expect(referencesComposeProjectName({ web: { command: text } })).toBe(true);
  }
  for (const text of [
    "$${COMPOSE_PROJECT_NAME}",
    "$$COMPOSE_PROJECT_NAME",
    "${COMPOSE_PROJECT_NAME_SUFFIX}",
    "${PREFIX_COMPOSE_PROJECT_NAME}",
    "COMPOSE_PROJECT_NAME",
  ]) {
    expect(referencesComposeProjectName({ web: { command: text } })).toBe(
      false
    );
  }
  expect(
    referencesComposeProjectName({
      web: { environment: ["QUEUE=${COMPOSE_PROJECT_NAME}-queue-1"] },
    })
  ).toBe(true);
  // Mapping keys are not interpolated.
  expect(
    referencesComposeProjectName({
      web: { labels: { "${COMPOSE_PROJECT_NAME}": "x" } },
    })
  ).toBe(false);
});

test("the instance name is declared only for documents that reference it", () => {
  const referencing = {
    services: {
      worker: {
        image: "example",
        environment: { QUEUE: "${COMPOSE_PROJECT_NAME}-queue-1:9000" },
      },
      queue: { image: "example" },
    },
  };
  const branched = applyNativeRuntimeMetadata({
    input: input(referencing),
    selection: SELECTION,
    branch: "feature-a",
    httpsPort: null,
  });
  const compose = JSON.parse(branched.input.normalizedComposeJson);
  expect(compose.name).toBe("app--feature-a");
  expect(compose.services.worker.environment.QUEUE).toBe(
    "${COMPOSE_PROJECT_NAME}-queue-1:9000"
  );
  const base = applyNativeRuntimeMetadata({
    input: input({ ...referencing, name: "declared" }),
    selection: { ...SELECTION, projectName: "declared" },
    branch: null,
    httpsPort: null,
  });
  expect(JSON.parse(base.input.normalizedComposeJson).name).toBe("declared");

  // Without the reference the document keeps its declared name (or none),
  // so normalized bytes match what earlier versions reviewed.
  for (const document of [
    {
      services: {
        web: { image: "example", command: "$${COMPOSE_PROJECT_NAME}" },
      },
    },
    { name: "declared", services: { web: { image: "example" } } },
  ]) {
    const result = applyNativeRuntimeMetadata({
      input: input(document),
      selection: SELECTION,
      branch: "feature-a",
      httpsPort: null,
    });
    expect(JSON.parse(result.input.normalizedComposeJson).name).toBe(
      document.name
    );
  }
});

test("a project name outside the Compose rule refuses without values", () => {
  for (const composeProject of ["App", "-app", "app.name", "app name", ""]) {
    const compose: Record<string, unknown> = {
      services: { web: { command: "${COMPOSE_PROJECT_NAME}" } },
    };
    const error = expectCodedThrow(
      () => declareNativeComposeProjectName({ compose, composeProject }),
      "E_NATIVE_PROJECT_UNSUPPORTED",
      "COMPOSE_PROJECT_NAME requires a Compose project name"
    );
    if (composeProject) {
      expect(error.message).not.toContain(composeProject);
    }
    expect(compose.name).toBeUndefined();
  }
  const compose: Record<string, unknown> = { services: { web: {} } };
  expect(
    declareNativeComposeProjectName({ compose, composeProject: "App" })
  ).toBe(false);
});
