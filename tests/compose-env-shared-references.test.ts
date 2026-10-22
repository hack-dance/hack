import { expect, test } from "bun:test";
import { YAML } from "bun";
import {
  classifyComposeEnvOverrideText,
  composeEnvGlobalReferenceName,
  composeEnvReferenceName,
  isComposeEnvReferenceName,
  renderComposeEnvReferenceOverride,
  withoutComposeEnvReferences,
} from "../src/lib/compose-managed-env.ts";

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
