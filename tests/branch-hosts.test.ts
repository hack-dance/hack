import { expect, test } from "bun:test";
import {
  applyBranchToHost,
  applyBranchToHosts,
  rewriteCaddyLabelForBranch,
} from "../src/lib/branch-hosts.ts";
import { resolveProjectRouteBaseHosts } from "../src/lib/project.ts";

const BASE_HOSTS = ["demo.hack", "demo.hack.gy"];

test("migrated branch labels keep both original namespaces branch-scoped", () => {
  const baseHosts = resolveProjectRouteBaseHosts({
    devHost: "demo.hack.local",
    aliasHost: null,
  });
  expect(
    rewriteCaddyLabelForBranch({
      value: "api.demo.hack, api.demo.hack.gy, api.demo.hack.local",
      branch: "feature-x",
      baseHosts,
    }).value
  ).toBe(
    "api.feature-x.demo.hack, api.feature-x.demo.hack.gy, api.feature-x.demo.hack.local"
  );
  expect(
    resolveProjectRouteBaseHosts({ devHost: "custom.example", aliasHost: null })
  ).toEqual(["custom.example"]);
});

test("branch routes preserve hack.local and the legacy OAuth namespace together", () => {
  expect(
    applyBranchToHosts({
      hosts: [
        "demo.hack.local",
        "api.demo.hack.local",
        "demo.hack.gy",
        "api.demo.hack.gy",
        "external.example",
      ],
      branch: "feature-x",
      baseHosts: ["demo.hack.local", "demo.hack.gy"],
    })
  ).toEqual([
    "feature-x.demo.hack.local",
    "api.feature-x.demo.hack.local",
    "feature-x.demo.hack.gy",
    "api.feature-x.demo.hack.gy",
    "external.example",
  ]);
});

test("branch host rewriting handles root, matching service, alias, and foreign hosts", () => {
  expect(
    applyBranchToHost({
      host: "demo.hack",
      branch: "feature-x",
      baseHosts: BASE_HOSTS,
    })
  ).toBe("feature-x.demo.hack");
  expect(
    applyBranchToHost({
      host: "api.demo.hack.gy",
      branch: "feature-x",
      baseHosts: BASE_HOSTS,
    })
  ).toBe("api.feature-x.demo.hack.gy");
  expect(
    applyBranchToHost({
      host: "api.demo.hack",
      branch: "api",
      baseHosts: BASE_HOSTS,
    })
  ).toBe("api.api.demo.hack");
  expect(
    applyBranchToHost({
      host: "api.feature-x.demo.hack",
      branch: "feature-x",
      baseHosts: BASE_HOSTS,
    })
  ).toBe("api.feature-x.demo.hack");
  expect(
    applyBranchToHost({
      host: "external.example.com",
      branch: "feature-x",
      baseHosts: BASE_HOSTS,
    })
  ).toBe("external.example.com");
});

test("branch host collections preserve order and remove duplicates", () => {
  expect(
    applyBranchToHosts({
      hosts: ["demo.hack", "demo.hack", "api.demo.hack"],
      branch: "feature-x",
      baseHosts: BASE_HOSTS,
    })
  ).toEqual(["feature-x.demo.hack", "api.feature-x.demo.hack"]);

  expect(
    rewriteCaddyLabelForBranch({
      value: "demo.hack, demo.hack, api.demo.hack",
      branch: "feature-x",
      baseHosts: BASE_HOSTS,
    })
  ).toEqual({
    value: "feature-x.demo.hack, api.feature-x.demo.hack",
    changed: true,
  });
});
