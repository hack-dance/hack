import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compileNativeConfig,
  NATIVE_CONFIG_INPUT_LIMIT,
  NativeConfigCompilerError,
  planNativeConfig,
  resolveNativeConfig,
} from "../src/lib/native-config-compiler.ts";
import {
  type NativeEnvMetadata,
  parseNativeEnvMetadata,
} from "../src/lib/native-env-plan-protocol.ts";
import { planNativeProject } from "../src/lib/native-project-validation.ts";
import { restoreEnv } from "./helpers/env.ts";

const PROTOCOL = {
  transport_version: 1,
  authored_version: 1,
  plan_version: 1,
  resolve_version: 1,
  local_version: 1,
  env_plan_version: 1,
  host_env_plan_version: 1,
};
const { host_env_plan_version, ...HOSTLESS_PROTOCOL } = PROTOCOL;
void host_env_plan_version;
const INPUT = new TextEncoder().encode('{"schema_version":1,"name":"fixture"}');
const CANARY = "host-wire-private-canary";
const HOSTLESS_METADATA = {
  metadata_version: 1,
  overlay: "qa",
  overlay_exists: true,
  workloads: { web: { TOKEN: { scope: "web", secret: true } } },
  inactive_scopes: [],
} as const satisfies NativeEnvMetadata;
const HOST_METADATA = {
  ...HOSTLESS_METADATA,
  host: {
    default: { HOST_TOKEN: { scope: "host", secret: true } },
    workloads: {
      seed: { SEED_TOKEN: { scope: "seed", secret: true } },
      web: { TOKEN: { scope: "web", secret: true } },
    },
  },
} as const satisfies NativeEnvMetadata;
const HOST_TARGET = { kind: "host" } as const;
const WEB_TARGET = { kind: "workload", name: "web" } as const;
const SEED_TARGET = { kind: "workload", name: "seed" } as const;
const HOST_TARGETS = {
  include_default: true,
  workloads: ["seed", "web"],
};
const INVOCATION = {
  command: ["printf", "fixture"],
  cwd: ".",
  environment: {},
};
const HOST_PLAN = {
  up: {
    before: [
      { ...INVOCATION, name: "web", env_target: HOST_TARGET },
      { ...INVOCATION, name: "prepare", env_target: SEED_TARGET },
    ],
    after: [{ ...INVOCATION, name: "after-up", env_target: WEB_TARGET }],
  },
  down: {
    before: [{ ...INVOCATION, name: "before-down", env_target: HOST_TARGET }],
    after: [{ ...INVOCATION, name: "after-down", env_target: WEB_TARGET }],
  },
  processes: {
    watch: {
      ...INVOCATION,
      env_target: WEB_TARGET,
      startup: "up",
      exit: "stop_on_down",
    },
  },
};
const HOST_BINDING = {
  kind: "managed",
  key: "HOST_TOKEN",
  scope: "host",
  secret: true,
} as const;
const HOST_WEB_REPORT = {
  env_target: HOST_TARGET,
  bindings: {
    HOST_TOKEN: HOST_BINDING,
    MODE: { kind: "literal", value: "host-web" },
  },
} as const;
const HOST_REPORT = {
  web: HOST_WEB_REPORT,
  prepare: {
    env_target: SEED_TARGET,
    bindings: {
      TOKEN: {
        kind: "managed",
        key: "SEED_TOKEN",
        scope: "seed",
        secret: true,
      },
    },
  },
  "after-up": { env_target: WEB_TARGET, bindings: {} },
  "before-down": { env_target: HOST_TARGET, bindings: {} },
  "after-down": { env_target: WEB_TARGET, bindings: {} },
  watch: {
    env_target: WEB_TARGET,
    bindings: { retries: { kind: "default", value: "3" } },
  },
} as const;
const HOSTLESS_SUCCESS = {
  transport_version: 1,
  ok: true,
  plan: { plan_version: 1, services: { web: {} }, jobs: {} },
  semantic_hash: "a".repeat(64),
  declared_workloads: { web: "service", seed: "job", unused: "service" },
  local_resolution: {
    overlay: "qa",
    origin: "checkout_local",
    auto_branch: true,
    inherit_local: true,
    resolution_hash: "b".repeat(64),
  },
  environment_plan: {
    plan_version: 1,
    overlay: "qa",
    overlay_exists: true,
    complete: true,
    workloads: { web: { MODE: { kind: "literal", value: "workload-web" } } },
    warnings: [],
    diagnostics: [],
  },
} as const;
const SUCCESS = {
  ...HOSTLESS_SUCCESS,
  plan: { ...HOSTLESS_SUCCESS.plan, host: HOST_PLAN },
  host_env_targets: HOST_TARGETS,
  environment_plan: { ...HOSTLESS_SUCCESS.environment_plan, host: HOST_REPORT },
};
let directory = "";

