import { expect, test } from "bun:test";
import { parseImportDocument } from "../src/lib/native-config-import-parser.ts";
import {
  mapLegacyNativeAdoptionBaseline,
  mapLegacyNativeImport,
} from "../src/lib/native-config-import-plan.ts";

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

test("one owned internal bridge maps selected and inactive static aliases without source drift", () => {
  const source = {
    name: "fixture",
    networks: { private: { driver: "bridge", internal: true } },
    services: {
      db: {
        image: "postgres:17",
        networks: { private: { aliases: ["db-reader", "db-writer"] } },
      },
      worker: {
        image: "worker:1",
        profiles: ["later"],
        networks: ["private"],
      },
    },
  };
  const original = JSON.stringify(source);
  const result = map({ name: "fixture" }, source);
  expect(result.report.complete).toBe(true);
  expect(result.candidate).toMatchObject({
    networks: { private: { internal: true } },
    services: {
      db: { networks: { private: { aliases: ["db-reader", "db-writer"] } } },
      worker: { networks: { private: { aliases: [] } } },
    },
  });
  expect(
    result.report.fields
      .filter((field) => field.pointer.includes("networks"))
      .every((field) => field.status === "normalized" && !!field.target)
  ).toBe(true);
  expect(JSON.stringify(source)).toBe(original);
  expect(JSON.stringify(result)).not.toContain("db-reader");
});

test("two owned bridges map complete selected and inactive attachment sets without source drift", () => {
  const source = {
    name: "fixture",
    networks: {
      back: { driver: "bridge", internal: true },
      edge: { driver: "bridge", internal: false },
    },
    services: {
      db: {
        image: "postgres:17",
        networks: { back: { aliases: ["db-reader"] } },
      },
      web: {
        image: "web:1",
        networks: {
          back: { aliases: ["web-back"] },
          edge: { aliases: ["web-edge"] },
        },
      },
      observer: {
        image: "observer:1",
        profiles: ["later"],
        networks: { edge: { aliases: ["observer-edge"] } },
      },
    },
  };
  const original = JSON.stringify(source);
  const result = map({ name: "fixture" }, source);
  expect(result.report.complete).toBe(true);
  expect(result.candidate).toMatchObject({
    networks: { back: { internal: true }, edge: { internal: false } },
    services: {
      db: { networks: { back: { aliases: ["db-reader"] } } },
      web: {
        networks: {
          back: { aliases: ["web-back"] },
          edge: { aliases: ["web-edge"] },
        },
      },
      observer: { networks: { edge: { aliases: ["observer-edge"] } } },
    },
  });
  expect(
    result.report.fields
      .filter((field) => field.pointer.includes("networks"))
      .every((field) => field.status === "normalized" && !!field.target)
  ).toBe(true);
  expect(JSON.stringify(source)).toBe(original);
  expect(JSON.stringify(result)).not.toContain("db-reader");
});

test("basic build preview and owned bridge remain separate from retained adoption", () => {
  const compose = {
    networks: { private: { internal: true } },
    services: {
      db: {
        image: "postgres:17",
        networks: { private: { aliases: ["db-reader"] } },
      },
      worker: {
        build: "..",
        pull_policy: "build",
        profiles: ["later"],
        networks: { private: { aliases: ["worker-reader"] } },
      },
    },
  };
  const source = {
    configText: CONFIG,
    composeText: JSON.stringify(compose),
  };
  const preview = mapLegacyNativeImport(source);
  expect(preview.report.complete).toBe(true);
  expect(preview.candidate).toMatchObject({
    networks: { private: { internal: true } },
    services: {
      db: { networks: { private: { aliases: ["db-reader"] } } },
      worker: {
        build: { context: "." },
        pull_policy: "build",
        profiles: ["later"],
        networks: { private: { aliases: ["worker-reader"] } },
      },
    },
  });
  expect(preview.report.fields).toContainEqual(
    expect.objectContaining({
      pointer: "/services/worker/build",
      status: "normalized",
    })
  );
  const adoption = mapLegacyNativeAdoptionBaseline(source);
  expect(adoption.candidate).toBeUndefined();
  expect(adoption.report.fields).toContainEqual(
    expect.objectContaining({
      pointer: "/services/worker/build",
      status: "refused",
    })
  );
});

