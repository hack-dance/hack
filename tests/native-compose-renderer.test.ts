import { expect, test } from "bun:test";
import type { EnvironmentBinding } from "../packages/config-compiler/generated/native-config.ts";
import {
  assertNativeComposeSupported,
  NativeComposeRenderError,
  renderNativeCompose,
} from "../src/lib/native-compose-renderer.ts";
import { composeFixture } from "./helpers/native-compose.ts";

const LABELS = {
  "io.hack.native-config.version": "1",
  "io.hack.native-config.instance": "nc03-fixture-a",
  "io.hack.native-config.owner": "c".repeat(32),
  "io.hack.native-config.generation": "a".repeat(32),
  "io.hack.native-config.workload": "service",
};
const RESOURCE_LABELS = {
  "io.hack.native-config.version": "1",
  "io.hack.native-config.instance": "nc03-fixture-a",
  "io.hack.native-config.owner": "c".repeat(32),
};

function refuses(run: () => unknown, code?: string): void {
  try {
    run();
    throw new Error("Expected a render refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(NativeComposeRenderError);
    if (error instanceof NativeComposeRenderError && code) {
      expect(error.code).toBe(code);
    }
    expect(String(error)).not.toContain("private-sentinel");
  }
}

test("image defaults remain omitted and one private Compose document is returned", () => {
  const input = composeFixture();
  const result = renderNativeCompose(input);
  expect(result.document).toEqual({
    name: "nc03-fixture-a",
    services: {
      web: { image: "fixture/web:1", environment: {}, labels: LABELS },
    },
    volumes: {},
    networks: {
      default: { name: "nc03-fixture-a_default", labels: RESOURCE_LABELS },
    },
  });
  expect(JSON.parse(result.json)).toEqual(result.document);
  expect(result.profiles).toEqual([]);
  expect(result.sourceRoot).toBe("/verified/checkout");
  const service = result.document.services.web;
  for (const field of [
    "command",
    "entrypoint",
    "init",
    "restart",
    "healthcheck",
    "cpus",
    "mem_limit",
    "pids_limit",
    "ports",
    "env_file",
    "include",
    "extends",
    "container_name",
  ]) {
    expect(service).not.toHaveProperty(field);
  }
});

test("independent Compose representation preserves process, mount and dependency intent", () => {
  const input = composeFixture({
    services: {
      web: {
        image: "fixture/web:1",
        command: { exec: ["web", "--port", "3000", ""] },
        entrypoint: { exec: [] },
        init: false,
        shutdown: { signal: "SIGTERM", grace: "45000ms" },
        restart: { kind: "on-failure", max_retries: 3 },
        working_directory: "/app",
        mounts: [
          { source: "src", target: "/app", access: "read-only" },
          { storage: "data", target: "/data", access: "read-write" },
        ],
        profiles: ["dev"],
        depends_on: [
          { service: "db", condition: "ready" },
          { service: "metrics", condition: "started" },
          { job: "check", condition: "completed" },
        ],
      },
      db: {
        image: "fixture/db:1",
        readiness: {
          kind: "exec",
          command: { exec: ["db-ready"] },
          interval: "2000ms",
          timeout: "1000ms",
          retries: 4,
        },
      },
      metrics: { image: "fixture/metrics:1" },
    },
    jobs: {
      check: {
        build: {
          context: "backend",
          dockerfile: "docker/Dockerfile",
          target: "check",
        },
        command: { shell: "test -f /app/ready" },
        restart: { kind: "no" },
      },
    },
  });
  input.plan.source.root = "src";
  input.plan.storage.data = { kind: "persistent", scope: "worktree" };
  input.plan.selected_profiles = ["dev"];
  const result = renderNativeCompose(input);
  expect(result.sourceRoot).toBe("/verified/checkout/src");
  expect(result.profiles).toEqual(["dev"]);
  expect(result.document.services.web).toEqual({
    labels: LABELS,
    image: "fixture/web:1",
    command: ["web", "--port", "3000", ""],
    entrypoint: [],
    init: false,
    stop_signal: "SIGTERM",
    stop_grace_period: "45000ms",
    restart: "on-failure:3",
    working_dir: "/app",
    profiles: ["dev"],
    environment: {},
    volumes: [
      {
        type: "bind",
        source: "/verified/checkout/src",
        target: "/app",
        read_only: true,
        bind: { create_host_path: false },
      },
      { type: "volume", source: "data", target: "/data", read_only: false },
    ],
    depends_on: {
      db: { condition: "service_healthy" },
      metrics: { condition: "service_started" },
      check: { condition: "service_completed_successfully" },
    },
  });
  expect(result.document.services.db).toEqual({
    labels: LABELS,
    image: "fixture/db:1",
    environment: {},
    healthcheck: {
      test: ["CMD", "db-ready"],
      interval: "2000ms",
      timeout: "1000ms",
      retries: 4,
    },
  });
  expect(result.document.services.check).toEqual({
    labels: { ...LABELS, "io.hack.native-config.workload": "job" },
    build: {
      context: "/verified/checkout/backend",
      dockerfile: "docker/Dockerfile",
      target: "check",
    },
    command: ["/bin/sh", "-c", "test -f /app/ready"],
    restart: "no",
    environment: {},
  });
  expect(result.document.volumes).toEqual({
    data: {
      name: "hack-14-nc03-fixture-a-4-data",
      labels: { ...RESOURCE_LABELS, "io.hack.native-config.storage": "data" },
    },
  });
});

test("shell commands and shell entrypoints are explicit argv and never guessed CMD-SHELL", () => {
  const input = composeFixture({
    services: {
      web: {
        image: "fixture/web:1",
        command: { shell: "echo $HOME; exit 3" },
        entrypoint: { shell: 'exec "$@"' },
        init: true,
        readiness: {
          kind: "exec",
          command: { shell: 'test -n "$READY"' },
          interval: "1ms",
          timeout: "1ms",
          retries: 1,
        },
      },
    },
  });
  const result = renderNativeCompose(input);
  expect(result.document.services.web).toEqual({
    labels: LABELS,
    image: "fixture/web:1",
    command: ["/bin/sh", "-c", "echo $$HOME; exit 3"],
    entrypoint: ["/bin/sh", "-c", 'exec "$$@"', "hack-native-entrypoint"],
    init: true,
    environment: {},
    healthcheck: {
      test: ["CMD", "/bin/sh", "-c", 'test -n "$$READY"'],
      interval: "1ms",
      timeout: "1ms",
      retries: 1,
    },
  });
});

test("explicit entrypoint with omitted image command refuses until image defaults are qualified", () => {
  for (const entrypoint of [
    { exec: [] },
    { exec: ["wrapper"] },
    { shell: "echo ready" },
  ]) {
    const input = composeFixture({
      services: { web: { image: "fixture/web:1", entrypoint } },
    });
    refuses(() => renderNativeCompose(input), "E_COMPOSE_IMAGE_COMMAND_OWNER");
    input.plan.services.web!.command = { exec: ["server"] };
    expect(renderNativeCompose(input).document.services.web).toHaveProperty(
      "entrypoint"
    );
  }
});

test("environment uses immutable owner values and explicit empty, default, unset and remapped refs", () => {
  const input = composeFixture();
  input.plan.services.web!.environment = {
    LITERAL: { literal: "${HOSTILE:-replace}" },
    EMPTY: { default: "fallback" },
    FALLBACK: { default: "" },
    RENAMED: { env_ref: "SOURCE" },
    SOURCE: { literal: "public replacement" },
    REMOVED: { unset: true },
  };
  input.environmentPlan.workloads.web = {
    LITERAL: { kind: "literal", value: "${HOSTILE:-replace}" },
    EMPTY: { kind: "managed", key: "EMPTY", scope: "global", secret: true },
    FALLBACK: { kind: "default", value: "" },
    RENAMED: { kind: "managed", key: "SOURCE", scope: "web", secret: true },
    SOURCE: { kind: "literal", value: "public replacement" },
    BASELINE: {
      kind: "managed",
      key: "BASELINE",
      scope: "global",
      secret: false,
    },
  };
  input.managedValues.web = {
    EMPTY: "",
    SOURCE: "owner-$value",
    REMOVED: "unused private-sentinel",
    BASELINE: "false",
  };
  expect(renderNativeCompose(input).document.services.web!.environment).toEqual(
    {
      LITERAL: "$${HOSTILE:-replace}",
      EMPTY: "",
      FALLBACK: "",
      RENAMED: "owner-$$value",
      SOURCE: "public replacement",
      BASELINE: "false",
    }
  );
  expect(renderNativeCompose(input).json).not.toContain("private-sentinel");
});

test("HTTP and HTTPS service/external endpoints render explicit qualified URIs", () => {
  const input = composeFixture({
    services: {
      web: {
        image: "fixture/web:1",
        environment: {
          API: {
            endpoint: {
              kind: "service",
              name: "api",
              port: 8443,
              protocol: "https",
            },
          },
          EXTERNAL: { endpoint: { kind: "host_binding", name: "external" } },
        },
      },
      api: { image: "fixture/api:1" },
    },
  });
  input.environmentPlan.workloads.web = {
    API: {
      kind: "endpoint",
      reference: {
        kind: "service",
        name: "api",
        port: 8443,
        protocol: "https",
      },
      target: { kind: "service", name: "api", port: 8443, protocol: "https" },
    },
    EXTERNAL: {
      kind: "endpoint",
      reference: { kind: "host_binding", name: "external" },
      target: {
        kind: "external",
        hostname: "[::1]",
        port: 8080,
        protocol: "http",
      },
    },
  };
  expect(renderNativeCompose(input).document.services.web!.environment).toEqual(
    { API: "https://api:8443", EXTERNAL: "http://[::1]:8080" }
  );
});

test("route, host gateway and TCP endpoint intent refuses without inventing an address convention", () => {
  const cases: EnvironmentBinding[] = [
    {
      kind: "endpoint",
      reference: { kind: "route", name: "web" },
      target: { kind: "route", origin: "https://fixture.hack.local" },
    },
    {
      kind: "endpoint",
      reference: { kind: "host_binding", name: "database" },
      target: {
        kind: "host",
        context: "workload",
        port: 5432,
        protocol: "tcp",
      },
    },
    {
      kind: "endpoint",
      reference: { kind: "service", name: "web", port: 5432, protocol: "tcp" },
      target: { kind: "service", name: "web", port: 5432, protocol: "tcp" },
    },
  ];
  for (const binding of cases) {
    if (binding.kind !== "endpoint") {
      throw new Error("Expected endpoint fixture");
    }
    const input = composeFixture();
    input.plan.services.web!.environment = {
      URL: { endpoint: binding.reference },
    };
    input.environmentPlan.workloads.web = { URL: binding };
    refuses(() => renderNativeCompose(input));
  }
});

test("persistent resource names isolate worktrees and avoid ambiguous concatenation", () => {
  const a = composeFixture();
  a.plan.storage.data = { kind: "persistent", scope: "worktree" };
  const b = structuredClone(a);
  b.runtimeIdentity = "nc03-fixture-b";
  expect(renderNativeCompose(a).document.volumes.data).not.toEqual(
    renderNativeCompose(b).document.volumes.data
  );
  const left = composeFixture();
  left.runtimeIdentity = "runtime_a";
  left.plan.storage.b = { kind: "persistent", scope: "worktree" };
  const right = composeFixture();
  right.runtimeIdentity = "runtime";
  right.plan.storage.a_b = { kind: "persistent", scope: "worktree" };
  expect(renderNativeCompose(left).document.volumes.b).not.toEqual(
    renderNativeCompose(right).document.volumes.a_b
  );
});

test("map order is deterministic and every dollar remains escaped", () => {
  const a = composeFixture({
    services: {
      z: { image: "fixture/z:1" },
      a: {
        image: "fixture/a:1",
        command: { exec: ["server", "${AMBIENT}", "$", "$$"] },
      },
    },
  });
  const b = {
    ...a,
    plan: {
      ...a.plan,
      services: { a: a.plan.services.a!, z: a.plan.services.z! },
    },
    managedValues: { a: {}, z: {} },
  };
  expect(renderNativeCompose(a).json).toBe(renderNativeCompose(b).json);
  expect(renderNativeCompose(a).document.services.a!.command).toEqual([
    "server",
    "$${AMBIENT}",
    "$$",
    "$$$$",
  ]);
  expect(a.plan.services.a!.command).toEqual({
    exec: ["server", "${AMBIENT}", "$", "$$"],
  });
});

test("actual shell entrypoint forwards every command argument and missing sentinel is a negative control", () => {
  const input = composeFixture({
    services: {
      web: {
        image: "fixture/web:1",
        entrypoint: { shell: 'exec "$@"' },
        command: {
          exec: [
            "/bin/sh",
            "-c",
            'printf \'[%s]\\n\' "$0" "$@"',
            "first",
            "second",
            "",
          ],
        },
      },
    },
  });
  const result = renderNativeCompose(input);
  const entrypoint = result.document.services.web!.entrypoint;
  const command = result.document.services.web!.command;
  if (
    !(
      Array.isArray(entrypoint) &&
      entrypoint.every((value) => typeof value === "string") &&
      Array.isArray(command) &&
      command.every((value) => typeof value === "string")
    )
  ) {
    throw new Error("Expected private argv fixture");
  }
  // Decode this known escaped fixture once; real Compose interpolation is tested independently.
  const logicalEntry = entrypoint.map((value) => value.replaceAll("$$", "$"));
  const logicalCommand = command.map((value) => value.replaceAll("$$", "$"));
  const positive = Bun.spawnSync([...logicalEntry, ...logicalCommand], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 1000,
  });
  expect(positive.exitCode).toBe(0);
  expect(new TextDecoder().decode(positive.stdout)).toBe(
    "[first]\n[second]\n[]\n"
  );
  const negative = Bun.spawnSync(
    [...logicalEntry.slice(0, 3), ...logicalCommand],
    { stdout: "pipe", stderr: "pipe", timeout: 1000 }
  );
  expect(negative.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(negative.stdout)).not.toBe(
    "[first]\n[second]\n[]\n"
  );
});

