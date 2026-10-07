import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compileNativeConfig,
  NATIVE_CONFIG_INPUT_LIMIT,
  NativeConfigCompilerError,
  planNativeConfig,
  resolveNativeConfig,
} from "../src/lib/native-config-compiler.ts";
import type { NativeEnvMetadata } from "../src/lib/native-env-plan-protocol.ts";
import { restoreEnv } from "./helpers/env.ts";

const PROTOCOL = {
  transport_version: 1,
  authored_version: 1,
  plan_version: 1,
  resolve_version: 1,
  local_version: 1,
  env_plan_version: 1,
};
const INPUT = new TextEncoder().encode('{"schema_version":1,"name":"fixture"}');
const CANARY = "wire-private-canary";
const METADATA = Object.freeze({
  metadata_version: 1,
  overlay: "qa",
  overlay_exists: true,
  workloads: Object.freeze({
    web: Object.freeze({
      API_TOKEN: Object.freeze({ scope: "web", secret: true }),
    }),
  }),
  inactive_scopes: Object.freeze(["retired"]),
}) satisfies NativeEnvMetadata;
const LOCAL_RESOLUTION = {
  overlay: "qa",
  origin: "checkout_local",
  auto_branch: true,
  inherit_local: true,
  resolution_hash: "b".repeat(64),
} as const;
const DIAGNOSTIC = {
  document: "project",
  code: "missing_environment_binding",
  pointer: "/services/web/environment/API_TOKEN",
  message: "Required environment binding is missing.",
  line: 1,
  column: 1,
} as const;
const ENVIRONMENT_PLAN = {
  plan_version: 1,
  overlay: "qa",
  overlay_exists: true,
  complete: true,
  workloads: {
    web: {
      API_TOKEN: {
        kind: "managed",
        key: "API_TOKEN",
        scope: "web",
        secret: true,
      },
      MODE: { kind: "literal", value: "fixture" },
      retries: { kind: "default", value: "3" },
    },
  },
  warnings: [],
  diagnostics: [],
} as const;
const SUCCESS = {
  transport_version: 1,
  ok: true,
  plan: { plan_version: 1, services: { web: {} }, jobs: {} },
  semantic_hash: "a".repeat(64),
  declared_workloads: { web: "service", seed: "job" },
  local_resolution: LOCAL_RESOLUTION,
  environment_plan: ENVIRONMENT_PLAN,
} as const;
let directory = "";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "hack-env-plan-transport-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function fixture(opts: {
  readonly body: string;
  readonly protocol?: Readonly<Record<string, unknown>>;
  readonly onInvocation?: string;
}): Promise<string> {
  const path = join(directory, "compiler");
  await Bun.write(
    path,
    `#!${process.execPath}\n${opts.onInvocation ?? ""}\nif (process.argv[2] === '--protocol') { process.stdout.write(${JSON.stringify(JSON.stringify(opts.protocol ?? PROTOCOL))}); } else { ${opts.body} }\n`
  );
  await chmod(path, 0o755);
  return path;
}

async function responseFixture(opts: {
  readonly response: unknown;
  readonly exitCode?: number;
}): Promise<string> {
  return await fixture({
    body: `process.stdout.write(${JSON.stringify(JSON.stringify(opts.response))}); process.stderr.write(${JSON.stringify(CANARY)}); process.exitCode=${opts.exitCode ?? 0};`,
  });
}

async function expectFailure(opts: {
  readonly operation: Promise<unknown>;
  readonly code: string;
  readonly message?: string;
}): Promise<void> {
  const error: unknown = await opts.operation.catch((value: unknown) => value);
  expect(error).toBeInstanceOf(NativeConfigCompilerError);
  if (!(error instanceof NativeConfigCompilerError)) {
    throw new Error("Expected a fixed native compiler transport failure");
  }
  expect(error.code).toBe(opts.code);
  if (opts.message !== undefined) {
    expect(error.message).toBe(opts.message);
  }
  expect(error.message).not.toContain(CANARY);
  expect(error.message).not.toContain(directory);
}

