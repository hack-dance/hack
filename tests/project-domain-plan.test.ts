import { expect, test } from "bun:test";
import { planProjectDomainMigration } from "../src/lib/project-domain-plan.ts";

function plan(
  composeText: string,
  host = "demo.hack",
  claimedHosts: readonly string[] = []
) {
  return planProjectDomainMigration({
    configText: JSON.stringify({
      dev_host: host,
      name: "demo",
      nested: { untouched: "demo.hack" },
    }),
    composeText,
    claimedHosts,
  });
}

const COMPOSE = `# retained heading
services:
  web:
    image: nginx
    environment:
      ORIGIN: demo.hack
    labels:
      # retained label note
      caddy: demo.hack,api.demo.hack, demo.hack.gy # keep old routes
      caddy.reverse_proxy: "{{upstreams 3000}}"
`;

test("adds local routes and preserves old routes, comments and non-route values", () => {
  const result = plan(COMPOSE);
  expect(result.fromHost).toBe("demo.hack");
  expect(result.toHost).toBe("demo.hack.local");
  expect(result.addedHosts).toEqual(["demo.hack.local", "api.demo.hack.local"]);
  expect(JSON.parse(result.configText)).toEqual({
    dev_host: "demo.hack.local",
    name: "demo",
    nested: { untouched: "demo.hack" },
  });
  expect(result.composeText).toContain("# retained heading");
  expect(result.composeText).toContain("# retained label note");
  expect(result.composeText).toContain("# keep old routes");
  expect(result.composeText).toContain("ORIGIN: demo.hack");
  expect(result.composeText).toContain(
    'caddy.reverse_proxy: "{{upstreams 3000}}"'
  );
  expect(result.composeText).toContain(
    "demo.hack, api.demo.hack, demo.hack.gy, demo.hack.local, api.demo.hack.local"
  );
});

test("migrates gy base and supports list labels", () => {
  const result = plan(
    `services:
  web:
    labels:
      - 'caddy=api.demo.hack.gy, demo.hack.gy' # list comment
      - caddy.reverse_proxy={{upstreams 3000}}
`,
    "demo.hack.gy"
  );
  expect(result.toHost).toBe("demo.hack.local");
  expect(result.addedHosts).toEqual(["api.demo.hack.local", "demo.hack.local"]);
  expect(result.composeText).toContain("# list comment");
  expect(result.composeText).toContain(
    "api.demo.hack.gy, demo.hack.gy, api.demo.hack.local, demo.hack.local"
  );
});

for (const host of [
  "demo.example.com",
  "demo.hack.local",
  "demo.HACK",
  "${SECRET}",
]) {
  test(`refuses unsupported base ${host}`, () => {
    expect(() => plan(COMPOSE, host)).toThrow();
  });
}

for (const claim of [
  "demo.hack.local",
  "DEMO.HACK.LOCAL.",
  "*.hack.local",
  "*.HACK.LOCAL.",
]) {
  test(`refuses external claim ${claim}`, () => {
    expect(() => plan(COMPOSE, "demo.hack", [claim])).toThrow("conflicts");
  });
}

for (const conflicting of ["demo.hack.local", "demo.hack.gy", "demo.hack"]) {
  test(`refuses a second service's overlapping routes ${conflicting}`, () => {
    expect(() =>
      plan(`${COMPOSE}  other:\n    labels:\n      caddy: ${conflicting}\n`)
    ).toThrow("conflicts");
  });
}

test("an already routed local name on the same service is not duplicated", () => {
  const result = plan(
    "services:\n  web:\n    labels:\n      caddy: demo.hack, demo.hack.local\n"
  );
  expect(result.addedHosts).toEqual([]);
});

for (const route of [
  "${SECRET}",
  "*.demo.hack",
  "https://demo.hack",
  "demo.hack:443",
  "true",
  "[demo.hack]",
]) {
  test(`refuses nonliteral route ${route}`, () => {
    expect(() =>
      plan(`services:\n  web:\n    labels:\n      caddy: ${route}\n`)
    ).toThrow("literal Compose routes");
  });
}

for (const extra of [
  "include: other.yml\n",
  "x: &shared {}\n",
  "x: !secret hidden\n",
  "x: {extends: other}\n",
  "x: {volumes_from: [other]}\n",
  "x: {<<: other}\n",
]) {
  test(`refuses indirect routes ${extra}`, () => {
    expect(() => plan(`${extra}${COMPOSE}`)).toThrow();
  });
}

test("refuses no matching route, duplicate list route and flow labels", () => {
  expect(() => plan(COMPOSE.replaceAll("demo.hack", "foreign.test"))).toThrow(
    "no matching"
  );
  expect(() =>
    plan(
      "services:\n  web:\n    labels:\n      - caddy=demo.hack\n      - caddy=demo.hack\n"
    )
  ).toThrow();
  expect(() => plan("services: {web: {labels: {caddy: demo.hack}}}")).toThrow();
});

test("sanitizes JSON and YAML parse errors", () => {
  for (const configText of ["{SECRET", "[]"]) {
    try {
      planProjectDomainMigration({ configText, composeText: COMPOSE });
      throw new Error("unexpected success");
    } catch (error) {
      expect(String(error)).not.toContain("SECRET");
      expect(String(error)).toContain("configuration");
    }
  }
  expect(() => plan("services: [SECRET")).toThrow("literal Compose routes");
});
