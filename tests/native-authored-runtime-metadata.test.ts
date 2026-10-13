import { expect, test } from "bun:test";
import type { NativeProjectInput } from "../src/backends/native-project-input.ts";
import { applyNativeRuntimeMetadata } from "../src/backends/native-runtime-metadata.ts";
import { isRecord } from "../src/lib/guards.ts";
import {
  type NativeAuthoredRuntimeMetadataSelection,
  nativeAuthoredRuntimeMetadata,
} from "../src/lib/native-authored-runtime-metadata.ts";
import {
  NativeComposeRenderError,
  renderNativeCompose,
} from "../src/lib/native-compose-renderer.ts";
import {
  type NativeConfigPlanResult,
  planNativeConfig,
  resolveNativeConfig,
} from "../src/lib/native-config-compiler.ts";
import type { NativeEnvMetadata } from "../src/lib/native-env-plan-protocol.ts";
import {
  RUNTIME_HOST_METADATA_KEY_NAMES,
  type RuntimeHostMetadata,
} from "../src/lib/runtime-host-metadata.ts";
import { requireTestConfigCompiler } from "./helpers/test-config-compiler.ts";

const binary = requireTestConfigCompiler();
const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));

/** Real compiler: resolve routing, derive the shared metadata, then plan with it. */
async function authoredPlan(opts: {
  readonly project: Record<string, unknown>;
  readonly branch?: string;
  readonly selection: NativeAuthoredRuntimeMetadataSelection;
  readonly workloads?: NativeEnvMetadata["workloads"];
}): Promise<Extract<NativeConfigPlanResult, { readonly ok: true }>> {
  const input = encode(opts.project);
  const resolved = await resolveNativeConfig({
    input,
    binary,
    branch: opts.branch,
    requireRoutingPlanning: opts.branch !== undefined,
  });
  if (!(resolved.ok && resolved.declared_workloads)) {
    throw new Error("fixture project did not resolve");
  }
  const runtime = nativeAuthoredRuntimeMetadata({
    projectName: String(resolved.plan.name),
    declaredWorkloads: resolved.declared_workloads,
    routing: resolved.routing_resolution,
    selection: opts.selection,
  });
  const planned = await planNativeConfig({
    input,
    binary,
    branch: opts.branch,
    envMetadata: {
      metadata_version: 1,
      overlay: null,
      overlay_exists: false,
      workloads:
        opts.workloads ??
        Object.fromEntries(
          Object.keys(resolved.declared_workloads).map((name) => [name, {}])
        ),
      inactive_scopes: [],
      runtime,
    },
  });
  if (!(planned.ok && planned.environment_plan.complete)) {
    throw new Error("fixture project did not plan");
  }
  return planned;
}

function runtimeBindings(
  planned: Extract<NativeConfigPlanResult, { readonly ok: true }>,
  workload: string
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(planned.environment_plan.workloads[workload] ?? {}).flatMap(
      ([key, binding]) =>
        binding.kind === "runtime" ? [[key, binding.value] as const] : []
    )
  );
}

function imageInput(services: Record<string, unknown>): NativeProjectInput {
  return {
    originalSha256: "d".repeat(64),
    normalizedComposeJson: JSON.stringify({ services }),
    managedEnvironment: {},
    lifecycleHostEnvironment: {},
    effectiveEnvName: null,
    environmentFiles: [],
    serviceNames: Object.keys(services),
  };
}

function imageEnvironment(
  input: NativeProjectInput,
  service: string
): Record<string, unknown> {
  const compose: unknown = JSON.parse(input.normalizedComposeJson);
  if (!(isRecord(compose) && isRecord(compose.services))) {
    throw new Error("missing services");
  }
  const selected = compose.services[service];
  if (!(isRecord(selected) && isRecord(selected.environment))) {
    throw new Error(`missing ${service} environment`);
  }
  return selected.environment;
}

