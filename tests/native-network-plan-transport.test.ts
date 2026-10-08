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
  network_plan_version: 1,
};
const CANARY = "private-network-wire-canary";
const WEB = {
  image: "fixture:web",
  networks: { inside: { aliases: ["second", "first"] }, default: {} },
};
const PEER = { image: "fixture:peer" };
const SEED = {
  image: "fixture:seed",
  networks: { inside: { aliases: ["initializer"] } },
  profiles: ["tools"],
};
const SOURCE = {
  schema_version: 1,
  name: "fixture",
  networks: { inside: { internal: true }, outbound: {} },
  profiles: ["tools"],
  services: { web: WEB, peer: PEER },
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
    networks: { inside: { internal: true }, outbound: { internal: false } },
    services: {
      web: {
        ...WEB,
        networks: { inside: { aliases: ["first", "second"] }, default: {} },
      },
      peer: PEER,
    },
    jobs: {},
  },
  semantic_hash: "a".repeat(64),
  declared_workloads: { web: "service", peer: "service", seed: "job" },
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
  workloads: { web: {}, peer: {}, seed: {} },
  inactive_scopes: [],
} as const satisfies NativeEnvMetadata;
type Operation = "compile" | "resolve" | "plan";
let root = "";
beforeEach(async () => {
  root = await realpath(
    await mkdtemp(join(tmpdir(), "native-network-transport-"))
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
    readonly inputReceipt?: string;
  } = {}
) {
  const binary = join(root, "compiler");
  await Bun.write(
    binary,
    `#!${process.execPath}
if(process.argv[2]==='--protocol'){console.log(${JSON.stringify(JSON.stringify(opts.protocol ?? PROTOCOL))})}
else{
 const text=await Bun.stdin.text();
 ${opts.inputReceipt ? `await Bun.write(${JSON.stringify(opts.inputReceipt)},text);` : ""}
 const result=${JSON.stringify(opts.result ?? COMPILED)};
 if(result.ok&&process.argv[2]!=='compile')result.local_resolution=${JSON.stringify(LOCAL)};
 if(result.ok&&process.argv[2]==='plan')result.environment_plan={plan_version:1,overlay:null,overlay_exists:false,complete:true,workloads:Object.fromEntries([...Object.keys(result.plan.services??{}),...Object.keys(result.plan.jobs??{})].map(name=>[name,{}])),warnings:[],diagnostics:[]};
 console.log(JSON.stringify(result));process.stderr.write(${JSON.stringify(CANARY)});process.exitCode=${opts.exit ?? 0};
}`
  );
  await chmod(binary, 0o700);
  return binary;
}

function invoke(
  operation: Operation,
  opts: {
    readonly input: Uint8Array;
    readonly binary: string;
    readonly profiles?: readonly string[];
    readonly requireNetworkPlanning?: boolean;
  }
) {
  return operation === "compile"
    ? compileNativeConfig(opts)
    : operation === "resolve"
      ? resolveNativeConfig(opts)
      : planNativeConfig({ ...opts, envMetadata: METADATA });
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

function input(source: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(source));
}

test.each([
  undefined,
  null,
  0,
  2,
  "1",
])("network capability %s is required before all input deliveries", async (version) => {
  const receipt = join(root, "input-receipt");
  const binary = await fixture({
    protocol: { ...PROTOCOL, network_plan_version: version },
    inputReceipt: receipt,
  });
  for (const operation of ["compile", "resolve", "plan"] as const) {
    await failure(
      invoke(operation, { input: INPUT, binary }),
      "E_COMPILER_VERSION"
    );
  }
  expect(await Bun.file(receipt).exists()).toBe(false);
});

test.each([
  { schema_version: 1, name: "fixture", networks: {} },
  {
    schema_version: 1,
    name: "fixture",
    profiles: ["tools"],
    jobs: {
      seed: {
        image: "fixture",
        profiles: ["tools"],
        networks: { default: {} },
      },
    },
  },
])("authored presence including empty/inactive inputs requires negotiation", async (source) => {
  const receipt = join(root, "input-receipt");
  await failure(
    compileNativeConfig({
      input: input(source),
      binary: await fixture({
        protocol: { ...PROTOCOL, network_plan_version: undefined },
        inputReceipt: receipt,
      }),
    }),
    "E_COMPILER_VERSION"
  );
  expect(await Bun.file(receipt).exists()).toBe(false);
});

test("explicit network negotiation fences an otherwise unchanged old call", async () => {
  await failure(
    compileNativeConfig({
      input: input({ schema_version: 1, name: "fixture" }),
      binary: await fixture({
        protocol: { ...PROTOCOL, network_plan_version: undefined },
      }),
      requireNetworkPlanning: true,
    }),
    "E_COMPILER_VERSION"
  );
});

test("old network-free callers retain exact replies without requiring new capability", async () => {
  const result = {
    ...COMPILED,
    plan: { plan_version: 1, services: { web: {} }, jobs: {} },
  } satisfies NativeConfigCompileResult;
  const binary = await fixture({
    result,
    protocol: { ...PROTOCOL, network_plan_version: undefined },
  });
  const source = input({ schema_version: 1, name: "fixture" });
  expect(await compileNativeConfig({ input: source, binary })).toEqual(result);
  expect((await resolveNativeConfig({ input: source, binary })).ok).toBe(true);
  expect(
    (await planNativeConfig({ input: source, binary, envMetadata: METADATA }))
      .ok
  ).toBe(true);
});

test.each([
  "compile",
  "resolve",
  "plan",
] as const)("%s preserves normalized internal and outbound definitions plus aliases", async (operation) => {
  expect(
    await invoke(operation, { input: INPUT, binary: await fixture() })
  ).toHaveProperty("plan.networks.inside.internal", true);
});

test.each([
  "compile",
  "resolve",
  "plan",
] as const)("%s rejects stripped authored isolation despite a matching capability", async (operation) => {
  const plan = {
    ...COMPILED.plan,
    networks: undefined,
    services: { web: { image: WEB.image }, peer: PEER },
  };
  await failure(
    invoke(operation, {
      input: INPUT,
      binary: await fixture({ result: { ...COMPILED, plan } }),
    })
  );
});

test.each(
  [
    undefined,
    null,
    {},
    [],
    { inside: { internal: false }, outbound: { internal: false } },
    { inside: {}, outbound: { internal: false } },
    { inside: { internal: 1 }, outbound: { internal: false } },
    {
      inside: { internal: true, driver: CANARY },
      outbound: { internal: false },
    },
    {
      inside: { internal: true },
      outbound: { internal: false },
      extra: { internal: true },
    },
    {
      inside: { internal: true },
      outbound: { internal: false },
      default: { internal: false },
    },
    {
      inside: { internal: true },
      outbound: { internal: false },
      ingress: { internal: false },
    },
  ].map((networks: unknown) => ({ networks }))
)("changed/unsupported top network shape $networks is refused with fixed diagnostics", async ({
  networks,
}) => {
  await failure(
    compileNativeConfig({
      input: INPUT,
      binary: await fixture({
        result: {
          ...COMPILED,
          plan: { ...COMPILED.plan, networks },
        },
      }),
    })
  );
});

test.each(
  [
    undefined,
    null,
    {},
    [],
    { default: {} },
    { inside: {} },
    { inside: { aliases: ["first", "changed"] }, default: {} },
    { inside: { aliases: ["second", "first"] }, default: {} },
    { inside: { aliases: ["first", "first"] }, default: {} },
    { inside: { aliases: [] }, default: {} },
    { inside: { aliases: [CANARY, "first"], extra: true }, default: {} },
    { constructor: {} },
  ].map((networks: unknown) => ({ networks }))
)("altered/invalid selected attachment shape $networks is refused", async ({
  networks,
}) => {
  await failure(
    compileNativeConfig({
      input: INPUT,
      binary: await fixture({
        result: {
          ...COMPILED,
          plan: {
            ...COMPILED.plan,
            services: { ...COMPILED.plan.services, web: { ...WEB, networks } },
          },
        },
      }),
    })
  );
});

test("network-free sibling cannot acquire an invented default attachment", async () => {
  await failure(
    compileNativeConfig({
      input: INPUT,
      binary: await fixture({
        result: {
          ...COMPILED,
          plan: {
            ...COMPILED.plan,
            services: {
              ...COMPILED.plan.services,
              peer: { ...PEER, networks: { default: {} } },
            },
          },
        },
      }),
    })
  );
});

test.each([
  undefined,
  "foreign",
])("network-aware reply must bind source project name %s", async (name) => {
  await failure(
    compileNativeConfig({
      input: INPUT,
      binary: await fixture({
        result: { ...COMPILED, plan: { ...COMPILED.plan, name } },
      }),
    })
  );
});

test("forged success cannot bless a matching noncanonical project identity", async () => {
  await failure(
    compileNativeConfig({
      input: input({ ...SOURCE, name: "Invalid project" }),
      binary: await fixture({
        result: {
          ...COMPILED,
          plan: { ...COMPILED.plan, name: "Invalid project" },
        },
      }),
    })
  );
});

test("network-aware reply cannot omit an active field-free sibling", async () => {
  await failure(
    compileNativeConfig({
      input: INPUT,
      binary: await fixture({
        result: {
          ...COMPILED,
          plan: {
            ...COMPILED.plan,
            services: { web: COMPILED.plan.services.web },
          },
        },
      }),
    })
  );
});

test("network-aware reply cannot include an inactive field-free sibling", async () => {
  const peer = { ...PEER, profiles: ["tools"] };
  await failure(
    compileNativeConfig({
      input: input({ ...SOURCE, services: { web: WEB, peer } }),
      binary: await fixture({
        result: {
          ...COMPILED,
          plan: {
            ...COMPILED.plan,
            services: { ...COMPILED.plan.services, peer },
          },
        },
      }),
    })
  );
});

test("enabled job remains in its own selected namespace and actual profile request", async () => {
  const result = {
    ...COMPILED,
    plan: {
      ...COMPILED.plan,
      selected_profiles: ["tools"],
      jobs: { seed: SEED },
    },
  };
  const binary = await fixture({ result });
  expect(
    (await compileNativeConfig({ input: INPUT, binary, profiles: ["tools"] }))
      .ok
  ).toBe(true);
  await failure(compileNativeConfig({ input: INPUT, binary }));
  await failure(
    compileNativeConfig({
      input: INPUT,
      profiles: ["tools"],
      binary: await fixture(),
    })
  );
  await failure(
    compileNativeConfig({
      input: INPUT,
      profiles: ["tools"],
      binary: await fixture({
        result: {
          ...result,
          declared_workloads: {
            ...COMPILED.declared_workloads,
            seed: "service",
          },
          plan: {
            ...result.plan,
            jobs: {},
            services: { ...result.plan.services, seed: SEED },
          },
        },
      }),
    })
  );
});

test("inactive authored network errors cannot hide behind successful pruning", async () => {
  await failure(
    compileNativeConfig({
      input: input({ ...SOURCE, jobs: { seed: { ...SEED, networks: null } } }),
      binary: await fixture(),
    })
  );
});

test("own constructor network/workload names remain valid while invented inherited entries refuse", async () => {
  const source = {
    schema_version: 1,
    name: "fixture",
    networks: { constructor: {} },
    services: {
      constructor: { image: "fixture", networks: { constructor: {} } },
    },
  };
  const result = {
    ...COMPILED,
    declared_workloads: { constructor: "service" },
    plan: {
      plan_version: 1,
      name: "fixture",
      selected_profiles: [],
      networks: { constructor: { internal: false } },
      services: source.services,
      jobs: {},
    },
  };
  expect(
    (
      await compileNativeConfig({
        input: input(source),
        binary: await fixture({ result }),
      })
    ).ok
  ).toBe(true);
  await failure(
    compileNativeConfig({
      input: INPUT,
      binary: await fixture({
        result: {
          ...COMPILED,
          declared_workloads: {
            ...COMPILED.declared_workloads,
            constructor: "service",
          },
          plan: {
            ...COMPILED.plan,
            services: { ...COMPILED.plan.services, constructor: PEER },
          },
        },
      }),
    })
  );
});

test("empty authored top maps and alias arrays normalize without invented defaults", async () => {
  const source = {
    schema_version: 1,
    name: "fixture",
    networks: {},
    services: {
      web: { image: "fixture", networks: { default: { aliases: [] } } },
    },
  };
  const result = {
    ...COMPILED,
    declared_workloads: { web: "service" },
    plan: {
      plan_version: 1,
      name: "fixture",
      selected_profiles: [],
      services: { web: { image: "fixture", networks: { default: {} } } },
      jobs: {},
    },
  };
  expect(
    (
      await compileNativeConfig({
        input: input(source),
        binary: await fixture({ result }),
      })
    ).ok
  ).toBe(true);
});

test("unexpected network reply requires capability and still refuses invented declarations", async () => {
  const source = input({
    schema_version: 1,
    name: "fixture",
    services: { web: { image: "fixture" } },
  });
  const result = {
    ...COMPILED,
    declared_workloads: { web: "service" },
    plan: {
      plan_version: 1,
      name: "fixture",
      selected_profiles: [],
      networks: { inside: { internal: true } },
      services: { web: { image: "fixture" } },
      jobs: {},
    },
  };
  await failure(
    compileNativeConfig({
      input: source,
      binary: await fixture({
        result,
        protocol: { ...PROTOCOL, network_plan_version: undefined },
      }),
    }),
    "E_COMPILER_VERSION"
  );
  await failure(
    compileNativeConfig({ input: source, binary: await fixture({ result }) })
  );
});

test("authoritative invalid network diagnostics survive the transport unchanged", async () => {
  const diagnostics = [
    {
      code: "invalid_network_selection",
      pointer: "/jobs/seed/networks",
      message: "Network selection cannot be empty.",
      line: 1,
      column: 1,
      document: "project" as const,
    },
  ];
  const result = {
    transport_version: 1,
    ok: false,
    diagnostics,
  } satisfies NativeConfigCompileResult;
  const binary = await fixture({ result, exit: 1 });
  for (const operation of ["compile", "resolve", "plan"] as const) {
    expect(await invoke(operation, { input: INPUT, binary })).toEqual(result);
  }
});