test("incomplete or mismatched environment and missing private values never produce partial output", () => {
  const input = composeFixture();
  refuses(() =>
    renderNativeCompose({
      ...input,
      environmentPlan: { ...input.environmentPlan, complete: false },
    })
  );
  refuses(
    () =>
      renderNativeCompose({
        ...input,
        environmentPlan: { ...input.environmentPlan, workloads: {} },
      }),
    "E_COMPOSE_ENV_NAMESPACE"
  );
  refuses(
    () =>
      renderNativeCompose({
        ...input,
        managedValues: { web: {}, extra: { TOKEN: "private-sentinel" } },
      }),
    "E_COMPOSE_VALUES_NAMESPACE"
  );
  input.environmentPlan.workloads.web = {
    TOKEN: { kind: "managed", key: "TOKEN", scope: "global", secret: true },
  };
  refuses(() => renderNativeCompose(input), "E_COMPOSE_MISSING_VALUE");
  input.managedValues.web = { TOKEN: "private-sentinel" };
  input.plan.services.web!.environment = { TOKEN: { unset: true } };
  refuses(() => renderNativeCompose(input), "E_COMPOSE_ENV_MISMATCH");
});

test("pure support preflight validates managed metadata without reading or replacing private values", () => {
  const input = composeFixture();
  input.environmentPlan.workloads.web = {
    TOKEN: { kind: "managed", key: "TOKEN", scope: "web", secret: true },
  };
  let valueReads = 0;
  const beforeDelivery = {
    ...input,
    get managedValues(): unknown {
      valueReads += 1;
      throw new Error(
        "Private owner must not be called during support preflight"
      );
    },
  };
  expect(assertNativeComposeSupported(beforeDelivery)).toBeUndefined();
  expect(valueReads).toBe(0);
  refuses(() => renderNativeCompose(input), "E_COMPOSE_MISSING_VALUE");
  input.managedValues.web = { TOKEN: "private-sentinel" };
  expect(renderNativeCompose(input).document.services.web!.environment).toEqual(
    {
      TOKEN: "private-sentinel",
    }
  );
});

