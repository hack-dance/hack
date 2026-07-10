import { expect, test } from "bun:test";

import {
  applyBranchToHost,
  applyBranchToHosts,
  rewriteCaddyLabelForBranch,
} from "../src/lib/branch-hosts.ts";

const BASE_HOSTS = ["demo.hack", "demo.hack.gy"];

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
