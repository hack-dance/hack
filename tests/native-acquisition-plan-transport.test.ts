import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compileNativeConfig,
  type NativeConfigCompileResult,
  NativeConfigCompilerError,
  planNativeConfig,
  resolveNativeConfig,
} from "../src/lib/native-config-compiler.ts";
import type { NativeEnvMetadata } from "../src/lib/native-env-plan-protocol.ts";

const PROTOCOL = {
  transport_version: 1,
  authored_version: 1,
  plan_version: 1,
  resolve_version: 1,
  local_version: 1,
  env_plan_version: 1,
  acquisition_plan_version: 1,
};
const CANARY = "private-acquisition-wire-canary";
const WEB = { image: "fixture:1", pull_policy: "missing" };
const BUILDER = {
  build: { context: ".", dockerfile: "Dockerfile" },
  pull_policy: "build",
};
const SEED = {
  image: "fixture:seed",
  pull_policy: "never",
  profiles: ["tools"],
};
const SOURCE = {
  schema_version: 1,
  name: "fixture",
  profiles: ["tools"],
  services: { web: WEB, builder: BUILDER },
  jobs: { seed: SEED },
};
const INPUT = new TextEncoder().encode(JSON.stringify(SOURCE));
const COMPILED = {
  transport_version: 1,
  ok: true,
  plan: {
    plan_version: 1,
    name: "fixture",
    selected_profiles: [],
    services: { web: WEB, builder: BUILDER },
    jobs: {},
  },
  semantic_hash: "a".repeat(64),
  declared_workloads: { web: "service", builder: "service", seed: "job" },
} satisfies NativeConfigCompileResult;
const LOCAL = {
  overlay: null,
  origin: "project",
  auto_branch: false,
  inherit_local: false,
  resolution_hash: "b".repeat(64),
};
const METADATA = {
  metadata_version: 1,
  overlay: null,
  overlay_exists: false,
  workloads: { web: {}, builder: {}, seed: {} },
  inactive_scopes: [],
} as const satisfies NativeEnvMetadata;
let root = "";