test("unsupported requirements and inconsistent metadata refuse before private owner delivery", () => {
  const input = composeFixture();
  let deliveries = 0;
  const deliverAfterPreflight = (candidate: typeof input): void => {
    assertNativeComposeSupported(candidate);
    deliveries += 1;
    renderNativeCompose(candidate);
  };
  const unsupported = composeFixture({
    services: {
      web: {
        image: "fixture/web:1",
        readiness: {
          kind: "http",
          path: "/ready",
          port: 3000,
          interval: "1000ms",
          timeout: "1000ms",
          retries: 1,
        },
      },
    },
  });
  refuses(
    () => deliverAfterPreflight(unsupported),
    "E_COMPOSE_READINESS_UNSUPPORTED"
  );
  input.environmentPlan.complete = false;
  refuses(() => deliverAfterPreflight(input), "E_COMPOSE_ENV_INCOMPLETE");
  input.environmentPlan.complete = true;
  input.environmentPlan.workloads.web = {
    TOKEN: { kind: "managed", key: "TOKEN", scope: "other", secret: true },
  };
  refuses(() => deliverAfterPreflight(input), "E_COMPOSE_ENV_SCOPE");
  input.plan.services.web!.environment = { TOKEN: { literal: "expected" } };
  input.environmentPlan.workloads.web = {
    TOKEN: { kind: "literal", value: "forged" },
  };
  refuses(() => deliverAfterPreflight(input), "E_COMPOSE_ENV_MISMATCH");
  expect(deliveries).toBe(0);
});

