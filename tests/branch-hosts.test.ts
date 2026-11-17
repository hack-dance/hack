import { expect, test } from "bun:test";
import {
  applyBranchToHost,
  applyBranchToHosts,
  isCaddySiteLabel,
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
    dropped: [],
  });
});

test("HACK-2284: the project's .hack, .hack.local and alias forms are one family whatever dev_host says", () => {
  const family = ["demo.hack", "demo.hack.local", "demo.hack.gy"].sort();
  for (const devHost of ["demo.hack", "demo.hack.local", "demo.hack.gy"]) {
    expect(
      [...resolveProjectRouteBaseHosts({ devHost, aliasHost: null })].sort()
    ).toEqual(family);
  }
  // A configured alias tld joins the family, from an alias-form dev_host too.
  expect(
    resolveProjectRouteBaseHosts({ devHost: "demo.hack.dev", aliasHost: null })
  ).toContain("demo.hack.dev");
  expect(
    resolveProjectRouteBaseHosts({
      devHost: "demo.hack",
      aliasHost: "demo.hack.dev",
    })
  ).toContain("demo.hack.dev");
});

test("HACK-2284: an alias-form dev_host no longer leaves the .hack host to both instances", () => {
  const baseHosts = resolveProjectRouteBaseHosts({
    devHost: "demo.hack.gy",
    aliasHost: null,
  });
  expect(
    rewriteCaddyLabelForBranch({
      value: "web.demo.hack, web.demo.hack.gy",
      branch: "feature-x",
      baseHosts,
    })
  ).toEqual({
    value: "web.feature-x.demo.hack, web.feature-x.demo.hack.gy",
    changed: true,
    dropped: [],
  });
});

test("label sites keep scheme and port, and sites outside the family are dropped", () => {
  expect(
    rewriteCaddyLabelForBranch({
      value:
        "https://api.demo.hack:8443 api.demo.hack.gy, external.example :80",
      branch: "feature-x",
      baseHosts: BASE_HOSTS,
    })
  ).toEqual({
    value: "https://api.feature-x.demo.hack:8443, api.feature-x.demo.hack.gy",
    changed: true,
    dropped: ["external.example", ":80"],
  });
  expect(
    rewriteCaddyLabelForBranch({
      value: "external.example",
      branch: "feature-x",
      baseHosts: BASE_HOSTS,
    })
  ).toEqual({ value: "", changed: true, dropped: ["external.example"] });
  expect(isCaddySiteLabel("caddy")).toBe(true);
  expect(isCaddySiteLabel("caddy_2")).toBe(true);
  expect(isCaddySiteLabel("caddy.reverse_proxy")).toBe(false);
  expect(isCaddySiteLabel("caddy_ingress_network")).toBe(false);
});
