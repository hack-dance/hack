import { expect, test } from "bun:test";
import {
  parseRunningCaddySites,
  sharedCaddyHosts,
  siteHostnames,
  warnSharedCaddyHosts,
} from "../src/lib/caddy-host-claims.ts";

// HACK-2284: warn when two running instances claim the same Caddy host.

test("site labels yield lowercase host names without scheme or port", () => {
  expect(
    siteHostnames("https://API.demo.hack:8443, api.demo.hack.gy  :80")
  ).toEqual(["api.demo.hack", "api.demo.hack.gy"]);
});

test("a host listed by this and another running instance is reported once, with the others", () => {
  const running = [
    { project: "demo", sites: ["web.demo.hack, web.demo.hack.gy"] },
    { project: "demo", sites: ["api.demo.hack"] },
    { project: "demo--feature-x", sites: ["web.demo.hack"] },
    { project: "other", sites: ["web.demo.hack", "other.hack"] },
    { project: null, sites: ["web.demo.hack.gy"] },
  ];
  expect(sharedCaddyHosts({ composeProject: "demo", running })).toEqual([
    { host: "web.demo.hack", others: ["demo--feature-x", "other"] },
  ]);
  // The branch instance sees the same conflict from its side.
  expect(
    sharedCaddyHosts({ composeProject: "demo--feature-x", running })
  ).toEqual([{ host: "web.demo.hack", others: ["demo", "other"] }]);
  // Hosts only one instance lists are not reported.
  expect(sharedCaddyHosts({ composeProject: "solo", running })).toEqual([]);
});

test("inspect lines keep only root site labels and refuse malformed rows", () => {
  expect(
    parseRunningCaddySites(
      JSON.stringify({
        project: "demo",
        labels: { caddy: "a.demo.hack", caddy_1: "b.demo.hack", "": "" },
      })
    )
  ).toEqual({ project: "demo", sites: ["a.demo.hack", "b.demo.hack"] });
  expect(parseRunningCaddySites("{not json")).toBeUndefined();
  expect(
    parseRunningCaddySites(JSON.stringify({ project: 1, labels: {} }))
  ).toBeUndefined();
});

test("the warning names the host and the other instance, and Docker failures stay silent", async () => {
  const warnings: string[] = [];
  await warnSharedCaddyHosts({
    composeProject: "demo--feature-x",
    warn: (message) => warnings.push(message),
    read: async () => [
      { project: "demo", sites: ["web.demo.hack"] },
      { project: "demo--feature-x", sites: ["web.demo.hack"] },
    ],
  });
  expect(warnings).toEqual([
    "Host web.demo.hack is also claimed by running instance demo; Caddy will not route it to this instance alone. Stop the other instance or give each its own host.",
  ]);
  for (const read of [
    async () => null,
    async () => {
      throw new Error("docker unavailable");
    },
  ]) {
    const silent: string[] = [];
    await warnSharedCaddyHosts({
      composeProject: "demo",
      warn: (message) => silent.push(message),
      read,
    });
    expect(silent).toEqual([]);
  }
});