test("complete binding warnings remain valid and no secret or warning value enters the private document", () => {
  const input = composeFixture();
  input.environmentPlan.warnings.push({
    document: "project",
    code: "missing_overlay",
    message: "Fixed warning",
    pointer: "/environment/default_overlay",
    line: 1,
    column: 1,
  });
  expect(renderNativeCompose(input).json).not.toContain("missing_overlay");
});

test("unknown versions, nulls and unowned Compose fields refuse with fixed errors", () => {
  const input = composeFixture();
  for (const plan of [
    { ...input.plan, plan_version: 2 },
    { ...input.plan, include: "private-sentinel" },
    { ...input.plan, source: null },
    {
      ...input.plan,
      services: {
        web: { image: "fixture/web:1", env_file: "private-sentinel" },
      },
    },
    {
      ...input.plan,
      services: { web: { image: "fixture/web:1", command: null } },
    },
    {
      ...input.plan,
      services: { web: { image: "fixture/web:1", init: null } },
    },
    {
      ...input.plan,
      services: {
        web: { image: "fixture/web:1", shutdown: { signal: "TERM" } },
      },
    },
  ]) {
    refuses(() => renderNativeCompose({ ...input, plan }));
  }
  for (const field of ["profiles", "mounts", "environment", "depends_on"]) {
    refuses(() =>
      renderNativeCompose({
        ...input,
        plan: {
          ...input.plan,
          services: { web: { image: "fixture/web:1", [field]: null } },
        },
      })
    );
  }
});

