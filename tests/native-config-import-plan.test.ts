import { expect, test } from "bun:test";
import { parseImportDocument } from "../src/lib/native-config-import-parser.ts";
import { mapLegacyNativeImport } from "../src/lib/native-config-import-plan.ts";

const CANARY = "synthetic-private-import-value";
const CONFIG = '{"name":"fixture"}';
const COMPOSE = "services:\n  web:\n    image: fixture:1\n";
function map(config: unknown, compose: unknown) {
  return mapLegacyNativeImport({
    configText: JSON.stringify(config),
    composeText: JSON.stringify(compose),
  });
}
function code(
  result: ReturnType<typeof mapLegacyNativeImport>,
  expected: string
) {
  expect(result.report.complete).toBe(false);
  expect(result.candidate).toBeUndefined();
  expect(
    result.report.fields.some(
      (field) => field.status === "refused" && field.code === expected
    )
  ).toBe(true);
  expect(JSON.stringify(result)).not.toContain(CANARY);
}

test("closed conversion preserves argv, process intent, overlay aliases and empty static env", () => {
  const result = map(
    {
      name: "fixture",
      $schema: CANARY,
      defaultEnvConfig: " QA ",
      env: { default_overlay: "qa" },
      worktree: { autoBranch: false, inherit_local: true },
    },
    {
      name: "fixture",
      services: {
        web: {
          image: "fixture:1",
          command: ["sh", "-c", "exit 0"],
          entrypoint: [],
          working_dir: "/app",
          init: false,
          pull_policy: "never",
          restart: "on-failure:3",
          stop_signal: "SIGTERM",
          stop_grace_period: "2s",
          environment: { TOKEN: CANARY, EMPTY: "" },
          profiles: ["qa"],
        },
      },
    }
  );
  expect(result.report.complete).toBe(true);
  expect(result.candidate).toEqual({
    schema_version: 1,
    name: "fixture",
    environment: { default_overlay: "qa" },
    worktree: { auto_branch: false, inherit_local: true },
    profiles: ["qa"],
    services: {
      web: {
        image: "fixture:1",
        command: { exec: ["sh", "-c", "exit 0"] },
        entrypoint: { exec: [] },
        working_directory: "/app",
        init: false,
        pull_policy: "never",
        restart: { kind: "on-failure", max_retries: 3 },
        shutdown: { signal: "SIGTERM", grace: "2s" },
        environment: { TOKEN: { default: CANARY }, EMPTY: { default: "" } },
        profiles: ["qa"],
      },
    },
  });
  expect(JSON.stringify(result)).not.toContain(CANARY);
  expect(JSON.stringify({ ...result })).not.toContain(CANARY);
  expect(Object.keys(result)).toEqual(["report"]);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.candidate)).toBe(true);
  expect(Object.isFrozen(result.report.fields)).toBe(true);
});

test("static list values split only at first equal sign without source mutation", () => {
  const source = {
    services: {
      web: {
        image: "fixture",
        environment: ["EMPTY=", `TOKEN=${CANARY}=suffix`],
      },
    },
  };
  const before = JSON.stringify(source);
  const result = map({ name: "fixture" }, source);
  expect(result.report.complete).toBe(true);
  expect(result.candidate).toMatchObject({
    services: {
      web: {
        environment: {
          EMPTY: { default: "" },
          TOKEN: { default: `${CANARY}=suffix` },
        },
      },
    },
  });
  expect(JSON.stringify(source)).toBe(before);
});

test("complete Compose dollar pairs become literal exec argv in selected and inactive services", () => {
  const source = {
    services: {
      web: {
        image: "fixture",
        command: ["serve", "$${AMBIENT}", "$$", "$$$$", "plain", ""],
        entrypoint: ["/bin/echo", "prefix-$$HOME"],
      },
      inactive: {
        image: "fixture",
        profiles: ["later"],
        command: ["print", "$${INACTIVE}"],
      },
    },
  };
  const original = JSON.stringify(source);
  const result = map({ name: "fixture" }, source);
  expect(result.report.complete).toBe(true);
  expect(result.candidate).toMatchObject({
    services: {
      web: {
        command: { exec: ["serve", "${AMBIENT}", "$", "$$", "plain", ""] },
        entrypoint: { exec: ["/bin/echo", "prefix-$HOME"] },
      },
      inactive: {
        command: { exec: ["print", "${INACTIVE}"] },
      },
    },
  });
  expect(JSON.stringify(source)).toBe(original);
  for (const pointer of [
    "/services/web/command",
    "/services/web/command/1",
    "/services/web/entrypoint",
    "/services/inactive/command/1",
  ]) {
    expect(
      result.report.fields.find((field) => field.pointer === pointer)
    ).toMatchObject({
      document: "compose",
      status: "normalized",
      code: "escaped_dollar_literal",
    });
  }
  expect(
    result.report.fields.find(
      (field) => field.pointer === "/services/web/command/0"
    )
  ).toMatchObject({ status: "exact", code: "exact" });
  expect(
    result.report.fields.find(
      (field) => field.pointer === "/services/web/command/1"
    )
  ).toMatchObject({ target: "/services/web/command/exec/1" });
  expect(JSON.stringify(result)).not.toContain("${AMBIENT}");
  expect(JSON.stringify(result)).not.toContain("${INACTIVE}");
});