test("authored native metadata matches the native image path for a branch instance on HTTPS port 8443", async () => {
  // Native image project: dev host app.hack.local, branch feature, port 8443.
  const image = applyNativeRuntimeMetadata({
    input: imageInput({
      web: { image: "example" },
      worker: { image: "example" },
    }),
    selection: {
      devHost: "app.hack.local",
      aliasHost: null,
      projectName: "app",
    },
    branch: "feature",
    httpsPort: 8443,
  }).input;
  // Authored project named app: the compiler generates feature.app.hack.local.
  const planned = await authoredPlan({
    project: {
      schema_version: 1,
      name: "app",
      services: { web: { image: "example:1" }, worker: { image: "example:1" } },
    },
    branch: "feature",
    selection: { branch: "feature", httpsPort: 8443 },
  });
  for (const service of ["web", "worker"]) {
    const authored = runtimeBindings(planned, service);
    expect(authored).toEqual(
      imageEnvironment(image, service) as Record<string, string>
    );
    expect(Object.keys(authored).sort()).toEqual(
      RUNTIME_HOST_METADATA_KEY_NAMES.filter(
        (key) =>
          key !== "HACK_ALIAS_HOST" &&
          key !== "HACK_ALIAS_URL" &&
          key !== "HACK_SERVICE_URL"
      ).sort()
    );
  }
  const web = runtimeBindings(planned, "web");
  expect(web.HACK_BRANCH).toBe("feature");
  expect(web.HACK_COMPOSE_PROJECT).toBe("app--feature");
  expect(web.HACK_DEV_HOST).toBe("feature.app.hack.local");
  expect(web.HACK_DEV_URL).toBe("https://feature.app.hack.local:8443");
  expect(web.HACK_SERVICE_NAME).toBe("web");
  expect(web.HACK_SERVICE_URLS).toBe("[]");
  expect(JSON.parse(web.HACK_RUNTIME_METADATA ?? "")).toEqual({
    version: 1,
    branch: "feature",
    composeProject: "app--feature",
    hosts: { dev: "feature.app.hack.local", alias: null },
    services: {},
  } satisfies RuntimeHostMetadata);
});

test("authored base instance without routing uses the compiler's generated origin and portless URLs", async () => {
  const planned = await authoredPlan({
    project: {
      schema_version: 1,
      name: "app",
      services: { web: { image: "example:1" } },
      jobs: { seed: { image: "example:1" } },
    },
    selection: { branch: null, httpsPort: 443 },
  });
  expect(planned.routing_resolution).toBeUndefined();
  const web = runtimeBindings(planned, "web");
  expect(web.HACK_BRANCH).toBe("");
  expect(web.HACK_COMPOSE_PROJECT).toBe("app");
  expect(web.HACK_DEV_URL).toBe("https://app.hack.local");
  expect(runtimeBindings(planned, "seed").HACK_SERVICE_NAME).toBe("seed");
});

test("explicit authored and managed env win over generated metadata through the real compiler", async () => {
  const planned = await authoredPlan({
    project: {
      schema_version: 1,
      name: "app",
      services: {
        web: {
          image: "example:1",
          environment: {
            HACK_DEV_URL: { literal: "https://authored.example" },
            HACK_SERVICE_URLS: { unset: true },
          },
        },
      },
    },
    branch: "feature",
    selection: { branch: "feature", httpsPort: 8443 },
    workloads: {
      web: { HACK_BRANCH: { scope: "web", secret: false } },
    },
  });
  const bindings = planned.environment_plan.workloads.web ?? {};
  expect(bindings.HACK_DEV_URL).toEqual({
    kind: "literal",
    value: "https://authored.example",
  });
  expect(bindings.HACK_BRANCH).toEqual({
    kind: "managed",
    key: "HACK_BRANCH",
    scope: "web",
    secret: false,
  });
  expect(bindings.HACK_SERVICE_URLS).toBeUndefined();
  expect(bindings.HACK_DEV_HOST).toEqual({
    kind: "runtime",
    value: "feature.app.hack.local",
  });
});

const ROUTED = {
  schema_version: 1,
  name: "app",
  routes: {
    aliases: { oauth: { domain: "hack.gy" } },
    oauth_alias: "oauth",
    http: {
      web: { service: "web", port: 3000, hostname: "project" },
      api: { service: "api", port: 4000, hostname: "api" },
    },
  },
  services: {
    web: {
      image: "example:1",
      environment: { HACK_DEV_URL: { literal: "https://authored.example" } },
    },
    api: { image: "example:1" },
    worker: { image: "example:1" },
  },
};

async function routedRender(withRuntime: boolean) {
  const composeProject = `hack-nc-${"a".repeat(32)}`;
  const planned = await authoredPlan({
    project: ROUTED,
    branch: "feature",
    selection: { branch: "feature", composeProject, httpsPort: null },
  });
  const workloads = withRuntime
    ? planned.environment_plan.workloads
    : Object.fromEntries(
        Object.entries(planned.environment_plan.workloads).map(
          ([name, bindings]) => [
            name,
            Object.fromEntries(
              Object.entries(bindings).filter(
                ([, binding]) => binding.kind !== "runtime"
              )
            ),
          ]
        )
      );
  return renderNativeCompose({
    plan: planned.plan,
    environmentPlan: { ...planned.environment_plan, workloads },
    projectRoot: "/verified/checkout",
    runtimeIdentity: composeProject,
    ownerToken: "c".repeat(32),
    generationIdentity: "b".repeat(32),
    managedValues: { web: {}, api: {}, worker: {} },
    routingResolution: planned.routing_resolution,
    declaredWorkloads: planned.declared_workloads,
  });
}