test("paths stay anchored to the verified checkout and traversal never creates a source directory", () => {
  const input = composeFixture();
  for (const projectRoot of [
    "relative",
    "/verified/../outside",
    "/verified/checkout/",
    "C:\\private-sentinel",
  ]) {
    refuses(
      () => renderNativeCompose({ ...input, projectRoot }),
      "E_COMPOSE_ROOT"
    );
  }
  for (const source of [
    "../outside",
    "/absolute",
    "dir/../outside",
    "dir\\private-sentinel",
    "./dir",
    "dir//nested",
  ]) {
    input.plan.services.web!.mounts = [
      { source, target: "/app", access: "read-write" },
    ];
    refuses(() => renderNativeCompose(input), "E_COMPOSE_PATH");
  }
});

test("HTTP/TCP readiness and unhealthy ready dependencies refuse instead of guessing tools", () => {
  const input = composeFixture();
  for (const readiness of [
    {
      kind: "http" as const,
      port: 3000,
      path: "/",
      interval: "1000ms",
      timeout: "1000ms",
      retries: 1,
    },
    {
      kind: "tcp" as const,
      port: 3000,
      interval: "1000ms",
      timeout: "1000ms",
      retries: 1,
    },
  ]) {
    input.plan.services.web!.readiness = readiness;
    refuses(
      () => renderNativeCompose(input),
      "E_COMPOSE_READINESS_UNSUPPORTED"
    );
  }
  input.plan.services.web = { image: "fixture/web:1" };
  input.plan.services.other = {
    image: "fixture/other:1",
    depends_on: [{ service: "web", condition: "ready" }],
  };
  input.environmentPlan.workloads.other = {};
  input.managedValues.other = {};
  refuses(() => renderNativeCompose(input), "E_COMPOSE_DEPENDENCY_READINESS");
  input.plan.services.other.depends_on = [
    { service: "constructor", condition: "started" },
  ];
  refuses(() => renderNativeCompose(input), "E_COMPOSE_DEPENDENCY");
});

