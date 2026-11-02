import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YAML } from "bun";
import {
  classifyComposeEnvOverrideText,
  composeEnvGlobalReferenceName,
  composeEnvReferenceName,
  isComposeEnvReferenceName,
  renderComposeEnvReferenceOverride,
  withoutComposeEnvReferences,
} from "../src/lib/compose-managed-env.ts";
import {
  resolveProjectEnvConfig,
  setProjectEnvValue,
} from "../src/lib/project-env-config.ts";

/**
 * HACK-1317: values a service gets from the global scope share one Compose
 * reference, so the Compose process environment grows with distinct values,
 * not services times keys. Every value is a synthetic canary assembled here.
 */
const CANARY = "g45-unit-canary";

type Environment = Record<string, string>;

function services(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `svc${String(index + 1).padStart(2, "0")}`
  );
}

function parsedEnvironment(text: string): Record<string, Environment> {
  const parsed = YAML.parse(text) as {
    readonly services: Record<string, { readonly environment: Environment }>;
  };
  return Object.fromEntries(
    Object.entries(parsed.services).map(([name, service]) => [
      name,
      service.environment,
    ])
  );
}

test("twenty services that inherit one large global value share one reference", () => {
  const big = `${CANARY}-${"g".repeat(64 * 1024)}`;
  const names = services(20);
  const globalEnv = { BIG_TOKEN: big };
  const serviceEnv = Object.fromEntries(
    names.map((name) => [name, { BIG_TOKEN: big }])
  );
  const effectiveScopes = Object.fromEntries(
    names.map((name) => [name, { BIG_TOKEN: { scope: "global" } }])
  );
  const rendered = renderComposeEnvReferenceOverride({
    targetServices: names,
    globalEnv,
    serviceEnv,
    effectiveScopes,
  });
  if (!rendered) {
    throw new Error("expected a reference projection");
  }
  const shared = composeEnvGlobalReferenceName({ key: "BIG_TOKEN" });
  expect(Object.keys(rendered.env)).toEqual([shared]);
  expect(rendered.env[shared] === big).toBe(true);
  const environment = parsedEnvironment(rendered.text);
  expect(Object.keys(environment)).toEqual(names);
  for (const name of names) {
    expect(environment[name]).toEqual({ BIG_TOKEN: `\${${shared}}` });
  }
  expect(rendered.text.includes(CANARY)).toBe(false);
  expect(classifyComposeEnvOverrideText(rendered.text)).toEqual({
    kind: "references",
  });
  // Size grows with distinct values: one copy, not twenty.
  const delivered = Object.values(rendered.env).reduce(
    (bytes, value) => bytes + Buffer.byteLength(value),
    0
  );
  expect(delivered).toBe(Buffer.byteLength(big));
});

test("service-scoped keys keep their own reference while global keys share one", () => {
  const globalEnv = {
    SHARED: `${CANARY}-global`,
    OVERRIDDEN: `${CANARY}-g`,
    RESTATED: `${CANARY}-same`,
  };
  const serviceEnv = {
    web: {
      SHARED: `${CANARY}-global`,
      OVERRIDDEN: `${CANARY}-web`,
      WEB_ONLY: `${CANARY}-web-only`,
      // Set in the web scope to the same value: still web's own reference.
      RESTATED: `${CANARY}-same`,
    },
    worker: {
      SHARED: `${CANARY}-global`,
      OVERRIDDEN: `${CANARY}-g`,
      RESTATED: `${CANARY}-same`,
    },
  };
  const effectiveScopes = {
    web: {
      SHARED: { scope: "global" },
      OVERRIDDEN: { scope: "web" },
      WEB_ONLY: { scope: "web" },
      RESTATED: { scope: "web" },
    },
    worker: {
      SHARED: { scope: "global" },
      OVERRIDDEN: { scope: "global" },
      RESTATED: { scope: "global" },
    },
  };
  const rendered = renderComposeEnvReferenceOverride({
    targetServices: ["web", "worker", "fallback"],
    globalEnv,
    serviceEnv,
    effectiveScopes,
  });
  if (!rendered) {
    throw new Error("expected a reference projection");
  }
  const environment = parsedEnvironment(rendered.text);
  const shared = (key: string) =>
    `\${${composeEnvGlobalReferenceName({ key })}}`;
  const own = (service: string, key: string) =>
    `\${${composeEnvReferenceName({ service, key })}}`;
  expect(environment).toEqual({
    web: {
      SHARED: shared("SHARED"),
      OVERRIDDEN: own("web", "OVERRIDDEN"),
      WEB_ONLY: own("web", "WEB_ONLY"),
      RESTATED: own("web", "RESTATED"),
    },
    worker: {
      SHARED: shared("SHARED"),
      OVERRIDDEN: shared("OVERRIDDEN"),
      RESTATED: shared("RESTATED"),
    },
    // A service without its own env takes the global values, shared.
    fallback: {
      SHARED: shared("SHARED"),
      OVERRIDDEN: shared("OVERRIDDEN"),
      RESTATED: shared("RESTATED"),
    },
  });
  // Every container still receives exactly its own resolved value.
  for (const [service, keys] of Object.entries(environment)) {
    const expected =
      service === "fallback"
        ? globalEnv
        : serviceEnv[service as keyof typeof serviceEnv];
    for (const [key, reference] of Object.entries(keys)) {
      const name = reference.slice(2, -1);
      expect(isComposeEnvReferenceName(name)).toBe(true);
      expect(rendered.env[name]).toBe(
        expected[key as keyof typeof expected] ?? ""
      );
    }
  }
  expect(Object.keys(rendered.env)).toHaveLength(6);
  // Shared names are reference names, so non-Compose children never get them.
  expect(
    withoutComposeEnvReferences({ ...rendered.env, PATH: "/bin" })
  ).toEqual({ PATH: "/bin" });
});

