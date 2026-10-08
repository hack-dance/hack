import { expect, test } from "bun:test";
import {
  assertNativeComposeSupported,
  NativeComposeRenderError,
  renderNativeCompose,
} from "../src/lib/native-compose-renderer.ts";
import {
  nativeBuildProject,
  verifyNativeBuildEvidence,
  verifyNativeBuildImage,
  verifyNativeBuildReuse,
  verifyNativeBuildWorkloadState,
  verifyUnsupportedNativeBuild,
} from "./e2e/scenarios/native-config-build.ts";
import { composeFixture } from "./helpers/native-compose.ts";

const OWNER = "b".repeat(32);
const ID = `sha256:${"c".repeat(64)}`;
const TAG = "native-fixture-builder:latest";

test("build reuse proof rejects rebuilt omitted-policy jobs and unchanged explicit builds", () => {
  const first = { builder: ID, defaultfile: `sha256:${"d".repeat(64)}` };
  const second = {
    builder: `sha256:${"e".repeat(64)}`,
    defaultfile: first.defaultfile,
  };
  expect(() => verifyNativeBuildReuse({ first, second })).not.toThrow();
  for (const changed of [
    null,
    {},
    { ...second, defaultfile: ID },
    { ...second, builder: ID },
    { ...second, builder: "short-image-id" },
    { ...second, extra: ID },
    { ...second, builder: second.defaultfile },
  ]) {
    expect(() => verifyNativeBuildReuse({ first, second: changed })).toThrow();
    expect(() => verifyNativeBuildReuse({ first: changed, second })).toThrow();
  }
});

const SAFE_WORKLOAD = {
  service: "builder",
  image: ID,
  running: true,
  exit: 0,
  ports: {},
  publishAll: false,
  runtimePorts: { "3000/tcp": null },
};

test("build workload accepts explicit no-publication facts for service and completed job", () => {
  expect(() => verifyNativeBuildWorkloadState(SAFE_WORKLOAD)).not.toThrow();
  expect(() =>
    verifyNativeBuildWorkloadState({
      ...SAFE_WORKLOAD,
      service: "defaultfile",
      running: false,
      ports: null,
      runtimePorts: null,
    })
  ).not.toThrow();
});

test.each([
  {
    publishAll: true,
    runtimePorts: { "3000/tcp": [{ HostIp: "0.0.0.0", HostPort: "49153" }] },
  },
  {
    publishAll: false,
    runtimePorts: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "49153" }] },
  },
  { publishAll: true, runtimePorts: { "3000/tcp": null } },
])("build workload refuses dynamic publication %#", (ports) => {
  expect(() =>
    verifyNativeBuildWorkloadState({ ...SAFE_WORKLOAD, ...ports })
  ).toThrow();
});

test.each([
  "ports",
  "publishAll",
  "runtimePorts",
])("build workload refuses missing %s fact", (field) => {
  const missing: Record<string, unknown> = { ...SAFE_WORKLOAD };
  delete missing[field];
  expect(() => verifyNativeBuildWorkloadState(missing)).toThrow();
});

function evidence(): Record<string, unknown> {
  return {
    owner: OWNER,
    marker: "updated",
    retained: { owner: OWNER, firstMarker: "first" },
    argv: ["", "${NC03_BUILD_AMBIENT}"],
  };
}
function image(): Record<string, unknown> {
  return {
    id: ID,
    tags: [TAG],
    digests: [],
    labels: {
      "hack.e2e.native-build.owner": OWNER,
      "hack.e2e.native-build.project": "fixture",
      "hack.e2e.native-build.ambient": "not-inherited",
    },
  };
}
const verifyEvidence = (value: unknown): void =>
  verifyNativeBuildEvidence({
    evidence: value,
    owner: OWNER,
    marker: "updated",
    firstMarker: "first",
  });
const verifyImage = (
  value: unknown,
  baselineIds: readonly string[] = []
): void =>
  verifyNativeBuildImage({
    image: value,
    id: ID,
    owner: OWNER,
    project: "fixture",
    tags: [TAG],
    baselineIds,
  });

test("build evidence requires the selected stage, literal argv and original data marker", () => {
  expect(() => verifyEvidence(evidence())).not.toThrow();
  for (const changed of [
    null,
    { ...evidence(), owner: "foreign" },
    { ...evidence(), marker: "wrong-final-stage" },
    { ...evidence(), retained: { owner: OWNER, firstMarker: "updated" } },
    { ...evidence(), retained: { owner: "foreign", firstMarker: "first" } },
    { ...evidence(), argv: ["", "interpolated-host-value"] },
    { ...evidence(), argv: ["${NC03_BUILD_AMBIENT}"] },
  ]) {
    expect(() => verifyEvidence(changed)).toThrow();
  }
});