test("nonempty host hooks/processes and authored routing require their separate owner", () => {
  const input = composeFixture();
  for (const host of [
    {
      up: {
        before: [{ name: "hook", command: { exec: ["private-sentinel"] } }],
      },
    },
    { processes: { tunnel: { command: { shell: "private-sentinel" } } } },
  ]) {
    refuses(
      () => renderNativeCompose({ ...input, plan: { ...input.plan, host } }),
      "E_COMPOSE_HOST_OWNER"
    );
  }
  expect(
    renderNativeCompose({
      ...input,
      plan: {
        ...input.plan,
        host: { up: { before: [], after: [] }, processes: {} },
      },
    }).document.services.web
  ).toBeDefined();
  for (const extension of [{ routes: {} }, { open: {} }]) {
    refuses(
      () =>
        renderNativeCompose({
          ...input,
          plan: { ...input.plan, ...extension },
        }),
      "E_COMPOSE_ROUTING_OWNER"
    );
  }
});

test("forged binding destinations and cross-workload scopes refuse before private value delivery", () => {
  const input = composeFixture();
  input.managedValues.web = { TOKEN: "private-sentinel" };
  input.environmentPlan.workloads.web = {
    RENAMED: { kind: "managed", key: "TOKEN", scope: "global", secret: true },
  };
  refuses(() => renderNativeCompose(input), "E_COMPOSE_ENV_MISMATCH");
  input.environmentPlan.workloads.web = {
    TOKEN: { kind: "managed", key: "TOKEN", scope: "other", secret: true },
  };
  refuses(() => renderNativeCompose(input), "E_COMPOSE_ENV_SCOPE");
  input.environmentPlan.workloads.web = {
    URL: {
      kind: "endpoint",
      reference: { kind: "host_binding", name: "unowned" },
      target: {
        kind: "external",
        hostname: "example.com",
        port: 443,
        protocol: "https",
      },
    },
  };
  refuses(() => renderNativeCompose(input), "E_COMPOSE_ENV_MISMATCH");
});