beforeEach(async () => {
  root = await realpath(
    await mkdtemp(join(tmpdir(), "native-acquisition-transport-"))
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function fixture(
  opts: {
    readonly protocol?: Record<string, unknown>;
    readonly result?: unknown;
    readonly exit?: number;
    readonly body?: string;
  } = {}
) {
  const binary = join(root, "compiler");
  const body =
    opts.body ??
    `const result=${JSON.stringify(opts.result ?? COMPILED)};if(result.ok&&process.argv[2]!=='compile'){result.local_resolution=${JSON.stringify(LOCAL)}}if(result.ok&&process.argv[2]==='plan'){result.environment_plan={plan_version:1,overlay:null,overlay_exists:false,complete:true,workloads:Object.fromEntries([...Object.keys(result.plan.services??{}),...Object.keys(result.plan.jobs??{})].map(name=>[name,{}])),warnings:[],diagnostics:[]}}console.log(JSON.stringify(result));process.stderr.write(${JSON.stringify(CANARY)});process.exitCode=${opts.exit ?? 0}`;
  await Bun.write(
    binary,
    `#!${process.execPath}\nif(process.argv[2]==='--protocol'){console.log(${JSON.stringify(JSON.stringify(opts.protocol ?? PROTOCOL))})}else{${body}}`
  );
  await chmod(binary, 0o700);
  return binary;
}

async function failure(
  operation: Promise<unknown>,
  code = "E_COMPILER_RESPONSE"
) {
  const error: unknown = await operation.catch((value: unknown) => value);
  expect(error).toBeInstanceOf(NativeConfigCompilerError);
  expect(error).toMatchObject({ code });
  expect(String(error)).not.toContain(CANARY);
  expect(String(error)).not.toContain(root);
}

function withWeb(web: unknown) {
  return {
    ...COMPILED,
    plan: { ...COMPILED.plan, services: { ...COMPILED.plan.services, web } },
  };
}

test.each([
  undefined,
  null,
  2,
])("authored acquisition capability %s is required before any payload", async (version) => {
  const receipt = join(root, "input-receipt");
  const binary = await fixture({
    protocol: { ...PROTOCOL, acquisition_plan_version: version },
    body: `await Bun.write(${JSON.stringify(receipt)},await Bun.stdin.text())`,
  });
  await failure(
    compileNativeConfig({ input: INPUT, binary }),
    "E_COMPILER_VERSION"
  );
  await failure(
    resolveNativeConfig({ input: INPUT, binary }),
    "E_COMPILER_VERSION"
  );
  await failure(
    planNativeConfig({ input: INPUT, binary, envMetadata: METADATA }),
    "E_COMPILER_VERSION"
  );
  expect(await Bun.file(receipt).exists()).toBe(false);
});

test("inactive policy still negotiates the capability before sending input", async () => {
  const input = new TextEncoder().encode(
    JSON.stringify({
      schema_version: 1,
      name: "fixture",
      profiles: ["tools"],
      jobs: { seed: SEED },
    })
  );
  const receipt = join(root, "input-receipt");
  const binary = await fixture({
    protocol: { ...PROTOCOL, acquisition_plan_version: undefined },
    body: `await Bun.write(${JSON.stringify(receipt)},await Bun.stdin.text())`,
  });
  await failure(compileNativeConfig({ input, binary }), "E_COMPILER_VERSION");
  expect(await Bun.file(receipt).exists()).toBe(false);
});

test("explicit acquisition negotiation can fence a policy-free call", async () => {
  await failure(
    compileNativeConfig({
      input: new TextEncoder().encode('{"schema_version":1,"name":"fixture"}'),
      binary: await fixture({
        protocol: { ...PROTOCOL, acquisition_plan_version: undefined },
      }),
      requireAcquisitionPlanning: true,
    }),
    "E_COMPILER_VERSION"
  );
});

test("older policy-free compilers retain the exact wire without invented defaults", async () => {
  const input = new TextEncoder().encode(
    '{"schema_version":1,"name":"fixture"}'
  );
  const result = {
    ...COMPILED,
    plan: { plan_version: 1, services: { web: {} }, jobs: {} },
  } satisfies NativeConfigCompileResult;
  const binary = await fixture({
    protocol: { ...PROTOCOL, acquisition_plan_version: undefined },
    result,
  });
  expect(await compileNativeConfig({ input, binary })).toEqual(result);
  expect((await resolveNativeConfig({ input, binary })).ok).toBe(true);
  expect(
    (await planNativeConfig({ input, binary, envMetadata: METADATA })).ok
  ).toBe(true);
});

test.each([
  "always",
  "never",
  "missing",
])("canonical image policy %s survives all transport paths", async (pull_policy) => {
  const web = { ...WEB, pull_policy };
  const input = new TextEncoder().encode(
    JSON.stringify({ ...SOURCE, services: { ...SOURCE.services, web } })
  );
  const binary = await fixture({ result: withWeb(web) });
  expect((await compileNativeConfig({ input, binary })).ok).toBe(true);
  expect((await resolveNativeConfig({ input, binary })).ok).toBe(true);
  expect(
    await planNativeConfig({ input, binary, envMetadata: METADATA })
  ).toHaveProperty("plan.services.web.pull_policy", pull_policy);
});

test("build-only policy stays typed without image fetching or guessed build defaults", async () => {
  const result = await compileNativeConfig({
    input: INPUT,
    binary: await fixture(),
  });
  expect(result).toHaveProperty("plan.services.builder", BUILDER);
  expect(result).not.toHaveProperty("plan.services.builder.image");
});

test.each([
  "compile",
  "resolve",
  "plan",
] as const)("%s rejects silently dropped policy despite a claimed matching capability", async (operation) => {
  const binary = await fixture({ result: withWeb({ image: WEB.image }) });
  const opts = { input: INPUT, binary };
  await failure(
    operation === "compile"
      ? compileNativeConfig(opts)
      : operation === "resolve"
        ? resolveNativeConfig(opts)
        : planNativeConfig({ ...opts, envMetadata: METADATA })
  );
});

test.each([
  null,
  false,
  1,
  {},
  { always: null },
  "",
  "Always",
  "if_not_present",
  "daily",
  "weekly",
  "every_12h",
])("malformed or unsupported policy %j is refused without leaking output", async (pull_policy) => {
  await failure(
    compileNativeConfig({
      input: INPUT,
      binary: await fixture({ result: withWeb({ ...WEB, pull_policy }) }),
    })
  );
});

test.each([
  { image: WEB.image, pull_policy: "never" },
  { image: "foreign:image", pull_policy: "missing" },
  { build: { context: "." }, pull_policy: "build" },
  { image: WEB.image, build: { context: "." }, pull_policy: "missing" },
  { image: null, pull_policy: "missing" },
  { pull_policy: "missing" },
])("changed acquisition source or intent %j is rejected", async (web) => {
  await failure(
    compileNativeConfig({
      input: INPUT,
      binary: await fixture({ result: withWeb(web) }),
    })
  );
});

test.each([
  { pull_policy: "build" },
  { build: null, pull_policy: "build" },
  { image: "fixture:1", pull_policy: "build" },
  { image: "fixture:1", build: BUILDER.build, pull_policy: "build" },
])("build policy refuses forged source combination %j", async (builder) => {
  const result = {
    ...COMPILED,
    plan: {
      ...COMPILED.plan,
      services: { ...COMPILED.plan.services, builder },
    },
  };
  await failure(
    compileNativeConfig({ input: INPUT, binary: await fixture({ result }) })
  );
});

test("a policy-free sibling cannot acquire an invented default", async () => {
  const sibling = { image: "fixture:sibling" };
  const input = new TextEncoder().encode(
    JSON.stringify({ ...SOURCE, services: { ...SOURCE.services, sibling } })
  );
  const result = {
    ...COMPILED,
    declared_workloads: { ...COMPILED.declared_workloads, sibling: "service" },
    plan: {
      ...COMPILED.plan,
      services: {
        ...COMPILED.plan.services,
        sibling: { ...sibling, pull_policy: "missing" },
      },
    },
  };
  await failure(
    compileNativeConfig({ input, binary: await fixture({ result }) })
  );
});

test.each([
  "foreign",
  undefined,
])("success binds project name %s to the original source", async (name) => {
  await failure(
    compileNativeConfig({
      input: INPUT,
      binary: await fixture({
        result: { ...COMPILED, plan: { ...COMPILED.plan, name } },
      }),
    })
  );
});

test("a job cannot move into the service namespace with its policy", async () => {
  const input = new TextEncoder().encode(
    JSON.stringify({ ...SOURCE, jobs: { seed: { ...SEED, profiles: [] } } })
  );
  const result = {
    ...COMPILED,
    declared_workloads: { ...COMPILED.declared_workloads, seed: "service" },
    plan: {
      ...COMPILED.plan,
      services: { ...COMPILED.plan.services, seed: { ...SEED, profiles: [] } },
    },
  };
  await failure(
    compileNativeConfig({ input, binary: await fixture({ result }) })
  );
});

test("namespace claims cannot invent absent own constructor workloads", async () => {
  const result = {
    ...COMPILED,
    declared_workloads: {
      ...COMPILED.declared_workloads,
      constructor: "service",
    },
    plan: {
      ...COMPILED.plan,
      services: { ...COMPILED.plan.services, constructor: WEB },
    },
  };
  await failure(
    compileNativeConfig({ input: INPUT, binary: await fixture({ result }) })
  );
});

test("process-free active siblings cannot be dropped by acquisition-aware replies", async () => {
  const input = new TextEncoder().encode(
    JSON.stringify({
      ...SOURCE,
      services: { ...SOURCE.services, sibling: { image: "fixture:sibling" } },
    })
  );
  const result = {
    ...COMPILED,
    declared_workloads: { ...COMPILED.declared_workloads, sibling: "service" },
  };
  await failure(
    compileNativeConfig({ input, binary: await fixture({ result }) })
  );
});

test("inactive policy-free siblings cannot appear in the selected plan", async () => {
  const sibling = { image: "fixture:sibling", profiles: ["tools"] };
  const input = new TextEncoder().encode(
    JSON.stringify({ ...SOURCE, services: { ...SOURCE.services, sibling } })
  );
  const result = {
    ...COMPILED,
    declared_workloads: { ...COMPILED.declared_workloads, sibling: "service" },
    plan: {
      ...COMPILED.plan,
      services: { ...COMPILED.plan.services, sibling },
    },
  };
  await failure(
    compileNativeConfig({ input, binary: await fixture({ result }) })
  );
});

test("selection matches the actual profile request and includes the enabled job", async () => {
  const result = {
    ...COMPILED,
    plan: {
      ...COMPILED.plan,
      selected_profiles: ["tools"],
      jobs: { seed: SEED },
    },
  };
  const binary = await fixture({ result });
  await failure(compileNativeConfig({ input: INPUT, binary }));
  expect(
    (await compileNativeConfig({ input: INPUT, binary, profiles: ["tools"] }))
      .ok
  ).toBe(true);
  await failure(
    compileNativeConfig({
      input: INPUT,
      binary: await fixture(),
      profiles: ["tools"],
    })
  );
});

test("invalid inactive source policy cannot hide behind a successful filtered reply", async () => {
  const input = new TextEncoder().encode(
    JSON.stringify({
      ...SOURCE,
      jobs: { seed: { ...SEED, pull_policy: "daily" } },
    })
  );
  await failure(compileNativeConfig({ input, binary: await fixture() }));
});

test("invalid image/build policy diagnostics remain authoritative Rust failures", async () => {
  const diagnostics = [
    {
      code: "invalid_pull_policy_source",
      pointer: "/services/web/pull_policy",
      message: "Pull policy does not match workload source.",
      line: 1,
      column: 1,
    },
  ];
  const input = new TextEncoder().encode(
    JSON.stringify({
      ...SOURCE,
      services: {
        ...SOURCE.services,
        web: { image: WEB.image, pull_policy: "build" },
      },
    })
  );
  const result = await compileNativeConfig({
    input,
    binary: await fixture({
      result: { transport_version: 1, ok: false, diagnostics },
      exit: 1,
    }),
  });
  expect(result).toEqual({ transport_version: 1, ok: false, diagnostics });
});

test("malformed JSON keeps authoritative diagnostics with older policy-free protocol", async () => {
  const diagnostics = [
    {
      code: "invalid_json",
      pointer: "",
      message: "Invalid JSON.",
      line: 1,
      column: 1,
    },
  ];
  const result = await compileNativeConfig({
    input: new TextEncoder().encode('{"services":{"web":{"pull_policy":'),
    binary: await fixture({
      protocol: { ...PROTOCOL, acquisition_plan_version: undefined },
      result: { transport_version: 1, ok: false, diagnostics },
      exit: 1,
    }),
  });
  expect(result).toEqual({ transport_version: 1, ok: false, diagnostics });
});