test("built image ownership rejects old IDs, relabeled images and foreign aliases", () => {
  expect(() => verifyImage(image())).not.toThrow();
  expect(() =>
    verifyImage({ ...image(), tags: null, digests: null })
  ).not.toThrow();
  expect(() => verifyImage(image(), [ID])).toThrow();
  for (const changed of [
    null,
    { ...image(), id: `sha256:${"d".repeat(64)}` },
    { ...image(), labels: {} },
    { ...image(), tags: [TAG, "foreign:latest"] },
    { ...image(), digests: ["foreign@sha256:private"] },
    { ...image(), tags: "not-an-array" },
  ]) {
    expect(() => verifyImage(changed)).toThrow();
  }
  for (const [key, value] of [
    ["hack.e2e.native-build.owner", "foreign"],
    ["hack.e2e.native-build.project", "foreign"],
    ["hack.e2e.native-build.ambient", "inherited-host-value"],
  ] as const) {
    const actual = image();
    const labels = actual.labels;
    if (!(labels && typeof labels === "object" && !Array.isArray(labels))) {
      throw new Error("Fixture labels missing");
    }
    expect(() =>
      verifyImage({ ...actual, labels: { ...labels, [key]: value } })
    ).toThrow();
  }
});

test("unsupported build proof rejects unrelated diagnostics or accidental execution", () => {
  const diagnostic = {
    code: "unknown_field",
    document: "project",
    pointer: "/jobs/unsupported/build/secrets",
  };
  const compiler = {
    transport_version: 1,
    ok: false,
    diagnostics: [diagnostic],
  };
  const execution = {
    ok: false,
    error: {
      code: "E_UNEXPECTED",
      message:
        "Native execution inputs are invalid or changed; prepare a fresh generation. Values omitted.",
    },
  };
  const verify = (compilerReport: unknown, executionReport: unknown): void =>
    verifyUnsupportedNativeBuild({
      field: "secrets",
      namespace: "jobs",
      compilerReport,
      executionReport,
    });
  expect(() => verify(compiler, execution)).not.toThrow();
  for (const changed of [
    { ...compiler, ok: true },
    { ...compiler, diagnostics: [] },
    { ...compiler, diagnostics: [diagnostic, diagnostic] },
    { ...compiler, diagnostics: [{ ...diagnostic, code: "invalid_shape" }] },
    { ...compiler, diagnostics: [{ ...diagnostic, document: "request" }] },
    {
      ...compiler,
      diagnostics: [
        { ...diagnostic, pointer: "/services/unsupported/build/secrets" },
      ],
    },
  ]) {
    expect(() => verify(changed, execution)).toThrow();
  }
  expect(() => verify(compiler, { ok: true })).toThrow();
  expect(() =>
    verify(compiler, {
      ...execution,
      error: { code: "E_COMPOSE_FAILED", message: "engine ran" },
    })
  ).toThrow();
});

test("build renderer anchors context, keeps nested Dockerfile and stage without adding arguments", () => {
  const project = nativeBuildProject({
    name: "fixture",
    owner: OWNER,
    marker: "first",
  });
  const defaultfile = project.jobs?.defaultfile;
  const builder = project.services?.builder;
  if (!(defaultfile && builder)) {
    throw new Error("Build declarations are missing");
  }
  expect(Object.hasOwn(defaultfile, "pull_policy")).toBe(false);
  const input = composeFixture({
    services: {
      builder: {
        ...builder,
        readiness: {
          kind: "exec",
          command: { exec: ["check"] },
          interval: "1000ms",
          timeout: "5000ms",
          retries: 30,
        },
      },
    },
    jobs: {
      defaultfile: {
        ...defaultfile,
        build: { context: "default-context", dockerfile: "Dockerfile" },
      },
    },
  });
  input.plan.selected_profiles = ["exercise"];
  input.plan.storage = project.storage ?? {};
  input.projectRoot = "/verified/${NC03_BUILD_AMBIENT}/checkout";
  input.environmentPlan.workloads.builder = {
    FIXTURE_OWNER: { kind: "literal", value: OWNER },
    EXPECTED_MARKER: { kind: "literal", value: "first" },
  };
  const rendered = renderNativeCompose(input);
  expect(rendered.document.services.builder).toMatchObject({
    build: {
      context:
        "/verified/$${NC03_BUILD_AMBIENT}/checkout/build-$${NC03_BUILD_AMBIENT}",
      dockerfile: "docker/Dockerfile",
      target: "selected",
    },
    pull_policy: "build",
    profiles: ["exercise"],
    command: ["bun", "/probe.js", "", "$${NC03_BUILD_AMBIENT}"],
  });
  expect(rendered.document.services.builder).not.toHaveProperty("build.args");
});

test("renderer preflight refuses advanced build fields before private value delivery", () => {
  const input = composeFixture();
  for (const field of [
    "args",
    "platform",
    "platforms",
    "additional_contexts",
    "cache_from",
    "cache_to",
    "no_cache",
    "pull",
    "network",
    "secrets",
    "ssh",
  ]) {
    const unsupported = {
      ...input,
      plan: {
        ...input.plan,
        services: {
          web: {
            build: {
              context: ".",
              dockerfile: "Dockerfile",
              [field]: "private-canary",
            },
          },
        },
      },
    };
    expect(() => assertNativeComposeSupported(unsupported)).toThrow(
      NativeComposeRenderError
    );
    try {
      renderNativeCompose(unsupported);
      throw new Error("Unsupported build unexpectedly rendered");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(NativeComposeRenderError);
      expect(String(error)).not.toContain("private-canary");
    }
  }
});