test("prototype-like authored keys and workload names preserve their own namespace", () => {
  const input = composeFixture({
    jobs: { constructor: { image: "fixture/check:1" } },
  });
  input.plan.services.web!.environment = Object.fromEntries([
    ["__proto__", { unset: true }],
    ["constructor", { literal: "own value" }],
  ]);
  input.environmentPlan.workloads.web = Object.fromEntries([
    ["constructor", { kind: "literal", value: "own value" }],
  ]);
  expect(renderNativeCompose(input).document.services.web!.environment).toEqual(
    { constructor: "own value" }
  );
  expect(
    renderNativeCompose(input).document.services.constructor
  ).toMatchObject({ image: "fixture/check:1" });
});

test("supplied baseline presence prevents forged default, remapped and endpoint replacement", () => {
  const input = composeFixture();
  input.managedValues.web = {
    TOKEN: "private-sentinel",
    SOURCE: "private-sentinel",
  };
  input.plan.services.web!.environment = { TOKEN: { default: "fallback" } };
  input.environmentPlan.workloads.web = {
    TOKEN: { kind: "default", value: "fallback" },
  };
  refuses(() => renderNativeCompose(input), "E_COMPOSE_ENV_MISMATCH");
  input.plan.services.web!.environment = { TOKEN: { env_ref: "SOURCE" } };
  input.environmentPlan.workloads.web = {
    TOKEN: { kind: "managed", key: "SOURCE", scope: "global", secret: true },
  };
  refuses(() => renderNativeCompose(input), "E_COMPOSE_ENV_MISMATCH");
  input.plan.services.web!.environment = {
    TOKEN: {
      endpoint: { kind: "service", name: "web", port: 3000, protocol: "http" },
    },
  };
  input.environmentPlan.workloads.web = {
    TOKEN: {
      kind: "endpoint",
      reference: { kind: "service", name: "web", port: 3000, protocol: "http" },
      target: { kind: "service", name: "web", port: 3000, protocol: "http" },
    },
  };
  refuses(() => renderNativeCompose(input), "E_COMPOSE_ENV_MISMATCH");
});

test("owner generation labels change containers but preserve persistent data/network identity", () => {
  const input = composeFixture();
  input.plan.storage.data = { kind: "persistent", scope: "worktree" };
  const first = renderNativeCompose(input);
  const next = renderNativeCompose({
    ...input,
    generationIdentity: "b".repeat(32),
  });
  expect(next.document.services.web!.labels).toEqual({
    ...LABELS,
    "io.hack.native-config.generation": "b".repeat(32),
  });
  expect(next.document.volumes).toEqual(first.document.volumes);
  expect(next.document.networks).toEqual(first.document.networks);
  for (const generationIdentity of [
    "",
    "a".repeat(64),
    "A".repeat(32),
    "private-sentinel",
  ]) {
    refuses(
      () => renderNativeCompose({ ...input, generationIdentity }),
      "E_COMPOSE_IDENTITY"
    );
  }
  refuses(
    () =>
      renderNativeCompose({
        ...input,
        plan: {
          ...input.plan,
          services: { web: { image: "fixture/web:1", labels: LABELS } },
        },
      }),
    "E_COMPOSE_UNKNOWN_FIELD"
  );
});

test("a new private-store owner changes all resource ownership labels but retains persistent names", () => {
  const input = composeFixture({
    jobs: { check: { image: "fixture/check:1" } },
  });
  input.plan.storage.data = { kind: "persistent", scope: "worktree" };
  const first = renderNativeCompose(input);
  const replacement = renderNativeCompose({
    ...input,
    ownerToken: "d".repeat(32),
  });
  expect(replacement.document.volumes.data!.name).toBe(
    first.document.volumes.data!.name
  );
  expect(replacement.document.networks.default!.name).toBe(
    first.document.networks.default!.name
  );
  for (const resource of [
    replacement.document.services.web,
    replacement.document.services.check,
    replacement.document.volumes.data,
    replacement.document.networks.default,
  ]) {
    expect(resource!.labels).toMatchObject({
      "io.hack.native-config.owner": "d".repeat(32),
    });
  }
  expect(first.document.services.web!.labels).toEqual(LABELS);
  expect(replacement.document.volumes).not.toEqual(first.document.volumes);
  expect(replacement.document.networks).not.toEqual(first.document.networks);
  for (const ownerToken of [
    "",
    "A".repeat(32),
    "c".repeat(64),
    "private-sentinel",
  ]) {
    refuses(
      () => assertNativeComposeSupported({ ...input, ownerToken }),
      "E_COMPOSE_IDENTITY"
    );
    refuses(
      () => renderNativeCompose({ ...input, ownerToken }),
      "E_COMPOSE_IDENTITY"
    );
  }
});

