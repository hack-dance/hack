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
  process_plan_version: 1,
};
const CANARY = "private-process-wire-canary";
const WEB = {
  image: "fixture",
  entrypoint: { exec: [] },
  init: false,
  shutdown: { signal: "SIGPWR", grace: "2s" },
  restart: { kind: "always" },
};
const SEED = {
  image: "fixture",
  profiles: ["tools"],
  entrypoint: { shell: "printf fixture" },
  shutdown: { signal: "SIGTERM", grace: "1m" },
  restart: { kind: "on-failure", max_retries: 5 },
};
const SOURCE = {
  schema_version: 1,
  name: "fixture",
  profiles: ["tools"],
  services: { web: WEB },
  jobs: { seed: SEED },
};
const INPUT = new TextEncoder().encode(JSON.stringify(SOURCE));
const NORMALIZED_WEB = {
  ...WEB,
  shutdown: { ...WEB.shutdown, grace: "2000ms" },
};
const COMPILED = {
  transport_version: 1,
  ok: true,
  plan: {
    plan_version: 1,
    name: "fixture",
    selected_profiles: [],
    services: { web: NORMALIZED_WEB },
    jobs: {},
  },
  semantic_hash: "a".repeat(64),
  declared_workloads: { web: "service", seed: "job" },
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
  workloads: { web: {}, seed: {} },
  inactive_scopes: [],
} as const satisfies NativeEnvMetadata;
let root = "";
beforeEach(async () => {
  root = await realpath(
    await mkdtemp(join(tmpdir(), "native-process-transport-"))
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
  return { ...COMPILED, plan: { ...COMPILED.plan, services: { web } } };
}

test.each([
  undefined,
  null,
  2,
])("authored process capability %s is required before any payload", async (version) => {
  const receipt = join(root, "input-receipt");
  const binary = await fixture({
    protocol: { ...PROTOCOL, process_plan_version: version },
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

test("inactive authored process requirements still negotiate capability before input", async () => {
  const input = new TextEncoder().encode(
    JSON.stringify({
      schema_version: 1,
      name: "fixture",
      services: {},
      jobs: { seed: SEED },
    })
  );
  const receipt = join(root, "payload");
  const binary = await fixture({
    protocol: { ...PROTOCOL, process_plan_version: undefined },
    body: `await Bun.write(${JSON.stringify(receipt)},await Bun.stdin.text())`,
  });
  await failure(compileNativeConfig({ input, binary }), "E_COMPILER_VERSION");
  expect(await Bun.file(receipt).exists()).toBe(false);
});

test("explicit process negotiation remains available before field-free payloads", async () => {
  const input = new TextEncoder().encode(
    '{"schema_version":1,"name":"fixture"}'
  );
  await failure(
    compileNativeConfig({
      input,
      binary: await fixture({
        protocol: { ...PROTOCOL, process_plan_version: undefined },
      }),
      requireProcessPlanning: true,
    }),
    "E_COMPILER_VERSION"
  );
});

test("process-free old compiler calls retain their exact result without implied defaults", async () => {
  const result = {
    ...COMPILED,
    plan: { plan_version: 1, services: { web: {} }, jobs: {} },
  } satisfies NativeConfigCompileResult;
  const input = new TextEncoder().encode(
    '{"schema_version":1,"name":"fixture"}'
  );
  const binary = await fixture({
    protocol: { ...PROTOCOL, process_plan_version: undefined },
    result,
  });
  expect(await compileNativeConfig({ input, binary })).toEqual(result);
  expect((await resolveNativeConfig({ input, binary })).ok).toBe(true);
  expect(
    (await planNativeConfig({ input, binary, envMetadata: METADATA })).ok
  ).toBe(true);
});

test("entrypoint clearing, false init and normalized shutdown remain distinct authored requirements", async () => {
  const binary = await fixture();
  expect((await compileNativeConfig({ input: INPUT, binary })).ok).toBe(true);
  expect((await resolveNativeConfig({ input: INPUT, binary })).ok).toBe(true);
  const result = await planNativeConfig({
    input: INPUT,
    binary,
    envMetadata: METADATA,
  });
  expect(result).toHaveProperty("plan.services.web", NORMALIZED_WEB);
  expect(result).not.toHaveProperty("plan.services.web.command");
  expect(JSON.stringify(result)).not.toContain(CANARY);
});

test.each([
  "compile",
  "resolve",
  "plan",
] as const)("%s refuses silent drops despite a claimed matching process capability", async (operation) => {
  const result = withWeb({ image: "fixture" });
  const binary = await fixture({ result });
  const options = { input: INPUT, binary };
  await failure(
    operation === "compile"
      ? compileNativeConfig(options)
      : operation === "resolve"
        ? resolveNativeConfig(options)
        : planNativeConfig({ ...options, envMetadata: METADATA })
  );
});

test.each([
  { name: "entrypoint omitted", field: "entrypoint", value: undefined },
  {
    name: "changed entrypoint",
    field: "entrypoint",
    value: { shell: "printf changed" },
  },
  { name: "false init dropped", field: "init", value: undefined },
  { name: "changed init", field: "init", value: true },
  { name: "shutdown omitted", field: "shutdown", value: undefined },
  {
    name: "changed signal",
    field: "shutdown",
    value: { signal: "SIGKILL", grace: "2000ms" },
  },
  {
    name: "changed grace",
    field: "shutdown",
    value: { signal: "SIGPWR", grace: "2001ms" },
  },
  { name: "missing grace", field: "shutdown", value: { signal: "SIGPWR" } },
  { name: "restart omitted", field: "restart", value: undefined },
  { name: "changed restart", field: "restart", value: { kind: "no" } },
])("refuses changed source requirement: $name", async ({ field, value }) => {
  await failure(
    compileNativeConfig({
      input: INPUT,
      binary: await fixture({
        result: withWeb({ ...NORMALIZED_WEB, [field]: value }),
      }),
    })
  );
});

test.each([
  { name: "null entrypoint", field: "entrypoint", value: null },
  {
    name: "both entrypoint variants",
    field: "entrypoint",
    value: { exec: [], shell: "true" },
  },
  {
    name: "empty entrypoint program",
    field: "entrypoint",
    value: { exec: [""] },
  },
  { name: "entrypoint non-string", field: "entrypoint", value: { exec: [1] } },
  {
    name: "entrypoint NUL",
    field: "entrypoint",
    value: { exec: ["tool", "a\0b"] },
  },
  { name: "empty shell", field: "entrypoint", value: { shell: "" } },
  { name: "numeric init", field: "init", value: 1 },
  { name: "null init", field: "init", value: null },
  { name: "empty shutdown", field: "shutdown", value: {} },
  { name: "null shutdown", field: "shutdown", value: null },
  { name: "alias signal", field: "shutdown", value: { signal: "SIGIOT" } },
  { name: "prefixless signal", field: "shutdown", value: { signal: "TERM" } },
  { name: "numeric signal", field: "shutdown", value: { signal: 15 } },
  { name: "realtime signal", field: "shutdown", value: { signal: "SIGRTMIN" } },
  {
    name: "unknown shutdown field",
    field: "shutdown",
    value: { grace: "2000ms", signal: "SIGPWR", private: CANARY },
  },
  { name: "noncanonical grace", field: "shutdown", value: { grace: "2s" } },
  {
    name: "noncanonical padded grace",
    field: "shutdown",
    value: { grace: "0002ms" },
  },
  { name: "zero grace", field: "shutdown", value: { grace: "0ms" } },
  {
    name: "overflow grace",
    field: "shutdown",
    value: { grace: "4294967296ms" },
  },
  { name: "unknown restart", field: "restart", value: { kind: "sometimes" } },
  {
    name: "retry on always",
    field: "restart",
    value: { kind: "always", max_retries: 1 },
  },
  {
    name: "zero retry",
    field: "restart",
    value: { kind: "on-failure", max_retries: 0 },
  },
  {
    name: "overflow retry",
    field: "restart",
    value: { kind: "on-failure", max_retries: 4_294_967_296 },
  },
  {
    name: "extra restart field",
    field: "restart",
    value: { kind: "no", private: CANARY },
  },
])("refuses malformed process reply: $name", async ({ field, value }) => {
  await failure(
    compileNativeConfig({
      input: INPUT,
      binary: await fixture({
        result: withWeb({ ...NORMALIZED_WEB, [field]: value }),
      }),
    })
  );
});

test("an omitted authored field cannot be replaced by a guessed image default", async () => {
  const source = {
    ...SOURCE,
    services: { web: { image: "fixture", init: false } },
  };
  await failure(
    compileNativeConfig({
      input: new TextEncoder().encode(JSON.stringify(source)),
      binary: await fixture(),
    })
  );
});

test("process output cannot manufacture a workload absent from the authored namespace", async () => {
  const input = new TextEncoder().encode(
    '{"schema_version":1,"name":"fixture"}'
  );
  await failure(compileNativeConfig({ input, binary: await fixture() }));
});

test("a declared job cannot become a service to conceal a never-ending restart", async () => {
  const source = {
    schema_version: 1,
    name: "fixture",
    jobs: { task: { image: "fixture", restart: { kind: "always" } } },
  };
  const result = {
    ...COMPILED,
    declared_workloads: { task: "service" },
    plan: {
      ...COMPILED.plan,
      services: { task: { image: "fixture", restart: { kind: "always" } } },
      jobs: {},
    },
  };
  await failure(
    compileNativeConfig({
      input: new TextEncoder().encode(JSON.stringify(source)),
      binary: await fixture({ result }),
    })
  );
});

test("job always restart is rejected even when the claimed plan omits that inactive job", async () => {
  const input = new TextEncoder().encode(
    JSON.stringify({
      ...SOURCE,
      jobs: { seed: { ...SEED, restart: { kind: "always" } } },
    })
  );
  await failure(compileNativeConfig({ input, binary: await fixture() }));
});

test("profile selection is bound to the actual caller and cannot silently omit active process intent", async () => {
  const binary = await fixture();
  await failure(
    compileNativeConfig({ input: INPUT, binary, profiles: ["tools"] })
  );
  const result = {
    ...COMPILED,
    plan: {
      ...COMPILED.plan,
      selected_profiles: ["tools"],
      jobs: {
        seed: { ...SEED, shutdown: { ...SEED.shutdown, grace: "60000ms" } },
      },
    },
  };
  expect(
    (
      await compileNativeConfig({
        input: INPUT,
        binary: await fixture({ result }),
        profiles: ["tools"],
      })
    ).ok
  ).toBe(true);
});

test("inactive process intent is omitted only under the matching profile context", async () => {
  const result = {
    ...COMPILED,
    plan: {
      ...COMPILED.plan,
      jobs: {
        seed: { ...SEED, shutdown: { ...SEED.shutdown, grace: "60000ms" } },
      },
    },
  };
  await failure(
    compileNativeConfig({ input: INPUT, binary: await fixture({ result }) })
  );
});

test.each([
  "foreign",
  undefined,
])("process-aware replies bind project name %s to the original source", async (name) => {
  const result = { ...COMPILED, plan: { ...COMPILED.plan, name } };
  await failure(
    compileNativeConfig({ input: INPUT, binary: await fixture({ result }) })
  );
});

test("process-aware replies cannot omit active field-free siblings", async () => {
  const input = new TextEncoder().encode(
    JSON.stringify({
      ...SOURCE,
      services: { ...SOURCE.services, sibling: { image: "fixture" } },
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

test("process-aware replies cannot include inactive field-free siblings", async () => {
  const sibling = { image: "fixture", profiles: ["tools"] };
  const input = new TextEncoder().encode(
    JSON.stringify({
      ...SOURCE,
      services: { ...SOURCE.services, sibling },
    })
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

test("authoritative invalid-process diagnostics remain structured rather than TS-authored errors", async () => {
  const diagnostics = [
    {
      code: "invalid_restart",
      pointer: "/jobs/seed/restart",
      message: "Job restart cannot create a never-ending job.",
      line: 1,
      column: 1,
    },
  ];
  const input = new TextEncoder().encode(
    JSON.stringify({
      ...SOURCE,
      jobs: { seed: { ...SEED, restart: { kind: "always" } } },
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

test("malformed JSON remains an authoritative compiler diagnostic", async () => {
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
    input: new TextEncoder().encode('{"services":{"web":{"init":'),
    binary: await fixture({
      protocol: { ...PROTOCOL, process_plan_version: undefined },
      result: { transport_version: 1, ok: false, diagnostics },
      exit: 1,
    }),
  });
  expect(result).toEqual({ transport_version: 1, ok: false, diagnostics });
});