test.each([
  { name: "missing", version: undefined },
  { name: "null", version: null },
  { name: "unsupported", version: 2 },
])("requires env_plan_version 1 before sending any input: $name", async ({
  version,
}) => {
  const receipt = join(directory, "input-receipt");
  const protocolReceipt = join(directory, "protocol-input-receipt");
  const binary = await fixture({
    protocol: { ...PROTOCOL, env_plan_version: version },
    onInvocation: `if (process.argv[2] === '--protocol') { await Bun.write(${JSON.stringify(protocolReceipt)}, await Bun.stdin.text()); }`,
    body: `await Bun.write(${JSON.stringify(receipt)}, await Bun.stdin.text());`,
  });
  for (const operation of [
    () => planNativeConfig({ input: INPUT, envMetadata: METADATA, binary }),
    () =>
      compileNativeConfig({ input: INPUT, binary, requireEnvPlanning: true }),
    () =>
      resolveNativeConfig({ input: INPUT, binary, requireEnvPlanning: true }),
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

test("older local-resolution compilers still compile and resolve", async () => {
  const { env_plan_version, ...protocol } = PROTOCOL;
  void env_plan_version;
  const legacyResponse = {
    transport_version: 1,
    ok: true,
    plan: { plan_version: 1 },
    semantic_hash: SUCCESS.semantic_hash,
    local_resolution: LOCAL_RESOLUTION,
  };
  const binary = await fixture({
    protocol,
    body: `const request=await Bun.stdin.text(); const result=${JSON.stringify(legacyResponse)}; result.plan.request=request; result.plan.command=process.argv[2]; process.stdout.write(JSON.stringify(result));`,
  });
  const compiled = await compileNativeConfig({ input: INPUT, binary });
  const resolved = await resolveNativeConfig({ input: INPUT, binary });
  expect(compiled.ok).toBe(true);
  expect(resolved.ok).toBe(true);
  if (!(compiled.ok && resolved.ok)) {
    throw new Error("Expected backward-compatible compile and resolve success");
  }
  expect(compiled.plan.command).toBe("compile");
  expect(compiled.plan.request).toBe(new TextDecoder().decode(INPUT));
  expect(resolved.plan.command).toBe("resolve");
  expect(JSON.parse(String(resolved.plan.request))).toEqual({
    request_version: 1,
    project: new TextDecoder().decode(INPUT),
  });
  expect(compiled).not.toHaveProperty("declared_workloads");
  expect(resolved).not.toHaveProperty("declared_workloads");
  expect(resolved).not.toHaveProperty("environment_plan");
});

test("preserves immutable original documents, tri-state selection, and PATH-only environment", async () => {
  const projectText = '\ufeff{ "name":"first", "name":"second" }\n';
  const primaryText = '\ufeff{"default_overlay":"qa","default_overlay":null}\n';
  const checkoutText = "null\n";
  const input = new TextEncoder().encode(projectText);
  const primaryLocal = new TextEncoder().encode(primaryText);
  const checkoutLocal = new TextEncoder().encode(checkoutText);
  const originals = [
    input.slice(),
    primaryLocal.slice(),
    checkoutLocal.slice(),
  ];
  const originalEnv = process.env.HACK_TEST_NATIVE_PLAN_PRIVATE;
  process.env.HACK_TEST_NATIVE_PLAN_PRIVATE = CANARY;
  try {
    const binary = await fixture({
      body: `const received=JSON.parse(await Bun.stdin.text()); const result=${JSON.stringify(SUCCESS)}; result.plan.received=received; result.plan.arguments=process.argv.slice(2); result.plan.environment=process.env; process.stdout.write(JSON.stringify(result));`,
    });
    for (const explicitOverlay of [undefined, null, "qa"]) {
      const result = await planNativeConfig({
        input,
        primaryLocal,
        checkoutLocal,
        explicitOverlay,
        envMetadata: METADATA,
        profiles: ["with spaces", "--unsafe"],
        binary,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("Expected environment planning success");
      }
      expect(result.plan.received).toEqual({
        request_version: 1,
        project: projectText,
        primary_local: primaryText,
        checkout_local: checkoutText,
        ...(explicitOverlay === undefined
          ? {}
          : { explicit_overlay: explicitOverlay }),
        env_metadata: METADATA,
      });
      expect(result.plan.arguments).toEqual([
        "plan",
        "--profile",
        "with spaces",
        "--profile",
        "--unsafe",
      ]);
      expect(result.plan.environment).toEqual({ PATH: "/usr/bin:/bin" });
      expect(result.environment_plan).toEqual(ENVIRONMENT_PLAN);
    }
    expect([input, primaryLocal, checkoutLocal]).toEqual(originals);
  } finally {
    restoreEnv("HACK_TEST_NATIVE_PLAN_PRIVATE", originalEnv);
  }
});

test.each([
  "value",
  "ciphertext",
  "path",
])("rejects extra metadata %s fields before spawning with fixed redaction", async (field) => {
  const receipt = join(directory, "spawn-receipt");
  const binary = await fixture({
    onInvocation: `await Bun.write(${JSON.stringify(receipt)}, 'spawned');`,
    body: `process.stdout.write(${JSON.stringify(JSON.stringify(SUCCESS))});`,
  });
  for (const envMetadata of [
    { ...METADATA, [field]: CANARY },
    {
      ...METADATA,
      workloads: {
        web: { API_TOKEN: { scope: "web", secret: true, [field]: CANARY } },
      },
    },
  ]) {
    await expectFailure({
      operation: planNativeConfig({ input: INPUT, envMetadata, binary }),
      code: "E_CONFIG_METADATA",
      message:
        "Native environment metadata is invalid or exceeds its budget; values omitted.",
    });
    expect(await Bun.file(receipt).exists()).toBe(false);
  }
});

test("rejects oversized metadata before spawning", async () => {
  const receipt = join(directory, "spawn-receipt");
  const binary = await fixture({
    onInvocation: `await Bun.write(${JSON.stringify(receipt)}, 'spawned');`,
    body: "",
  });
  await expectFailure({
    operation: planNativeConfig({
      input: INPUT,
      envMetadata: {
        ...METADATA,
        inactive_scopes: ["a".repeat(NATIVE_CONFIG_INPUT_LIMIT)],
      },
      binary,
    }),
    code: "E_CONFIG_METADATA",
    message:
      "Native environment metadata is invalid or exceeds its budget; values omitted.",
  });
  expect(await Bun.file(receipt).exists()).toBe(false);
});

test("bounds original documents and UTF-8 before spawning", async () => {
  const receipt = join(directory, "spawn-receipt");
  const binary = await fixture({
    onInvocation: `await Bun.write(${JSON.stringify(receipt)}, 'spawned');`,
    body: "",
  });
  for (const documents of [
    { input: new Uint8Array(NATIVE_CONFIG_INPUT_LIMIT + 1) },
    { input: INPUT, primaryLocal: new Uint8Array([255]) },
    { input: INPUT, checkoutLocal: new Uint8Array([255]) },
    {
      input: INPUT,
      explicitOverlay: "a".repeat(NATIVE_CONFIG_INPUT_LIMIT + 1),
    },
  ]) {
    await expectFailure({
      operation: planNativeConfig({
        ...documents,
        envMetadata: METADATA,
        binary,
      }),
      code: "E_CONFIG_INPUT",
    });
    expect(await Bun.file(receipt).exists()).toBe(false);
  }
});

const INVALID_RESPONSES: readonly {
  readonly name: string;
  readonly response: unknown;
  readonly exitCode?: number;
}[] = [
  {
    name: "missing report",
    response: { ...SUCCESS, environment_plan: undefined },
  },
  {
    name: "missing namespace",
    response: { ...SUCCESS, declared_workloads: undefined },
  },
  {
    name: "invalid namespace kind",
    response: { ...SUCCESS, declared_workloads: { web: CANARY } },
  },
  {
    name: "invalid namespace name",
    response: { ...SUCCESS, declared_workloads: { "../private": "service" } },
  },
  {
    name: "report version",
    response: {
      ...SUCCESS,
      environment_plan: { ...ENVIRONMENT_PLAN, plan_version: 2 },
    },
  },
  {
    name: "report extra field",
    response: {
      ...SUCCESS,
      environment_plan: { ...ENVIRONMENT_PLAN, ciphertext: CANARY },
    },
  },
  {
    name: "managed binding value",
    response: {
      ...SUCCESS,
      environment_plan: {
        ...ENVIRONMENT_PLAN,
        workloads: {
          web: {
            API_TOKEN: {
              ...ENVIRONMENT_PLAN.workloads.web.API_TOKEN,
              value: CANARY,
            },
          },
        },
      },
    },
  },
  {
    name: "unknown binding kind",
    response: {
      ...SUCCESS,
      environment_plan: {
        ...ENVIRONMENT_PLAN,
        workloads: { web: { MODE: { kind: CANARY } } },
      },
    },
  },
  {
    name: "invalid binding key",
    response: {
      ...SUCCESS,
      environment_plan: {
        ...ENVIRONMENT_PLAN,
        workloads: {
          web: { "invalid-key": { kind: "literal", value: CANARY } },
        },
      },
    },
  },
  {
    name: "invalid managed scope",
    response: {
      ...SUCCESS,
      environment_plan: {
        ...ENVIRONMENT_PLAN,
        workloads: {
          web: {
            API_TOKEN: {
              ...ENVIRONMENT_PLAN.workloads.web.API_TOKEN,
              scope: "../private",
            },
          },
        },
      },
    },
  },
  {
    name: "missing diagnostic document",
    response: {
      ...SUCCESS,
      environment_plan: {
        ...ENVIRONMENT_PLAN,
        warnings: [{ ...DIAGNOSTIC, document: undefined }],
      },
    },
  },
  {
    name: "invalid diagnostic document",
    response: {
      ...SUCCESS,
      environment_plan: {
        ...ENVIRONMENT_PLAN,
        warnings: [{ ...DIAGNOSTIC, document: CANARY }],
      },
    },
  },
  {
    name: "diagnostics with complete report",
    response: {
      ...SUCCESS,
      environment_plan: { ...ENVIRONMENT_PLAN, diagnostics: [DIAGNOSTIC] },
    },
  },
  {
    name: "incomplete report without diagnostics",
    response: {
      ...SUCCESS,
      environment_plan: { ...ENVIRONMENT_PLAN, complete: false },
    },
    exitCode: 1,
  },
  {
    name: "report overlay mismatch",
    response: {
      ...SUCCESS,
      environment_plan: { ...ENVIRONMENT_PLAN, overlay: "prod" },
    },
  },
  {
    name: "resolution overlay mismatch",
    response: {
      ...SUCCESS,
      local_resolution: { ...LOCAL_RESOLUTION, overlay: "prod" },
    },
  },
  {
    name: "overlay existence mismatch",
    response: {
      ...SUCCESS,
      environment_plan: { ...ENVIRONMENT_PLAN, overlay_exists: false },
    },
  },
  {
    name: "missing selected workload",
    response: {
      ...SUCCESS,
      environment_plan: { ...ENVIRONMENT_PLAN, workloads: {} },
    },
  },
  {
    name: "extra selected workload",
    response: {
      ...SUCCESS,
      environment_plan: {
        ...ENVIRONMENT_PLAN,
        workloads: { ...ENVIRONMENT_PLAN.workloads, seed: {} },
      },
    },
  },
  {
    name: "selected workload kind mismatch",
    response: { ...SUCCESS, declared_workloads: { web: "job" } },
  },
  {
    name: "selected workload in both kinds",
    response: { ...SUCCESS, plan: { ...SUCCESS.plan, jobs: { web: {} } } },
  },
  {
    name: "missing selection record",
    response: { ...SUCCESS, plan: { plan_version: 1 } },
  },
  { name: "complete report exits one", response: SUCCESS, exitCode: 1 },
  {
    name: "incomplete report exits zero",
    response: {
      ...SUCCESS,
      environment_plan: {
        ...ENVIRONMENT_PLAN,
        complete: false,
        diagnostics: [DIAGNOSTIC],
      },
    },
  },
  { name: "unexpected exit", response: SUCCESS, exitCode: 2 },
];

test.each([
  ...INVALID_RESPONSES,
])("rejects malformed plan response: $name", async ({ response, exitCode }) => {
  const binary = await responseFixture({ response, exitCode });
  await expectFailure({
    operation: planNativeConfig({
      input: INPUT,
      envMetadata: METADATA,
      binary,
    }),
    code: "E_COMPILER_RESPONSE",
  });
});

test("accepts an incomplete ok:true plan with exit one and structured diagnostics", async () => {
  const response = {
    ...SUCCESS,
    environment_plan: {
      ...ENVIRONMENT_PLAN,
      complete: false,
      diagnostics: [DIAGNOSTIC],
    },
  };
  const binary = await responseFixture({ response, exitCode: 1 });
  expect(
    await planNativeConfig({ input: INPUT, envMetadata: METADATA, binary })
  ).toEqual(response);
});

test("strips raw envelope, local-resolution, and diagnostic extra fields", async () => {
  const binary = await responseFixture({
    response: {
      ...SUCCESS,
      private_payload: CANARY,
      local_resolution: { ...LOCAL_RESOLUTION, path: CANARY },
      environment_plan: {
        ...ENVIRONMENT_PLAN,
        warnings: [{ ...DIAGNOSTIC, ciphertext: CANARY }],
      },
    },
  });
  const result = await planNativeConfig({
    input: INPUT,
    envMetadata: METADATA,
    binary,
  });
  expect(result).toEqual({
    ...SUCCESS,
    environment_plan: { ...ENVIRONMENT_PLAN, warnings: [DIAGNOSTIC] },
  });
  expect(JSON.stringify(result)).not.toContain(CANARY);
  expect(result).not.toHaveProperty("envelope");
});

test("preserves an authored __proto__ binding as an own JSON property", async () => {
  const bindings = Object.fromEntries([
    ["__proto__", { kind: "literal", value: "fixture-proto" }],
  ]);
  const environmentPlan = {
    ...ENVIRONMENT_PLAN,
    workloads: { web: bindings },
  };
  const binary = await responseFixture({
    response: { ...SUCCESS, environment_plan: environmentPlan },
  });
  const result = await planNativeConfig({
    input: INPUT,
    envMetadata: METADATA,
    binary,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("Expected a valid authored binding report");
  }
  const reportedBindings = result.environment_plan.workloads.web;
  expect(Object.hasOwn(reportedBindings ?? {}, "__proto__")).toBe(true);
  expect(JSON.parse(JSON.stringify(result.environment_plan))).toEqual(
    environmentPlan
  );
});

test.each([
  "stdout",
  "stderr",
])("bounds plan %s and reaps the overflowing child", async (stream) => {
  const pidPath = join(directory, "pid");
  const limit = stream === "stdout" ? 8 * 1024 * 1024 : 64 * 1024;
  const binary = await fixture({
    body: `await Bun.write(${JSON.stringify(pidPath)}, String(process.pid)); process.${stream}.write('x'.repeat(${limit + 1})); await Bun.sleep(10000);`,
  });
  await expectFailure({
    operation: planNativeConfig({
      input: INPUT,
      envMetadata: METADATA,
      binary,
    }),
    code: "E_COMPILER_BUDGET",
    message: "Native configuration I/O exceeds its budget.",
  });
  const pid = Number(await Bun.file(pidPath).text());
  expect(() => process.kill(pid, 0)).toThrow();
});

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (await Bun.file(path).exists()) {
      const pid = Number(await Bun.file(path).text());
      if (Number.isSafeInteger(pid) && pid > 0) {
        return pid;
      }
    }
    await Bun.sleep(10);
  }
  throw new Error(
    "Owned plan compiler did not publish its PID within the test budget"
  );
}

test("cancellation reaps the owned plan child and pre-cancellation never spawns", async () => {
  const pidPath = join(directory, "pid");
  const receipt = join(directory, "spawn-receipt");
  const binary = await fixture({
    onInvocation: `await Bun.write(${JSON.stringify(receipt)}, 'spawned');`,
    body: `await Bun.stdin.text(); await Bun.write(${JSON.stringify(pidPath)}, String(process.pid)); await Bun.sleep(10000);`,
  });
  const controller = new AbortController();
  const operation = planNativeConfig({
    input: INPUT,
    envMetadata: METADATA,
    binary,
    signal: controller.signal,
  }).catch((error: unknown) => error);
  let pid = 0;
  try {
    pid = await waitForPid(pidPath);
  } finally {
    controller.abort();
    await expectFailure({ operation, code: "E_COMPILER_CANCELLED" });
  }
  expect(() => process.kill(pid, 0)).toThrow();
  await rm(receipt);
  await expectFailure({
    operation: planNativeConfig({
      input: INPUT,
      envMetadata: METADATA,
      binary,
      signal: controller.signal,
    }),
    code: "E_COMPILER_CANCELLED",
  });
  expect(await Bun.file(receipt).exists()).toBe(false);
});

async function descendantFixture(): Promise<{
  readonly binary: string;
  readonly parentPidPath: string;
  readonly descendantPidPath: string;
}> {
  const parentPidPath = join(directory, "parent-pid");
  const descendantPidPath = join(directory, "descendant-pid");
  const descendantScript = join(directory, "descendant.ts");
  await Bun.write(
    descendantScript,
    `await Bun.write(${JSON.stringify(descendantPidPath)}, String(process.pid)); await Bun.sleep(10000);`
  );
  const binary = await fixture({
    body: `await Bun.stdin.text(); await Bun.write(${JSON.stringify(parentPidPath)}, String(process.pid)); Bun.spawn([${JSON.stringify(process.execPath)}, ${JSON.stringify(descendantScript)}], { env:{PATH:'/usr/bin:/bin'}, stdin:'ignore', stdout:'inherit', stderr:'inherit' }); await Bun.sleep(10000);`,
  });
  return { binary, parentPidPath, descendantPidPath };
}

async function withinTestBudget(operation: Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error("Owned plan operation exceeded the test cleanup budget")
      );
    }, 2000);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopOwnedFixturePid(path: string): Promise<void> {
  if (!(await Bun.file(path).exists())) {
    return;
  }
  const pid = Number(await Bun.file(path).text());
  if (!(Number.isSafeInteger(pid) && pid > 0)) {
    throw new Error("Owned process fixture published an invalid PID");
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (error: unknown) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ESRCH")
    ) {
      throw error;
    }
  }
}

async function expectProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error("Owned compiler process survived completed cancellation");
}