test.each([
  "$",
  "$$$",
  "$VAR",
  "${VAR}",
  "prefix-$$suffix-$",
  "$$${VAR}",
])("refuses ambiguous Compose argv dollar expression %s in inactive service", (part) => {
  const result = map(
    { name: "fixture" },
    {
      services: {
        web: { image: "fixture" },
        inactive: {
          image: "fixture",
          profiles: ["later"],
          command: ["print", part],
        },
      },
    }
  );
  code(result, "invalid_or_ambiguous_value");
  expect(
    result.report.fields.find(
      (field) => field.pointer === "/services/inactive/command"
    )
  ).toMatchObject({
    status: "refused",
  });
});

test("dollar syntax outside exec arrays remains refused", () => {
  for (const [key, value] of [
    ["command", "echo $$HOME"],
    ["entrypoint", "echo $$HOME"],
    ["environment", { TOKEN: "$$HOME" }],
  ] as const) {
    code(
      map(
        { name: "fixture" },
        { services: { web: { image: "fixture", [key]: value } } }
      ),
      "invalid_or_ambiguous_value"
    );
  }
});

test("raw provenance retains original spelling, escaped pointers and line positions", () => {
  const result = mapLegacyNativeImport({
    configText: '{\n  "name": "fixture",\n  "defaultEnvConfig": "QA"\n}',
    composeText: `services:\n  web:\n    image: fixture\n    environment:\n      TOKEN: "${CANARY}"\n    x/a~b:\n      nested: "${CANARY}"\n`,
  });
  code(result, "unsupported_field");
  expect(result.report.fields).toContainEqual({
    document: "config",
    pointer: "/defaultEnvConfig",
    line: 3,
    column: 3,
    status: "normalized",
    code: "overlay_normalized",
    target: "/environment/default_overlay",
  });
  expect(result.report.fields).toContainEqual({
    document: "compose",
    pointer: "/services/web/x~1a~0b/nested",
    line: 7,
    column: 7,
    status: "refused",
    code: "unsupported_field",
  });
});

test.each([
  [
    "config top field",
    { name: "fixture", secrets: CANARY },
    { services: { web: { image: "fixture" } } },
  ],
  [
    "compose top field",
    { name: "fixture" },
    { version: CANARY, services: { web: { image: "fixture" } } },
  ],
  [
    "inactive profile field",
    { name: "fixture" },
    {
      services: {
        web: { image: "fixture" },
        inactive: {
          image: "fixture",
          profiles: ["unused"],
          volumes: [CANARY],
          deploy: { replicas: 3 },
        },
      },
    },
  ],
  [
    "unknown env child",
    { name: "fixture", env: { defaultOverlay: "qa", extra: CANARY } },
    { services: { web: { image: "fixture" } } },
  ],
  [
    "unknown worktree child",
    { name: "fixture", worktree: { extra: CANARY } },
    { services: { web: { image: "fixture" } } },
  ],
])("refuses every omitted relevant field: %s", (_label, config, compose) => {
  code(map(config, compose), "unsupported_field");
});

test.each([
  undefined,
  "",
  "Not Canonical",
  "snake_case",
  null,
  4,
])("refuses missing or normalized project identity %p", (name) => {
  code(
    map({ name }, { services: { web: { image: "fixture" } } }),
    "explicit_canonical_name_required"
  );
});

test("conflicting runtime identity never produces a candidate", () => {
  code(
    map(
      { name: "fixture" },
      { name: CANARY, services: { web: { image: "fixture" } } }
    ),
    "runtime_identity_conflict"
  );
});

test.each([
  { defaultEnvConfig: "qa", env: { defaultOverlay: "dev" } },
  { defaultEnvConfig: null },
  { defaultEnvConfig: "../private" },
])("refuses ambiguous overlay aliases %p", (selection) => {
  code(
    map(
      { name: "fixture", ...selection },
      { services: { web: { image: "fixture" } } }
    ),
    "invalid_or_conflicting_overlay_alias"
  );
});

test("conflicting worktree aliases retain both original refusals", () => {
  const result = map(
    { name: "fixture", worktree: { autoBranch: false, auto_branch: true } },
    { services: { web: { image: "fixture" } } }
  );
  code(result, "invalid_or_conflicting_worktree_alias");
  expect(
    result.report.fields
      .filter((field) => field.code === "invalid_or_conflicting_worktree_alias")
      .map((field) => field.pointer)
  ).toEqual(["/worktree/auto_branch", "/worktree/autoBranch"]);
});

