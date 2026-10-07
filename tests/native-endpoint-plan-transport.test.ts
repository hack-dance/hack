import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compileNativeConfig,
  NativeConfigCompilerError,
  planNativeConfig,
  resolveNativeConfig,
} from "../src/lib/native-config-compiler.ts";
import {
  parseNativeEndpointBinding,
  parseNativeHostBindingTarget,
} from "../src/lib/native-endpoint-plan-protocol.ts";
import type { NativeEnvMetadata } from "../src/lib/native-env-plan-protocol.ts";

const PROTOCOL = {
  transport_version: 1,
  authored_version: 1,
  plan_version: 1,
  resolve_version: 1,
  local_version: 1,
  env_plan_version: 1,
  host_env_plan_version: 1,
  routing_plan_version: 1,
  endpoint_plan_version: 1,
};
const INPUT = new TextEncoder().encode('{"schema_version":1,"name":"fixture"}');
const CANARY = "endpoint-private-canary";
const METADATA = {
  metadata_version: 1,
  overlay: null,
  overlay_exists: false,
  workloads: { web: {}, api: {} },
  inactive_scopes: [],
} as const satisfies NativeEnvMetadata;
const HOST_TARGET = { kind: "host", port: 9443, protocol: "https" } as const;
const EXTERNAL_TARGET = {
  kind: "external",
  hostname: "qa.example.test",
  port: 443,
  protocol: "https",
} as const;
const ROUTE_REFERENCE = { kind: "route", name: "web" } as const;
const SERVICE_REFERENCE = {
  kind: "service",
  name: "api",
  port: 3000,
  protocol: "http",
} as const;
const BINDING_REFERENCE = { kind: "host_binding", name: "tunnel" } as const;
const ENVIRONMENT = {
  PUBLIC: { endpoint: ROUTE_REFERENCE },
  API: { endpoint: SERVICE_REFERENCE },
  TUNNEL: { endpoint: BINDING_REFERENCE },
  EXTERNAL: { endpoint: { kind: "host_binding", name: "qa" } },
};
const PLAN = {
  plan_version: 1,
  name: "fixture",
  services: { web: { environment: ENVIRONMENT }, api: {} },
  jobs: {},
  host_bindings: { tunnel: HOST_TARGET, qa: EXTERNAL_TARGET },
  routes: {
    aliases: {},
    http: {
      web: {
        service: "web",
        port: 3000,
        protocol: "http",
        hostname: "project",
      },
    },
  },
};
const COMPILED = {
  transport_version: 1,
  ok: true,
  semantic_hash: "a".repeat(64),
  declared_workloads: {
    web: "service",
    api: "service",
    inactive: "service",
    seed: "job",
  },
  plan: PLAN,
};
const RESOLUTION = {
  bindings: {
    tunnel: { target: HOST_TARGET, origin: "project" },
    qa: { target: EXTERNAL_TARGET, origin: "project" },
  },
  removed: {},
};
const LOCAL = {
  overlay: null,
  origin: "project",
  auto_branch: false,
  inherit_local: true,
  resolution_hash: "b".repeat(64),
};
const ROUTING = {
  domain: "hack.local",
  domain_origin: "default",
  project_origin: "https://fixture.hack.local",
  aliases: {},
  oauth_alias: null,
  open_preference: "auto",
  open_preference_origin: "default",
  open_origin: "https://fixture.hack.local",
  routes: {
    web: {
      service: "web",
      port: 3000,
      protocol: "http",
      origin: "https://fixture.hack.local",
      aliases: {},
    },
  },
};
const BINDINGS = {
  PUBLIC: {
    kind: "endpoint",
    reference: ROUTE_REFERENCE,
    target: { kind: "route", origin: "https://fixture.hack.local" },
  },
  API: {
    kind: "endpoint",
    reference: SERVICE_REFERENCE,
    target: SERVICE_REFERENCE,
  },
  TUNNEL: {
    kind: "endpoint",
    reference: BINDING_REFERENCE,
    target: { ...HOST_TARGET, context: "workload" },
  },
  EXTERNAL: {
    kind: "endpoint",
    reference: { kind: "host_binding", name: "qa" },
    target: EXTERNAL_TARGET,
  },
};
const SUCCESS = {
  ...COMPILED,
  local_resolution: LOCAL,
  host_binding_resolution: RESOLUTION,
  routing_resolution: ROUTING,
  environment_plan: {
    plan_version: 1,
    overlay: null,
    overlay_exists: false,
    complete: true,
    workloads: { web: BINDINGS, api: {} },
    warnings: [],
    diagnostics: [],
  },
};
let directory = "";
beforeEach(async () => {
  directory = await realpath(
    await mkdtemp(join(tmpdir(), "native-endpoint-transport-"))
  );
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function fixture(
  opts: {
    readonly response?: unknown;
    readonly protocol?: Record<string, unknown>;
    readonly body?: string;
    readonly exit?: number;
  } = {}
) {
  const binary = join(directory, "compiler");
  await Bun.write(
    binary,
    `#!${process.execPath}\nif(process.argv[2]==='--protocol'){console.log(${JSON.stringify(JSON.stringify(opts.protocol ?? PROTOCOL))})}else{${opts.body ?? `console.log(${JSON.stringify(JSON.stringify(opts.response ?? SUCCESS))});process.stderr.write(${JSON.stringify(CANARY)});process.exitCode=${opts.exit ?? 0}`}}`
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
  expect(String(error)).not.toContain(directory);
}

function withBinding(name: string, value: unknown) {
  return {
    ...SUCCESS,
    environment_plan: {
      ...SUCCESS.environment_plan,
      workloads: {
        ...SUCCESS.environment_plan.workloads,
        web: { ...BINDINGS, [name]: value },
      },
    },
  };
}

test.each([
  undefined,
  null,
  2,
])("endpoint capability %s is fenced before payload", async (version) => {
  const receipt = join(directory, "payload");
  const binary = await fixture({
    protocol: { ...PROTOCOL, endpoint_plan_version: version },
    body: `await Bun.write(${JSON.stringify(receipt)},await Bun.stdin.text())`,
  });
  const options = { input: INPUT, binary, requireEndpointPlanning: true };
  await failure(compileNativeConfig(options), "E_COMPILER_VERSION");
  await failure(resolveNativeConfig(options), "E_COMPILER_VERSION");
  await failure(
    planNativeConfig({ ...options, envMetadata: METADATA }),
    "E_COMPILER_VERSION"
  );
  expect(await Bun.file(receipt).exists()).toBe(false);
});

test("endpoint declarations require capability even when the caller did not predict them", async () => {
  const binary = await fixture({
    response: COMPILED,
    protocol: { ...PROTOCOL, endpoint_plan_version: undefined },
  });
  await failure(
    compileNativeConfig({ input: INPUT, binary }),
    "E_COMPILER_VERSION"
  );
});

test("old endpoint-free compilers remain compatible with all three calls", async () => {
  const legacy = {
    ...COMPILED,
    plan: { plan_version: 1, services: { web: {} }, jobs: {} },
  };
  const protocol = {
    ...PROTOCOL,
    endpoint_plan_version: undefined,
    routing_plan_version: undefined,
  };
  const binary = await fixture({
    protocol,
    body: `const result=${JSON.stringify(legacy)};if(process.argv[2]!=='compile'){result.local_resolution=${JSON.stringify(LOCAL)}}if(process.argv[2]==='plan'){result.environment_plan={plan_version:1,overlay:null,overlay_exists:false,complete:true,workloads:{web:{}},warnings:[],diagnostics:[]}}console.log(JSON.stringify(result))`,
  });
  expect((await compileNativeConfig({ input: INPUT, binary })).ok).toBe(true);
  expect((await resolveNativeConfig({ input: INPUT, binary })).ok).toBe(true);
  expect(
    (
      await planNativeConfig({
        input: INPUT,
        binary,
        envMetadata: { ...METADATA, workloads: { web: {} } },
      })
    ).ok
  ).toBe(true);
});

test("typed service, public route, host and external endpoints cross-check without inventing runtime URLs", async () => {
  const binary = await fixture();
  const result = await planNativeConfig({
    input: INPUT,
    binary,
    envMetadata: METADATA,
  });
  expect(result).toHaveProperty("environment_plan.workloads.web", BINDINGS);
  expect(result).toHaveProperty("host_binding_resolution", RESOLUTION);
  const output = JSON.stringify(result);
  expect(output).not.toContain(CANARY);
  expect(output).not.toContain("host.docker.internal");
});

test("routing input probes still validate effective bindings and postpone public-origin resolution", async () => {
  const { routing_resolution, environment_plan, ...probe } = SUCCESS;
  void routing_resolution;
  void environment_plan;
  const binary = await fixture({
    response: { ...probe, routing_inputs_required: true },
  });
  const result = await resolveNativeConfig({
    input: INPUT,
    binary,
    probeRoutingInputs: true,
  });
  expect(result).toHaveProperty("routing_inputs_required", true);
  expect(result).toHaveProperty("host_binding_resolution", RESOLUTION);
  expect(result).not.toHaveProperty("routing_resolution");
});

test.each([
  { name: "unknown", reference: { ...SERVICE_REFERENCE, name: "missing" } },
  { name: "inactive", reference: { ...SERVICE_REFERENCE, name: "inactive" } },
  { name: "job", reference: { ...SERVICE_REFERENCE, name: "seed" } },
  { name: "unknown route", reference: { kind: "route", name: "missing" } },
  { name: "unknown tag", reference: { kind: "database", name: "api" } },
  { name: "extra field", reference: { ...SERVICE_REFERENCE, value: CANARY } },
  { name: "zero port", reference: { ...SERVICE_REFERENCE, port: 0 } },
  { name: "fractional port", reference: { ...SERVICE_REFERENCE, port: 1.5 } },
  {
    name: "bad protocol",
    reference: { ...SERVICE_REFERENCE, protocol: "udp" },
  },
])("refuses invalid normalized endpoint: $name", async ({ reference }) => {
  const response = {
    ...COMPILED,
    plan: {
      ...PLAN,
      services: {
        ...PLAN.services,
        web: { environment: { API: { endpoint: reference } } },
      },
    },
  };
  const binary = await fixture({ response });
  await failure(compileNativeConfig({ input: INPUT, binary }));
});

test("endpoint plus unset in a normalized environment destination is refused", async () => {
  const response = {
    ...COMPILED,
    plan: {
      ...PLAN,
      services: {
        ...PLAN.services,
        web: {
          environment: { API: { endpoint: SERVICE_REFERENCE, unset: true } },
        },
      },
    },
  };
  await failure(
    compileNativeConfig({ input: INPUT, binary: await fixture({ response }) })
  );
});

test.each([
  {
    name: "foreign public origin",
    binding: {
      ...BINDINGS.PUBLIC,
      target: { kind: "route", origin: "https://foreign.example.test" },
    },
  },
  {
    name: "forged reference",
    binding: { ...BINDINGS.PUBLIC, reference: { kind: "route", name: "api" } },
  },
  {
    name: "wrong target kind",
    binding: { ...BINDINGS.PUBLIC, target: SERVICE_REFERENCE },
  },
  {
    name: "extra secret value",
    binding: { ...BINDINGS.PUBLIC, value: CANARY },
  },
  {
    name: "credential origin",
    binding: {
      ...BINDINGS.PUBLIC,
      target: { kind: "route", origin: `https://user:${CANARY}@example.test` },
    },
  },
  {
    name: "origin with path",
    binding: {
      ...BINDINGS.PUBLIC,
      target: { kind: "route", origin: "https://fixture.hack.local/path" },
    },
  },
])("refuses forged route report: $name", async ({ binding }) => {
  await failure(
    planNativeConfig({
      input: INPUT,
      binary: await fixture({ response: withBinding("PUBLIC", binding) }),
      envMetadata: METADATA,
    })
  );
});

test.each([
  {
    name: "wrong target service",
    key: "API",
    target: { ...SERVICE_REFERENCE, name: "web" },
  },
  {
    name: "wrong service port",
    key: "API",
    target: { ...SERVICE_REFERENCE, port: 3001 },
  },
  {
    name: "wrong service protocol",
    key: "API",
    target: { ...SERVICE_REFERENCE, protocol: "tcp" },
  },
  {
    name: "wrong host context",
    key: "TUNNEL",
    target: { ...HOST_TARGET, context: "host" },
  },
  { name: "absent host context", key: "TUNNEL", target: HOST_TARGET },
  {
    name: "wrong host port",
    key: "TUNNEL",
    target: { ...HOST_TARGET, port: 9444, context: "workload" },
  },
  {
    name: "wrong external hostname",
    key: "EXTERNAL",
    target: { ...EXTERNAL_TARGET, hostname: "foreign.test" },
  },
])("refuses forged contextual target: $name", async ({ key, target }) => {
  const original = BINDINGS[key as keyof typeof BINDINGS];
  await failure(
    planNativeConfig({
      input: INPUT,
      binary: await fixture({
        response: withBinding(key, { ...original, target }),
      }),
      envMetadata: METADATA,
    })
  );
});

test("refuses an endpoint at an unauthored environment destination", async () => {
  await failure(
    planNativeConfig({
      input: INPUT,
      binary: await fixture({ response: withBinding("FORGED", BINDINGS.API) }),
      envMetadata: METADATA,
    })
  );
});

test("refuses a complete report omitting an authored endpoint", async () => {
  const { API, ...bindings } = BINDINGS;
  void API;
  const response = {
    ...SUCCESS,
    environment_plan: {
      ...SUCCESS.environment_plan,
      workloads: { web: bindings, api: {} },
    },
  };
  await failure(
    planNativeConfig({
      input: INPUT,
      binary: await fixture({ response }),
      envMetadata: METADATA,
    })
  );
});

test("managed same-key endpoint collisions retain the baseline and remain incomplete", async () => {
  const baseline = { scope: "web", secret: true };
  const metadata = {
    ...METADATA,
    workloads: { ...METADATA.workloads, web: { API: baseline } },
  };
  const response = withBinding("API", {
    kind: "managed",
    key: "API",
    ...baseline,
  });
  const result = await planNativeConfig({
    input: INPUT,
    binary: await fixture({
      response: {
        ...response,
        environment_plan: {
          ...response.environment_plan,
          complete: false,
          diagnostics: [
            {
              document: "project",
              code: "env_endpoint_collision",
              pointer: "/services/web/environment/API",
              message: "Endpoint conflicts with managed environment.",
              line: 1,
              column: 1,
            },
          ],
        },
      },
      exit: 1,
    }),
    envMetadata: metadata,
  });
  expect(result).toHaveProperty("environment_plan.complete", false);
  expect(result).toHaveProperty("environment_plan.workloads.web.API", {
    kind: "managed",
    key: "API",
    ...baseline,
  });
  await failure(
    planNativeConfig({
      input: INPUT,
      binary: await fixture(),
      envMetadata: metadata,
    })
  );
});

function withHost(opts: {
  readonly environment: Record<string, unknown>;
  readonly bindings: Record<string, unknown>;
  readonly diagnostics?: readonly unknown[];
}) {
  const diagnostics = opts.diagnostics ?? [];
  return {
    ...SUCCESS,
    plan: {
      ...PLAN,
      host: {
        up: {
          before: [
            {
              name: "prepare",
              command: ["printf", "fixture"],
              cwd: ".",
              environment: opts.environment,
              env_target: { kind: "host" },
            },
          ],
        },
      },
    },
    host_env_targets: { include_default: true, workloads: [] },
    environment_plan: {
      ...SUCCESS.environment_plan,
      complete: diagnostics.length === 0,
      diagnostics,
      host: {
        prepare: { env_target: { kind: "host" }, bindings: opts.bindings },
      },
    },
  };
}

const HOST_METADATA = {
  ...METADATA,
  host: { default: {}, workloads: {} },
} as const satisfies NativeEnvMetadata;
const UNSUPPORTED_HOST_ENDPOINT = {
  document: "project",
  code: "unsupported_endpoint_context",
  pointer: "/host/up/before/0/environment/API",
  message: "A host invocation cannot use a workload-only endpoint.",
  line: 1,
  column: 1,
};

test("host invocations preserve host context and route origins in typed endpoints", async () => {
  const response = withHost({
    environment: { PUBLIC: ENVIRONMENT.PUBLIC, TUNNEL: ENVIRONMENT.TUNNEL },
    bindings: {
      PUBLIC: BINDINGS.PUBLIC,
      TUNNEL: {
        ...BINDINGS.TUNNEL,
        target: { ...HOST_TARGET, context: "host" },
      },
    },
  });
  const result = await planNativeConfig({
    input: INPUT,
    binary: await fixture({ response }),
    envMetadata: HOST_METADATA,
  });
  expect(result).toHaveProperty(
    "environment_plan.host.prepare.bindings.TUNNEL.target.context",
    "host"
  );
});

test("unsupported direct service endpoints in host commands are incomplete and symbolic", async () => {
  const response = withHost({
    environment: { API: ENVIRONMENT.API },
    bindings: {},
    diagnostics: [UNSUPPORTED_HOST_ENDPOINT],
  });
  const result = await planNativeConfig({
    input: INPUT,
    binary: await fixture({ response, exit: 1 }),
    envMetadata: HOST_METADATA,
  });
  expect(result).toHaveProperty("environment_plan.complete", false);
  expect(result).not.toHaveProperty(
    "environment_plan.host.prepare.bindings.API"
  );
});

test.each([
  "host",
  "workload",
] as const)("unsupported host endpoint cannot discard same-key managed %s metadata", async (kind) => {
  const original = withHost({
    environment: { API: ENVIRONMENT.API },
    bindings: {},
    diagnostics: [UNSUPPORTED_HOST_ENDPOINT],
  });
  const target =
    kind === "host" ? { kind: "host" } : { kind: "workload", name: "api" };
  const response = {
    ...original,
    plan: {
      ...original.plan,
      host: {
        up: {
          before: [{ ...original.plan.host.up.before[0], env_target: target }],
        },
      },
    },
    host_env_targets: {
      include_default: kind === "host",
      workloads: kind === "workload" ? ["api"] : [],
    },
    environment_plan: {
      ...original.environment_plan,
      host: { prepare: { env_target: target, bindings: {} } },
    },
  };
  const baseline = {
    API: { scope: kind === "host" ? "host" : "api", secret: true },
  };
  const metadata: NativeEnvMetadata = {
    ...METADATA,
    host:
      kind === "host"
        ? { default: baseline, workloads: {} }
        : { workloads: { api: baseline } },
  };
  await failure(
    planNativeConfig({
      input: INPUT,
      binary: await fixture({ response, exit: 1 }),
      envMetadata: metadata,
    })
  );
});

test.each([
  {
    name: "guessed workload address",
    bindings: { API: BINDINGS.API },
    diagnostics: [],
  },
  {
    name: "missing destination without diagnostic",
    bindings: {},
    diagnostics: [],
  },
  {
    name: "diagnostic at foreign pointer",
    bindings: {},
    diagnostics: [
      {
        ...UNSUPPORTED_HOST_ENDPOINT,
        pointer: "/host/up/before/0/environment/OTHER",
      },
    ],
  },
  {
    name: "unrelated diagnostic",
    bindings: {},
    diagnostics: [
      { ...UNSUPPORTED_HOST_ENDPOINT, code: "missing_environment_binding" },
    ],
  },
])("refuses unsupported host endpoint substitution: $name", async ({
  bindings,
  diagnostics,
}) => {
  const response = withHost({
    environment: { API: ENVIRONMENT.API },
    bindings,
    diagnostics,
  });
  await failure(
    planNativeConfig({
      input: INPUT,
      binary: await fixture({
        response,
        exit: diagnostics.length === 0 ? 0 : 1,
      }),
      envMetadata: HOST_METADATA,
    })
  );
});

test("host endpoint collision retains only the managed metadata baseline", async () => {
  const baseline = { scope: "host", secret: true };
  const metadata = {
    ...HOST_METADATA,
    host: { default: { TUNNEL: baseline }, workloads: {} },
  };
  const response = withHost({
    environment: { TUNNEL: ENVIRONMENT.TUNNEL },
    bindings: { TUNNEL: { kind: "managed", key: "TUNNEL", ...baseline } },
    diagnostics: [
      {
        ...UNSUPPORTED_HOST_ENDPOINT,
        code: "env_endpoint_collision",
        pointer: "/host/up/before/0/environment/TUNNEL",
      },
    ],
  });
  const result = await planNativeConfig({
    input: INPUT,
    binary: await fixture({ response, exit: 1 }),
    envMetadata: metadata,
  });
  expect(result).toHaveProperty(
    "environment_plan.host.prepare.bindings.TUNNEL",
    { kind: "managed", key: "TUNNEL", ...baseline }
  );
  const forged = withHost({
    environment: { TUNNEL: ENVIRONMENT.TUNNEL },
    bindings: {
      TUNNEL: {
        ...BINDINGS.TUNNEL,
        target: { ...HOST_TARGET, context: "host" },
      },
    },
  });
  await failure(
    planNativeConfig({
      input: INPUT,
      binary: await fixture({ response: forged }),
      envMetadata: metadata,
    })
  );
});

test.each([
  { name: "missing", resolution: undefined },
  { name: "null", resolution: null },
  { name: "extra keys", resolution: { ...RESOLUTION, private: CANARY } },
  {
    name: "unknown origin",
    resolution: {
      ...RESOLUTION,
      bindings: {
        ...RESOLUTION.bindings,
        tunnel: { target: HOST_TARGET, origin: "global" },
      },
    },
  },
  {
    name: "forged project target",
    resolution: {
      ...RESOLUTION,
      bindings: {
        ...RESOLUTION.bindings,
        tunnel: { target: { ...HOST_TARGET, port: 9000 }, origin: "project" },
      },
    },
  },
  {
    name: "missing authored binding",
    resolution: { ...RESOLUTION, bindings: { qa: RESOLUTION.bindings.qa } },
  },
  {
    name: "project tombstone",
    resolution: { ...RESOLUTION, removed: { absent: "project" } },
  },
  {
    name: "same name retained and removed",
    resolution: { ...RESOLUTION, removed: { tunnel: "checkout_local" } },
  },
  {
    name: "absent primary provenance",
    resolution: {
      ...RESOLUTION,
      bindings: {
        ...RESOLUTION.bindings,
        tunnel: { target: HOST_TARGET, origin: "primary_local" },
      },
    },
  },
  {
    name: "absent checkout provenance",
    resolution: {
      ...RESOLUTION,
      bindings: {
        ...RESOLUTION.bindings,
        tunnel: { target: HOST_TARGET, origin: "checkout_local" },
      },
    },
  },
])("refuses malformed binding resolution: $name", async ({ resolution }) => {
  const response = { ...SUCCESS, host_binding_resolution: resolution };
  await failure(
    resolveNativeConfig({ input: INPUT, binary: await fixture({ response }) })
  );
});

test("compile accepts symbolic local binding names but resolution refuses missing or removed references", async () => {
  const localPlan = {
    plan_version: 1,
    services: {
      web: { environment: { TUNNEL: { endpoint: BINDING_REFERENCE } } },
    },
    jobs: {},
  };
  const compiled = { ...COMPILED, plan: localPlan };
  expect(
    (
      await compileNativeConfig({
        input: INPUT,
        binary: await fixture({ response: compiled }),
      })
    ).ok
  ).toBe(true);
  const response = {
    ...compiled,
    local_resolution: LOCAL,
    host_binding_resolution: {
      bindings: {},
      removed: { tunnel: "checkout_local" },
    },
  };
  await failure(
    resolveNativeConfig({
      input: INPUT,
      binary: await fixture({ response }),
      checkoutLocal: new TextEncoder().encode(
        '{"schema_version":1,"host_bindings":{"tunnel":null}}'
      ),
    })
  );
});

test("an absent constructor binding cannot resolve through the Object prototype", async () => {
  const plan = {
    plan_version: 1,
    services: {
      web: {
        environment: {
          API: { endpoint: { kind: "host_binding", name: "constructor" } },
        },
      },
    },
    jobs: {},
    host_bindings: {},
  };
  const response = {
    ...COMPILED,
    plan,
    local_resolution: LOCAL,
    host_binding_resolution: { bindings: {}, removed: {} },
  };
  await failure(
    resolveNativeConfig({ input: INPUT, binary: await fixture({ response }) })
  );
});

test("an explicitly declared constructor binding remains an own logical name", async () => {
  const reference = { kind: "host_binding", name: "constructor" };
  const plan = {
    plan_version: 1,
    services: { web: { environment: { API: { endpoint: reference } } } },
    jobs: {},
    host_bindings: { constructor: HOST_TARGET },
  };
  const response = {
    ...COMPILED,
    plan,
    local_resolution: LOCAL,
    host_binding_resolution: {
      bindings: { constructor: { target: HOST_TARGET, origin: "project" } },
      removed: {},
    },
    environment_plan: {
      plan_version: 1,
      overlay: null,
      overlay_exists: false,
      complete: true,
      workloads: {
        web: {
          API: {
            kind: "endpoint",
            reference,
            target: { ...HOST_TARGET, context: "workload" },
          },
        },
      },
      warnings: [],
      diagnostics: [],
    },
  };
  const result = await planNativeConfig({
    input: INPUT,
    binary: await fixture({ response }),
    envMetadata: { ...METADATA, workloads: { web: {} } },
  });
  expect(result).toHaveProperty(
    "environment_plan.workloads.web.API.target.port",
    HOST_TARGET.port
  );
});

test("local-only binding report negotiates endpoint capability before callers may fetch metadata", async () => {
  const response = {
    ...COMPILED,
    plan: { plan_version: 1, services: {}, jobs: {} },
    local_resolution: LOCAL,
    host_binding_resolution: {
      bindings: { local: { target: HOST_TARGET, origin: "checkout_local" } },
      removed: {},
    },
  };
  await failure(
    resolveNativeConfig({
      input: INPUT,
      binary: await fixture({
        response,
        protocol: { ...PROTOCOL, endpoint_plan_version: undefined },
      }),
      checkoutLocal: new TextEncoder().encode(
        JSON.stringify({
          schema_version: 1,
          host_bindings: { local: HOST_TARGET },
        })
      ),
    }),
    "E_COMPILER_VERSION"
  );
});

test.each([
  {
    name: "missing local map",
    document: { schema_version: 1 },
    source: "checkout_local",
    target: HOST_TARGET,
  },
  {
    name: "missing own local member",
    document: { schema_version: 1, host_bindings: {} },
    source: "checkout_local",
    target: HOST_TARGET,
  },
  {
    name: "changed local target",
    document: {
      schema_version: 1,
      host_bindings: { local: { ...HOST_TARGET, port: 9444 } },
    },
    source: "checkout_local",
    target: HOST_TARGET,
  },
  {
    name: "null local target",
    document: { schema_version: 1, host_bindings: { local: null } },
    source: "checkout_local",
    target: HOST_TARGET,
  },
  {
    name: "missing primary member",
    document: { schema_version: 1, host_bindings: {} },
    source: "primary_local",
    target: HOST_TARGET,
  },
])("provenance cannot invent a source claim: $name", async ({
  document,
  source,
  target,
}) => {
  const input = new TextEncoder().encode(JSON.stringify(document));
  const response = {
    ...COMPILED,
    plan: { plan_version: 1, services: {}, jobs: {} },
    local_resolution: LOCAL,
    host_binding_resolution: {
      bindings: { local: { target, origin: source } },
      removed: {},
    },
  };
  await failure(
    resolveNativeConfig({
      input: INPUT,
      binary: await fixture({ response }),
      ...(source === "primary_local"
        ? { primaryLocal: input }
        : { checkoutLocal: input }),
    })
  );
});

test.each([
  { schema_version: 1 },
  { schema_version: 1, host_bindings: {} },
  { schema_version: 1, host_bindings: { local: HOST_TARGET } },
])("provenance cannot invent a local tombstone from %j", async (document) => {
  const response = {
    ...COMPILED,
    plan: { plan_version: 1, services: {}, jobs: {} },
    local_resolution: LOCAL,
    host_binding_resolution: {
      bindings: {},
      removed: { local: "checkout_local" },
    },
  };
  await failure(
    resolveNativeConfig({
      input: INPUT,
      binary: await fixture({ response }),
      checkoutLocal: new TextEncoder().encode(JSON.stringify(document)),
    })
  );
});

test("a supplied local map requires a binding report even when empty", async () => {
  const response = {
    ...COMPILED,
    plan: { plan_version: 1, services: {}, jobs: {} },
    local_resolution: LOCAL,
  };
  await failure(
    resolveNativeConfig({
      input: INPUT,
      binary: await fixture({ response }),
      checkoutLocal: new TextEncoder().encode(
        '{"schema_version":1,"host_bindings":{}}'
      ),
    })
  );
});

test("ignored primary bindings cannot manufacture an effective report", async () => {
  const response = {
    ...COMPILED,
    plan: { plan_version: 1, services: {}, jobs: {} },
    local_resolution: { ...LOCAL, inherit_local: false },
    host_binding_resolution: {
      bindings: { local: { target: HOST_TARGET, origin: "primary_local" } },
      removed: {},
    },
  };
  await failure(
    resolveNativeConfig({
      input: INPUT,
      binary: await fixture({ response }),
      primaryLocal: new TextEncoder().encode(
        JSON.stringify({
          schema_version: 1,
          host_bindings: { local: HOST_TARGET },
        })
      ),
    })
  );
});

test("source-verified local target and tombstone projections retain their provenance", async () => {
  const response = {
    ...COMPILED,
    plan: { plan_version: 1, services: {}, jobs: {} },
    local_resolution: LOCAL,
    host_binding_resolution: {
      bindings: { local: { target: HOST_TARGET, origin: "primary_local" } },
      removed: { removed: "checkout_local" },
    },
  };
  const result = await resolveNativeConfig({
    input: INPUT,
    binary: await fixture({ response }),
    primaryLocal: new TextEncoder().encode(
      JSON.stringify({
        schema_version: 1,
        host_bindings: { local: HOST_TARGET },
      })
    ),
    checkoutLocal: new TextEncoder().encode(
      '{"schema_version":1,"host_bindings":{"removed":null}}'
    ),
  });
  expect(result).toHaveProperty(
    "host_binding_resolution",
    response.host_binding_resolution
  );
});

test("a BOM-prefixed source cannot justify a local binding claim", async () => {
  const document = `\ufeff${JSON.stringify({ schema_version: 1, host_bindings: { local: HOST_TARGET } })}`;
  const response = {
    ...COMPILED,
    plan: { plan_version: 1, services: {}, jobs: {} },
    local_resolution: LOCAL,
    host_binding_resolution: {
      bindings: { local: { target: HOST_TARGET, origin: "checkout_local" } },
      removed: {},
    },
  };
  await failure(
    resolveNativeConfig({
      input: INPUT,
      binary: await fixture({ response }),
      checkoutLocal: new TextEncoder().encode(document),
    })
  );
});

test.each([
  "localhost",
  "external",
  "qa.example.test",
  "127.0.0.1",
  "[::1]",
  "[2001:db8::1]",
])("preserves canonical external hostname %s", (hostname) => {
  const target = { ...EXTERNAL_TARGET, hostname };
  expect(parseNativeHostBindingTarget(target)).toEqual(target);
});

test.each([
  "localhost:9000",
  "UPPER.test",
  "*.test",
  "qa.test.",
  "1",
  "0x7f000001",
  "qa.123",
  "::1",
  "[0:0:0:0:0:0:0:1]",
  "127.00.0.1",
  "user@qa.test",
  "qa.test/path",
])("refuses noncanonical external hostname %s", (hostname) => {
  expect(
    parseNativeHostBindingTarget({ ...EXTERNAL_TARGET, hostname })
  ).toBeNull();
});

test("endpoint parsing never strips an extra stored value", () => {
  expect(
    parseNativeEndpointBinding({ ...BINDINGS.API, value: CANARY })
  ).toBeNull();
  expect(
    parseNativeEndpointBinding({
      ...BINDINGS.API,
      reference: { ...SERVICE_REFERENCE, secret: CANARY },
    })
  ).toBeNull();
  expect(
    parseNativeEndpointBinding({
      ...BINDINGS.API,
      target: { ...SERVICE_REFERENCE, value: CANARY },
    })
  ).toBeNull();
});

test.each([
  "UPPER",
  "dot.name",
  "under_score",
  "double--dash",
  "trailing-",
  "a".repeat(64),
])("logical binding names refuse noncanonical spelling %s", async (name) => {
  const response = {
    ...COMPILED,
    plan: { ...PLAN, host_bindings: { [name]: HOST_TARGET } },
  };
  await failure(
    compileNativeConfig({ input: INPUT, binary: await fixture({ response }) })
  );
  expect(
    parseNativeEndpointBinding({
      ...BINDINGS.TUNNEL,
      reference: { kind: "host_binding", name },
    })
  ).toBeNull();
});