test("owned bridge and inactive completed job refuse retained adoption baseline", () => {
  code(
    mapLegacyNativeAdoptionBaseline({
      configText: '{"name":"fixture"}',
      composeText: JSON.stringify({
        networks: { private: { internal: true } },
        services: {
          web: { image: "fixture:1", networks: ["private"] },
          initialize: {
            image: "fixture:1",
            labels: { "hack.service.one-shot": "true" },
            profiles: ["later"],
            networks: ["private"],
          },
        },
      }),
    }),
    "completed_job_adoption_unqualified"
  );
});

test.each([
  [
    "external",
    { external: true, internal: true },
    "unsupported_network_policy",
  ],
  [
    "missing internal",
    { driver: "bridge" },
    "explicit_internal_policy_required",
  ],
  [
    "foreign driver",
    { driver: "overlay", internal: true },
    "owned_bridge_driver_required",
  ],
])("owned bridge refuses %s before exposing a candidate", (_name, declaration, expected) => {
  code(
    map(
      { name: "fixture" },
      {
        networks: { private: declaration },
        services: { web: { image: "fixture:1", networks: ["private"] } },
      }
    ),
    expected
  );
});

test.each([
  [
    "implicit sibling default",
    undefined,
    "explicit_owned_bridge_attachment_required",
  ],
  ["mixed default", ["private", "default"], "single_owned_bridge_required"],
  [
    "foreign endpoint option",
    { private: { ipv4_address: "10.0.0.5" } },
    "unsupported_network_attachment",
  ],
  [
    "collision with workload",
    { private: { aliases: ["db"] } },
    "network_alias_collision",
  ],
])("owned bridge refuses %s in the inactive workload too", (_name, networks, expected) => {
  code(
    map(
      { name: "fixture" },
      {
        networks: { private: { internal: false } },
        services: {
          db: { image: "fixture:1", networks: ["private"] },
          worker: { image: "fixture:1", profiles: ["later"], networks },
        },
      }
    ),
    expected
  );
});

test("explicit outbound bridge policy remains representable without inventing a default network", () => {
  const result = map(
    { name: "fixture" },
    {
      services: { web: { image: "fixture:1", networks: ["private"] } },
      networks: { private: { internal: false } },
    }
  );
  expect(result.report.complete).toBe(true);
  expect(result.candidate).toMatchObject({
    networks: { private: { internal: false } },
    services: { web: { networks: { private: { aliases: [] } } } },
  });
});

test.each([
  [
    "mixed default",
    { private: { internal: true }, default: {} },
    "named_owned_bridge_required",
  ],
  [
    "multiple owned bridges without closed attachments",
    { private: { internal: true }, second: { internal: true } },
    "explicit_owned_bridge_attachments_required",
  ],
  [
    "custom physical name",
    { private: { internal: true, name: "foreign" } },
    "unsupported_network_policy",
  ],
  [
    "IPAM",
    { private: { internal: true, ipam: { config: [] } } },
    "unsupported_network_policy",
  ],
  [
    "driver options",
    { private: { internal: true, driver_opts: {} } },
    "unsupported_network_policy",
  ],
])("owned bridge refuses top-level %s without a candidate", (_name, networks, expected) => {
  code(
    map(
      { name: "fixture" },
      {
        services: { web: { image: "fixture:1", networks: ["private"] } },
        networks,
      }
    ),
    expected
  );
});

test.each([
  [
    "unused second bridge",
    { back: { aliases: ["web-reader"] } },
    "unused_owned_bridge",
  ],
  [
    "undeclared attachment",
    { back: {}, foreign: {} },
    "closed_owned_bridge_attachments_required",
  ],
  [
    "duplicate alias on one bridge",
    { back: { aliases: ["db-reader"] }, edge: { aliases: ["db-reader"] } },
    "network_alias_collision",
  ],
])("two-bridge mapping refuses %s without a candidate", (_name, attachment, expected) => {
  const source = {
    networks: { back: { internal: true }, edge: { internal: false } },
    services: {
      db: {
        image: "postgres:17",
        networks: { back: { aliases: ["db-reader"] } },
      },
      web: { image: "web:1", networks: attachment },
    },
  };
  code(map({ name: "fixture" }, source), expected);
});