test("authored Compose render gains route-derived metadata while every other byte stays the same", async () => {
  const rendered = await routedRender(true);
  const baseline = await routedRender(false);
  const services = rendered.document.services;
  const env = (name: string) => {
    const service = services[name];
    if (!(service && isRecord(service.environment))) {
      throw new Error(`missing ${name} environment`);
    }
    return service.environment as Record<string, string>;
  };
  expect(env("web").HACK_DEV_URL).toBe("https://authored.example");
  expect(env("web").HACK_SERVICE_URL).toBe("https://feature.app.hack.local");
  expect(JSON.parse(env("web").HACK_SERVICE_URLS ?? "")).toEqual([
    "https://feature.app.hack.local",
    "https://feature.app.hack.gy",
  ]);
  expect(env("api").HACK_DEV_URL).toBe("https://feature.app.hack.local");
  expect(env("api").HACK_SERVICE_URL).toBe(
    "https://api.feature.app.hack.local"
  );
  expect(env("api").HACK_ALIAS_HOST).toBe("feature.app.hack.gy");
  expect(env("api").HACK_ALIAS_URL).toBe("https://feature.app.hack.gy");
  expect(env("api").HACK_COMPOSE_PROJECT).toBe(`hack-nc-${"a".repeat(32)}`);
  expect(env("worker").HACK_SERVICE_URL).toBeUndefined();
  expect(env("worker").HACK_SERVICE_URLS).toBe("[]");
  const document = JSON.parse(
    env("worker").HACK_RUNTIME_METADATA ?? ""
  ) as RuntimeHostMetadata;
  expect(document).toEqual({
    version: 1,
    branch: "feature",
    composeProject: `hack-nc-${"a".repeat(32)}`,
    hosts: { dev: "feature.app.hack.local", alias: "feature.app.hack.gy" },
    services: {
      api: {
        urls: [
          "https://api.feature.app.hack.local",
          "https://api.feature.app.hack.gy",
        ],
      },
      web: {
        urls: ["https://feature.app.hack.local", "https://feature.app.hack.gy"],
      },
    },
  });
  // Removing exactly the generated keys yields the metadata-free render, byte for byte.
  const stripped = structuredClone(rendered.document) as Record<
    string,
    unknown
  >;
  for (const service of Object.values(
    stripped.services as Record<string, Record<string, unknown>>
  )) {
    const environment = service.environment as Record<string, string>;
    for (const key of RUNTIME_HOST_METADATA_KEY_NAMES) {
      if (
        key !== "HACK_DEV_URL" ||
        environment[key] !== "https://authored.example"
      ) {
        delete environment[key];
      }
    }
  }
  expect(`${JSON.stringify(stripped, null, 2)}\n`).toBe(baseline.json);
  expect(rendered.json).not.toBe(baseline.json);
});

test("the renderer refuses generated bindings that shadow owned keys or leave the reserved set", async () => {
  const planned = await authoredPlan({
    project: ROUTED,
    branch: "feature",
    selection: {
      branch: "feature",
      composeProject: `hack-nc-${"a".repeat(32)}`,
      httpsPort: null,
    },
  });
  const render = (
    web: Record<string, unknown>,
    managedValues: Record<string, Record<string, string>> = {
      web: {},
      api: {},
      worker: {},
    }
  ) =>
    renderNativeCompose({
      plan: planned.plan,
      environmentPlan: {
        ...planned.environment_plan,
        workloads: { ...planned.environment_plan.workloads, web },
      },
      projectRoot: "/verified/checkout",
      runtimeIdentity: `hack-nc-${"a".repeat(32)}`,
      ownerToken: "c".repeat(32),
      generationIdentity: "b".repeat(32),
      managedValues,
      routingResolution: planned.routing_resolution,
      declaredWorkloads: planned.declared_workloads,
    });
  const web = planned.environment_plan.workloads.web ?? {};
  const expectRefusal = (action: () => unknown, code: string) => {
    try {
      action();
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(NativeComposeRenderError);
      expect((error as NativeComposeRenderError).code).toBe(code);
      return;
    }
    throw new Error("expected a renderer refusal");
  };
  // Positive control: the compiler output itself renders.
  expect(() => render(web)).not.toThrow();
  // A generated binding for a non-reserved key fails the closed plan parse.
  expectRefusal(
    () => render({ ...web, OTHER: { kind: "runtime", value: "x" } }),
    "E_COMPOSE_ENV_INCOMPLETE"
  );
  // A generated binding where the authored directive owns the key.
  expectRefusal(
    () =>
      render({ ...web, HACK_DEV_URL: { kind: "runtime", value: "forged" } }),
    "E_COMPOSE_ENV_MISMATCH"
  );
  // A generated binding where a managed value owns the key.
  expectRefusal(
    () =>
      render(web, {
        web: { HACK_BRANCH: "managed" },
        api: {},
        worker: {},
      }),
    "E_COMPOSE_ENV_MISMATCH"
  );
});
