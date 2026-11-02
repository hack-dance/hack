import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
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
import type { NativeRoutingResolution } from "../src/lib/native-routing-plan-protocol.ts";
import { restoreEnv } from "./helpers/env.ts";

const PROTOCOL = {
  transport_version: 1,
  authored_version: 1,
  plan_version: 1,
  resolve_version: 1,
  local_version: 1,
  env_plan_version: 1,
  host_env_plan_version: 1,
  routing_plan_version: 1,
};
const { routing_plan_version, ...ROUTINGLESS_PROTOCOL } = PROTOCOL;
void routing_plan_version;
const INPUT = new TextEncoder().encode('{"schema_version":1,"name":"fixture"}');
const CANARY = "routing-wire-private-canary";
const METADATA = {
  metadata_version: 1,
  overlay: "qa",
  overlay_exists: true,
  workloads: { web: {} },
  inactive_scopes: [],
} as const satisfies NativeEnvMetadata;
const ROUTINGLESS_SUCCESS = {
  transport_version: 1,
  ok: true,
  plan: {
    plan_version: 1,
    name: "fixture",
    services: { web: {} },
    jobs: {},
    worktree: { inherit_local: false },
  },
  semantic_hash: "a".repeat(64),
  declared_workloads: { web: "service", inactive: "service", seed: "job" },
  local_resolution: {
    overlay: "qa",
    origin: "checkout_local",
    auto_branch: false,
    inherit_local: false,
    resolution_hash: "b".repeat(64),
  },
  environment_plan: {
    plan_version: 1,
    overlay: "qa",
    overlay_exists: true,
    complete: true,
    workloads: { web: {} },
    warnings: [],
    diagnostics: [],
  },
} as const;
const HTTP_ROUTE = {
  service: "web",
  port: 3000,
  protocol: "http",
  hostname: "web",
} as const;
const ROUTES_PLAN = {
  domain: "dev.test",
  origin: "https://fixture.dev.test",
  aliases: {
    preview: { origin: "https://preview.test" },
    oauth: { domain: "login.test" },
  },
  oauth_alias: "oauth",
  http: {
    web: HTTP_ROUTE,
    inactive: { ...HTTP_ROUTE, service: "inactive", hostname: "inactive" },
  },
} as const;
const ROUTING_RESOLUTION = {
  domain: "dev.test",
  domain_origin: "project",
  project_origin: "https://fixture.dev.test",
  aliases: {
    preview: "https://preview.test",
    oauth: "https://fixture.login.test",
  },
  oauth_alias: "oauth",
  open_preference: "alias",
  open_preference_origin: "project",
  open_origin: "https://fixture.login.test",
  routes: {
    web: {
      service: "web",
      port: 3000,
      protocol: "http",
      origin: "https://web.fixture.dev.test",
      aliases: {
        preview: "https://web.preview.test",
        oauth: "https://web.fixture.login.test",
      },
    },
  },
} as const satisfies NativeRoutingResolution;
const COMPILE_SUCCESS = {
  ...ROUTINGLESS_SUCCESS,
  plan: {
    ...ROUTINGLESS_SUCCESS.plan,
    routes: ROUTES_PLAN,
    open: { prefer: "alias" },
  },
} as const;
const SUCCESS = { ...COMPILE_SUCCESS, routing_resolution: ROUTING_RESOLUTION };
const PROBE_SUCCESS = {
  ...COMPILE_SUCCESS,
  routing_inputs_required: true,
} as const;
const EMPTY_RESOLUTION = {
  ...ROUTING_RESOLUTION,
  domain: "hack.local",
  domain_origin: "default",
  project_origin: "https://fixture.hack.local",
  aliases: {},
  oauth_alias: null,
  open_preference: "auto",
  open_preference_origin: "default",
  open_origin: "https://fixture.hack.local",
  routes: {},
} as const satisfies NativeRoutingResolution;
const BRANCHED_SUCCESS = {
  ...SUCCESS,
  routing_resolution: {
    ...ROUTING_RESOLUTION,
    domain_origin: "explicit",
    branch: "feature-routing",
    aliases: {
      ...ROUTING_RESOLUTION.aliases,
      oauth: "https://feature-routing.fixture.login.test",
    },
    open_origin: "https://feature-routing.fixture.login.test",
    routes: {
      web: {
        ...ROUTING_RESOLUTION.routes.web,
        aliases: {
          ...ROUTING_RESOLUTION.routes.web.aliases,
          oauth: "https://web.feature-routing.fixture.login.test",
        },
      },
    },
  },
} as const;
let directory = "";