test("selected authored namespace distinguishes jobs from services independently of restart intent", () => {
  const input = composeFixture({
    services: { web: { image: "fixture/web:1", restart: { kind: "no" } } },
    jobs: { check: { image: "fixture/check:1", restart: { kind: "no" } } },
  });
  input.plan.storage.data = { kind: "persistent", scope: "worktree" };
  const { document } = renderNativeCompose(input);
  expect(document.services.web!.restart).toBe("no");
  expect(document.services.check!.restart).toBe("no");
  expect(document.services.web!.labels).toMatchObject({
    "io.hack.native-config.workload": "service",
  });
  expect(document.services.check!.labels).toMatchObject({
    "io.hack.native-config.workload": "job",
  });
  expect(document.volumes.data!.labels).toEqual({
    ...RESOURCE_LABELS,
    "io.hack.native-config.storage": "data",
  });
  expect(document.networks.default!.labels).toEqual(RESOURCE_LABELS);
});

test("all canonical acquisition policies preserve exact source intent including latest", () => {
  for (const pull_policy of ["always", "never", "missing"] as const) {
    const input = composeFixture({
      services: { web: { image: "fixture/web:latest", pull_policy } },
      jobs: { check: { image: "fixture/check:1", pull_policy } },
    });
    const result = renderNativeCompose(input);
    expect(result.document.services.web).toMatchObject({
      image: "fixture/web:latest",
      pull_policy,
    });
    expect(result.document.services.check).toMatchObject({
      image: "fixture/check:1",
      pull_policy,
    });
  }
  const input = composeFixture({
    services: {
      web: {
        build: { context: "web", dockerfile: "Dockerfile" },
        pull_policy: "build",
      },
    },
    jobs: {
      check: {
        build: { context: "check", dockerfile: "Dockerfile" },
        pull_policy: "build",
      },
    },
  });
  expect(renderNativeCompose(input).document.services.web).toMatchObject({
    build: { context: "/verified/checkout/web" },
    pull_policy: "build",
  });
  expect(renderNativeCompose(input).document.services.check).toMatchObject({
    build: { context: "/verified/checkout/check" },
    pull_policy: "build",
  });
  expect(
    renderNativeCompose(composeFixture()).document.services.web
  ).not.toHaveProperty("pull_policy");
});

test("acquisition aliases, types and incompatible sources refuse without inference", () => {
  const input = composeFixture();
  for (const pull_policy of [
    null,
    false,
    1,
    ["always"],
    { always: null },
    "if_not_present",
    "daily",
    "weekly",
    "every_12h",
    "private-sentinel",
  ]) {
    refuses(
      () =>
        renderNativeCompose({
          ...input,
          plan: {
            ...input.plan,
            services: { web: { image: "fixture/web:1", pull_policy } },
          },
        }),
      "E_COMPOSE_PULL_POLICY"
    );
  }
  for (const workload of [
    { image: "fixture/web:1", pull_policy: "build" },
    {
      build: { context: ".", dockerfile: "Dockerfile" },
      pull_policy: "missing",
    },
    {
      image: "fixture/web:1",
      build: { context: ".", dockerfile: "Dockerfile" },
    },
  ]) {
    refuses(() =>
      renderNativeCompose({
        ...input,
        plan: { ...input.plan, services: { web: workload } },
      })
    );
  }
});