beforeEach(async () => {
  directory = await realpath(
    await mkdtemp(join(tmpdir(), "hack-host-plan-transport-"))
  );
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function fixture(opts: {
  readonly response?: unknown;
  readonly protocol?: Readonly<Record<string, unknown>>;
  readonly body?: string;
  readonly onInvocation?: string;
  readonly exitCode?: number;
}): Promise<string> {
  const path = join(directory, "compiler");
  const body =
    opts.body ??
    `process.stdout.write(${JSON.stringify(JSON.stringify(opts.response ?? SUCCESS))}); process.stderr.write(${JSON.stringify(CANARY)}); process.exitCode=${opts.exitCode ?? 0};`;
  await Bun.write(
    path,
    `#!${process.execPath}\n${opts.onInvocation ?? ""}\nif (process.argv[2] === '--protocol') { process.stdout.write(${JSON.stringify(JSON.stringify(opts.protocol ?? PROTOCOL))}); } else { ${body} }\n`
  );
  await chmod(path, 0o755);
  return path;
}

async function expectFailure(opts: {
  readonly operation: Promise<unknown>;
  readonly code: string;
  readonly message?: string;
}): Promise<void> {
  const error: unknown = await opts.operation.catch((value: unknown) => value);
  expect(error).toBeInstanceOf(NativeConfigCompilerError);
  if (!(error instanceof NativeConfigCompilerError)) {
    throw new Error("Expected a fixed host planning transport failure");
  }
  expect(error.code).toBe(opts.code);
  if (opts.message !== undefined) {
    expect(error.message).toBe(opts.message);
  }
  expect(error.message).not.toContain(CANARY);
  expect(error.message).not.toContain(directory);
}

function withHostReport(host: unknown): Record<string, unknown> {
  return {
    ...SUCCESS,
    environment_plan: { ...SUCCESS.environment_plan, host },
  };
}

test.each([
  { name: "missing", version: undefined },
  { name: "null", version: null },
  { name: "unsupported", version: 2 },
])("requires host capability before any payload: $name", async ({
  version,
}) => {
  const receipt = join(directory, "payload-receipt");
  const protocolReceipt = join(directory, "protocol-input-receipt");
  const binary = await fixture({
    protocol: { ...PROTOCOL, host_env_plan_version: version },
    onInvocation: `if (process.argv[2] === '--protocol') { await Bun.write(${JSON.stringify(protocolReceipt)}, await Bun.stdin.text()); }`,
    body: `await Bun.write(${JSON.stringify(receipt)}, await Bun.stdin.text());`,
  });
  for (const operation of [
    () =>
      compileNativeConfig({ input: INPUT, binary, requireHostPlanning: true }),
    () =>
      resolveNativeConfig({ input: INPUT, binary, requireHostPlanning: true }),
    () =>
      planNativeConfig({ input: INPUT, binary, envMetadata: HOST_METADATA }),
    () =>
      planNativeConfig({
        input: INPUT,
        binary,
        envMetadata: { ...HOSTLESS_METADATA, host: { workloads: {} } },
      }),
  ]) {
    await expectFailure({
      operation: operation(),
      code: "E_COMPILER_VERSION",
      message: "Native configuration compiler version mismatch.",
    });
    expect(await Bun.file(protocolReceipt).text()).toBe("");
    expect(await Bun.file(receipt).exists()).toBe(false);
  }
});

test.each([
  { name: "older env v1", protocol: HOSTLESS_PROTOCOL },
  { name: "host-capable", protocol: PROTOCOL },
])("keeps hostless compile, resolve, and env planning compatible: $name", async ({
  protocol,
}) => {
  const binary = await fixture({ protocol, response: HOSTLESS_SUCCESS });
  expect((await compileNativeConfig({ input: INPUT, binary })).ok).toBe(true);
  expect((await resolveNativeConfig({ input: INPUT, binary })).ok).toBe(true);
  expect(
    await planNativeConfig({
      input: INPUT,
      binary,
      envMetadata: HOSTLESS_METADATA,
    })
  ).toEqual(HOSTLESS_SUCCESS);
});

test("projects host targets through compile and resolve without a host report", async () => {
  const { environment_plan, ...response } = SUCCESS;
  void environment_plan;
  const binary = await fixture({ response });
  for (const result of [
    await compileNativeConfig({
      input: INPUT,
      binary,
      requireHostPlanning: true,
    }),
    await resolveNativeConfig({
      input: INPUT,
      binary,
      requireHostPlanning: true,
    }),
  ]) {
    expect(result.ok).toBe(true);
    expect(result).toHaveProperty("host_env_targets", HOST_TARGETS);
    expect(result).not.toHaveProperty("environment_plan");
  }
});

test("keeps host and workload names separate across hooks and processes with raw documents and PATH-only env", async () => {
  const projectText = '\ufeff{"name":"first","name":"second"}\n';
  const localText = "null\n";
  const input = new TextEncoder().encode(projectText);
  const checkoutLocal = new TextEncoder().encode(localText);
  const originalInput = input.slice();
  const originalLocal = checkoutLocal.slice();
  const metadata = Object.freeze({
    ...HOST_METADATA,
    host: Object.freeze({
      default: Object.freeze(HOST_METADATA.host.default),
      workloads: Object.freeze(HOST_METADATA.host.workloads),
    }),
  });
  const originalMetadata = JSON.stringify(metadata);
  const originalEnv = process.env.HACK_TEST_HOST_PLAN_PRIVATE;
  process.env.HACK_TEST_HOST_PLAN_PRIVATE = CANARY;
  try {
    const binary = await fixture({
      body: `const received=JSON.parse(await Bun.stdin.text()); const result=${JSON.stringify(SUCCESS)}; result.plan.received=received; result.plan.arguments=process.argv.slice(2); result.plan.environment=process.env; process.stdout.write(JSON.stringify(result));`,
    });
    const result = await planNativeConfig({
      input,
      checkoutLocal,
      explicitOverlay: null,
      envMetadata: metadata,
      binary,
      profiles: ["with spaces", "--unsafe"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Expected host planning success");
    }
    expect(result.plan.received).toEqual({
      request_version: 1,
      project: projectText,
      checkout_local: localText,
      explicit_overlay: null,
      env_metadata: metadata,
    });
    expect(result.plan.arguments).toEqual([
      "plan",
      "--profile",
      "with spaces",
      "--profile",
      "--unsafe",
    ]);
    expect(result.plan.environment).toEqual({ PATH: "/usr/bin:/bin" });
    expect(result.environment_plan).toEqual(SUCCESS.environment_plan);
    expect(result).toHaveProperty("host_env_targets", HOST_TARGETS);
    expect(input).toEqual(originalInput);
    expect(checkoutLocal).toEqual(originalLocal);
    expect(JSON.stringify(metadata)).toBe(originalMetadata);
  } finally {
    restoreEnv("HACK_TEST_HOST_PLAN_PRIVATE", originalEnv);
  }
});

test("accepts workload-only host targeting without requesting the default scope", async () => {
  const response = {
    ...SUCCESS,
    plan: {
      ...HOSTLESS_SUCCESS.plan,
      host: {
        up: {
          before: [{ ...INVOCATION, name: "web", env_target: WEB_TARGET }],
        },
      },
    },
    host_env_targets: { include_default: false, workloads: ["web"] },
    environment_plan: {
      ...SUCCESS.environment_plan,
      host: { web: { env_target: WEB_TARGET, bindings: {} } },
    },
  };
  const binary = await fixture({ response });
  expect(
    await planNativeConfig({
      input: INPUT,
      binary,
      envMetadata: { ...HOSTLESS_METADATA, host: { workloads: { web: {} } } },
    })
  ).toEqual(response);
});

test("accepts default-only host targeting with empty metadata maps", async () => {
  const response = {
    ...SUCCESS,
    plan: {
      ...HOSTLESS_SUCCESS.plan,
      host: {
        processes: {
          watch: { ...HOST_PLAN.processes.watch, env_target: HOST_TARGET },
        },
      },
    },
    host_env_targets: { include_default: true, workloads: [] },
    environment_plan: {
      ...SUCCESS.environment_plan,
      host: { watch: { env_target: HOST_TARGET, bindings: {} } },
    },
  };
  const binary = await fixture({ response });
  expect(
    await planNativeConfig({
      input: INPUT,
      binary,
      envMetadata: {
        ...HOSTLESS_METADATA,
        host: { default: {}, workloads: {} },
      },
    })
  ).toEqual(response);
});

test.each([
  "value",
  "ciphertext",
  "path",
])("refuses sensitive extra host metadata %s before spawning", async (field) => {
  const receipt = join(directory, "spawn-receipt");
  const binary = await fixture({
    onInvocation: `await Bun.write(${JSON.stringify(receipt)}, 'spawned');`,
  });
  for (const host of [
    { ...HOST_METADATA.host, [field]: CANARY },
    {
      ...HOST_METADATA.host,
      default: { HOST_TOKEN: { scope: "host", secret: true, [field]: CANARY } },
    },
    {
      ...HOST_METADATA.host,
      workloads: {
        ...HOST_METADATA.host.workloads,
        web: { TOKEN: { scope: "web", secret: true, [field]: CANARY } },
      },
    },
  ]) {
    await expectFailure({
      operation: planNativeConfig({
        input: INPUT,
        binary,
        envMetadata: { ...HOSTLESS_METADATA, host },
      }),
      code: "E_CONFIG_METADATA",
      message:
        "Native environment metadata is invalid or exceeds its budget; values omitted.",
    });
    expect(await Bun.file(receipt).exists()).toBe(false);
  }
});

test("bounds host metadata before spawning", async () => {
  const receipt = join(directory, "spawn-receipt");
  const binary = await fixture({
    onInvocation: `await Bun.write(${JSON.stringify(receipt)}, 'spawned');`,
  });
  await expectFailure({
    operation: planNativeConfig({
      input: INPUT,
      binary,
      envMetadata: {
        ...HOST_METADATA,
        host: {
          ...HOST_METADATA.host,
          default: {
            ["X".repeat(NATIVE_CONFIG_INPUT_LIMIT)]: {
              scope: "host",
              secret: false,
            },
          },
        },
      },
    }),
    code: "E_CONFIG_METADATA",
    message:
      "Native environment metadata is invalid or exceeds its budget; values omitted.",
  });
  expect(await Bun.file(receipt).exists()).toBe(false);
});

test.each([
  { name: "null", host: null },
  { name: "array", host: [] },
  { name: "missing workload maps", host: { default: {} } },
  { name: "default map array", host: { default: [], workloads: {} } },
  { name: "workload maps array", host: { workloads: [] } },
  { name: "noncanonical target", host: { workloads: { Web: {} } } },
  {
    name: "invalid binding key",
    host: {
      default: { lowercase: { scope: "host", secret: true } },
      workloads: {},
    },
  },
  {
    name: "invalid scope",
    host: {
      workloads: { web: { TOKEN: { scope: "../private", secret: true } } },
    },
  },
  {
    name: "invalid secret flag",
    host: { workloads: { web: { TOKEN: { scope: "web", secret: CANARY } } } },
  },
])("rejects malformed host metadata shape: $name", ({ host }) => {
  expect(parseNativeEnvMetadata({ ...HOSTLESS_METADATA, host })).toBeNull();
});

test("preserves Rust ownership of requested metadata completeness diagnostics", async () => {
  const response = {
    transport_version: 1,
    ok: false,
    diagnostics: [
      {
        document: "request",
        code: "invalid_metadata",
        pointer: "/env_metadata/host",
        message: "Environment metadata does not match selected targets.",
        line: 1,
        column: 1,
      },
    ],
  } as const;
  const binary = await fixture({ response, exitCode: 1 });
  expect(
    await planNativeConfig({
      input: INPUT,
      binary,
      envMetadata: { ...HOSTLESS_METADATA, host: { workloads: {} } },
    })
  ).toEqual(response);
});

test.each([
  { name: "missing", targets: undefined },
  { name: "null", targets: null },
  {
    name: "nonboolean default",
    targets: { ...HOST_TARGETS, include_default: 1 },
  },
  { name: "nonarray targets", targets: { ...HOST_TARGETS, workloads: "web" } },
  {
    name: "unknown sensitive field",
    targets: { ...HOST_TARGETS, path: CANARY },
  },
  {
    name: "noncanonical name",
    targets: { ...HOST_TARGETS, workloads: ["Web"] },
  },
  {
    name: "duplicate names",
    targets: { ...HOST_TARGETS, workloads: ["web", "web"] },
  },
  {
    name: "unsorted names",
    targets: { ...HOST_TARGETS, workloads: ["web", "seed"] },
  },
  {
    name: "undeclared target",
    targets: { ...HOST_TARGETS, workloads: ["ghost"] },
  },
  {
    name: "missing requested target",
    targets: { ...HOST_TARGETS, workloads: ["web"] },
  },
  {
    name: "extra requested target",
    targets: { ...HOST_TARGETS, workloads: ["seed", "unused", "web"] },
  },
  {
    name: "default flag mismatch",
    targets: { ...HOST_TARGETS, include_default: false },
  },
])("rejects malformed host target projection in compile and resolve: $name", async ({
  targets,
}) => {
  const binary = await fixture({
    response: { ...SUCCESS, host_env_targets: targets },
  });
  for (const operation of [
    () =>
      compileNativeConfig({ input: INPUT, binary, requireHostPlanning: true }),
    () =>
      resolveNativeConfig({ input: INPUT, binary, requireHostPlanning: true }),
  ]) {
    await expectFailure({
      operation: operation(),
      code: "E_COMPILER_RESPONSE",
    });
  }
});

test.each([
  { name: "missing host report", response: withHostReport(undefined) },
  { name: "empty host report", response: withHostReport({}) },
  { name: "null host report", response: withHostReport(null) },
  { name: "array host report", response: withHostReport([]) },
  {
    name: "extra host name",
    response: withHostReport({ ...HOST_REPORT, extra: HOST_WEB_REPORT }),
  },
  {
    name: "missing host name",
    response: withHostReport({ ...HOST_REPORT, watch: undefined }),
  },
  {
    name: "host report without host plan",
    response: {
      ...SUCCESS,
      plan: HOSTLESS_SUCCESS.plan,
      host_env_targets: { include_default: false, workloads: [] },
    },
  },
  {
    name: "host report with empty host plan",
    response: {
      ...SUCCESS,
      plan: { ...HOSTLESS_SUCCESS.plan, host: {} },
      host_env_targets: { include_default: false, workloads: [] },
    },
  },
  {
    name: "host target mismatch",
    response: withHostReport({
      ...HOST_REPORT,
      web: { ...HOST_WEB_REPORT, env_target: WEB_TARGET },
    }),
  },
  {
    name: "workload target mismatch",
    response: withHostReport({
      ...HOST_REPORT,
      prepare: { ...HOST_REPORT.prepare, env_target: WEB_TARGET },
    }),
  },
  {
    name: "undeclared workload target",
    response: withHostReport({
      ...HOST_REPORT,
      watch: {
        ...HOST_REPORT.watch,
        env_target: { kind: "workload", name: "ghost" },
      },
    }),
  },
  {
    name: "malformed target kind",
    response: withHostReport({
      ...HOST_REPORT,
      web: { ...HOST_WEB_REPORT, env_target: { kind: CANARY } },
    }),
  },
  {
    name: "host target extra name",
    response: withHostReport({
      ...HOST_REPORT,
      web: { ...HOST_WEB_REPORT, env_target: { kind: "host", name: "web" } },
    }),
  },
  {
    name: "workload target extra path",
    response: withHostReport({
      ...HOST_REPORT,
      watch: {
        ...HOST_REPORT.watch,
        env_target: { ...WEB_TARGET, path: CANARY },
      },
    }),
  },
  {
    name: "host entry extra ciphertext",
    response: withHostReport({
      ...HOST_REPORT,
      web: { ...HOST_WEB_REPORT, ciphertext: CANARY },
    }),
  },
  {
    name: "managed binding extra value",
    response: withHostReport({
      ...HOST_REPORT,
      web: {
        ...HOST_WEB_REPORT,
        bindings: { HOST_TOKEN: { ...HOST_BINDING, value: CANARY } },
      },
    }),
  },
  {
    name: "nonrecord bindings",
    response: withHostReport({
      ...HOST_REPORT,
      web: { ...HOST_WEB_REPORT, bindings: [] },
    }),
  },
  {
    name: "invalid destination",
    response: withHostReport({
      ...HOST_REPORT,
      web: {
        ...HOST_WEB_REPORT,
        bindings: { "invalid-key": { kind: "literal", value: CANARY } },
      },
    }),
  },
  {
    name: "declared target omitted",
    response: { ...SUCCESS, declared_workloads: { web: "service" } },
  },
  {
    name: "duplicate invocation name",
    response: {
      ...SUCCESS,
      plan: {
        ...SUCCESS.plan,
        host: {
          ...HOST_PLAN,
          processes: { ...HOST_PLAN.processes, web: HOST_PLAN.processes.watch },
        },
      },
    },
  },
])("rejects host report and normalized plan inconsistency: $name", async ({
  response,
}) => {
  const binary = await fixture({ response });
  await expectFailure({
    operation: planNativeConfig({
      input: INPUT,
      binary,
      envMetadata: HOST_METADATA,
    }),
    code: "E_COMPILER_RESPONSE",
  });
});

test("retains own __proto__ host bindings through JSON roundtrip and strips raw envelope extras", async () => {
  const bindings = Object.fromEntries([
    ["__proto__", { kind: "literal", value: "fixture-proto" } as const],
  ]);
  const environmentPlan = {
    ...SUCCESS.environment_plan,
    host: { ...HOST_REPORT, web: { ...HOST_WEB_REPORT, bindings } },
  };
  const binary = await fixture({
    response: {
      ...SUCCESS,
      environment_plan: environmentPlan,
      private_payload: CANARY,
    },
  });
  const result = await planNativeConfig({
    input: INPUT,
    binary,
    envMetadata: HOST_METADATA,
  });
  expect(result).toEqual({ ...SUCCESS, environment_plan: environmentPlan });
  expect(JSON.stringify(result)).not.toContain(CANARY);
  expect(result).not.toHaveProperty("envelope");
  if (!result.ok) {
    throw new Error("Expected host report with an authored own data key");
  }
  expect(
    Object.hasOwn(
      result.environment_plan.host?.web?.bindings ?? {},
      "__proto__"
    )
  ).toBe(true);
  expect(JSON.parse(JSON.stringify(result.environment_plan))).toEqual(
    environmentPlan
  );
});

async function projectWithMalformedSelectedMetadata(): Promise<string> {
  const projectRoot = join(directory, "project");
  await mkdir(join(projectRoot, ".hack"), { recursive: true });
  await Bun.write(join(projectRoot, ".hack/hack.project.json"), INPUT);
  await Bun.write(
    join(projectRoot, ".hack/hack.env.qa.yaml"),
    `version: [${CANARY}`
  );
  return projectRoot;
}

const PROJECT_SUCCESS = {
  ...SUCCESS,
  plan: { ...SUCCESS.plan, worktree: { inherit_local: false } },
  local_resolution: { ...SUCCESS.local_resolution, inherit_local: false },
};

test("project planning checks host capability before reading malformed selected YAML", async () => {
  const projectRoot = await projectWithMalformedSelectedMetadata();
  const resolveReceipt = join(directory, "resolve-receipt");
  const binary = await fixture({
    protocol: HOSTLESS_PROTOCOL,
    body: `await Bun.stdin.text(); if (process.argv[2] === 'resolve') { await Bun.write(${JSON.stringify(resolveReceipt)}, 'received'); } process.stdout.write(${JSON.stringify(JSON.stringify(PROJECT_SUCCESS))});`,
  });
  const originalBinary = process.env.HACK_CONFIG_COMPILER_BINARY;
  process.env.HACK_CONFIG_COMPILER_BINARY = binary;
  try {
    await expectFailure({
      operation: planNativeProject({ startDir: projectRoot }),
      code: "E_COMPILER_VERSION",
      message: "Native configuration compiler version mismatch.",
    });
    expect(await Bun.file(resolveReceipt).exists()).toBe(false);
    // Confirm the selected YAML is an active failure if the host handshake passes.
    await fixture({ response: PROJECT_SUCCESS });
    await expectFailure({
      operation: planNativeProject({ startDir: projectRoot }),
      code: "E_CONFIG_METADATA",
      message:
        "Cannot inspect selected managed environment metadata; values omitted.",
    });
  } finally {
    restoreEnv("HACK_CONFIG_COMPILER_BINARY", originalBinary);
  }
});

test.each([
  {
    name: "authored hash",
    resolved: { ...PROJECT_SUCCESS, semantic_hash: "c".repeat(64) },
  },
  {
    name: "host target projection",
    resolved: {
      ...PROJECT_SUCCESS,
      plan: {
        ...PROJECT_SUCCESS.plan,
        host: {
          processes: {
            watch: { ...HOST_PLAN.processes.watch, env_target: HOST_TARGET },
          },
        },
      },
      host_env_targets: { include_default: true, workloads: [] },
    },
  },
])("project planning refuses changed $name before malformed selected YAML", async ({
  resolved,
}) => {
  const projectRoot = await projectWithMalformedSelectedMetadata();
  const planReceipt = join(directory, "plan-receipt");
  const binary = await fixture({
    body: `await Bun.stdin.text(); if (process.argv[2] === 'plan') { await Bun.write(${JSON.stringify(planReceipt)}, 'received'); } process.stdout.write(JSON.stringify(process.argv[2] === 'resolve' ? ${JSON.stringify(resolved)} : ${JSON.stringify(PROJECT_SUCCESS)}));`,
  });
  const originalBinary = process.env.HACK_CONFIG_COMPILER_BINARY;
  process.env.HACK_CONFIG_COMPILER_BINARY = binary;
  try {
    await expectFailure({
      operation: planNativeProject({ startDir: projectRoot }),
      code: "E_COMPILER_RESPONSE",
      message:
        "Native local resolution changed the authored identity or host targets.",
    });
    expect(await Bun.file(planReceipt).exists()).toBe(false);
  } finally {
    restoreEnv("HACK_CONFIG_COMPILER_BINARY", originalBinary);
  }
});