test.each([
  ["command", CANARY],
  ["command", []],
  ["command", [""]],
  ["entrypoint", [""]],
  ["entrypoint", CANARY],
  ["image", "${PRIVATE}"],
  ["init", "true"],
  ["restart", "on-failure:4294967296"],
  ["environment", ["TOKEN"]],
  ["environment", ["TOKEN=a", "TOKEN=b"]],
  ["environment", { TOKEN: null }],
  ["environment", { TOKEN: true }],
  ["environment", { TOKEN: "${PRIVATE}" }],
  ["environment", { TOKEN: "nul\0value" }],
  ["profiles", ["Not Canonical"]],
  ["pull_policy", "weekly"],
])("refuses ambiguous %s values", (key, value) => {
  code(
    map(
      { name: "fixture" },
      { services: { web: { image: "fixture", [key]: value } } }
    ),
    "invalid_or_ambiguous_value"
  );
});

test.each([
  ["build", { context: CANARY }],
  ["ports", ["3000:3000"]],
  ["volumes", [CANARY]],
  ["depends_on", ["other"]],
  ["healthcheck", { test: ["CMD", CANARY] }],
  ["labels", { "hack.domain": CANARY }],
  ["env_file", CANARY],
  ["networks", ["default"]],
  ["extra_hosts", [CANARY]],
  ["user", CANARY],
])("refuses unsupported Compose intent %s", (key, value) => {
  code(
    map(
      { name: "fixture" },
      { services: { web: { image: "fixture", [key]: value } } }
    ),
    "unsupported_field"
  );
});

test("missing image cannot become a normalized build or image fallback", () => {
  code(
    map({ name: "fixture" }, { services: { web: {} } }),
    "image_required_in_first_slice"
  );
});

test.each([
  "web.v1",
  "web_one",
  "Web",
  "${PRIVATE}",
])("unsupported service spelling retains its original name %s", (name) => {
  const result = map(
    { name: "fixture" },
    { services: { [name]: { image: "fixture" } } }
  );
  code(result, "invalid_service_name_first_slice");
  expect(
    result.report.fields.some(
      (field) =>
        field.pointer === `/services/${name}` &&
        field.code === "invalid_service_name_first_slice"
    )
  ).toBe(true);
});

test.each([
  ["config", `{"name":"fixture","name":"${CANARY}"}`],
  ["config", `{"name":"fixture","na\\u006de":"${CANARY}"}`],
  ["compose", `services:\n  web:\n    image: fixture\n    image: "${CANARY}"`],
  ["compose", `services: {web: {image: fixture}, web: {image: "${CANARY}"}}`],
] as const)("rejects duplicate %s fields without parser excerpts", (document, text) => {
  const result = parseImportDocument({ document, text });
  expect(result.value).toBeUndefined();
  expect(result.fields.some((field) => field.code === "duplicate_key")).toBe(
    true
  );
  expect(JSON.stringify(result)).not.toContain(CANARY);
});

test.each([
  "services: {web: &base {image: fixture}}",
  "x-base: &base {image: fixture}\nservices: {web: *base}",
  "services: {web: {<<: {image: fixture}}}",
  "services: {web: {!!str image: fixture}}",
  `services: {web: {image: !private "${CANARY}"}}`,
  "%YAML 1.1\n---\nservices: {web: {image: fixture}}",
  `services: {web: {image: fixture}}\n---\nprivate: "${CANARY}"`,
  "services: {web: {image: fixture, environment: {TOKEN: on}}}",
])("rejects references, directives, multiple docs and ambiguous YAML scalars", (composeText) => {
  const result = mapLegacyNativeImport({ configText: CONFIG, composeText });
  expect(result.report.complete).toBe(false);
  expect(result.candidate).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain(CANARY);
});

test("JSON stays strict rather than accepting YAML-compatible syntax", () => {
  for (const text of [
    '{name:"fixture"}',
    '{"name":"fixture",}',
    '{"name":"fixture"} //private',
    '{"name":01}',
  ]) {
    const result = mapLegacyNativeImport({
      configText: text,
      composeText: COMPOSE,
    });
    code(result, "invalid_syntax");
  }
});

test.each([
  "tag:yaml.org,2002:",
  "tag:private.invalid,2026:",
])("explicit standard tag handle directive refuses even without tagged nodes: %s", (prefix) => {
  const result = mapLegacyNativeImport({
    configText: CONFIG,
    composeText: `%TAG !! ${prefix}\n---\n${COMPOSE}`,
  });
  code(result, "unsupported_yaml_directive");
});

test("parser budgets refuse huge or deeply nested documents", () => {
  for (const text of [
    "x".repeat(1024 * 1024 + 1),
    `{"name":"fixture","nested":${"[".repeat(50)}0${"]".repeat(50)}}`,
  ]) {
    const result = parseImportDocument({ text, document: "config" });
    expect(result.value).toBeUndefined();
    expect(result.fields.some((field) => field.code === "input_budget")).toBe(
      true
    );
  }
});