test("shared text depends on scopes, not values", () => {
  const scopes = {
    web: { A: { scope: "global" }, B: { scope: "web" } },
    worker: { A: { scope: "global" } },
  };
  const render = (a: string, b: string) =>
    renderComposeEnvReferenceOverride({
      targetServices: ["web", "worker"],
      globalEnv: { A: a },
      serviceEnv: { web: { A: a, B: b }, worker: { A: a } },
      effectiveScopes: scopes,
    })?.text;
  expect(render(`${CANARY}-1`, `${CANARY}-2`)).toBe(
    render(`${CANARY}-3`, `${CANARY}-4`) ?? ""
  );
});

test("a global scope that disagrees with the global value keeps a per-service reference", () => {
  const rendered = renderComposeEnvReferenceOverride({
    targetServices: ["web"],
    globalEnv: { KEY: `${CANARY}-global` },
    serviceEnv: { web: { KEY: `${CANARY}-web` } },
    effectiveScopes: { web: { KEY: { scope: "global" } } },
  });
  const own = composeEnvReferenceName({ service: "web", key: "KEY" });
  expect(rendered?.env).toEqual({ [own]: `${CANARY}-web` });
});

test("without scope metadata every service keeps its own reference (the earlier form)", () => {
  const rendered = renderComposeEnvReferenceOverride({
    targetServices: ["web", "worker"],
    globalEnv: { KEY: CANARY },
    serviceEnv: { web: { KEY: CANARY }, worker: { KEY: CANARY } },
  });
  expect(Object.keys(rendered?.env ?? {}).sort()).toEqual(
    [
      composeEnvReferenceName({ service: "web", key: "KEY" }),
      composeEnvReferenceName({ service: "worker", key: "KEY" }),
    ].sort()
  );
});

test("the shared name never equals a per-service name, even for a service named global", () => {
  for (const key of ["KEY", "a.b"]) {
    const shared = composeEnvGlobalReferenceName({ key });
    expect(isComposeEnvReferenceName(shared)).toBe(true);
    for (const service of ["global", "", "web"]) {
      expect(composeEnvReferenceName({ service, key })).not.toBe(shared);
    }
  }
  expect(composeEnvGlobalReferenceName({ key: "a.b" })).toMatch(
    /^HACK_ENV_[0-9A-F]{12}$/
  );
});

test("with metadata and values from one resolution the value guard never fires, so the text depends only on scopes", async () => {
  // docs/env.md: scopes and values come from the same traversal, so a key
  // whose winning scope is global has the global value. Layered default and
  // local files, with service overrides in both, exercise the traversal.
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "hack-env-shared-guard-"))
  );
  try {
    const projectDir = join(root, ".hack");
    await mkdir(projectDir);
    const set = async (opts: {
      readonly scope: string;
      readonly key: string;
      readonly tag: string;
      readonly local?: boolean;
    }) =>
      await setProjectEnvValue({
        projectRoot: root,
        projectDir,
        envName: null,
        scope: opts.scope,
        key: opts.key,
        value: `${CANARY}-${opts.tag}`,
        secret: false,
        local: opts.local,
      });
    await set({ scope: "global", key: "SHARED", tag: "default-global" });
    await set({ scope: "global", key: "LAYERED", tag: "default-global" });
    await set({ scope: "web", key: "LAYERED", tag: "default-web" });
    await set({
      scope: "global",
      key: "LAYERED",
      tag: "local-global",
      local: true,
    });
    await set({
      scope: "worker",
      key: "SHARED",
      tag: "local-worker",
      local: true,
    });
    const resolved = await resolveProjectEnvConfig({
      projectRoot: root,
      projectDir,
      serviceNames: ["web", "worker"],
    });
    if (!resolved) {
      throw new Error("expected a resolved env config");
    }
    const scopeOf = (service: string, key: string) =>
      resolved.effectiveMetadata[service]?.[key]?.scope;
    // Both scope kinds occur, so the check below is not vacuous. The local
    // global value is a later layer than the default web value, so it wins
    // for web too, with scope global.
    expect(scopeOf("web", "LAYERED")).toBe("global");
    expect(scopeOf("worker", "LAYERED")).toBe("global");
    expect(scopeOf("worker", "SHARED")).toBe("worker");
    expect(scopeOf("web", "SHARED")).toBe("global");
    for (const service of ["web", "worker"]) {
      for (const [key, value] of Object.entries(
        resolved.serviceEnv[service] ?? {}
      )) {
        if (scopeOf(service, key) === "global") {
          // A flag, so a failure never prints a value.
          expect(value === resolved.globalEnv[key]).toBe(true);
        }
      }
    }
    const rendered = renderComposeEnvReferenceOverride({
      targetServices: ["web", "worker"],
      globalEnv: resolved.globalEnv,
      serviceEnv: resolved.serviceEnv,
      effectiveScopes: resolved.effectiveMetadata,
    });
    expect(Object.keys(rendered?.env ?? {}).sort()).toEqual(
      [
        composeEnvGlobalReferenceName({ key: "LAYERED" }),
        composeEnvGlobalReferenceName({ key: "SHARED" }),
        composeEnvReferenceName({ service: "worker", key: "SHARED" }),
      ].sort()
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