test("cancellation kills the owned plan process group when a descendant holds its pipes", async () => {
  const { binary, parentPidPath, descendantPidPath } =
    await descendantFixture();
  const controller = new AbortController();
  const operation = planNativeConfig({
    input: INPUT,
    envMetadata: METADATA,
    binary,
    signal: controller.signal,
  }).catch((error: unknown) => error);
  try {
    const parentPid = await waitForPid(parentPidPath);
    const descendantPid = await waitForPid(descendantPidPath);
    controller.abort();
    await expectFailure({
      operation: withinTestBudget(operation),
      code: "E_COMPILER_CANCELLED",
    });
    await expectProcessGone(parentPid);
    await expectProcessGone(descendantPid);
  } finally {
    controller.abort();
    await stopOwnedFixturePid(descendantPidPath);
    await stopOwnedFixturePid(parentPidPath);
    await operation;
  }
});

test("timeout kills the owned plan process group when a descendant holds its pipes", async () => {
  const { binary, parentPidPath, descendantPidPath } =
    await descendantFixture();
  const operation = planNativeConfig({
    input: INPUT,
    envMetadata: METADATA,
    binary,
    timeoutMs: 1000,
  }).catch((error: unknown) => error);
  try {
    const parentPid = await waitForPid(parentPidPath);
    const descendantPid = await waitForPid(descendantPidPath);
    await expectFailure({
      operation: withinTestBudget(operation),
      code: "E_COMPILER_TIMEOUT",
    });
    await expectProcessGone(parentPid);
    await expectProcessGone(descendantPid);
  } finally {
    await stopOwnedFixturePid(descendantPidPath);
    await stopOwnedFixturePid(parentPidPath);
    await operation;
  }
});