beforeEach(async () => {
  directory = await realpath(
    await mkdtemp(join(tmpdir(), "hack-routing-plan-transport-"))
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
    `process.stdout.write(${JSON.stringify(JSON.stringify(opts.response ?? ROUTINGLESS_SUCCESS))}); process.stderr.write(${JSON.stringify(CANARY)}); process.exitCode=${opts.exitCode ?? 0};`;
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
    throw new Error("Expected a fixed routing transport failure");
  }
  expect(error.code).toBe(opts.code);
  if (opts.message !== undefined) {
    expect(error.message).toBe(opts.message);
  }
  expect(error.message).not.toContain(CANARY);
  expect(error.message).not.toContain(directory);
}

function withResolution(
  overrides: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  return {
    ...SUCCESS,
    routing_resolution: { ...ROUTING_RESOLUTION, ...overrides },
  };
}

function withResolvedRoute(
  overrides: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  return withResolution({
    routes: { web: { ...ROUTING_RESOLUTION.routes.web, ...overrides } },
  });
}

function withRoutesPlan(
  overrides: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  return {
    ...COMPILE_SUCCESS,
    plan: { ...COMPILE_SUCCESS.plan, routes: { ...ROUTES_PLAN, ...overrides } },
  };
}

test.each([
  { name: "missing", version: undefined },
  { name: "null", version: null },
  { name: "unsupported", version: 2 },
])("requires routing capability before payload: $name", async ({ version }) => {
  const receipt = join(directory, "payload-receipt");
  const protocolReceipt = join(directory, "protocol-input-receipt");
  const binary = await fixture({
    protocol: { ...PROTOCOL, routing_plan_version: version },
    onInvocation: `if (process.argv[2] === '--protocol') { await Bun.write(${JSON.stringify(protocolReceipt)}, await Bun.stdin.text()); }`,
    body: `await Bun.write(${JSON.stringify(receipt)}, await Bun.stdin.text());`,
  });
  for (const operation of [
    () =>
      compileNativeConfig({
        input: INPUT,
        binary,
        requireRoutingPlanning: true,
      }),
    () =>
      resolveNativeConfig({
        input: INPUT,
        binary,
        requireRoutingPlanning: true,
      }),
    () =>
      planNativeConfig({
        input: INPUT,
        binary,
        envMetadata: METADATA,
        requireRoutingPlanning: true,
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
  { name: "older env v1", protocol: ROUTINGLESS_PROTOCOL },
  { name: "routing-capable", protocol: PROTOCOL },
])("preserves routingless compile, resolve, and planning compatibility: $name", async ({
  protocol,
}) => {
  const binary = await fixture({ protocol });
  expect((await compileNativeConfig({ input: INPUT, binary })).ok).toBe(true);
  expect((await resolveNativeConfig({ input: INPUT, binary })).ok).toBe(true);
  expect(
    await planNativeConfig({ input: INPUT, binary, envMetadata: METADATA })
  ).toEqual(ROUTINGLESS_SUCCESS);
});

test("an active routing probe sends one original-document request and returns only the routing need", async () => {
  const receipt = join(directory, "resolve-requests");
  const projectText = '\ufeff{"name":"first","name":"second"}\n';
  const localText = "null\n";
  const input = new TextEncoder().encode(projectText);
  const checkoutLocal = new TextEncoder().encode(localText);
  const binary = await fixture({
    body: `const payload=JSON.parse(await Bun.stdin.text()); const {appendFileSync}=await import('node:fs'); appendFileSync(${JSON.stringify(receipt)}, JSON.stringify({command:process.argv[2],payload})+'\\n'); process.stdout.write(${JSON.stringify(JSON.stringify({ ...PROBE_SUCCESS, private_payload: CANARY }))});`,
  });
  const result = await resolveNativeConfig({
    input,
    checkoutLocal,
    probeRoutingInputs: true,
    binary,
  });
  const { environment_plan, ...expected } = PROBE_SUCCESS;
  void environment_plan;
  expect(result).toEqual(expected);
  expect(result).not.toHaveProperty("routing_resolution");
  expect(result).not.toHaveProperty("envelope");
  expect(JSON.stringify(result)).not.toContain(CANARY);
  expect(await Bun.file(receipt).text()).toBe(
    `${JSON.stringify({
      command: "resolve",
      payload: {
        request_version: 1,
        project: projectText,
        checkout_local: localText,
        routing_probe: true,
      },
    })}\n`
  );
  expect(input).toEqual(new TextEncoder().encode(projectText));
  expect(checkoutLocal).toEqual(new TextEncoder().encode(localText));
});

test.each([
  { name: "inactive routing probe", protocol: PROTOCOL, probe: true },
  {
    name: "older compiler fallback",
    protocol: ROUTINGLESS_PROTOCOL,
    probe: undefined,
  },
])("resolves without an expanded routing report: $name", async ({
  protocol,
  probe,
}) => {
  const receipt = join(directory, "resolve-request");
  const binary = await fixture({
    protocol,
    body: `await Bun.write(${JSON.stringify(receipt)}, await Bun.stdin.text()); process.stdout.write(${JSON.stringify(JSON.stringify(ROUTINGLESS_SUCCESS))});`,
  });
  const result = await resolveNativeConfig({
    input: INPUT,
    probeRoutingInputs: true,
    binary,
  });
  const { environment_plan, ...expected } = ROUTINGLESS_SUCCESS;
  void environment_plan;
  expect(result).toEqual(expected);
  expect(result).not.toHaveProperty("routing_inputs_required");
  expect(result).not.toHaveProperty("routing_resolution");
  expect(JSON.parse(await Bun.file(receipt).text())).toEqual({
    request_version: 1,
    project: new TextDecoder().decode(INPUT),
    ...(probe ? { routing_probe: true } : {}),
  });
});

test.each([
  { name: "false", marker: false },
  { name: "null", marker: null },
])("refuses an active probe's malformed routing marker: $name", async ({
  marker,
}) => {
  const binary = await fixture({
    response: { ...COMPILE_SUCCESS, routing_inputs_required: marker },
  });
  await expectFailure({
    operation: resolveNativeConfig({
      input: INPUT,
      binary,
      probeRoutingInputs: true,
    }),
    code: "E_COMPILER_RESPONSE",
    message: "Native routing input probe returned an invalid result.",
  });
});

test.each([
  { name: "ordinary resolve", command: "resolve" },
  { name: "context-free compile", command: "compile" },
  { name: "environment plan", command: "plan" },
])("refuses an unrequested routing marker from $name", async ({ command }) => {
  const binary = await fixture({
    response:
      command === "compile"
        ? PROBE_SUCCESS
        : { ...SUCCESS, routing_inputs_required: true },
  });
  const operation =
    command === "compile"
      ? compileNativeConfig({ input: INPUT, binary })
      : command === "plan"
        ? planNativeConfig({ input: INPUT, binary, envMetadata: METADATA })
        : resolveNativeConfig({ input: INPUT, binary });
  await expectFailure({ operation, code: "E_COMPILER_RESPONSE" });
});

test("an older compiler fallback refuses a probe-only routing marker", async () => {
  const binary = await fixture({
    protocol: ROUTINGLESS_PROTOCOL,
    response: { ...ROUTINGLESS_SUCCESS, routing_inputs_required: true },
  });
  await expectFailure({
    operation: resolveNativeConfig({
      input: INPUT,
      binary,
      probeRoutingInputs: true,
    }),
    code: "E_COMPILER_RESPONSE",
  });
});

test.each([
  {
    name: "with marker",
    response: { ...SUCCESS, routing_inputs_required: true },
  },
  { name: "without marker", response: SUCCESS },
])("refuses an expanded routing report during a probe: $name", async ({
  response,
}) => {
  const binary = await fixture({ response });
  await expectFailure({
    operation: resolveNativeConfig({
      input: INPUT,
      binary,
      probeRoutingInputs: true,
    }),
    code: "E_COMPILER_RESPONSE",
    message: "Native routing input probe returned an invalid result.",
  });
});

test.each([
  { name: "routes", response: COMPILE_SUCCESS },
  {
    name: "open preference",
    response: {
      ...ROUTINGLESS_SUCCESS,
      plan: { ...ROUTINGLESS_SUCCESS.plan, open: { prefer: "auto" } },
    },
  },
  { name: "explicitly required routing", response: ROUTINGLESS_SUCCESS },
])("refuses a missing probe marker when $name is enabled", async ({
  name,
  response,
}) => {
  const binary = await fixture({ response });
  await expectFailure({
    operation: resolveNativeConfig({
      input: INPUT,
      binary,
      probeRoutingInputs: true,
      requireRoutingPlanning: name === "explicitly required routing",
    }),
    code: "E_COMPILER_RESPONSE",
    message: "Native routing input probe returned an invalid result.",
  });
});

test("routing selection strings force capability checks before payload without an explicit flag", async () => {
  const receipt = join(directory, "payload-receipt");
  const binary = await fixture({
    protocol: ROUTINGLESS_PROTOCOL,
    body: `await Bun.write(${JSON.stringify(receipt)}, await Bun.stdin.text());`,
  });
  for (const selection of [
    { explicitDomain: "dev.test" },
    { globalDomain: "global.test" },
    { branch: "feature-routing" },
  ]) {
    for (const operation of [
      () => resolveNativeConfig({ input: INPUT, binary, ...selection }),
      () =>
        planNativeConfig({
          input: INPUT,
          binary,
          envMetadata: METADATA,
          ...selection,
        }),
    ]) {
      await expectFailure({
        operation: operation(),
        code: "E_COMPILER_VERSION",
      });
      expect(await Bun.file(receipt).exists()).toBe(false);
    }
  }
});

test("preserves routing request text, document bytes, and PATH-only compiler environment", async () => {
  const projectText = '\ufeff{"name":"first","name":"second"}\n';
  const localText = "null\n";
  const input = new TextEncoder().encode(projectText);
  const checkoutLocal = new TextEncoder().encode(localText);
  const originalInput = input.slice();
  const originalLocal = checkoutLocal.slice();
  const originalEnv = process.env.HACK_TEST_ROUTING_PLAN_PRIVATE;
  process.env.HACK_TEST_ROUTING_PLAN_PRIVATE = CANARY;
  try {
    const binary = await fixture({
      body: `const received=JSON.parse(await Bun.stdin.text()); const result=${JSON.stringify(BRANCHED_SUCCESS)}; result.plan.received=received; result.plan.arguments=process.argv.slice(2); result.plan.environment=process.env; process.stdout.write(JSON.stringify(result));`,
    });
    const result = await planNativeConfig({
      input,
      checkoutLocal,
      explicitDomain: "dev.test",
      globalDomain: "global.test",
      branch: "feature-routing",
      envMetadata: METADATA,
      profiles: ["with spaces", "--unsafe"],
      binary,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Expected routing planning success");
    }
    expect(result.plan.received).toEqual({
      request_version: 1,
      project: projectText,
      checkout_local: localText,
      explicit_domain: "dev.test",
      global_domain: "global.test",
      branch: "feature-routing",
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
    expect(result.routing_resolution).toEqual(
      BRANCHED_SUCCESS.routing_resolution
    );
    expect(input).toEqual(originalInput);
    expect(checkoutLocal).toEqual(originalLocal);
  } finally {
    restoreEnv("HACK_TEST_ROUTING_PLAN_PRIVATE", originalEnv);
  }
});

test("compiles declarations without a resolution and reports only routes for selected services", async () => {
  const binary = await fixture({
    body: `process.stdout.write(JSON.stringify(process.argv[2] === 'compile' ? ${JSON.stringify(COMPILE_SUCCESS)} : ${JSON.stringify(SUCCESS)}));`,
  });
  const compiled = await compileNativeConfig({ input: INPUT, binary });
  expect(compiled.ok).toBe(true);
  expect(compiled).not.toHaveProperty("routing_resolution");
  const resolved = await resolveNativeConfig({ input: INPUT, binary });
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) {
    throw new Error("Expected selected route resolution success");
  }
  expect(resolved.routing_resolution).toEqual(ROUTING_RESOLUTION);
  expect(resolved.routing_resolution?.routes).not.toHaveProperty("inactive");
});

test.each([
  { name: "routes plan", compiled: COMPILE_SUCCESS, resolved: SUCCESS },
  {
    name: "open plan",
    compiled: {
      ...ROUTINGLESS_SUCCESS,
      plan: { ...ROUTINGLESS_SUCCESS.plan, open: { prefer: "auto" } },
    },
    resolved: {
      ...ROUTINGLESS_SUCCESS,
      plan: { ...ROUTINGLESS_SUCCESS.plan, open: { prefer: "auto" } },
      routing_resolution: EMPTY_RESOLUTION,
    },
  },
])("refuses routing from an older handshake before returning a result: $name", async ({
  compiled,
  resolved,
}) => {
  const binary = await fixture({
    protocol: ROUTINGLESS_PROTOCOL,
    body: `process.stdout.write(JSON.stringify(process.argv[2] === 'compile' ? ${JSON.stringify(compiled)} : ${JSON.stringify(resolved)}));`,
  });
  for (const operation of [
    () => compileNativeConfig({ input: INPUT, binary }),
    () => resolveNativeConfig({ input: INPUT, binary }),
    () => planNativeConfig({ input: INPUT, binary, envMetadata: METADATA }),
  ]) {
    await expectFailure({ operation: operation(), code: "E_COMPILER_VERSION" });
  }
});

test("a resolution alone requires routing capability even without routing declarations", async () => {
  const binary = await fixture({
    protocol: ROUTINGLESS_PROTOCOL,
    response: { ...ROUTINGLESS_SUCCESS, routing_resolution: EMPTY_RESOLUTION },
  });
  await expectFailure({
    operation: resolveNativeConfig({ input: INPUT, binary }),
    code: "E_COMPILER_VERSION",
  });
});

test.each([
  { name: "older compiler", protocol: ROUTINGLESS_PROTOCOL },
  { name: "routing-capable compiler", protocol: PROTOCOL },
])("context-free compile refuses a routing resolution: $name", async ({
  protocol,
}) => {
  const binary = await fixture({ protocol, response: SUCCESS });
  await expectFailure({
    operation: compileNativeConfig({ input: INPUT, binary }),
    code: "E_COMPILER_RESPONSE",
  });
});

test.each([
  { name: "routes enabled", response: COMPILE_SUCCESS },
  {
    name: "open enabled",
    response: {
      ...ROUTINGLESS_SUCCESS,
      plan: { ...ROUTINGLESS_SUCCESS.plan, open: { prefer: "auto" } },
    },
  },
  { name: "routing explicitly required", response: ROUTINGLESS_SUCCESS },
])("refuses an omitted routing report when $name", async ({ response }) => {
  const binary = await fixture({ response });
  for (const operation of [
    () =>
      resolveNativeConfig({
        input: INPUT,
        binary,
        requireRoutingPlanning: true,
      }),
    () =>
      planNativeConfig({
        input: INPUT,
        binary,
        envMetadata: METADATA,
        requireRoutingPlanning: true,
      }),
  ]) {
    await expectFailure({
      operation: operation(),
      code: "E_COMPILER_RESPONSE",
    });
  }
});

test("accepts explicit empty routing declarations with an empty report", async () => {
  const response = {
    ...ROUTINGLESS_SUCCESS,
    plan: { ...ROUTINGLESS_SUCCESS.plan, routes: { aliases: {}, http: {} } },
    routing_resolution: EMPTY_RESOLUTION,
  };
  const binary = await fixture({ response });
  const { environment_plan, ...expected } = response;
  void environment_plan;
  expect(await resolveNativeConfig({ input: INPUT, binary })).toEqual(expected);
});

test("project hostname legitimately retains unprefixed project and alias origins", async () => {
  const response = {
    ...SUCCESS,
    plan: {
      ...COMPILE_SUCCESS.plan,
      routes: {
        ...ROUTES_PLAN,
        http: { web: { ...HTTP_ROUTE, hostname: "project" } },
      },
    },
    routing_resolution: {
      ...ROUTING_RESOLUTION,
      routes: {
        web: {
          ...ROUTING_RESOLUTION.routes.web,
          origin: ROUTING_RESOLUTION.project_origin,
          aliases: ROUTING_RESOLUTION.aliases,
        },
      },
    },
  };
  const binary = await fixture({ response });
  const { environment_plan, ...expected } = response;
  void environment_plan;
  expect(await resolveNativeConfig({ input: INPUT, binary })).toEqual(expected);
});

test("bounds domain and branch context before spawning", async () => {
  const receipt = join(directory, "spawn-receipt");
  const binary = await fixture({
    onInvocation: `await Bun.write(${JSON.stringify(receipt)}, 'spawned');`,
  });
  for (const field of ["explicitDomain", "globalDomain", "branch"]) {
    await expectFailure({
      operation: resolveNativeConfig({
        input: INPUT,
        binary,
        [field]: "x".repeat(NATIVE_CONFIG_INPUT_LIMIT + 1),
      }),
      code: "E_CONFIG_INPUT",
      message: "Native routing selection is invalid or exceeds its budget.",
    });
    expect(await Bun.file(receipt).exists()).toBe(false);
  }
});

test.each([
  {
    name: "null routes",
    response: {
      ...COMPILE_SUCCESS,
      plan: { ...COMPILE_SUCCESS.plan, routes: null },
    },
  },
  { name: "unknown routes field", response: withRoutesPlan({ value: CANARY }) },
  { name: "missing aliases", response: withRoutesPlan({ aliases: undefined }) },
  { name: "array route map", response: withRoutesPlan({ http: [] }) },
  {
    name: "noncanonical domain",
    response: withRoutesPlan({ domain: "Private.TEST" }),
  },
  {
    name: "domain path",
    response: withRoutesPlan({ domain: `private.test/${CANARY}` }),
  },
  {
    name: "alias with both encodings",
    response: withRoutesPlan({
      aliases: {
        oauth: { domain: "login.test", origin: "https://login.test" },
      },
    }),
  },
  {
    name: "alias sensitive field",
    response: withRoutesPlan({
      aliases: { oauth: { domain: "login.test", value: CANARY } },
    }),
  },
  {
    name: "missing OAuth alias",
    response: withRoutesPlan({ oauth_alias: "missing" }),
  },
  {
    name: "undeclared service",
    response: withRoutesPlan({
      http: { web: { ...HTTP_ROUTE, service: "ghost" } },
    }),
  },
  {
    name: "job target",
    response: withRoutesPlan({
      http: { web: { ...HTTP_ROUTE, service: "seed" } },
    }),
  },
  {
    name: "missing declared namespace",
    response: { ...COMPILE_SUCCESS, declared_workloads: undefined },
  },
  {
    name: "noncanonical route name",
    response: withRoutesPlan({ http: { "../private": HTTP_ROUTE } }),
  },
  {
    name: "out-of-range port",
    response: withRoutesPlan({
      http: { web: { ...HTTP_ROUTE, port: 65_536 } },
    }),
  },
  {
    name: "fractional port",
    response: withRoutesPlan({ http: { web: { ...HTTP_ROUTE, port: 1.5 } } }),
  },
  {
    name: "unknown protocol",
    response: withRoutesPlan({
      http: { web: { ...HTTP_ROUTE, protocol: "ftp" } },
    }),
  },
  {
    name: "invalid hostname",
    response: withRoutesPlan({
      http: { web: { ...HTTP_ROUTE, hostname: `web/${CANARY}` } },
    }),
  },
  {
    name: "unknown route field",
    response: withRoutesPlan({
      http: { web: { ...HTTP_ROUTE, path: CANARY } },
    }),
  },
  {
    name: "unknown open preference",
    response: {
      ...COMPILE_SUCCESS,
      plan: { ...COMPILE_SUCCESS.plan, open: { prefer: CANARY } },
    },
  },
  {
    name: "unknown open field",
    response: {
      ...COMPILE_SUCCESS,
      plan: { ...COMPILE_SUCCESS.plan, open: { prefer: "auto", path: CANARY } },
    },
  },
])("refuses malformed normalized routing declarations: $name", async ({
  response,
}) => {
  const binary = await fixture({ response });
  await expectFailure({
    operation: compileNativeConfig({ input: INPUT, binary }),
    code: "E_COMPILER_RESPONSE",
  });
});

test.each([
  { name: "null report", response: { ...SUCCESS, routing_resolution: null } },
  {
    name: "unknown report field",
    response: withResolution({ ciphertext: CANARY }),
  },
  { name: "missing domain", response: withResolution({ domain: undefined }) },
  {
    name: "noncanonical domain",
    response: withResolution({ domain: "Private.TEST" }),
  },
  {
    name: "unknown domain source",
    response: withResolution({ domain_origin: CANARY }),
  },
  {
    name: "unknown open preference",
    response: withResolution({ open_preference: CANARY }),
  },
  {
    name: "unknown open source",
    response: withResolution({ open_preference_origin: "global" }),
  },
  {
    name: "unknown OAuth alias",
    response: withResolution({ oauth_alias: "missing" }),
  },
  {
    name: "OAuth reference mismatch",
    response: withResolution({ oauth_alias: null }),
  },
  {
    name: "invalid branch label",
    response: withResolution({ branch: "feature/private" }),
  },
  {
    name: "oversized branch label",
    response: withResolution({ branch: "x".repeat(64) }),
  },
  { name: "missing route", response: withResolution({ routes: {} }) },
  {
    name: "inactive route included",
    response: withResolution({
      routes: {
        ...ROUTING_RESOLUTION.routes,
        inactive: {
          ...ROUTING_RESOLUTION.routes.web,
          service: "inactive",
          origin: "https://inactive.fixture.dev.test",
        },
      },
    }),
  },
  {
    name: "service mismatch",
    response: withResolvedRoute({ service: "inactive" }),
  },
  { name: "port mismatch", response: withResolvedRoute({ port: 3001 }) },
  {
    name: "protocol mismatch",
    response: withResolvedRoute({ protocol: "https" }),
  },
  {
    name: "route sensitive field",
    response: withResolvedRoute({ path: CANARY }),
  },
  {
    name: "missing project alias",
    response: withResolution({ aliases: { oauth: "https://login.test" } }),
  },
  {
    name: "missing scoped alias",
    response: withResolvedRoute({
      aliases: { oauth: "https://web.login.test" },
    }),
  },
  {
    name: "foreign scoped alias",
    response: withResolvedRoute({
      aliases: {
        ...ROUTING_RESOLUTION.routes.web.aliases,
        foreign: "https://foreign.test",
      },
    }),
  },
  {
    name: "route origin scope mismatch",
    response: withResolvedRoute({ origin: "https://other.fixture.dev.test" }),
  },
  {
    name: "route alias scope mismatch",
    response: withResolvedRoute({
      aliases: {
        ...ROUTING_RESOLUTION.routes.web.aliases,
        oauth: ROUTING_RESOLUTION.aliases.oauth,
      },
    }),
  },
  {
    name: "static project origin mismatch",
    response: withResolution({ project_origin: "https://foreign.test" }),
  },
  {
    name: "static alias origin mismatch",
    response: withResolution({
      aliases: {
        ...ROUTING_RESOLUTION.aliases,
        preview: "https://foreign.test",
      },
    }),
  },
  {
    name: "open preference mismatch",
    response: withResolution({
      open_preference: "dev",
      open_origin: ROUTING_RESOLUTION.project_origin,
    }),
  },
  {
    name: "open destination mismatch",
    response: withResolution({
      open_origin: ROUTING_RESOLUTION.project_origin,
    }),
  },
])("refuses malformed routing reports and foreign selection: $name", async ({
  response,
}) => {
  const binary = await fixture({ response });
  await expectFailure({
    operation: resolveNativeConfig({ input: INPUT, binary }),
    code: "E_COMPILER_RESPONSE",
  });
});

test.each([
  { name: "credentials", value: `https://user:${CANARY}@fixture.dev.test` },
  { name: "path", value: `https://fixture.dev.test/${CANARY}` },
  { name: "query", value: `https://fixture.dev.test?value=${CANARY}` },
  { name: "fragment", value: `https://fixture.dev.test#${CANARY}` },
  { name: "trailing slash", value: "https://fixture.dev.test/" },
  { name: "noncanonical casing", value: "https://FIXTURE.dev.test" },
  { name: "default port spelling", value: "https://fixture.dev.test:443" },
  { name: "foreign protocol", value: "ftp://fixture.dev.test" },
])("refuses noncanonical or private origin encodings: $name", async ({
  value,
}) => {
  for (const response of [
    withResolution({ project_origin: value }),
    withResolution({ open_origin: value }),
    withResolution({
      aliases: { ...ROUTING_RESOLUTION.aliases, oauth: value },
    }),
    withResolvedRoute({ origin: value }),
    withResolvedRoute({
      aliases: { ...ROUTING_RESOLUTION.routes.web.aliases, oauth: value },
    }),
  ]) {
    const binary = await fixture({ response });
    await expectFailure({
      operation: resolveNativeConfig({ input: INPUT, binary }),
      code: "E_COMPILER_RESPONSE",
    });
  }
});

test("refuses duplicate origins across aliases and selected route variants", async () => {
  for (const response of [
    withResolution({
      aliases: {
        ...ROUTING_RESOLUTION.aliases,
        oauth: ROUTING_RESOLUTION.aliases.preview,
      },
      open_origin: ROUTING_RESOLUTION.aliases.preview,
      routes: {
        web: {
          ...ROUTING_RESOLUTION.routes.web,
          aliases: {
            ...ROUTING_RESOLUTION.routes.web.aliases,
            oauth: ROUTING_RESOLUTION.routes.web.aliases.preview,
          },
        },
      },
    }),
    withResolution({
      aliases: {
        ...ROUTING_RESOLUTION.aliases,
        oauth: ROUTING_RESOLUTION.project_origin,
      },
      open_origin: ROUTING_RESOLUTION.project_origin,
      routes: {
        web: {
          ...ROUTING_RESOLUTION.routes.web,
          aliases: {
            ...ROUTING_RESOLUTION.routes.web.aliases,
            oauth: ROUTING_RESOLUTION.routes.web.origin,
          },
        },
      },
    }),
    {
      ...SUCCESS,
      plan: {
        ...COMPILE_SUCCESS.plan,
        routes: {
          ...ROUTES_PLAN,
          http: { web: HTTP_ROUTE, other: HTTP_ROUTE },
        },
      },
      routing_resolution: {
        ...ROUTING_RESOLUTION,
        routes: {
          ...ROUTING_RESOLUTION.routes,
          other: ROUTING_RESOLUTION.routes.web,
        },
      },
    },
  ]) {
    const binary = await fixture({ response });
    await expectFailure({
      operation: resolveNativeConfig({ input: INPUT, binary }),
      code: "E_COMPILER_RESPONSE",
    });
  }
});

test("preserves canonical constructor alias keys as own properties through JSON roundtrip", async () => {
  const aliases = Object.fromEntries([
    ["constructor", { origin: "https://constructor.test" }],
  ]);
  const resolvedAliases = Object.fromEntries([
    ["constructor", "https://constructor.test"],
  ]);
  const scopedAliases = Object.fromEntries([
    ["constructor", "https://web.constructor.test"],
  ]);
  const response = {
    ...SUCCESS,
    plan: {
      ...COMPILE_SUCCESS.plan,
      routes: { ...ROUTES_PLAN, aliases, oauth_alias: "constructor" },
    },
    routing_resolution: {
      ...ROUTING_RESOLUTION,
      aliases: resolvedAliases,
      oauth_alias: "constructor",
      open_origin: "https://constructor.test",
      routes: {
        web: { ...ROUTING_RESOLUTION.routes.web, aliases: scopedAliases },
      },
    },
  };
  const binary = await fixture({ response });
  const result = await resolveNativeConfig({ input: INPUT, binary });
  const { environment_plan, ...expected } = response;
  void environment_plan;
  expect(result).toEqual(expected);
  if (!result.ok) {
    throw new Error("Expected canonical own alias keys");
  }
  expect(
    Object.hasOwn(result.routing_resolution?.aliases ?? {}, "constructor")
  ).toBe(true);
  expect(JSON.parse(JSON.stringify(result.routing_resolution))).toEqual(
    response.routing_resolution
  );
});

test("refuses an own __proto__ alias rather than losing it during projection", async () => {
  const aliases = Object.fromEntries([
    ["__proto__", { origin: "https://private.test" }],
  ]);
  const binary = await fixture({
    response: withRoutesPlan({ aliases, oauth_alias: undefined }),
  });
  await expectFailure({
    operation: compileNativeConfig({ input: INPUT, binary }),
    code: "E_COMPILER_RESPONSE",
  });
});

test("refuses foreign generated project and domain-alias origins even when scoped URLs agree", async () => {
  for (const response of [
    {
      ...SUCCESS,
      plan: {
        ...COMPILE_SUCCESS.plan,
        routes: { ...ROUTES_PLAN, origin: undefined },
      },
      routing_resolution: {
        ...ROUTING_RESOLUTION,
        project_origin: "https://foreign.dev.test",
        routes: {
          web: {
            ...ROUTING_RESOLUTION.routes.web,
            origin: "https://web.foreign.dev.test",
          },
        },
      },
    },
    withResolution({
      aliases: {
        ...ROUTING_RESOLUTION.aliases,
        oauth: "https://foreign.login.test",
      },
      open_origin: "https://foreign.login.test",
      routes: {
        web: {
          ...ROUTING_RESOLUTION.routes.web,
          aliases: {
            ...ROUTING_RESOLUTION.routes.web.aliases,
            oauth: "https://web.foreign.login.test",
          },
        },
      },
    }),
  ]) {
    const binary = await fixture({ response });
    await expectFailure({
      operation: resolveNativeConfig({ input: INPUT, binary }),
      code: "E_COMPILER_RESPONSE",
    });
  }
});

test("refuses an unrequested branch even when generated alias and route URLs agree", async () => {
  const binary = await fixture({
    response: {
      ...BRANCHED_SUCCESS,
      routing_resolution: {
        ...BRANCHED_SUCCESS.routing_resolution,
        domain_origin: "project",
      },
    },
  });
  await expectFailure({
    operation: resolveNativeConfig({ input: INPUT, binary }),
    code: "E_COMPILER_RESPONSE",
  });
});

test.each([
  {
    name: "explicit source without selection",
    selection: {},
    resolution: { domain_origin: "explicit" },
  },
  {
    name: "explicit value mismatch",
    selection: { explicitDomain: "dev.test" },
    resolution: { domain_origin: "explicit", domain: "foreign.test" },
  },
  {
    name: "global source without selection",
    selection: {},
    resolution: { domain_origin: "global", domain: "global.test" },
  },
  {
    name: "global value mismatch",
    selection: { globalDomain: "global.test" },
    resolution: { domain_origin: "global", domain: "foreign.test" },
  },
  {
    name: "default value mismatch",
    selection: {},
    resolution: { domain_origin: "default", domain: "foreign.test" },
  },
])("binds domain source metadata to the request: $name", async ({
  selection,
  resolution,
}) => {
  const binary = await fixture({ response: withResolution(resolution) });
  await expectFailure({
    operation: resolveNativeConfig({ input: INPUT, binary, ...selection }),
    code: "E_COMPILER_RESPONSE",
  });
});

test("strips raw envelope fields while retaining the validated routing projection", async () => {
  const binary = await fixture({
    response: { ...SUCCESS, private_payload: CANARY },
  });
  const result = await resolveNativeConfig({ input: INPUT, binary });
  const { environment_plan, ...expected } = SUCCESS;
  void environment_plan;
  expect(result).toEqual(expected);
  expect(result).not.toHaveProperty("envelope");
  expect(JSON.stringify(result)).not.toContain(CANARY);
});

test("projects fixed Rust domain diagnostics without raw values or private pointer fields", async () => {
  const diagnostic = {
    document: "request",
    code: "invalid_domain",
    pointer: "/explicit_domain",
    message: "Domain must be a canonical hostname.",
    line: 1,
    column: 1,
  } as const;
  const expected = {
    transport_version: 1,
    ok: false,
    diagnostics: [diagnostic],
  } as const;
  const binary = await fixture({
    response: {
      ...expected,
      diagnostics: [{ ...diagnostic, value: CANARY, path: directory }],
      private_payload: CANARY,
    },
    exitCode: 1,
  });
  const result = await resolveNativeConfig({
    input: INPUT,
    binary,
    requireRoutingPlanning: true,
    explicitDomain: CANARY,
  });
  expect(result).toEqual(expected);
  expect(JSON.stringify(result)).not.toContain(CANARY);
  expect(JSON.stringify(result)).not.toContain(directory);
});

test.each([
  { name: "single label", domain: "private" },
  { name: "numeric suffix", domain: "private.123" },
  { name: "hexadecimal suffix", domain: "private.0x1a" },
  { name: "empty hexadecimal suffix", domain: "private.0x" },
])("refuses a noncanonical declared or reported domain: $name", async ({
  domain,
}) => {
  for (const response of [
    withRoutesPlan({ domain }),
    withRoutesPlan({
      aliases: {
        ...ROUTES_PLAN.aliases,
        oauth: { domain },
      },
    }),
  ]) {
    const binary = await fixture({ response });
    await expectFailure({
      operation: compileNativeConfig({ input: INPUT, binary }),
      code: "E_COMPILER_RESPONSE",
    });
  }
  const binary = await fixture({ response: withResolution({ domain }) });
  await expectFailure({
    operation: resolveNativeConfig({ input: INPUT, binary }),
    code: "E_COMPILER_RESPONSE",
  });
});

test("retains the supported hack single-label domain", async () => {
  const binary = await fixture({
    response: withRoutesPlan({ domain: "hack" }),
  });
  const result = await compileNativeConfig({ input: INPUT, binary });
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("Expected the supported hack domain");
  }
  expect(result.plan.routes).toEqual({ ...ROUTES_PLAN, domain: "hack" });
});