test("duplicate static alias across active and inactive services refuses", () => {
  code(
    map(
      { name: "fixture" },
      {
        networks: { private: { internal: true } },
        services: {
          web: {
            image: "fixture:1",
            networks: { private: { aliases: ["shared"] } },
          },
          later: {
            image: "fixture:1",
            profiles: ["later"],
            networks: { private: { aliases: ["shared"] } },
          },
        },
      }
    ),
    "network_alias_collision"
  );
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

test("Compose strings map only their parsed exec words, preserving quotes, empty words and dollars", () => {
  const source = {
    services: {
      web: {
        image: "fixture",
        command: "  /bin/echo   'two words' \"\" a\\ b $${AMBIENT} $$$$ ",
        entrypoint: "  /bin/sh -c 'printf \"a b\"' ",
      },
      inactive: {
        image: "fixture",
        profiles: ["later"],
        command: "printf 'inactive arg' $$LATER",
        entrypoint: "",
      },
      defaults: { image: "fixture", command: null, entrypoint: null },
      omitted: { image: "fixture" },
    },
  };
  const raw = JSON.stringify(source);
  const result = map({ name: "fixture" }, source);
  expect(result.report.complete).toBe(true);
  expect(result.candidate).toMatchObject({
    services: {
      web: {
        command: {
          exec: ["/bin/echo", "two words", "", "a b", "${AMBIENT}", "$$"],
        },
        entrypoint: { exec: ["/bin/sh", "-c", 'printf "a b"'] },
      },
      inactive: {
        command: { exec: ["printf", "inactive arg", "$LATER"] },
        entrypoint: { exec: [] },
      },
      defaults: { image: "fixture" },
      omitted: { image: "fixture" },
    },
  });
  expect(JSON.stringify(source)).toBe(raw);
  expect(result.report.fields).toContainEqual(
    expect.objectContaining({
      pointer: "/services/web/command",
      target: "/services/web/command",
      status: "normalized",
      code: "compose_string_exec_argv",
    })
  );
  expect(result.report.fields).toContainEqual(
    expect.objectContaining({
      pointer: "/services/defaults/command",
      status: "normalized",
      code: "image_default",
    })
  );
  expect(JSON.stringify(result)).not.toContain("${AMBIENT}");
});

test("string conversion retains the authored source pointer and position without reporting its value", () => {
  const composeText = `{
    "services": {
      "web": {
        "image": "fixture",
        "command": "  /bin/echo 'source words'  "
      }
    }
  }`;
  const result = mapLegacyNativeImport({
    configText: CONFIG,
    composeText,
  });
  expect(result.report.complete).toBe(true);
  expect(result.report.fields).toContainEqual({
    document: "compose",
    pointer: "/services/web/command",
    line: 5,
    column: 9,
    status: "normalized",
    code: "compose_string_exec_argv",
    target: "/services/web/command",
  });
  expect(JSON.stringify(result)).not.toContain("source words");
});

test("an ambiguous string in an inactive profile still refuses the complete import", () => {
  const result = map(
    { name: "fixture" },
    {
      services: {
        web: { image: "fixture" },
        inactive: {
          image: "fixture",
          profiles: ["later"],
          entrypoint: "echo a && true",
        },
      },
    }
  );
  code(result, "invalid_or_ambiguous_value");
  expect(result.report.fields).toContainEqual(
    expect.objectContaining({
      pointer: "/services/inactive/entrypoint",
      status: "refused",
    })
  );
});

test.each([
  ["command", '"" next'],
  ["entrypoint", '"" next'],
  ["command", "echo $$HOME $VAR"],
  ["command", "echo $\\$VAR"],
  ["command", "echo $''$VAR"],
  ["command", "echo '$' '$VAR'"],
  ["entrypoint", "echo ${VAR}"],
  ["command", "echo $$$"],
  ["command", "echo foo\\"],
  ["command", "echo 'unfinished"],
  ["command", 'echo "unfinished'],
  ["command", "echo a && true"],
  ["command", "echo a | cat"],
  ["command", "echo a;true"],
  ["command", "echo a(b)c"],
  ["command", "echo\0secret"],
])("refuses unrepresentable or ambiguous Compose string %s %p", (key, value) => {
  const result = map(
    { name: "fixture" },
    { services: { web: { image: "fixture", [key]: value } } }
  );
  code(result, "invalid_or_ambiguous_value");
});

test.each([
  "",
  " \t\n ",
])("explicit empty Compose command %p refuses with its unrepresentable-override reason", (command) => {
  code(
    map(
      { name: "fixture" },
      { services: { web: { image: "fixture", command } } }
    ),
    "empty_command_unrepresentable"
  );
});

test("dollar syntax outside command and entrypoint remains refused", () => {
  for (const [key, value] of [["environment", { TOKEN: "$$HOME" }]] as const) {
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
  ["command", "echo ${PRIVATE}"],
  ["command", []],
  ["command", [""]],
  ["entrypoint", [""]],
  ["entrypoint", "echo ${PRIVATE}"],
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
